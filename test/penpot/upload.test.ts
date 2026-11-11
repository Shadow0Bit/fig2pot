import { strToU8, zipSync } from 'fflate';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeTransit,
  normalizePenpotUrl,
  PenpotUploadError,
  proxyFor,
  readPenpotManifest,
  readSse,
  redactUrl,
  uploadToPenpot,
  type UploadOptions,
} from '../../src/penpot/upload.ts';

const TOKEN = 'tok_SECRET_9f8e7d6c5b4a';
const PROFILE = 'aaaaaaaa-0000-4000-8000-000000000001';
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const DRAFTS = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER_TEAM = 'aaaaaaaa-0000-4000-8000-000000000004';
const OTHER_PROJECT = 'aaaaaaaa-0000-4000-8000-000000000005';
const FILE = 'aaaaaaaa-0000-4000-8000-000000000006';
const PAGES = ['bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'] as const;
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const BASE = 'https://penpot.example';

interface Call {
  url: string;
  command: string;
  headers: Headers;
  body: unknown;
  redirect: RequestRedirect | undefined;
  /** import-binfile requests so far, this one included. */
  imports: number;
}

type Handler = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A streamed body delivered in the given chunks; errors when the request is aborted, like real fetch. */
function streamed(chunks: Uint8Array[], signal: AbortSignal | undefined, { hang = false } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason));
      for (const c of chunks) controller.enqueue(c);
      if (!hang) controller.close();
    },
  });
}

/** SSE response split into one-byte chunks (so every boundary — CRLF halves, UTF-8 sequences — is exercised). */
function sse(text: string, signal: AbortSignal | undefined, options: { hang?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
  return new Response(streamed(chunks, signal, options), { status: 200, headers: { 'content-type': 'text/event-stream;charset=UTF-8' } });
}

const IMPORT_OK = [
  'event: progress',
  'data: {"~:section":"~:manifest"}',
  '',
  ': keep-alive comment',
  '',
  'event: progress',
  `data: {"~:section":"~:page","~:id":"~u${PAGES[0]}","~:name":"Seite ü 🙂"}`,
  '',
  'event: end',
  `data: {"~:file-ids":["~u${FILE}"],"~:resolution":{}}`,
  '',
  '',
].join('\r\n');

/** Shapes per page of the uploaded file (in `penpotZip`) and of the imported one (`fileBody`). */
const ROOT = '00000000-0000-0000-0000-000000000000';
const SHAPES: Record<string, readonly string[]> = {
  [PAGES[0]]: [ROOT, 'cccccccc-0000-4000-8000-000000000001'],
  [PAGES[1]]: [ROOT, 'cccccccc-0000-4000-8000-000000000002'],
};
const objects = (page: string, shapes = SHAPES): Record<string, unknown> => Object.fromEntries((shapes[page] ?? []).map((id) => [id, { id }]));

const fileBody = (overrides: Record<string, unknown> = {}, shapes = SHAPES) => ({
  id: FILE,
  name: 'frame',
  teamId: TEAM,
  projectId: DRAFTS,
  data: {
    pages: [PAGES[0], PAGES[1]],
    pagesIndex: {
      [PAGES[1]]: { id: PAGES[1], name: 'Second', objects: objects(PAGES[1], shapes) },
      [PAGES[0]]: { id: PAGES[0], name: 'First', objects: objects(PAGES[0], shapes) },
    },
  },
  ...overrides,
});

function mockPenpot(overrides: Record<string, Handler> = {}): { calls: Call[] } {
  const calls: Call[] = [];
  let imports = 0;
  const handlers: Record<string, Handler> = {
    'version.txt': () => new Response('2.19.0\n', { headers: { 'content-type': 'text/plain' } }),
    'get-profile': () => json({ id: PROFILE, fullname: 'T', defaultTeamId: TEAM, defaultProjectId: DRAFTS }),
    'get-project': (c) => json({ id: (c.body as { id: string }).id, teamId: OTHER_TEAM, name: 'Other' }),
    'get-all-projects': () => json([]),
    'import-binfile': (_c, signal) => sse(IMPORT_OK, signal),
    'get-file': () => json(fileBody()),
    'rename-file': (c) => json({ id: FILE, name: (c.body as { name: string }).name }),
    'get-project-files': () => json([]),
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const command = /\/api\/rpc\/command\/([\w-]+)$/.exec(path)?.[1] ?? path.split('/').pop()!;
      let body: unknown = init.body;
      if (typeof init.body === 'string') body = JSON.parse(init.body);
      else if (init.body instanceof Blob) {
        // The import's multipart body: parsed as a server would.
        const contentType = new Headers(init.headers).get('content-type') ?? '';
        expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
        const fields: Record<string, FormDataEntryValue> = {};
        (await new Response(init.body, { headers: { 'content-type': contentType } }).formData()).forEach((value, key) => (fields[key] = value));
        body = fields;
      }
      if (command === 'import-binfile') imports++;
      const call: Call = { url, command, headers: new Headers(init.headers), body, redirect: init.redirect, imports };
      calls.push(call);
      const signal = init.signal ?? undefined;
      if (signal?.aborted) throw signal.reason;
      const handler = handlers[command];
      if (!handler) return json({ type: 'not-found', code: 'unknown-command' }, 404);
      return handler(call, signal);
    }),
  );
  return { calls };
}

const options = (extra: Partial<UploadOptions> = {}): UploadOptions => ({
  baseUrl: BASE,
  accessToken: TOKEN,
  name: 'frame',
  verifyGraceMs: 0,
  ...extra,
});

