/**
 * The CLI's upload failure handling (U1–U3), against a local fake Penpot.
 */
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPenpotContent, type PenpotContent } from '../../src/penpot/upload.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const FIG = fileURLToPath(new URL('../fixtures/grida-blank.fig', import.meta.url));
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000002';
const DRAFTS = 'aaaaaaaa-0000-4000-8000-000000000003';
const FILE = 'aaaaaaaa-0000-4000-8000-000000000006';

const PAGE = 'bbbbbbbb-0000-4000-8000-000000000001';
const TOKEN = 'tok_0123456789';

/**
 * What the fake Penpot does on import-binfile / get-file / get-project-files. `drop-*`: the
 * connection drops during the import; the project then has the file (`found`) or files without
 * creation times (`undated`: the outcome cannot be determined).
 */
let mode: 'read-back-fails' | 'import-fails' | 'ok' | 'drop-found' | 'drop-undated' = 'read-back-fails';
let server: Server;
let port = 0;
/** Whether the fake Penpot received an import request (the project lists the file only after that). */
let imported = false;
/** Pages and shapes of the last uploaded file. */
let uploaded: PenpotContent | undefined;
/** A forwarding proxy (CONNECT tunnels, which Node's fetch uses for every proxied request). */
let proxy: Server;
let proxyPort = 0;
let proxyHits = 0;
let proxied: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const command = req.url?.split('/').pop();
      if (req.url === '/version.txt') return void res.end('2.19.0');
      if (command === 'get-profile') return json(200, { id: 'aaaaaaaa-0000-4000-8000-000000000001', defaultTeamId: TEAM, defaultProjectId: DRAFTS });
      if (command === 'import-binfile') {
        imported = true;
        // The `.penpot` in the multipart body: what Penpot would hold after importing it (page and shape ids).
        const body = Buffer.concat(chunks);
        uploaded = await readPenpotContent(new Uint8Array(body.subarray(body.indexOf('PK\x03\x04'), body.lastIndexOf('\r\n--'))));
        if (mode === 'import-fails') return json(400, { type: 'validation', code: 'invalid-file' });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode.startsWith('drop')) {
          res.write('event: progress\ndata: {}\n\n');
          return void setTimeout(() => req.socket.destroy(), 20);
        }
        return void res.end(`event: end\ndata: {"~:file-ids":["~u${FILE}"]}\n\n`);
      }
      if (command === 'get-project-files') {
        if (!imported) return mode === 'drop-undated' ? json(500, { type: 'internal' }) : json(200, []);
        const createdAt = mode === 'drop-undated' ? undefined : new Date().toISOString();
        return json(200, [{ id: FILE, name: 'Wanted', projectId: DRAFTS, createdAt }]);
      }
      if (command === 'get-file') {
        if (mode === 'read-back-fails') return json(500, { type: 'internal', code: 'boom' });
        if (mode === 'drop-found' && uploaded) {
          const ids = [...uploaded.pages.keys()];
          const index = Object.fromEntries(ids.map((id) => [id, { name: 'Page 1', objects: Object.fromEntries([...uploaded!.pages.get(id)!].map((s) => [s, {}])) }]));
          return json(200, { id: FILE, name: 'Wanted', teamId: TEAM, projectId: DRAFTS, data: { pages: ids, pagesIndex: index } });
        }
        return json(200, { id: FILE, name: 'Wanted', teamId: TEAM, projectId: DRAFTS, data: { pages: [PAGE], pagesIndex: { [PAGE]: { name: 'Page 1' } } } });
      }
      json(404, { type: 'not-found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  proxy = createServer((req, res) => {
    // Absolute-form forwarding: node:http's proxy support (the streamed import) uses it for http:// targets.
    proxyHits++;
    proxied.push(req.url!);
    const url = new URL(req.url!);
    req.pipe(request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      r.pipe(res);
    }));
  });
  proxy.on('connect', (req: IncomingMessage, socket, head) => {
    proxyHits++;
    const [host, p] = req.url!.split(':');
    const upstream = connect(Number(p), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as { port: number }).port;
});

afterAll(async () => {
  proxy.closeAllConnections();
  server.closeAllConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => proxy.close(resolve))]);
});

/** No proxy unless a test sets one; the parent's settings must not leak in. */
const NO_PROXY_ENV = { HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '' };

function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, PENPOT_URL: '', PENPOT_PROJECT_ID: '', ...NO_PROXY_ENV, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

