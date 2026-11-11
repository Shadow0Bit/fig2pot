/**
 * Typed client for the local Penpot stack in `docker-compose.yaml`.
 *
 * - Backend RPC: `POST /api/rpc/command/<name>` with a JSON body (kebab-case
 *   keys) and `Accept: application/json` (camelCase keys in the response).
 *   Authentication is the `auth-token` session cookie set by
 *   `login-with-password`.
 * - Import: `import-binfile` (multipart, Server-Sent-Events response).
 * - Export: the exporter service behind the frontend's nginx at
 *   `POST /api/export` (transit body, `cmd: export-shapes`, `wait: true`); the
 *   result names a temporary asset URI that is downloaded with the same cookie.
 *
 * See README.md for the details and the reasoning behind each choice.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeTransit, encodeTransit, kw, uuid } from './transit.ts';

const execFileAsync = promisify(execFile);

export const COMPOSE_FILE = fileURLToPath(new URL('./docker-compose.yaml', import.meta.url));
export const COMPOSE_PROJECT = 'fig2pot-penpot';
/** Must match the default `PENPOT_VERSION` in docker-compose.yaml. */
export const PENPOT_VERSION = '2.19.0';
export const ROOT_FRAME_ID = '00000000-0000-0000-0000-000000000000';

export const DEFAULT_BASE_URL = process.env.PENPOT_URL ?? `http://localhost:${process.env.PENPOT_PORT ?? '9001'}`;
export const TEST_USER = {
  email: process.env.PENPOT_EMAIL ?? 'fig2pot@example.com',
  password: process.env.PENPOT_PASSWORD ?? 'Fig2pot-local-1!',
  fullname: 'fig2pot visual harness',
} as const;

/**
 * `svg`: the classic SVG/DOM renderer — what a 2.19 user sees by default (the
 * `render-switch` flag is on and a profile without a saved preference gets
 * `:svg`); the exporter renders it in headless Chromium from `render.html`.
 * `wasm`: the render-wasm (Skia) engine (`?wasm=true` in the workspace URL, or
 * the user's renderer setting); the exporter renders it headless in Node.
 */
export type Renderer = 'wasm' | 'svg';

// ---------------------------------------------------------------------------
// errors

export class PenpotError extends Error {
  readonly status: number | undefined;
  /** The server's error payload, verbatim (decoded JSON/transit, or raw text). */
  readonly detail: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = 'PenpotError';
    this.status = status;
    this.detail = detail;
  }
}

export class PenpotImportError extends PenpotError {
  constructor(message: string, status?: number, detail?: unknown) {
    super(message, status, detail);
    this.name = 'PenpotImportError';
  }
}

function describe(detail: unknown): string {
  if (detail === undefined || detail === null) return '';
  if (typeof detail === 'string') return detail.slice(0, 2000);
  try {
    return JSON.stringify(detail).slice(0, 4000);
  } catch {
    return String(detail);
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  try {
    if (contentType?.includes('transit')) return decodeTransit(text);
    if (contentType?.includes('json')) return JSON.parse(text);
  } catch {
    // fall through to raw text
  }
  return text;
}

// ---------------------------------------------------------------------------
// docker compose lifecycle

export interface ComposeOptions {
  /** Extra Penpot flags (e.g. `disable-feature-render-wasm`), passed as PENPOT_EXTRA_FLAGS. */
  extraFlags?: string;
  log?: (msg: string) => void;
}

async function compose(args: string[], options: ComposeOptions = {}, timeoutMs = 15 * 60_000): Promise<string> {
  const env = { ...process.env };
  if (options.extraFlags !== undefined) env.PENPOT_EXTRA_FLAGS = options.extraFlags;
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
      env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout + stderr;
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    throw new PenpotError(`docker compose ${args.join(' ')} failed: ${e.stderr || e.stdout || e.message}`);
  }
}