async function failure(promise: Promise<unknown>): Promise<PenpotUploadError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PenpotUploadError);
  const e = error as PenpotUploadError;
  // The token must never leak, whatever the failure.
  expect(e.message).not.toContain(TOKEN);
  expect(JSON.stringify(e.penpot ?? {})).not.toContain(TOKEN);
  expect(String(e.stack)).not.toContain(TOKEN);
  return e;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadToPenpot', () => {
  it('imports into the Drafts project and links every page (SSE split into single bytes, CRLF)', async () => {
    const { calls } = mockPenpot();
    const result = await uploadToPenpot(BYTES, options());

    const ws = (page: string) => `${BASE}/?screen=workspace&team-id=${TEAM}&file-id=${FILE}&page-id=${page}`;
    expect(result).toEqual({
      url: ws(PAGES[0]),
      fileId: FILE,
      teamId: TEAM,
      projectId: DRAFTS,
      name: 'frame',
      pages: [
        { id: PAGES[0], name: 'First', url: ws(PAGES[0]) },
        { id: PAGES[1], name: 'Second', url: ws(PAGES[1]) },
      ],
    });

    const rpc = calls.filter((c) => c.url.includes('/api/rpc/command/'));
    // get-project-files: what the project holds before the import (to recognise a new file if the import's outcome is open).
    expect(rpc.map((c) => c.command)).toEqual(['get-profile', 'get-project-files', 'import-binfile', 'get-file']);
    for (const c of rpc) expect(c.headers.get('authorization')).toBe(`Token ${TOKEN}`);
    // Redirects are handled by hand, never followed blindly.
    for (const c of calls) expect(c.redirect).toBe('manual');
    // version.txt is a static file: no credentials sent there.
    expect(calls.find((c) => c.command === 'version.txt')?.headers.get('authorization')).toBeNull();

    const imp = calls.find((c) => c.command === 'import-binfile')!;
    expect(imp.headers.get('accept')).toContain('text/event-stream');
    const form = imp.body as Record<string, FormDataEntryValue>;
    expect(form.name).toBe('frame');
    expect(form['project-id']).toBe(DRAFTS);
    expect(new Uint8Array(await (form.file as Blob).arrayBuffer())).toEqual(BYTES);
    expect(calls.find((c) => c.command === 'get-file')?.body).toEqual({ id: FILE });
  });

  it('finds the Drafts project through get-all-projects when the profile does not name it', async () => {
    const { calls } = mockPenpot({
      'get-profile': () => json({ id: PROFILE }),
      'get-all-projects': () =>
        json([
          { id: OTHER_PROJECT, teamId: OTHER_TEAM, isDefault: true, isDefaultTeam: false },
          { id: 'aaaaaaaa-0000-4000-8000-0000000000ff', teamId: TEAM, isDefault: false, isDefaultTeam: true },
          { id: DRAFTS, teamId: TEAM, isDefault: true, isDefaultTeam: true },
        ]),
    });
    const result = await uploadToPenpot(BYTES, options());
    expect(calls.some((c) => c.command === 'get-all-projects')).toBe(true);
    expect(result.projectId).toBe(DRAFTS);
    expect((calls.find((c) => c.command === 'import-binfile')!.body as Record<string, unknown>)['project-id']).toBe(DRAFTS);
  });

  it('uploads into an explicit project and takes the team from it', async () => {
    const { calls } = mockPenpot({
      'get-file': () => json(fileBody({ teamId: OTHER_TEAM, projectId: OTHER_PROJECT })),
    });
    const result = await uploadToPenpot(BYTES, options({ projectId: OTHER_PROJECT }));
    expect(calls.find((c) => c.command === 'get-project')?.body).toEqual({ id: OTHER_PROJECT });
    const form = calls.find((c) => c.command === 'import-binfile')!.body as Record<string, unknown>;
    expect(form['project-id']).toBe(OTHER_PROJECT);
    expect(result).toMatchObject({ projectId: OTHER_PROJECT, teamId: OTHER_TEAM });
    expect(result.url).toContain(`team-id=${OTHER_TEAM}`);
  });

  it('reports an unknown project before uploading anything', async () => {
    const { calls } = mockPenpot({
      'get-project': () => json({ type: 'not-found', code: 'object-not-found', hint: 'database object not found' }, 404),
    });
    const e = await failure(uploadToPenpot(BYTES, options({ projectId: OTHER_PROJECT })));
    expect(e.status).toBe(404);
    expect(e.penpot).toEqual({ type: 'not-found', code: 'object-not-found', hint: 'database object not found' });
    expect(calls.some((c) => c.command === 'import-binfile')).toBe(false);
  });

  it('treats the anonymous profile (unknown token) as an authentication failure', async () => {
    const { calls } = mockPenpot({
      'get-profile': () => json({ id: '00000000-0000-0000-0000-000000000000', fullname: 'Anonymous User' }),
    });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/access token/);
    expect(calls.some((c) => c.command === 'import-binfile')).toBe(false);
  });

  it('surfaces HTTP auth errors with Penpot type/code/hint verbatim, never the token', async () => {
    mockPenpot({
      'get-profile': () =>
        json({ type: 'authentication', code: 'authentication-required', hint: `bad header: Token ${TOKEN}` }, 401),
    });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.status).toBe(401);
    expect(e.penpot).toEqual({ type: 'authentication', code: 'authentication-required', hint: 'bad header: Token <redacted>' });
    expect(e.message).toContain('code=authentication-required');
  });

  it('decodes transit error bodies too', async () => {
    mockPenpot({
      'import-binfile': () =>
        new Response('["^ ","~:type","~:authorization","~:code","~:not-allowed","~:hint","no edit permission"]', {
          status: 403,
          headers: { 'content-type': 'application/transit+json' },
        }),
    });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e).toMatchObject({ status: 403, penpot: { type: 'authorization', code: 'not-allowed', hint: 'no edit permission' } });
  });

  it('turns an SSE error event into PenpotUploadError', async () => {
    mockPenpot({
      'import-binfile': (_c, signal) =>
        sse('event: progress\ndata: {"~:section":"~:manifest"}\n\nevent: error\ndata: {"~:type":"~:server-error","~:code":"~:io-exception"}\n\n', signal),
    });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.penpot).toEqual({ type: 'server-error', code: 'io-exception' });
    expect(e.message).toMatch(/rejected the file/);
  });

  it('fails when the stream ends without an end event', async () => {
    mockPenpot({ 'import-binfile': (_c, signal) => sse('event: progress\ndata: {}\n\n', signal) });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.message).toMatch(/ended before the import finished; no file with this upload's pages appeared in the project within 0 s \(looked for files named "frame"\)/);
    // Looked for (the mock project stays empty): not found.
    expect(e.importMayHaveCompleted).toBe(false);
  });

  it('maps 413 to a size hint', async () => {
    mockPenpot({ 'import-binfile': () => new Response('<html>413 Request Entity Too Large</html>', { status: 413, headers: { 'content-type': 'text/html' } }) });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.status).toBe(413);
    expect(e.message).toMatch(/larger than this Penpot instance accepts/);
  });

  it('times out while the import stream stalls', async () => {
    mockPenpot({ 'import-binfile': (_c, signal) => sse('event: progress\ndata: {}\n\n', signal, { hang: true }) });
    const e = await failure(uploadToPenpot(BYTES, options({ timeoutMs: 100 })));
    expect(e.message).toMatch(/import-binfile: timed out/);
    expect(e.importMayHaveCompleted).toBe(false);
  });

  it('times out when Penpot does not answer at all', async () => {
    mockPenpot({
      'get-profile': (_c, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
    });
    const e = await failure(uploadToPenpot(BYTES, options({ timeoutMs: 100 })));
    expect(e.message).toMatch(/get-profile: timed out/);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    mockPenpot({
      'import-binfile': (_c, signal) => {
        setTimeout(() => controller.abort(), 10);
        return sse('event: progress\ndata: {}\n\n', signal, { hang: true });
      },
    });
    const e = await failure(uploadToPenpot(BYTES, options({ signal: controller.signal })));
    expect(e.message).toMatch(/aborted/);
    // An abort before Penpot's verdict leaves the outcome open; the project is not polled after an abort.
    expect(e.importMayHaveCompleted).toBe(true);
    expect(e.projectUrl).toBe(`${BASE}/?screen=dashboard-files&team-id=${TEAM}&project-id=${DRAFTS}`);
  });

  it('reports network failures without the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED (${TOKEN})`), { code: 'ECONNREFUSED' }) });
      }),
    );
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.message).toBe(`get-profile: could not reach Penpot at ${BASE} (ECONNREFUSED)`);
  });

  it('normalises the base URL (sub-path, trailing slashes) for API calls and links', async () => {
    const { calls } = mockPenpot();
    const result = await uploadToPenpot(BYTES, options({ baseUrl: 'https://example.com/design/penpot///' }));
    expect(calls.find((c) => c.command === 'get-profile')?.url).toBe('https://example.com/design/penpot/api/rpc/command/get-profile');
    expect(calls.find((c) => c.command === 'version.txt')?.url).toBe('https://example.com/design/penpot/version.txt');
    expect(result.url.startsWith('https://example.com/design/penpot/?screen=workspace&team-id=')).toBe(true);
  });

  it('defaults to Penpot cloud', async () => {
    const { calls } = mockPenpot();
    const { baseUrl: _omit, ...rest } = options();
    await uploadToPenpot(BYTES, rest);
    expect(calls[0]?.url.startsWith('https://design.penpot.app/')).toBe(true);
  });

  it('uses the legacy hash route for Penpot older than 2.19, the query route when the version is unknown', async () => {
    mockPenpot({ 'version.txt': () => new Response('2.18.3') });
    expect((await uploadToPenpot(BYTES, options())).url).toBe(`${BASE}/#/workspace?team-id=${TEAM}&file-id=${FILE}&page-id=${PAGES[0]}`);
    mockPenpot({ 'version.txt': () => new Response('not found', { status: 404 }) });
    expect((await uploadToPenpot(BYTES, options())).url).toBe(`${BASE}/?screen=workspace&team-id=${TEAM}&file-id=${FILE}&page-id=${PAGES[0]}`);
    mockPenpot({ 'version.txt': () => new Response('2.20.0-RC1') });
    expect((await uploadToPenpot(BYTES, options())).url).toContain('/?screen=workspace&');
  });

  it('renames the file when Penpot kept the name stored in the binfile', async () => {
    const { calls } = mockPenpot();
    const result = await uploadToPenpot(BYTES, options({ name: 'My design' }));
    expect(calls.find((c) => c.command === 'rename-file')?.body).toEqual({ id: FILE, name: 'My design' });
    expect(result.name).toBe('My design');
  });

  it('fetches page names with get-page when the file does not inline them, and says the file exists if reading back fails', async () => {
    const { calls } = mockPenpot({
      'get-file': () => json(fileBody({ data: { pages: [PAGES[0]], pagesIndex: {} } })),
      'get-page': () => json({ id: PAGES[0], name: 'Loaded' }),
    });
    const result = await uploadToPenpot(BYTES, options());
    expect(calls.find((c) => c.command === 'get-page')?.body).toEqual({ fileId: FILE, pageId: PAGES[0] });
    expect(result.pages).toEqual([{ id: PAGES[0], name: 'Loaded', url: result.url }]);

    mockPenpot({ 'get-file': () => json({ type: 'internal', code: 'boom' }, 500) });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.message).toContain(`imported (id ${FILE})`);
    // Callers can tell that the file exists (and must not be uploaded again).
    expect(e).toMatchObject({ fileId: FILE, teamId: TEAM, projectId: DRAFTS, url: `${BASE}/?screen=workspace&team-id=${TEAM}&file-id=${FILE}` });
  });

  it('leaves fileId unset when nothing was imported', async () => {
    mockPenpot({ 'import-binfile': () => json({ type: 'validation', code: 'invalid-file' }, 400) });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.fileId).toBeUndefined();
    expect(e.importMayHaveCompleted).toBeUndefined();
  });

  it('rejects tokens that cannot be sent in a header, before calling Penpot', async () => {
    const { calls } = mockPenpot();
    await expect(uploadToPenpot(BYTES, options({ accessToken: 'abc\ndef-123456' }))).rejects.toThrow(/line breaks|non-ASCII/);
    await expect(uploadToPenpot(BYTES, options({ accessToken: 'tökén-123456' }))).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('does not redact implausibly short tokens out of unrelated text', async () => {
    mockPenpot({ 'get-profile': () => json({ type: 'authentication', code: 'token-expired', hint: 'expired' }, 401) });
    const e = await uploadToPenpot(BYTES, options({ accessToken: 'e' })).then(
      () => expect.unreachable('the upload should fail'),
      (x: unknown) => x as PenpotUploadError,
    );
    expect(e.message).toContain('code=token-expired');
    expect(e.penpot?.hint).toBe('expired');
  });

  it('rejects invalid options without calling Penpot', async () => {
    const { calls } = mockPenpot();
    await expect(uploadToPenpot(BYTES, options({ accessToken: '  ' }))).rejects.toThrow(TypeError);
    await expect(uploadToPenpot(BYTES, options({ projectId: 'drafts' }))).rejects.toThrow(/not a UUID/);
    await expect(uploadToPenpot(BYTES, options({ baseUrl: 'ftp://x' }))).rejects.toThrow(/http/);
    expect(calls).toHaveLength(0);
  });
});