function workdir(): { dir: string; input: string; penpot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fig2pot-cli-'));
  const input = join(dir, 'design.fig');
  copyFileSync(FIG, input);
  // Elsewhere: the tests list `dir` to check what the CLI wrote there.
  const penpot = join(mkdtempSync(join(tmpdir(), 'fig2pot-cli-')), 'ready.penpot');
  writeFileSync(penpot, zipSync({ 'manifest.json': strToU8(JSON.stringify({ files: [{ id: FILE, name: 'Wanted' }] })) }));
  return { dir, input, penpot };
}

/** Asserts a successful upload's stdout: exactly one line, the workspace URL. */
function expectUrlLine(stdout: string): void {
  expect(stdout).toBe(`http://localhost:${port}/?screen=workspace&team-id=${TEAM}&file-id=${FILE}&page-id=${PAGE}\n`);
}

describe('fig2pot --upload failures', () => {
  it('says the file WAS imported when only reading it back failed, and neither writes a fallback nor suggests a retry', async () => {
    mode = 'read-back-fails';
    const { dir, input } = workdir();
    // A bare host:port is accepted (http for localhost).
    const r = await run([input, '--upload', '--penpot-url', `localhost:${port}`, '-q'], { PENPOT_ACCESS_TOKEN: 'tok_0123456789' });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`WAS imported into Penpot (file id ${FILE})`);
    expect(r.stderr).toContain(`http://localhost:${port}/?screen=workspace&team-id=${TEAM}&file-id=${FILE}`);
    expect(r.stderr).not.toMatch(/retry/);
    expect(readdirSync(dir)).toEqual(['design.fig']);
  }, 60_000);

  it('saves the fallback under a free name and keeps exit code 3', async () => {
    mode = 'import-fails';
    const { dir, input } = workdir();
    writeFileSync(join(dir, 'design.penpot'), 'existing');
    const r = await run([input, '--upload', '--penpot-url', `http://127.0.0.1:${port}`, '-q'], { PENPOT_ACCESS_TOKEN: 'tok_0123456789' });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`saved the converted file as ${join(dir, 'design-1.penpot')}`);
    expect(existsSync(join(dir, 'design-1.penpot'))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['design-1.penpot', 'design.fig', 'design.penpot']);
  }, 60_000);

  it('finds the file in the project when the connection drops during the import, and succeeds', async () => {
    mode = 'drop-found';
    imported = false;
    const { dir, input } = workdir();
    // A bare host with a query string is read like a full URL (the query is ignored).
    const r = await run([input, '--upload', '--penpot-url', `localhost:${port}?x=1`, '--name', 'Wanted', '-q'], { PENPOT_ACCESS_TOKEN: TOKEN });
    expect(r.stderr).toMatch(/the import request failed \(import-binfile: .*\), but the file is in the project: it was imported/);
    expect(r.code).toBe(0);
    // Found by its content: the converted file's own first page.
    expect(r.stdout).toBe(`http://localhost:${port}/?screen=workspace&team-id=${TEAM}&file-id=${FILE}&page-id=${[...uploaded!.pages.keys()][0]}\n`);
    expect(readdirSync(dir)).toEqual(['design.fig']);
  }, 60_000);

  it('says the import MAY have completed when that cannot be determined, keeps the file and does not call a retry safe', async () => {
    mode = 'drop-undated';
    imported = false;
    const { dir, input } = workdir();
    const r = await run([input, '--upload', '--penpot-url', `localhost:${port}`, '--name', 'Wanted', '-q'], { PENPOT_ACCESS_TOKEN: TOKEN });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('MAY HAVE IMPORTED the file');
    expect(r.stderr).toContain(`check the project: http://localhost:${port}/?screen=dashboard-files&team-id=${TEAM}&project-id=${DRAFTS}`);
    expect(r.stderr).toContain(`saved the converted file as ${join(dir, 'design.penpot')}; only if the project does not have it, upload it with:`);
    expect(r.stderr).not.toMatch(/retry/);
    expect(existsSync(join(dir, 'design.penpot'))).toBe(true);
  }, 60_000);

  it('exits 0 quietly when stdout is closed before the URL is written (EPIPE)', async () => {
    mode = 'ok';
    const { penpot } = workdir();
    const child = spawn(process.execPath, [CLI, 'upload', penpot, '--penpot-url', `localhost:${port}`], {
      env: { ...process.env, ...NO_PROXY_ENV, PENPOT_ACCESS_TOKEN: TOKEN, PENPOT_PROJECT_ID: '' },
    });
    child.stdout.destroy(); // like `| head -n0`
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(stderr).not.toMatch(/EPIPE|Error|    at /);
    expect(stderr).toContain(`stdout is closed; the file is at http://localhost:${port}/?screen=workspace`);
    expect(code).toBe(0);
  }, 60_000);

  it('uploads through HTTP_PROXY', async () => {
    mode = 'ok';
    const { penpot } = workdir();
    proxyHits = 0;
    proxied = [];
    const r = await run(['upload', penpot, '--penpot-url', `localhost:${port}`], { PENPOT_ACCESS_TOKEN: TOKEN, HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
    expect(r.code).toBe(0);
    expectUrlLine(r.stdout);
    expect(proxyHits).toBeGreaterThan(1);
    expect(proxied).toContain(`http://localhost:${port}/api/rpc/command/import-binfile`);
  }, 60_000);

  it('names a proxy that refuses the connection (without its credentials)', async () => {
    const { penpot } = workdir();
    // A port nothing listens on: the proxy's.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const dead = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));
    const r = await run(['upload', penpot, '--penpot-url', `localhost:${port}`], { PENPOT_ACCESS_TOKEN: TOKEN, HTTP_PROXY: `http://jdoe:SECRETPW@127.0.0.1:${dead}` });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(`could not reach the proxy http://127.0.0.1:${dead}/ (from HTTP_PROXY) for Penpot at http://localhost:${port} (ECONNREFUSED)`);
    expect(r.stderr).not.toMatch(/SECRETPW|jdoe/);
  }, 60_000);

  it('does not echo an invalid proxy URL\'s credentials', async () => {
    const { penpot } = workdir();
    const r = await run(['upload', penpot], { PENPOT_ACCESS_TOKEN: TOKEN, HTTPS_PROXY: 'http://jdoe:SECRETPW@[bad' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('HTTPS_PROXY is not a valid proxy URL');
    expect(r.stderr).not.toMatch(/SECRETPW|jdoe/);
  }, 60_000);

  it('rejects an access token with a line break as a usage error (exit 2)', async () => {
    const { input } = workdir();
    const r = await run([input, '--upload', '--penpot-url', `localhost:${port}`], { PENPOT_ACCESS_TOKEN: 'tok_0123\n456789' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/PENPOT_ACCESS_TOKEN: .*line breaks/);
  }, 60_000);

  it('accepts --renderer and rejects unknown renderers', async () => {
    const { dir, input } = workdir();
    expect((await run([input, '--renderer', 'wasm', '-o', join(dir, 'out.penpot'), '-q'], {})).code).toBe(0);
    const bad = await run([input, '--renderer', 'canvas'], {});
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--renderer');
  }, 60_000);
});

describe('fig2pot argument errors never echo what may be a secret', () => {
  it('counts unexpected arguments and shows only short prefixes of path-like ones', async () => {
    const { input, penpot } = workdir();
    let r = await run(['upload', penpot, 'SECRETTOKEN123'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('1 unexpected argument (1 not shown)');
    expect(r.stderr).not.toContain('SECRETTOKEN123');

    // A JWT-like secret has dots, but no file extension at the end: not path-like.
    r = await run([input, 'some/dir/other-design.fig', 'eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV', 'x'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('3 unexpected arguments ("some/dir/oth…", 2 not shown)');
    expect(r.stderr).not.toMatch(/eyJ|other-design/);
  }, 60_000);

  it('does not echo invalid option values unless they are short plain words', async () => {
    const { input } = workdir();
    let r = await run([input, '--renderer', 'SECRET_VALUE_99'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid value for --renderer (expected svg | wasm)');
    expect(r.stderr).not.toContain('SECRET_VALUE_99');
    r = await run([input, '--upload', '--project', 'SECRET_VALUE_99'], { PENPOT_ACCESS_TOKEN: TOKEN });
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain('SECRET_VALUE_99');
  }, 60_000);

  it('never prints URL credentials, nor the token when it ends up somewhere else (here: as the file name)', async () => {
    const { input } = workdir();
    let r = await run([input, '--upload', '--penpot-url', 'https://jdoe:SECRETPW@ho st'], { PENPOT_ACCESS_TOKEN: TOKEN });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('must not contain credentials');
    expect(r.stderr).not.toMatch(/SECRETPW|jdoe/);

    r = await run(['upload', TOKEN, '--penpot-url', `localhost:${port}`], { PENPOT_ACCESS_TOKEN: TOKEN });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ENOENT');
    expect(r.stderr).not.toContain(TOKEN);
  }, 60_000);
});