/** Starts (or reconciles) the stack and waits until frontend, backend and exporter answer. */
export async function up(options: ComposeOptions & { timeoutMs?: number; baseUrl?: string } = {}): Promise<void> {
  const log = options.log ?? (() => {});
  log('starting Penpot (docker compose up -d)…');
  await compose(['up', '-d', '--remove-orphans'], options);
  await waitUntilReady(options.baseUrl ?? DEFAULT_BASE_URL, options.timeoutMs ?? 5 * 60_000, log);
}

export async function down(options: ComposeOptions & { volumes?: boolean } = {}): Promise<void> {
  await compose(['down', ...(options.volumes ? ['--volumes'] : [])], options);
}

/** Exporter log lines since `sinceIso` (used to surface font / render warnings). */
export async function exporterLogs(sinceIso: string): Promise<string> {
  try {
    return await compose(['logs', '--no-color', '--since', sinceIso, 'penpot-exporter'], {}, 60_000);
  } catch {
    return '';
  }
}

async function probe(url: string, init: RequestInit): Promise<number> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

export async function isReady(baseUrl = DEFAULT_BASE_URL): Promise<boolean> {
  const [front, back, exporter] = await Promise.all([
    probe(`${baseUrl}/`, {}),
    probe(`${baseUrl}/api/rpc/command/get-profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    }),
    // No cookie + empty params → the exporter itself answers 400 (validation);
    // nginx answers 502/504 while the exporter is still starting.
    probe(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/transit+json' },
      body: encodeTransit({}),
    }),
  ]);
  return front === 200 && back === 200 && exporter >= 400 && exporter < 500;
}

export async function waitUntilReady(baseUrl = DEFAULT_BASE_URL, timeoutMs = 5 * 60_000, log: (m: string) => void = () => {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (await isReady(baseUrl)) return;
    if (!announced) {
      log(`waiting for Penpot at ${baseUrl} (backend migrations take ~1 min on first start)…`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new PenpotError(`Penpot at ${baseUrl} not ready after ${Math.round(timeoutMs / 1000)} s (check: docker compose -f ${COMPOSE_FILE} logs)`);
}

// ---------------------------------------------------------------------------
// file model (subset of what get-file returns)

export interface PenpotShape {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string;
  frameId: string;
  shapes?: string[];
  [key: string]: unknown;
}

export interface PenpotPage {
  id: string;
  name: string;
  objects: Record<string, PenpotShape>;
}

export interface PenpotFile {
  id: string;
  name: string;
  projectId: string;
  pages: PenpotPage[];
}

export interface ImportResult {
  fileId: string;
  pages: { id: string; name: string }[];
}

/** Boards whose parent is the page root, in page (z) order. */
export function topLevelBoards(page: PenpotPage): PenpotShape[] {
  const root = page.objects[ROOT_FRAME_ID];
  const order = root?.shapes ?? Object.keys(page.objects);
  return order
    .map((id) => page.objects[id])
    .filter((s): s is PenpotShape => !!s && s.type === 'frame' && s.parentId === ROOT_FRAME_ID && s.id !== ROOT_FRAME_ID);
}

// ---------------------------------------------------------------------------
// client

export interface ExportShapeParams {
  fileId: string;
  pageId: string;
  objectId: string;
  scale?: number;
  /** Defaults to the client's renderer. */
  renderer?: Renderer;
  /** ms, default 180 s. */
  timeoutMs?: number;
}

export interface PenpotClientOptions {
  baseUrl?: string;
  email?: string;
  password?: string;
  renderer?: Renderer;
}

export class PenpotClient {
  readonly baseUrl: string;
  readonly renderer: Renderer;
  private readonly email: string;
  private readonly password: string;
  private cookie = '';
  profileId = '';
  defaultTeamId = '';
  defaultProjectId = '';

  constructor(options: PenpotClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.email = options.email ?? TEST_USER.email;
    this.password = options.password ?? TEST_USER.password;
    this.renderer = options.renderer ?? 'svg';
  }

  /** ensureUser + login + profile lookup. */
  static async connect(options: PenpotClientOptions = {}): Promise<PenpotClient> {
    const client = new PenpotClient(options);
    await client.ensureUser();
    return client;
  }

  /** The `auth-token` cookie value (for opening the workspace in a scripted browser). */
  get sessionToken(): string {
    return this.cookie.replace(/^auth-token=/, '');
  }

  // --- low level ------------------------------------------------------------

  async rpc<T = any>(command: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/rpc/command/${command}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.captureCookie(res);
    const text = await res.text();
    const body = parseBody(text, res.headers.get('content-type'));
    if (!res.ok) {
      throw new PenpotError(`RPC ${command} failed (HTTP ${res.status}): ${describe(body)}`, res.status, body);
    }
    return body as T;
  }

  private captureCookie(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const m = /^auth-token=([^;]*)/.exec(c);
      if (m && m[1]) this.cookie = `auth-token=${m[1]}`;
    }
  }

  // --- auth -------------------------------------------------------------------

  /** Logs in; registers the local test user first if it does not exist yet. */
  async ensureUser(): Promise<void> {
    try {
      await this.login();
      return;
    } catch (error) {
      if (!(error instanceof PenpotError) || error.status !== 400) throw error;
    }
    // Registration flow (email verification disabled → the profile is active right away).
    const prepared = await this.rpc<{ token: string }>('prepare-register-profile', {
      fullname: TEST_USER.fullname,
      email: this.email,
      password: this.password,
    });
    await this.rpc('register-profile', { token: prepared.token });
    await this.login();
  }

  async login(): Promise<string> {
    this.cookie = '';
    await this.rpc('login-with-password', { email: this.email, password: this.password });
    if (!this.cookie) throw new PenpotError('login-with-password succeeded but set no auth-token cookie');
    const profile = await this.rpc<{ id: string; defaultTeamId: string; defaultProjectId: string }>('get-profile');
    this.profileId = profile.id;
    this.defaultTeamId = profile.defaultTeamId;
    this.defaultProjectId = profile.defaultProjectId;
    return this.cookie;
  }

  // --- files ------------------------------------------------------------------

  /**
   * Imports a `.penpot` (binfile v1/v3) into the user's Drafts project.
   * Throws PenpotImportError carrying Penpot's error payload verbatim.
   */
  async importPenpotFile(bytes: Uint8Array, name: string, options: { projectId?: string; timeoutMs?: number } = {}): Promise<ImportResult> {
    const form = new FormData();
    form.append('name', name);
    form.append('project-id', options.projectId ?? this.defaultProjectId);
    form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${name}.penpot`);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/rpc/command/import-binfile`, {
        method: 'POST',
        headers: { cookie: this.cookie, accept: 'text/event-stream' },
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
      });
    } catch (error) {
      throw new PenpotImportError(`import-binfile request failed: ${(error as Error).message}`);
    }
    if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
      const text = await res.text();
      const body = parseBody(text, res.headers.get('content-type'));
      throw new PenpotImportError(`import-binfile failed (HTTP ${res.status}): ${describe(body)}`, res.status, body);
    }

    let end: unknown;
    let failure: unknown;
    for await (const event of readSse(res)) {
      if (event.event === 'end') end = event.data;
      else if (event.event === 'error') failure = event.data;
    }
    if (failure !== undefined) {
      throw new PenpotImportError(`import-binfile reported an error: ${describe(failure)}`, res.status, failure);
    }
    const fileIds = extractFileIds(end);
    const fileId = fileIds[0];
    if (!fileId) throw new PenpotImportError(`import-binfile ended without a file id: ${describe(end)}`, res.status, end);

    const file = await this.getFile(fileId);
    return { fileId, pages: file.pages.map((p) => ({ id: p.id, name: p.name })) };
  }

  async getFile(fileId: string): Promise<PenpotFile> {
    const raw = await this.rpc<any>('get-file', { id: fileId }, 120_000);
    const data = raw.data ?? {};
    const pageIds: string[] = data.pages ?? Object.keys(data.pagesIndex ?? {});
    const pages: PenpotPage[] = [];
    for (const pageId of pageIds) {
      let page = data.pagesIndex?.[pageId];
      // Pointer-map files keep pages out of line; fetch them separately.
      if (!page || !page.objects) page = await this.rpc<any>('get-page', { fileId, pageId }, 120_000);
      pages.push({ id: page.id ?? pageId, name: page.name, objects: page.objects ?? {} });
    }
    return { id: raw.id, name: raw.name, projectId: raw.projectId, pages };
  }

  /** Moves the file to the trash and then deletes it permanently. */
  async deleteFile(fileId: string): Promise<void> {
    await this.rpc('delete-file', { id: fileId });
    try {
      const res = await fetch(`${this.baseUrl}/api/rpc/command/permanently-delete-team-files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie: this.cookie },
        body: JSON.stringify({ teamId: this.defaultTeamId, ids: [fileId] }),
        signal: AbortSignal.timeout(60_000),
      });
      await res.arrayBuffer();
    } catch {
      // best effort: the file is already in the trash
    }
  }

  // --- export -----------------------------------------------------------------

  /**
   * Renders one shape (normally a board) to PNG with Penpot's exporter.
   * `wait: true` makes the exporter answer only once the render is finished
   * and uploaded; the browser renderer additionally waits for every declared
   * font face to load before taking the screenshot.
   */
  async exportShape(params: ExportShapeParams): Promise<Uint8Array> {
    const renderer = params.renderer ?? this.renderer;
    const body = encodeTransit({
      cmd: kw('export-shapes'),
      wait: true,
      'profile-id': uuid(this.profileId),
      'is-wasm': renderer === 'wasm',
      exports: [
        {
          'file-id': uuid(params.fileId),
          'page-id': uuid(params.pageId),
          'object-id': uuid(params.objectId),
          type: kw('png'),
          suffix: '',
          scale: params.scale ?? 1,
          name: params.objectId,
        },
      ],
    });
    const timeout = params.timeoutMs ?? 180_000;
    const res = await fetch(`${this.baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/transit+json', accept: 'application/transit+json', cookie: this.cookie },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    const result = parseBody(text, res.headers.get('content-type')) as { uri?: string } | string | undefined;
    if (!res.ok || typeof result !== 'object' || !result?.uri) {
      throw new PenpotError(`export of ${params.objectId} failed (HTTP ${res.status}): ${describe(result)}`, res.status, result);
    }
    const uri = new URL(result.uri, this.baseUrl);
    // The resource URI uses PENPOT_PUBLIC_URI; always fetch through our base URL.
    const download = await fetch(`${this.baseUrl}${uri.pathname}${uri.search}`, {
      headers: { cookie: this.cookie },
      signal: AbortSignal.timeout(60_000),
    });
    if (!download.ok) {
      throw new PenpotError(`download of export ${uri.pathname} failed (HTTP ${download.status})`, download.status, await download.text());
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      throw new PenpotError(`export of ${params.objectId} did not return a PNG (${bytes.length} bytes)`);
    }
    return bytes;
  }

  /** Workspace URL for a file / page / board (needs a browser logged in as the test user). */
  workspaceUrl(fileId: string, pageId?: string, boardId?: string): string {
    const q = new URLSearchParams({ 'team-id': this.defaultTeamId, 'file-id': fileId });
    if (pageId) q.set('page-id', pageId);
    if (boardId) q.set('board-id', boardId);
    return `${this.baseUrl}/#/workspace?${q.toString()}`;
  }
}

// ---------------------------------------------------------------------------
// helpers

interface SseEvent {
  event: string;
  data: unknown;
}

async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = function* (chunk: string): Generator<SseEvent> {
    let event = 'message';
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const text = data.join('\n');
    let parsed: unknown = text;
    try {
      parsed = decodeTransit(text);
    } catch {
      // keep raw
    }
    yield { event, data: parsed };
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      yield* flush(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* flush(buffer);
}

function extractFileIds(end: unknown): string[] {
  if (Array.isArray(end)) return end.filter((x): x is string => typeof x === 'string');
  if (end && typeof end === 'object') {
    const o = end as Record<string, unknown>;
    for (const key of ['file-ids', 'fileIds', 'ids']) {
      if (Array.isArray(o[key])) return (o[key] as unknown[]).filter((x): x is string => typeof x === 'string');
    }
    if (typeof o.id === 'string') return [o.id];
  }
  return [];
}