/** A small `.penpot`-like zip whose manifest names the file `stored`. */
function penpotZip(stored: string, level: 0 | 6 = 6, comment?: string, shapes: Record<string, readonly string[]> = SHAPES): Uint8Array {
  const manifest = strToU8(JSON.stringify({ type: 'penpot/export-files', version: 1, files: [{ id: FILE, name: stored }] }));
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = { 'files/x.json': [strToU8('{"big":"' + 'x'.repeat(5000) + '"}'), { level }], 'manifest.json': [manifest, { level }] };
  // The layout of a real export: one entry per page and per shape (`readPenpotContent`).
  for (const [page, ids] of Object.entries(shapes)) {
    entries[`files/${FILE}/pages/${page}.json`] = [strToU8('{}'), { level }];
    for (const id of ids) entries[`files/${FILE}/pages/${page}/${id}.json`] = [strToU8('{}'), { level }];
  }
  const zip = zipSync(entries);
  if (comment === undefined) return zip;
  // Append a zip comment (the EOCD's last field is its length).
  const c = strToU8(comment);
  const out = new Uint8Array(zip.length + c.length);
  out.set(zip);
  out.set(c, zip.length);
  new DataView(out.buffer).setUint16(zip.length - 2, c.length, true);
  return out;
}

const dropped = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: progress\ndata: {}\n\n'));
        controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const projectFile = (name: string, createdAt: unknown, id = FILE) => ({ id, name, projectId: DRAFTS, teamId: TEAM, createdAt, modifiedAt: createdAt });

/** get-project-files answering `before` until the import was sent, then `after`. */
const projectFiles =
  (before: unknown[] | Response, after: unknown[] | (() => Response)): Handler =>
  (c) =>
    c.imports === 0 ? (before instanceof Response ? before : json(before)) : typeof after === 'function' ? after() : json(after);
const OLDER = 'aaaaaaaa-0000-4000-8000-0000000000aa';

describe('uploadToPenpot when the import outcome is unknown', () => {
  const STORED = 'Name stored in the file';
  const zip = penpotZip(STORED);
  const now = () => new Date().toISOString();
  const old = new Date(Date.now() - 3_600_000).toISOString();

  it('finds the new file the dropped import created (by the name stored in the .penpot) and returns it', async () => {
    // An upload of the same file a moment earlier is in the project already: not mistaken for this one.
    const earlier = projectFile(STORED, now(), OLDER);
    const { calls } = mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([earlier], [earlier, projectFile('unrelated', now(), 'aaaaaaaa-0000-4000-8000-0000000000bb'), projectFile(STORED, now())]),
      'get-file': () => json(fileBody({ name: STORED })),
    });
    const result = await uploadToPenpot(zip, options({ name: 'Wanted name' }));
    expect(result.fileId).toBe(FILE);
    expect(result.recovered).toMatch(/import-binfile: the connection to Penpot at https:\/\/penpot\.example failed \(UND_ERR_SOCKET\)/);
    for (const c of calls.filter((c) => c.command === 'get-project-files')) expect(c.body).toEqual({ projectId: DRAFTS });
    // Then handled like any import: renamed to the wanted name.
    expect(calls.find((c) => c.command === 'rename-file')?.body).toEqual({ id: FILE, name: 'Wanted name' });
    expect(result.name).toBe('Wanted name');
  });

  it('without a list from before the import, goes by creation time: the wanted name, transit timestamps, older files ignored', async () => {
    mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles(json({ type: 'internal' }, 500), () =>
        new Response(
          `[["^ ","~:id","~u${OLDER}","~:name","frame","~:created-at","~m${Date.parse(old)}"],["^ ","~:id","~u${FILE}","~:name","frame","~:created-at","~m${Date.now()}"]]`,
          { headers: { 'content-type': 'application/transit+json' } },
        ),
      ),
    });
    expect(await uploadToPenpot(penpotZip('frame'), options())).toMatchObject({ fileId: FILE, recovered: expect.any(String) });
  });

  it('says when no such file appeared, after polling over the grace period', async () => {
    const { calls } = mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([projectFile(STORED, old, OLDER)], [projectFile(STORED, old, OLDER), projectFile('other', now())]),
    });
    const e = await failure(uploadToPenpot(zip, options({ verifyGraceMs: 60 })));
    expect(e.importMayHaveCompleted).toBe(false);
    expect(e.message).toMatch(/no file with this upload's pages appeared in the project within 0 s \(looked for files named "Name stored in the file" or "frame"\), so it was most likely not imported/);
    expect(e.projectUrl).toBe(`${BASE}/?screen=dashboard-files&team-id=${TEAM}&project-id=${DRAFTS}`);
    expect(e.fileId).toBeUndefined();
    expect(calls.filter((c) => c.command === 'get-project-files' && c.imports > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('cannot tell when the check fails, when several files match, or when Penpot gives no creation times', async () => {
    mockPenpot({ 'import-binfile': () => dropped(), 'get-project-files': projectFiles([], () => json({ type: 'internal' }, 500)) });
    let e = await failure(uploadToPenpot(zip, options({ verifyGraceMs: 30 })));
    expect(e.importMayHaveCompleted).toBe(true);
    expect(e.message).toMatch(/checking the project for the file failed as well \(Penpot get-project-files failed \(HTTP 500/);
    expect(e.projectUrl).toContain(`project-id=${DRAFTS}`);

    mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([], [projectFile(STORED, now()), projectFile('frame', now(), 'aaaaaaaa-0000-4000-8000-0000000000cc')]),
    });
    e = await failure(uploadToPenpot(zip, options()));
    expect(e.importMayHaveCompleted).toBe(true);
    expect(e.message).toMatch(/2 new files named .* that may hold this upload's content .* one of them may be this upload/);

    mockPenpot({ 'import-binfile': () => dropped(), 'get-project-files': projectFiles(json({}, 500), [{ id: FILE, name: 'frame' }]) });
    e = await failure(uploadToPenpot(zip, options()));
    expect(e.importMayHaveCompleted).toBe(true);
    expect(e.message).toMatch(/did not say when/);
  });

  it('never adopts the file of a concurrent upload that shares the stored name: only one with this upload\'s pages and shapes', async () => {
    // Fault injection: this upload's request is dropped before it reaches Penpot, while another upload of a
    // different design, also stored as "Untitled", lands in the project (and is renamed by its own upload later).
    const theirs = { [PAGES[0]]: [ROOT, 'dddddddd-0000-4000-8000-000000000001'] };
    const { calls } = mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([], [projectFile('Untitled', now())]),
      'get-file': () => json(fileBody({ name: 'Untitled', data: { pages: [PAGES[0]], pagesIndex: { [PAGES[0]]: { id: PAGES[0], name: 'Page 1', objects: objects(PAGES[0], theirs) } } } })),
    });
    let e = await failure(uploadToPenpot(penpotZip('Untitled'), options({ name: 'Mine', verifyGraceMs: 40 })));
    expect(e.importMayHaveCompleted).toBe(false);
    expect(e.message).toMatch(/no file with this upload's pages appeared .* \(1 new file named "Untitled" or "Mine" did, with other content: aaaaaaaa-0000-4000-8000-000000000006\)/);
    expect(e.fileId).toBeUndefined();
    // The other upload's file is left alone.
    expect(calls.some((c) => c.command === 'rename-file')).toBe(false);

    // The same pages but other shapes on one of them: not this upload either.
    mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([], [projectFile('Untitled', now())]),
      'get-file': () => json(fileBody({ name: 'Untitled' }, { ...SHAPES, [PAGES[1]]: [ROOT] })),
    });
    e = await failure(uploadToPenpot(penpotZip('Untitled'), options({ name: 'Mine' })));
    expect(e.importMayHaveCompleted).toBe(false);

    // Two concurrent uploads of the same content: the file cannot be told apart from the other upload's.
    mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([], [projectFile('Untitled', now()), projectFile('Untitled', now(), 'aaaaaaaa-0000-4000-8000-0000000000dd')]),
      'get-file': () => json(fileBody({ name: 'Untitled' })),
    });
    e = await failure(uploadToPenpot(penpotZip('Untitled'), options({ name: 'Mine' })));
    expect(e.importMayHaveCompleted).toBe(true);
    expect(e.message).toMatch(/2 new files named "Untitled" or "Mine" that may hold this upload's content/);

    // Pages that are not inline are read with get-page; this upload's content there: adopted.
    const recovered = mockPenpot({
      'import-binfile': () => dropped(),
      'get-project-files': projectFiles([], [projectFile('Untitled', now())]),
      'get-file': () => json(fileBody({ name: 'Untitled', data: { pages: [PAGES[0], PAGES[1]], pagesIndex: {} } })),
      'get-page': (c) => json({ id: (c.body as { pageId: string }).pageId, objects: objects((c.body as { pageId: string }).pageId) }),
    });
    expect(await uploadToPenpot(penpotZip('Untitled'), options({ name: 'Mine' }))).toMatchObject({ fileId: FILE, recovered: expect.any(String) });
    expect(recovered.calls.filter((c) => c.command === 'get-page').length).toBeGreaterThanOrEqual(2);
  });

  it('does not adopt a file by its name alone when this upload\'s pages cannot be read (not a .penpot zip)', async () => {
    const { calls } = mockPenpot({ 'import-binfile': () => dropped(), 'get-project-files': projectFiles([], [projectFile('frame', now())]) });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.importMayHaveCompleted).toBe(true);
    expect(e.message).toMatch(/a new file named "frame" appeared in the project \(aaaaaaaa-0000-4000-8000-000000000006\), but fig2pot could not read this upload's pages/);
    expect(calls.some((c) => c.command === 'rename-file')).toBe(false);
  });

  it('checks after a time-out (with a fresh deadline) and after a gateway time-out', async () => {
    mockPenpot({
      'import-binfile': (_c, signal) => sse('event: progress\ndata: {}\n\n', signal, { hang: true }),
      'get-project-files': projectFiles([], [projectFile('frame', now())]),
    });
    expect((await uploadToPenpot(penpotZip('frame'), options({ timeoutMs: 100 }))).recovered).toMatch(/timed out/);

    mockPenpot({ 'import-binfile': () => new Response('<html>504</html>', { status: 504 }), 'get-project-files': projectFiles([], [projectFile('frame', now())]) });
    expect((await uploadToPenpot(penpotZip('frame'), options())).recovered).toMatch(/HTTP 504/);
  });

  it('does not look when Penpot gave a verdict or nothing was sent', async () => {
    const cases: Record<string, Handler> = {
      'HTTP 400': () => json({ type: 'validation', code: 'invalid-file' }, 400),
      'error event': (_c, signal) => sse('event: error\ndata: {"~:type":"~:validation"}\n\n', signal),
      'connection refused': () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      },
      'cross-origin redirect': () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/api/rpc/command/import-binfile' } }),
    };
    for (const [what, handler] of Object.entries(cases)) {
      const { calls } = mockPenpot({ 'import-binfile': handler, 'get-project-files': projectFiles([], [projectFile('frame', now())]) });
      const e = await failure(uploadToPenpot(BYTES, options()));
      expect(e.importMayHaveCompleted, what).toBeUndefined();
      expect(calls.some((c) => c.command === 'get-project-files' && c.imports > 0), what).toBe(false);
    }
  });
});

describe('uploadToPenpot redirects', () => {
  const redirect = (status: number, location: string): Response => new Response(null, { status, headers: { location } });

  it('fails on a cross-origin redirect of get-profile, naming the new origin, without following it', async () => {
    const { calls } = mockPenpot({ 'get-profile': () => redirect(307, 'https://new-host.example/penpot/api/rpc/command/get-profile') });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.status).toBe(307);
    expect(e.message).toMatch(/redirects \(HTTP 307\) to another origin, https:\/\/new-host\.example/);
    expect(e.message).toContain('set PENPOT_URL (or --penpot-url) to https://new-host.example/penpot');
    expect(e.message).not.toMatch(/access token was|did not accept/);
    expect(calls.some((c) => c.url.includes('new-host'))).toBe(false);
  });

  it('treats an http → https upgrade as another origin and suggests the https URL', async () => {
    const { calls } = mockPenpot({
      'get-profile': (c) => redirect(301, c.url.replace('http:', 'https:')),
    });
    const e = await failure(uploadToPenpot(BYTES, options({ baseUrl: 'http://penpot.example' })));
    expect(e.message).toContain('another origin, https://penpot.example;');
    expect(e.message).toContain('set PENPOT_URL (or --penpot-url) to https://penpot.example');
    expect(calls.some((c) => c.url.startsWith('https:'))).toBe(false);
  });

  it('never replays the file or the token to another origin on import-binfile', async () => {
    const { calls } = mockPenpot({ 'import-binfile': () => redirect(307, 'https://evil.example/upload') });
    const e = await failure(uploadToPenpot(BYTES, options()));
    expect(e.message).toContain('another origin, https://evil.example;');
    expect(calls.filter((c) => c.command === 'import-binfile')).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('follows same-origin redirects with the same method, body and token, a bounded number of times', async () => {
    const { calls } = mockPenpot({
      'get-profile': (c) =>
        c.url.includes('/v2/')
          ? json({ id: PROFILE, defaultTeamId: TEAM, defaultProjectId: DRAFTS })
          : redirect(308, '/v2/api/rpc/command/get-profile'),
      'import-binfile': (c, signal) => (c.url.includes('/v2/') ? sse(IMPORT_OK, signal) : redirect(307, `${BASE}/v2/api/rpc/command/import-binfile`)),
    });
    await uploadToPenpot(BYTES, options());
    const imports = calls.filter((c) => c.command === 'import-binfile');
    expect(imports.map((c) => c.url)).toEqual([`${BASE}/api/rpc/command/import-binfile`, `${BASE}/v2/api/rpc/command/import-binfile`]);
    for (const c of imports) {
      expect(c.headers.get('authorization')).toBe(`Token ${TOKEN}`);
      expect(new Uint8Array(await ((c.body as Record<string, Blob>).file as Blob).arrayBuffer())).toEqual(BYTES);
    }

    mockPenpot({ 'get-profile': (c) => redirect(302, c.url) });
    expect((await failure(uploadToPenpot(BYTES, options()))).message).toMatch(/too many redirects/);
  });
});

describe('uploadToPenpot against a local server (streamed upload)', () => {
  /** A fake Penpot on node:http; `routes` answer by path (after the body was read, unless they take over). */
  async function serve(routes: (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean, onServer?: (server: Server) => void): Promise<{ base: string; close: () => Promise<void>; log: string[] }> {
    const log: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        log.push(`${req.method} ${req.url} ${Buffer.concat(chunks).length}`);
        if (routes(req, res, Buffer.concat(chunks))) return;
        const command = req.url!.split('/').pop();
        const send = (body: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (req.url!.endsWith('/version.txt')) return void res.end('2.19.0');
        if (command === 'get-profile') return send({ id: PROFILE, defaultTeamId: TEAM, defaultProjectId: DRAFTS });
        if (command === 'get-project-files') return send([]);
        if (command === 'import-binfile') return void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: end\ndata: {"~:file-ids":["~u${FILE}"]}\n\n`);
        if (command === 'get-file') return send(fileBody());
        res.writeHead(404).end();
      });
    });
    onServer?.(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
      base,
      log,
      close: async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  it('gets a 413 that the server sends before the body and then closes the connection on (never sending the file)', async () => {
    const big = new Uint8Array(32 << 20);
    let received = 0;
    const penpot = await serve(
      () => false,
      (server) =>
        // Like nginx with a too-large Content-Length: answers `Expect: 100-continue` with 413 and closes.
        server.on('checkContinue', (req, res) => {
          if (!req.url!.includes('import-binfile')) {
            res.writeContinue();
            return void server.emit('request', req, res);
          }
          req.on('data', (c: Buffer) => (received += c.length));
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end('{"type":"validation","code":"too-large"}', () => req.socket.destroy());
        }),
    );
    try {
      const started = Date.now();
      const e = await failure(uploadToPenpot(big, { baseUrl: penpot.base, accessToken: TOKEN, name: 'x', verifyGraceMs: 5_000 }));
      expect(e.status).toBe(413);
      expect(e.message).toMatch(/HTTP 413: type=validation code=too-large\) — the file is larger than this Penpot instance accepts/);
      expect(e.importMayHaveCompleted).toBeUndefined();
      expect(received).toBe(0);
      // Penpot's verdict: no polling of the project.
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await penpot.close();
    }
  });

  it('streams the body after 100 Continue, and anyway after a second when the server ignores Expect', async () => {
    for (const ignoresExpect of [false, true]) {
      const penpot = await serve(
        () => false,
        (server) => {
          // Node answers `Expect` itself unless told otherwise; a server that ignores it just waits for the body.
          if (ignoresExpect) server.on('checkContinue', (req, res) => server.emit('request', req, res));
        },
      );
      try {
        const result = await uploadToPenpot(new Uint8Array(1000).fill(7), { baseUrl: penpot.base, accessToken: TOKEN, name: 'frame' });
        expect(result.fileId).toBe(FILE);
        expect(penpot.log.find((l) => l.includes('import-binfile'))).toMatch(/ \d{4}$/);
      } finally {
        await penpot.close();
      }
    }
  });

  it('uploads to the base URL that version.txt was redirected to (same origin), and follows at most one redirect of the upload', async () => {
    const penpot = await serve((req, res) => {
      const url = req.url!;
      if (url === '/version.txt') return void res.writeHead(301, { location: '/penpot/version.txt' }).end(), true;
      if (url.startsWith('/penpot/')) {
        req.url = url.slice('/penpot'.length);
        return false;
      }
      // Calls to the old base move too (get-profile ran before version.txt said where Penpot is).
      return void res.writeHead(302, { location: `/penpot${url}` }).end(), true;
    });
    try {
      const result = await uploadToPenpot(new Uint8Array(4096).fill(1), { baseUrl: penpot.base, accessToken: TOKEN, name: 'frame' });
      expect(result.url.startsWith(`${penpot.base}/penpot/?screen=workspace`)).toBe(true);
      // The file went once, straight to where Penpot is.
      expect(penpot.log.filter((l) => l.includes('import-binfile'))).toEqual([expect.stringMatching(/^POST \/penpot\/api\/rpc\/command\/import-binfile \d+$/)]);
    } finally {
      await penpot.close();
    }

    const looping = await serve((req, res) => {
      if (!req.url!.includes('import-binfile')) return false;
      return void res.writeHead(303, { location: `${req.url}?again` }).end(), true;
    });
    try {
      const e = await failure(uploadToPenpot(new Uint8Array(4096), { baseUrl: looping.base, accessToken: TOKEN, name: 'frame' }));
      expect(e.message).toMatch(/import-binfile: too many redirects/);
      expect(looping.log.filter((l) => l.includes('import-binfile'))).toHaveLength(2);
    } finally {
      await looping.close();
    }
  });
});

describe('proxyFor', () => {
  it('picks the variable for the scheme and honours NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://u:p@proxy.example:3128', http_proxy: 'plain.example:8080', NO_PROXY: 'internal.example, .corp:8443' };
    expect(proxyFor('https://penpot.example', env)?.href).toBe('http://u:p@proxy.example:3128/');
    expect(proxyFor('https://penpot.example', env)?.variable).toBe('HTTPS_PROXY');
    expect(proxyFor('http://penpot.example', env)?.host).toBe('plain.example:8080');
    expect(proxyFor('https://internal.example', env)).toBeUndefined();
    expect(proxyFor('https://a.internal.example', env)).toBeUndefined();
    expect(proxyFor('https://x.corp:8443', env)).toBeUndefined();
    expect(proxyFor('https://x.corp', env)).toBeDefined();
    expect(proxyFor('https://penpot.example', { ...env, no_proxy: '*' })).toBeUndefined();
    expect(proxyFor('https://penpot.example', {})).toBeUndefined();
  });
});

describe('uploadToPenpot with a Blob', () => {
  it('sends the Blob as the file (typed as a zip)', async () => {
    const { calls } = mockPenpot();
    await uploadToPenpot(new Blob([BYTES]), options());
    const file = (calls.find((c) => c.command === 'import-binfile')!.body as Record<string, Blob>).file as Blob;
    expect(file.type).toBe('application/zip');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
  });
});

describe('readPenpotManifest', () => {
  it('reads the stored name from stored and deflated zips, with or without a zip comment', async () => {
    expect(await readPenpotManifest(penpotZip('Stored', 0))).toEqual({ name: 'Stored' });
    expect(await readPenpotManifest(penpotZip('Déflaté 🙂', 6))).toEqual({ name: 'Déflaté 🙂' });
    expect(await readPenpotManifest(new Blob([penpotZip('In a blob', 6, 'a comment') as Uint8Array<ArrayBuffer>]))).toEqual({ name: 'In a blob' });
  });

  it('is undefined for anything but a zip with a manifest', async () => {
    expect(await readPenpotManifest(BYTES)).toBeUndefined();
    expect(await readPenpotManifest(strToU8('fig-kiwi' + 'x'.repeat(100)))).toBeUndefined();
    expect(await readPenpotManifest(zipSync({ 'other.json': strToU8('{}') }))).toBeUndefined();
    expect(await readPenpotManifest(zipSync({ 'manifest.json': strToU8('not json') }))).toEqual({ name: undefined });
  });

  it('reads only a few KiB of a large file', async () => {
    const big = zipSync({ 'manifest.json': strToU8('{"files":[{"name":"Big"}]}'), 'blob.bin': [new Uint8Array(8 << 20), { level: 0 }] });
    let read = 0;
    class SpyBlob extends Blob {
      override slice(start?: number, end?: number, type?: string): Blob {
        read += (end ?? this.size) - (start ?? 0);
        return super.slice(start, end, type);
      }
    }
    expect(await readPenpotManifest(new SpyBlob([big as Uint8Array<ArrayBuffer>]))).toEqual({ name: 'Big' });
    expect(read).toBeLessThan(80 * 1024);
  });
});

describe('normalizePenpotUrl', () => {
  it.each([
    ['https://design.penpot.app', 'https://design.penpot.app'],
    ['https://design.penpot.app/', 'https://design.penpot.app'],
    ['  http://localhost:9001//  ', 'http://localhost:9001'],
    ['https://example.com/penpot/', 'https://example.com/penpot'],
    ['https://design.penpot.app/#/dashboard/recent?team-id=x', 'https://design.penpot.app'],
    ['https://example.com/penpot/?screen=dashboard-recent', 'https://example.com/penpot'],
    // Bare host[:port]: https, except for the local machine.
    ['localhost:9001', 'http://localhost:9001'],
    ['127.0.0.1:9001/penpot/', 'http://127.0.0.1:9001/penpot'],
    ['penpot.example.com', 'https://penpot.example.com'],
    ['penpot.example.com:8443', 'https://penpot.example.com:8443'],
    // Query and fragment are ignored for a bare host just as for a full URL.
    ['localhost:9001?x=1', 'http://localhost:9001'],
    ['penpot.example.com/p/?a=b#c', 'https://penpot.example.com/p'],
    ['localhost#x', 'http://localhost'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePenpotUrl(input)).toBe(expected);
  });

  it('rejects non-http URLs and embedded credentials without echoing them', () => {
    expect(() => normalizePenpotUrl('not a url')).toThrow(TypeError);
    expect(() => normalizePenpotUrl('file:///tmp')).toThrow(/http/);
    expect(() => normalizePenpotUrl('https://me:hunter2@penpot.example')).toThrow(/credentials/);
    try {
      normalizePenpotUrl('https://me:hunter2@penpot.example');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });

  it.each([
    'https://jdoe:SECRETPW@ho st',
    'jdoe:SECRETPW@penpot.example:9001',
    'https://jdoe:SECRETPW@penpot.example',
    'https://SECRETPW@penpot.example/p',
    'http://a:b@c:SECRETPW@penpot.example',
    'https://bad host/?token=SECRETPW',
    'https://penpot.example:99999/#SECRETPW',
    // A password with "/", "#" or "?" (as typed, unencoded): parsed as host + path, or not at all.
    'https://jdoe:pa/SECRETPW@penpot.example',
    'https://jdoe:1234/SECRETPW@penpot.example',
    'https://jdoe:1#SECRETPW@penpot.example',
    'https://jdoe:SECRETPW?x@penpot.example',
    'jdoe:pa/SECRETPW@penpot.example',
  ])('never echoes credentials, queries or fragments: %s', (input) => {
    let message = '';
    try {
      normalizePenpotUrl(input);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('SECRETPW');
    expect(message).not.toContain('jdoe');
  });

  it('says what is wrong with a non-http scheme', () => {
    expect(() => normalizePenpotUrl('javascript:alert(1)')).toThrow('invalid Penpot URL (expected http:// or https://, got javascript:)');
  });
});

describe('redactUrl', () => {
  it('drops user info, query and fragment', () => {
    expect(redactUrl('http://u:p@proxy.example:3128/x?y#z')).toBe('http://proxy.example:3128/x');
    expect(redactUrl('u:p@host')).toBe('host');
    // Everything up to the last "@" goes, wherever it is: a password may hold "/", "?" or "#".
    expect(redactUrl('https://host/?next=https://u:p@e')).toBe('https://e');
    expect(redactUrl('https://user:pa/ssw0rd@host')).toBe('https://host');
    expect(redactUrl('https://user:pa#ss?w@rd@host:3128/x')).toBe('https://host:3128/x');
    expect(redactUrl('http://proxy.example:3128')).toBe('http://proxy.example:3128');
  });
});

describe('readSse', () => {
  const events = async (chunks: string[]) => {
    const enc = new TextEncoder();
    const res = new Response(streamed(chunks.map((c) => enc.encode(c)), undefined));
    const out = [];
    for await (const e of readSse(res)) out.push(e);
    return out;
  };

  it('handles LF, CR and CRLF endings, multi-line data, comments and a missing final blank line', async () => {
    expect(await events(['event: a\rdata: 1\r', '\rdata: x\ndata: y\n\n:c\n', 'event: b\r\n', 'data:z'])).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: 'x\ny' },
      { event: 'b', data: 'z' },
    ]);
  });

  it('does not split an event at a CR that is the first half of a CRLF', async () => {
    expect(await events(['data: 1\r', '\n\r', '\ndata: 2\r\n\r\n'])).toEqual([
      { event: 'message', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });
});

describe('decodeTransit', () => {
  it('decodes verbose and compact maps, keywords, uuids, sets and cached keys', () => {
    expect(decodeTransit('{"~:file-ids":["~uabc"],"~:resolution":{}}')).toEqual({ 'file-ids': ['abc'], resolution: {} });
    expect(decodeTransit('{"~#set":["~ux"]}')).toEqual(['x']);
    expect(decodeTransit('[["^ ","~:code","~:a"],["^ ","^0","~:b"]]')).toEqual([{ code: 'a' }, { code: 'b' }]);
    expect(decodeTransit('["~#set",["~:k","~~tilde"]]')).toEqual(['k', '~tilde']);
  });
});
