/**
 * Uploads a `.penpot` file into a Penpot project through Penpot's RPC API and
 * returns workspace links to the imported file.
 *
 * Authentication is a personal access token (`Authorization: Token <token>`).
 * Calls (all verified to accept token auth on Penpot 2.19):
 *
 * - `get-profile`      — checks the token and gives the default team + Drafts project.
 *                        An unknown token is *not* an HTTP error here: Penpot answers 200
 *                        with the anonymous profile (id = zero UUID).
 * - `get-project`      — validates an explicit project id and gives its team.
 * - `get-all-projects` — fallback discovery of the Drafts project of the default team.
 * - `import-binfile`   — multipart upload; the response is Server-Sent Events whose
 *                        `data:` lines are transit json-verbose.
 * - `rename-file`      — v3 binfiles keep the name stored in the file, ignoring the
 *                        `name` field; renamed afterwards when the caller asked for another name.
 * - `get-file`         — page order and names (`get-page` when a page is not inline).
 * - `get-project-files` — the project's files just before the import; again only when the import
 *                        request failed without a verdict (time-out, dropped connection), to
 *                        find a new file the import may have created; `get-file` / `get-page`
 *                        then tell whether its pages and shapes are this upload's.
 *
 * `GET <base>/version.txt` (static frontend file) picks the workspace URL style:
 * Penpot ≥ 2.19 routes by query string (`/?screen=workspace&…`), older versions by
 * hash (`/#/workspace?…`).
 *
 * With `Accept: application/json` the backend answers camelCase JSON (and JSON
 * errors `{type, code, hint}`); transit bodies are decoded too, for robustness.
 *
 * Redirects are never followed blindly: same-origin ones are (a few hops, same method, body
 * and token; one hop for the upload itself, whose base URL `version.txt` resolves first), a
 * redirect to another origin fails, naming that origin.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';

export const DEFAULT_PENPOT_URL = 'https://design.penpot.app';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_VERIFY_GRACE_MS = 10_000;
/** Extra time for the requests that look for the file, and for reading a found file back. */
const VERIFY_REQUEST_MS = 30_000;
/** `Date` headers have a 1 s resolution, and the HTTP front's clock may differ a bit from the database's. */
const CREATED_SLACK_MS = 5_000;
const MAX_REDIRECTS = 5;
const MANIFEST_MAX_BYTES = 1 << 20;
const UPLOAD_CHUNK_BYTES = 1 << 20;
/** How long to wait for `100 Continue` before sending the body anyway (curl waits 1 s too). */
const EXPECT_WAIT_MS = 1_000;
/** After a write error, how long an answer the server sent before closing may take to be read. */
const PENDING_ANSWER_MS = 1_000;
/** The fetch this module was loaded with; a replaced one (tests, instrumentation) is honoured. */
const NATIVE_FETCH = globalThis.fetch;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Errors fetch reports before anything was sent: the import certainly did not start. */
const NOTHING_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export interface UploadOptions {
  /** Penpot base URL (default `https://design.penpot.app`); sub-path deployments work. */
  baseUrl?: string;
  /** Personal access token (Penpot → Your account → Access tokens). Never logged. */
  accessToken: string;
  /** Target project; default: the Drafts project of the user's default team. */
  projectId?: string;
  /** Name of the file in Penpot. */
  name: string;
  signal?: AbortSignal;
  /** Deadline for the whole upload, including the import (default 5 minutes). */
  timeoutMs?: number;
  /**
   * When the import request fails without Penpot saying how it went (time-out, dropped
   * connection), how long to keep looking for the file in the project (default 10 s). This
   * comes on top of `timeoutMs`.
   */
  verifyGraceMs?: number;
}

export interface UploadResult {
  /** Workspace URL of the imported file, first page selected. */
  url: string;
  fileId: string;
  teamId: string;
  projectId: string;
  name: string;
  pages: { id: string; name: string; url: string }[];
  /**
   * Set when the import request itself failed (time-out, dropped connection) but the imported
   * file was then found in the project: what went wrong. The rest of the result is complete.
   */
  recovered?: string;
}

export interface PenpotErrorInfo {
  type?: string;
  code?: string;
  hint?: string;
}

export class PenpotUploadError extends Error {
  /** HTTP status; 401 also when Penpot answered with the anonymous profile (token not accepted). */
  status?: number;
  /** Penpot's error payload (`type`, `code`, `hint`), verbatim. */
  penpot?: PenpotErrorInfo;
  /**
   * Set when the import itself succeeded and a later step failed: the file EXISTS in Penpot, so uploading
   * again would duplicate it. `url` is its workspace link when it could be built.
   */
  fileId?: string;
  teamId?: string;
  projectId?: string;
  url?: string;
  /**
   * `true` when the import request failed without a verdict from Penpot (time-out, abort,
   * dropped connection, gateway error) and looking for the file in the project did not settle
   * it: the file MAY exist, so check `projectUrl` before uploading again. `false` when it was
   * looked for and not found.
   */
  importMayHaveCompleted?: boolean;
  /** Dashboard link of the target project; set whenever the outcome of the import was in doubt. */
  projectUrl?: string;

  constructor(message: string, options: { status?: number; penpot?: PenpotErrorInfo; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PenpotUploadError';
    if (options.status !== undefined) this.status = options.status;
    if (options.penpot !== undefined) this.penpot = options.penpot;
  }
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?([/?#]|$)/i;
const CREDENTIALS_MESSAGE = 'the Penpot URL must not contain credentials (user:password@…) or any other "@"; remove them';

/**
 * A URL (or URL-like text) safe to show: without user info, query and fragment. A password may hold `/`, `?`
 * or `#` (unencoded, as typed), so everything from the scheme to the LAST `@` is dropped, wherever that `@` is.
 */
export function redactUrl(text: string): string {
  const at = text.lastIndexOf('@');
  const scheme = SCHEME_RE.exec(text)?.[0] ?? '';
  const rest = at >= scheme.length ? text.slice(at + 1) : text.slice(scheme.length);
  return `${scheme}${rest.replace(/[?#].*$/s, '')}`;
}

/**
 * Normalises a Penpot base URL: http(s) only, no credentials, query or hash,
 * no trailing slashes. A bare `host[:port][/path][?query][#hash]` is accepted too, with
 * the same rules: https, or http for localhost / 127.0.0.1 / [::1]. Throws `TypeError`
 * for anything else; the message never contains credentials.
 */
export function normalizePenpotUrl(url: string): string {
  let text = url.trim();
  // Checked on the text: a malformed URL with credentials must not be echoed either. A password may hold
  // `/`, `?` or `#` (`https://user:pa/ss@host` parses as host "user", path "/ss@host"), so any `@` is refused.
  if (text.replace(SCHEME_RE, '').includes('@')) throw new TypeError(CREDENTIALS_MESSAGE);
  const bare = SCHEME_RE.test(text) ? null : BARE_HOST_RE.exec(text);
  if (bare) {
    const host = bare[1]!.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    text = `${local ? 'http' : 'https'}://${text}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError(`invalid Penpot URL: ${JSON.stringify(redactUrl(url.trim()))}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`invalid Penpot URL (expected http:// or https://, got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) throw new TypeError(CREDENTIALS_MESSAGE);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Why a token cannot be sent in an HTTP header, or undefined when it can. */
export function accessTokenProblem(token: string): string | undefined {
  if (token.trim() === '') return 'the access token is empty';
  // Header values are Latin-1 without control characters; Penpot tokens are printable ASCII.
  if (!/^[\x21-\x7e]+$/.test(token.trim())) return 'the access token contains spaces, line breaks or non-ASCII characters (check how it was copied)';
  return undefined;
}

/**
 * Imports `penpot` (the bytes of a `.penpot` file, or a Blob such as `fs.openAsBlob(path)`,
 * which is streamed from disk) into Penpot.
 */
export async function uploadToPenpot(penpot: Uint8Array | Blob, options: UploadOptions): Promise<UploadResult> {
  const token = options.accessToken?.trim();
  if (!token) throw new TypeError('uploadToPenpot: accessToken is required');
  const problem = accessTokenProblem(token);
  if (problem) throw new TypeError(`uploadToPenpot: ${problem}`);
  if (options.projectId !== undefined && !UUID_RE.test(options.projectId)) {
    throw new TypeError('uploadToPenpot: projectId is not a UUID');
  }
  const session = new Session(normalizePenpotUrl(options.baseUrl ?? DEFAULT_PENPOT_URL), token, options);
  const wanted = options.name.trim();

  const [profile, version] = await Promise.all([session.rpc('get-profile', {}), session.serverVersion()]);
  if (field(profile, 'id') === ZERO_UUID || typeof field(profile, 'id') !== 'string') {
    throw session.error('Penpot did not accept the access token (it is invalid, expired or revoked)', { status: 401 });
  }
  const target = await session.resolveProject(profile, options.projectId);

  // What the project holds before the import, so that a file this import created can be told
  // apart from older ones if the import's outcome is open. Without it: Penpot's clock.
  const before = await session.projectFileIds(target.projectId);
  const since = (session.serverTime ?? Date.now()) - CREATED_SLACK_MS;
  let fileId: string;
  let recovered: string | undefined;
  try {
    fileId = await session.importBinfile(penpot, options.name, target.projectId);
  } catch (error) {
    if (!(error instanceof PenpotUploadError) || error.importMayHaveCompleted !== true) throw error;
    // Penpot keeps the name stored in the file until rename-file runs: look for that one too.
    const stored = await readPenpotManifest(penpot).catch(() => undefined);
    const content = await readPenpotContent(penpot).catch(() => undefined);
    const names = [...new Set([stored?.name, wanted].filter((n): n is string => typeof n === 'string' && n !== ''))];
    const check = await session.findImported(target.projectId, names, before ?? since, options.verifyGraceMs ?? DEFAULT_VERIFY_GRACE_MS, content);
    if (check.fileId === undefined) {
      error.message = `${error.message}; ${check.summary}`;
      error.importMayHaveCompleted = check.unknown;
      error.teamId = target.teamId;
      error.projectId = target.projectId;
      error.projectUrl = dashboardUrl(session.baseUrl, version, target.teamId, target.projectId);
      throw error;
    }
    fileId = check.fileId;
    recovered = error.message;
    session.renewDeadline(VERIFY_REQUEST_MS);
  }
  try {
    const result = await describeImport(session, fileId, wanted, target, version);
    return recovered === undefined ? result : { ...result, recovered };
  } catch (error) {
    if (!(error instanceof PenpotUploadError)) throw error;
    // The file exists in Penpot at this point; say so, so that nobody retries and duplicates it.
    error.message = `the file was imported (id ${fileId}) but reading it back failed: ${error.message}`;
    error.fileId = fileId;
    error.teamId = target.teamId;
    error.projectId = target.projectId;
    error.url = workspaceUrl(session.baseUrl, version, target.teamId, fileId);
    throw error;
  }
}

async function describeImport(
  session: Session,
  fileId: string,
  wanted: string,
  target: { projectId: string; teamId: string },
  version: Version,
): Promise<UploadResult> {
  let file = await session.rpc('get-file', { id: fileId });
  if (wanted && field(file, 'name') !== wanted) {
    // Best effort: the file is imported either way; the result reports the actual name.
    const renamed = await session.rpc('rename-file', { id: fileId, name: wanted }).then(
      () => true,
      () => false,
    );
    if (renamed) file = { ...asRecord(file), name: wanted };
  }

  const teamId = str(field(file, 'teamId')) ?? target.teamId;
  const projectId = str(field(file, 'projectId')) ?? target.projectId;
  const pages = await session.pages(fileId, file);
  const link = (pageId?: string): string => workspaceUrl(session.baseUrl, version, teamId, fileId, pageId);
  return {
    url: link(pages[0]?.id),
    fileId,
    teamId,
    projectId,
    name: str(field(file, 'name')) ?? wanted,
    pages: pages.map((p) => ({ ...p, url: link(p.id) })),
  };
}

// ---------------------------------------------------------------------------

/** `[major, minor]` or undefined when unknown. */
type Version = [number, number] | undefined;

function workspaceUrl(base: string, version: Version, teamId: string, fileId: string, pageId?: string): string {
  const q = new URLSearchParams({ 'team-id': teamId, 'file-id': fileId });
  if (pageId) q.set('page-id', pageId);
  // Query-string routing arrived in 2.19 (`app.main.router/resolve-uri`: public-uri + `?screen=…`);
  // 2.19 still translates the legacy hash form once, older versions only know the hash form.
  return legacy(version) ? `${base}/#/workspace?${q}` : `${base}/?screen=workspace&${q}`;
}

function dashboardUrl(base: string, version: Version, teamId: string, projectId: string): string {
  const q = new URLSearchParams({ 'team-id': teamId, 'project-id': projectId });
  return legacy(version) ? `${base}/#/dashboard/files?${q}` : `${base}/?screen=dashboard-files&${q}`;
}

function legacy(version: Version): boolean {
  return version !== undefined && (version[0] < 2 || (version[0] === 2 && version[1] < 19));
}

function timestamp(value: unknown): number | undefined {
  const t = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

class Session {
  /** The Penpot base URL; replaced by where `version.txt` was found when Penpot redirects it (same origin). */
  baseUrl: string;
  private readonly origin: string;
  private readonly token: string;
  private readonly userSignal: AbortSignal | undefined;
  private deadline!: AbortSignal;
  private signal!: AbortSignal;
  private timeoutMs!: number;
  /** Penpot's clock (`Date` header of the latest RPC answer). */
  serverTime: number | undefined;

  constructor(baseUrl: string, token: string, options: UploadOptions) {
    this.baseUrl = baseUrl;
    this.origin = new URL(baseUrl).origin;
    this.token = token;
    this.userSignal = options.signal;
    this.renewDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /** Starts a new deadline for the following requests. */
  renewDeadline(ms: number): void {
    this.timeoutMs = ms;
    this.deadline = AbortSignal.timeout(ms);
    this.signal = this.userSignal ? AbortSignal.any([this.userSignal, this.deadline]) : this.deadline;
  }

  /** Builds an error whose message and payload can never contain the token. */
  error(message: string, options: { status?: number; penpot?: PenpotErrorInfo; cause?: unknown } = {}): PenpotUploadError {
    // Very short "tokens" would mangle unrelated text; real ones are long.
    const scrub = (s: string): string => (this.token.length >= 8 ? s.split(this.token).join('<redacted>') : s);
    const penpot = options.penpot && Object.fromEntries(Object.entries(options.penpot).map(([k, v]) => [k, scrub(v)]));
    return new PenpotUploadError(scrub(message), { ...options, ...(penpot ? { penpot } : {}) });
  }

  private failure(what: string, cause: unknown): PenpotUploadError {
    if (cause instanceof PenpotUploadError) return cause;
    if (this.userSignal?.aborted) return this.error(`${what}: aborted`, { cause: this.userSignal.reason });
    if (this.deadline.aborted) return this.error(`${what}: timed out after ${Math.round(this.timeoutMs / 1000)} s`);
    const reason = (cause as { cause?: { code?: string; message?: string; port?: unknown } })?.cause;
    const detail = reason?.code ?? reason?.message ?? (cause as Error)?.message ?? String(cause);
    const lost = !(typeof reason?.code === 'string' && NOTHING_SENT.has(reason.code));
    const proxy = proxyFor(this.baseUrl);
    if (proxy && !lost) {
      // A connection that never got going through a proxy failed at the proxy (a refused target is the
      // proxy's answer to CONNECT, not a socket error), unless the error names another port.
      const proxyPort = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
      if (reason?.port === undefined || String(reason.port) === proxyPort) {
        return this.error(`${what}: could not reach the proxy ${redactUrl(proxy.href)} (from ${proxy.variable}) for Penpot at ${this.baseUrl} (${detail})`, { cause });
      }
    }
    const via = proxy ? ` through the proxy ${redactUrl(proxy.href)} (from ${proxy.variable})` : '';
    return this.error(`${what}: ${lost ? 'the connection to' : 'could not reach'} Penpot at ${this.baseUrl}${via}${lost ? ' failed' : ''} (${detail})`, { cause });
  }

  /**
   * Sends a request that does not follow redirects by itself: same-origin redirects are followed
   * here (same method, body and headers), one to another origin is an error — the token and the
   * file never go there.
   */
  private async send(what: string, path: string, transport: Transport, signal = this.signal, maxRedirects = MAX_REDIRECTS): Promise<{ res: Response; url: string }> {
    let url = `${this.baseUrl}${path}`;
    for (let hops = 0; ; hops++) {
      let res: Response;
      try {
        res = await transport(url, signal);
      } catch (error) {
        throw this.failure(what, error);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location === null) return { res, url };
      await res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw this.error(`Penpot ${what}: HTTP ${res.status} redirect to an invalid location`, { status: res.status });
      }
      if (next.origin !== this.origin) {
        // The base URL the redirect target suggests: its path minus the part fig2pot added.
        const base = next.pathname.endsWith(path) ? next.pathname.slice(0, -path.length).replace(/\/+$/, '') : '';
        throw this.error(
          `Penpot ${what}: ${this.origin} redirects (HTTP ${res.status}) to another origin, ${next.origin}; ` +
            `fig2pot does not follow it, so neither the access token nor the file were sent there. ` +
            `If that is your Penpot, set PENPOT_URL (or --penpot-url) to ${next.origin}${base}`,
          { status: res.status },
        );
      }
      if (hops >= maxRedirects) throw this.error(`Penpot ${what}: too many redirects`, { status: res.status });
      next.username = next.password = '';
      url = next.href;
    }
  }

  private async post(command: string, init: { headers: Record<string, string>; body: string | Multipart }): Promise<Response> {
    const headers = { ...init.headers, authorization: `Token ${this.token}`, 'user-agent': 'fig2pot' };
    const body = init.body;
    const transport: Transport =
      typeof body === 'string'
        ? (url, signal) => fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal })
        : (url, signal) => streamPost(url, { ...headers, 'content-type': body.contentType }, body, signal);
    // A redirected upload may send the whole file once per hop (when the server does not answer before the
    // body, see `streamPost`): the base URL is resolved beforehand (`serverVersion`), one hop is tolerated.
    const { res } = await this.send(command, `/api/rpc/command/${command}`, transport, this.signal, typeof body === 'string' ? MAX_REDIRECTS : 1);
    const date = Date.parse(res.headers.get('date') ?? '');
    if (Number.isFinite(date)) this.serverTime = date;
    return res;
  }

  private async text(command: string, res: Response): Promise<string> {
    try {
      return await res.text();
    } catch (error) {
      throw this.failure(command, error);
    }
  }

  private async httpError(command: string, res: Response): Promise<PenpotUploadError> {
    const body = parseBody(await this.text(command, res), res.headers.get('content-type'));
    const penpot = errorInfo(body);
    const advice =
      res.status === 401 || res.status === 403
        ? ' — the access token was rejected or lacks access'
        : res.status === 413
          ? ' — the file is larger than this Penpot instance accepts'
          : '';
    return this.error(`Penpot ${command} failed (HTTP ${res.status}${describe(penpot)})${advice}`, { status: res.status, ...(penpot ? { penpot } : {}) });
  }

  async rpc(command: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await this.post(command, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw await this.httpError(command, res);
    return parseBody(await this.text(command, res), res.headers.get('content-type'));
  }

  /** Best effort; `undefined` when the frontend does not tell. */
  async serverVersion(): Promise<Version> {
    try {
      const { res, url } = await this.send(
        'version.txt',
        '/version.txt',
        (url, signal) => fetch(url, { redirect: 'manual', signal }),
        AbortSignal.any([this.signal, AbortSignal.timeout(VERSION_TIMEOUT_MS)]),
      );
      if (!res.ok) return undefined;
      // Same-origin redirects of this cheap GET give the base URL the RPC calls (and the upload) then use
      // directly, e.g. `/penpot` → `/penpot/` or a moved sub-path.
      const moved = new URL(url);
      if (moved.pathname.endsWith('/version.txt')) {
        const base = `${moved.origin}${moved.pathname.slice(0, -'/version.txt'.length).replace(/\/+$/, '')}`;
        if (base !== this.baseUrl) this.baseUrl = base;
      }
      const m = /^\s*(\d+)\.(\d+)/.exec(await res.text());
      return m ? [Number(m[1]), Number(m[2])] : undefined;
    } catch {
      return undefined;
    }
  }

  async resolveProject(profile: unknown, projectId: string | undefined): Promise<{ projectId: string; teamId: string }> {
    if (projectId) {
      const project = await this.rpc('get-project', { id: projectId });
      const teamId = str(field(project, 'teamId'));
      if (!teamId) throw this.error(`Penpot get-project returned no team for project ${projectId}`);
      return { projectId, teamId };
    }
    const defaultProjectId = str(field(profile, 'defaultProjectId'));
    const defaultTeamId = str(field(profile, 'defaultTeamId'));
    if (defaultProjectId && defaultTeamId) return { projectId: defaultProjectId, teamId: defaultTeamId };

    const projects = await this.rpc('get-all-projects', {});
    const drafts = (Array.isArray(projects) ? projects : []).find(
      (p) => field(p, 'isDefault') === true && (field(p, 'isDefaultTeam') === true || field(p, 'teamId') === defaultTeamId),
    );
    const id = str(field(drafts, 'id'));
    const team = str(field(drafts, 'teamId'));
    if (!id || !team) throw this.error('could not find the Drafts project of the default team; pass a project id');
    return { projectId: id, teamId: team };
  }

  /**
   * Returns the id of the imported file. A failure that leaves open whether Penpot imported it —
   * anything after the request went out and before Penpot's verdict (an HTTP error status, the
   * stream's `error` or `end` event) — has `importMayHaveCompleted = true`.
   */
  async importBinfile(file: Uint8Array | Blob, name: string, projectId: string): Promise<string> {
    const form = multipart({ name, 'project-id': projectId }, file, `${name.replace(/[^\w .-]+/g, '_') || 'file'}.penpot`);
    const command = 'import-binfile';
    let res: Response;
    try {
      // Listing JSON as well makes Penpot answer non-stream errors as JSON instead of transit.
      res = await this.post(command, { headers: { accept: 'text/event-stream, application/json' }, body: form });
    } catch (error) {
      const e = this.failure(command, error);
      // A redirect (status set) or a failed connection set-up proves that nothing was imported.
      const code = (e.cause as { cause?: { code?: unknown } } | undefined)?.cause?.code;
      if (e.status === undefined && !(typeof code === 'string' && NOTHING_SENT.has(code))) e.importMayHaveCompleted = true;
      throw e;
    }

    let verdict = false;
    try {
      if (!res.ok) {
        // A gateway that gave up waiting says nothing about what Penpot behind it did.
        verdict = res.status !== 502 && res.status !== 504;
        throw await this.httpError(command, res);
      }
      let end: unknown;
      if (res.headers.get('content-type')?.includes('text/event-stream')) {
        for await (const event of readSse(res)) {
          if (event.event === 'error') {
            verdict = true;
            const penpot = errorInfo(decodeEventData(event.data));
            throw this.error(`Penpot rejected the file (${command} error${describe(penpot)})`, {
              status: res.status,
              ...(penpot ? { penpot } : {}),
            });
          }
          if (event.event === 'end') {
            end = decodeEventData(event.data);
            break;
          }
        }
        if (end === undefined) throw this.error(`Penpot ${command}: the event stream ended before the import finished`);
      } else {
        end = parseBody(await this.text(command, res), res.headers.get('content-type'));
      }
      const fileId = fileIds(end)[0];
      if (!fileId) throw this.error(`Penpot ${command} finished without returning a file id`);
      return fileId;
    } catch (error) {
      const e = this.failure(command, error);
      if (!verdict) e.importMayHaveCompleted = true;
      throw e;
    }
  }

  /** Ids of the project's files; undefined when Penpot does not tell (never fails the upload). */
  async projectFileIds(projectId: string): Promise<Set<string> | undefined> {
    try {
      const files = await this.rpc('get-project-files', { projectId });
      return Array.isArray(files) ? new Set(files.map((f) => str(field(f, 'id'))).filter((id): id is string => id !== undefined)) : undefined;
    } catch (error) {
      if (this.signal.aborted) throw this.failure('get-project-files', error);
      return undefined;
    }
  }

  /**
   * After an import failure without a verdict: looks in the project for the file this import created, now
   * and again over `graceMs`. A candidate is a file with one of `names` that is new — not among the ids in
   * `before`, or (when the files could not be listed before the import) created since `before` on Penpot's
   * clock. A name alone does not tie a file to this upload (another upload of a file with the same stored
   * name, e.g. "Untitled", may run at the same time), so a candidate is adopted only when its pages and shapes
   * are this upload's (`content`, see `readPenpotContent`); without `content`, or when several candidates
   * match, the outcome stays open. `unknown` is true when the search did not settle whether the import happened.
   */
  async findImported(
    projectId: string,
    names: string[],
    before: Set<string> | number,
    graceMs: number,
    content: PenpotContent | undefined,
  ): Promise<{ fileId?: string; unknown: boolean; summary: string }> {
    const aborted = { unknown: true, summary: 'the upload was aborted before Penpot said whether it imported the file' };
    if (this.userSignal?.aborted) return aborted;
    this.renewDeadline(graceMs + VERIFY_REQUEST_MS);
    const label = names.map((n) => JSON.stringify(n)).join(' or ');
    const started = Date.now();
    /** Candidate id → whether its content is this upload's (undefined: could not be compared). */
    const compared = new Map<string, boolean | undefined>();
    let problem: string | undefined;
    for (;;) {
      try {
        const files = await this.rpc('get-project-files', { projectId });
        if (!Array.isArray(files)) throw this.error('Penpot get-project-files did not return a list');
        const found: string[] = [];
        let undated = false;
        for (const f of files) {
          const id = str(field(f, 'id'));
          if (!id || !names.includes(field(f, 'name') as string)) continue;
          if (before instanceof Set) {
            if (!before.has(id)) found.push(id);
            continue;
          }
          const created = timestamp(field(f, 'createdAt'));
          if (created === undefined) undated = true;
          else if (created >= before) found.push(id);
        }
        if (undated) return { unknown: true, summary: 'Penpot did not say when the files in the project were created, so fig2pot could not check whether the file was imported' };
        if (found.length > 0 && content === undefined) {
          return {
            unknown: true,
            summary: `${found.length === 1 ? 'a new file' : `${found.length} new files`} named ${label} appeared in the project (${found.join(', ')}), but fig2pot could not read this upload's pages to tell whether ${found.length === 1 ? 'it is' : 'one of them is'} this upload or another one`,
          };
        }
        for (const id of found) if (!compared.has(id)) compared.set(id, await this.sameContent(id, content!));
        const matching = found.filter((id) => compared.get(id) === true);
        const open = found.filter((id) => compared.get(id) === undefined);
        if (matching.length === 1 && open.length === 0) return { fileId: matching[0]!, unknown: false, summary: '' };
        if (matching.length + open.length > 1) {
          return {
            unknown: true,
            summary: `the project has ${matching.length + open.length} new files named ${label} that may hold this upload's content (${[...matching, ...open].join(', ')}); one of them may be this upload, another may be a concurrent upload of the same content`,
          };
        }
        if (open.length === 1) return { unknown: true, summary: `a new file named ${label} appeared (${open[0]}), but fig2pot could not read its pages to tell whether it is this upload` };
        problem = undefined;
      } catch (error) {
        problem = (error as Error).message;
      }
      const left = graceMs - (Date.now() - started);
      if (left <= 0 || this.signal.aborted) break;
      await delay(Math.min(left, Math.max(graceMs / 2, 1)), undefined, { signal: this.signal }).catch(() => {});
    }
    if (this.userSignal?.aborted) return aborted;
    if (problem !== undefined) return { unknown: true, summary: `checking the project for the file failed as well (${problem})` };
    const others = [...compared.keys()];
    return {
      unknown: false,
      summary:
        `no file with this upload's pages appeared in the project within ${Math.round(graceMs / 1000)} s` +
        (others.length > 0 ? ` (${others.length} new file${others.length > 1 ? 's' : ''} named ${label} did, with other content: ${others.join(', ')})` : ` (looked for files named ${label})`) +
        ', so it was most likely not imported (a very slow import could still finish later)',
    };
  }

  /**
   * Whether the file holds exactly the pages and shapes of `content`; undefined when Penpot does not tell
   * (a failed request, a page whose shapes are not returned).
   */
  private async sameContent(fileId: string, content: PenpotContent): Promise<boolean | undefined> {
    try {
      const file = await this.rpc('get-file', { id: fileId });
      const data = asRecord(field(file, 'data'));
      const index = asRecord(field(data, 'pagesIndex'));
      const ids = (Array.isArray(data.pages) ? data.pages.filter((p): p is string => typeof p === 'string') : Object.keys(index)).map((id) => id.toLowerCase());
      if (ids.length !== content.pages.size || !ids.every((id) => content.pages.has(id))) return false;
      for (const [id, shapes] of content.pages) {
        let objects = field(Object.entries(index).find(([k]) => k.toLowerCase() === id)?.[1], 'objects');
        // Files stored with pointer maps may not inline their pages.
        if (objects === undefined || objects === null) objects = field(await this.rpc('get-page', { fileId, pageId: id }), 'objects');
        if (objects === null || typeof objects !== 'object') return undefined;
        const keys = Object.keys(objects).map((k) => k.toLowerCase());
        if (keys.length !== shapes.size || !keys.every((k) => shapes.has(k))) return false;
      }
      return true;
    } catch (error) {
      if (this.signal.aborted) throw error;
      return undefined;
    }
  }

  async pages(fileId: string, file: unknown): Promise<{ id: string; name: string }[]> {
    const data = asRecord(field(file, 'data'));
    const index = asRecord(field(data, 'pagesIndex'));
    const ids = Array.isArray(data.pages) ? data.pages.filter((p): p is string => typeof p === 'string') : Object.keys(index);
    const out: { id: string; name: string }[] = [];
    for (const [i, id] of ids.entries()) {
      let name = str(field(index[id], 'name'));
      // Files stored with pointer maps may not inline their pages.
      if (name === undefined) name = str(field(await this.rpc('get-page', { fileId, pageId: id }), 'name'));
      out.push({ id, name: name ?? `Page ${i + 1}` });
    }
    return out;
  }
}

// --- proxies ---------------------------------------------------------------

/**
 * The proxy Node uses for `url` when it honours HTTP(S)_PROXY (`NODE_USE_ENV_PROXY=1`, or
 * `http.setGlobalProxyFromEnv()`, which the CLI calls when one is set): `https_proxy` / `HTTPS_PROXY` for
 * https, `http_proxy` / `HTTP_PROXY` for http, unless NO_PROXY lists the host (`*`, `host`, `.domain`,
 * `domain`, optionally with `:port`). Only used to name the proxy in errors (never with its credentials).
 */
export function proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): (URL & { variable: string }) | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const names = target.protocol === 'https:' ? ['https_proxy', 'HTTPS_PROXY'] : ['http_proxy', 'HTTP_PROXY'];
  const variable = names.find((n) => env[n]?.trim());
  if (!variable) return undefined;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const noProxy = (env.no_proxy ?? env.NO_PROXY ?? '').split(/[\s,]+/).filter(Boolean);
  for (const entry of noProxy) {
    if (entry === '*') return undefined;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry.toLowerCase().replace(/^\[|\]$/g, ''))!;
    const name = m[1]!.replace(/^\*?\./, '');
    if (m[2] !== undefined && m[2] !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return undefined;
  }
  const raw = env[variable]!.trim();
  try {
    return Object.assign(new URL(SCHEME_RE.test(raw) ? raw : `http://${raw}`), { variable });
  } catch {
    return undefined;
  }
}

// --- streamed upload -------------------------------------------------------

type Transport = (url: string, signal: AbortSignal) => Promise<Response>;

/** A multipart/form-data body kept as its parts, so that the file is neither copied nor loaded. */
interface Multipart {
  contentType: string;
  parts: (Uint8Array | Blob)[];
  length: number;
}

function multipart(fields: Record<string, string>, file: Uint8Array | Blob, filename: string): Multipart {
  const boundary = `fig2pot-${crypto.randomUUID()}`;
  let head = '';
  for (const [key, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`;
  const encoder = new TextEncoder();
  const parts = [encoder.encode(head), file, encoder.encode(`\r\n--${boundary}--\r\n`)];
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    parts,
    length: parts.reduce((n, p) => n + (p instanceof Blob ? p.size : p.length), 0),
  };
}

async function* bodyChunks(parts: (Uint8Array | Blob)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    if (part instanceof Blob) {
      // A Blob from fs.openAsBlob is read from disk as the upload goes.
      const reader = part.stream().getReader();
      try {
        for (let r = await reader.read(); !r.done; r = await reader.read()) yield r.value;
      } finally {
        reader.releaseLock();
      }
    } else for (let i = 0; i < part.length; i += UPLOAD_CHUNK_BYTES) yield part.subarray(i, i + UPLOAD_CHUNK_BYTES);
  }
}

/**
 * POSTs a multipart body without redirects and resolves with the answer as a fetch Response.
 * Node's fetch reads a whole request body into memory before sending it (≈ 1× the file size
 * even for a stream body); node:http(s) streams it with backpressure, so neither a file nor
 * in-memory bytes are copied. A replaced global fetch is used instead (with one copy).
 * HTTP(S)_PROXY support (NODE_USE_ENV_PROXY / http.setGlobalProxyFromEnv) covers both.
 *
 * The body is sent only after `100 Continue` (`Expect: 100-continue`; after `EXPECT_WAIT_MS` without an
 * answer, for servers that ignore it): a server that refuses the upload from its headers (nginx in front of
 * Penpot answers 413 for a too-large Content-Length) or redirects it does so before a single byte of the file
 * travels, and that answer cannot be lost to a reset connection. A refusal while the body is being sent
 * (a write error: EPIPE / ECONNRESET) waits `PENDING_ANSWER_MS` for an answer that was already on its way.
 */
function streamPost(url: string, headers: Record<string, string>, body: Multipart, signal: AbortSignal, expectContinue = true): Promise<Response> {
  if (globalThis.fetch !== NATIVE_FETCH) {
    return fetch(url, { method: 'POST', headers, body: new Blob(body.parts as BlobPart[]), redirect: 'manual', signal });
  }
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    let answered = false;
    let sending = false;
    let failed: Error | undefined;
    const req = send(
      target,
      { method: 'POST', headers: { ...headers, 'content-length': String(body.length), ...(expectContinue ? { expect: '100-continue' } : {}) }, signal },
      (res) => {
        answered = true;
        clearTimeout(waitForContinue);
        if (!sending) {
          // Answered before the body went out: the body never will; the connection cannot be reused.
          if (expectContinue && res.statusCode === 417) {
            // The server does not do `Expect`: once more, without it.
            res.resume();
            req.destroy();
            streamPost(url, headers, body, signal, false).then(resolve, reject);
            return;
          }
          res.on('close', () => req.destroy());
        }
        resolve(toResponse(res));
      },
    );
    // Shaped like fetch's errors (`cause` = the socket error), which Session.failure reads.
    req.on('error', (error) => {
      if (answered) return;
      if (failed === undefined && sending && !signal.aborted) {
        // A write error after the server answered and closed: the answer may still be parsed.
        failed = error;
        setTimeout(() => {
          if (!answered) reject(new TypeError('fetch failed', { cause: error }));
        }, PENDING_ANSWER_MS).unref();
        return;
      }
      reject(new TypeError('fetch failed', { cause: error }));
    });
    const start = (): void => {
      if (sending || answered) return;
      sending = true;
      clearTimeout(waitForContinue);
      // pipe, not pipeline: a failed write after an early answer (413, redirect) must not destroy that answer.
      const source = Readable.from(bodyChunks(body.parts), { objectMode: false });
      source.on('error', (error) => req.destroy(error));
      req.on('close', () => source.destroy());
      source.pipe(req);
    };
    const waitForContinue = setTimeout(start, expectContinue ? EXPECT_WAIT_MS : 0);
    req.on('continue', start);
    if (expectContinue) req.flushHeaders();
  });
}

function toResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, v);
  }
  const status = res.statusCode ?? 500;
  const nullBody = status === 204 || status === 205 || status === 304;
  if (nullBody) res.resume();
  return new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers });
}

// --- body helpers ----------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads a camelCase key, falling back to its kebab-case spelling (transit bodies). */
function field(value: unknown, camel: string): unknown {
  const o = asRecord(value);
  return camel in o ? o[camel] : o[camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  try {
    if (contentType?.includes('transit')) return decodeTransit(text);
    if (contentType?.includes('json')) return JSON.parse(text);
  } catch {
    // fall through: not parseable
  }
  return undefined;
}

function decodeEventData(data: string): unknown {
  try {
    return decodeTransit(data);
  } catch {
    return data;
  }
}

function errorInfo(body: unknown): PenpotErrorInfo | undefined {
  const info: PenpotErrorInfo = {};
  for (const key of ['type', 'code', 'hint'] as const) {
    const v = field(body, key);
    if (typeof v === 'string') info[key] = v;
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

function describe(info: PenpotErrorInfo | undefined): string {
  if (!info) return '';
  const parts = [info.type && `type=${info.type}`, info.code && `code=${info.code}`, info.hint && `hint=${JSON.stringify(info.hint)}`];
  return `: ${parts.filter(Boolean).join(' ')}`;
}

function fileIds(end: unknown): string[] {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (Array.isArray(end)) return ids(end);
  for (const key of ['fileIds', 'ids']) {
    const v = ids(field(end, key));
    if (v.length > 0) return v;
  }
  const id = str(field(end, 'fileId')) ?? str(field(end, 'id'));
  return id ? [id] : [];
}

// --- .penpot manifest ------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  local: number;
}

type ZipSource = Uint8Array | Blob;

/**
 * The central directory of a zip, read without loading the rest: only the end-of-central-directory record
 * and the central directory itself. Undefined when `source` is not a (non-zip64) zip.
 */
async function zipDirectory(source: ZipSource): Promise<ZipEntry[] | undefined> {
  const size = source instanceof Blob ? source.size : source.length;
  if (size < 22) return undefined;
  // End of central directory: 22 bytes plus a comment of up to 64 KiB.
  const tailStart = Math.max(0, size - 22 - 0xffff);
  const tail = await readRange(source, tailStart, size);
  const t = dataView(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (t.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = t.getUint16(eocd + 10, true);
  const cdSize = t.getUint32(eocd + 12, true);
  const cdOffset = t.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > size) return undefined; // zip64 or damaged

  const cd = await readRange(source, cdOffset, cdOffset + cdSize);
  const c = dataView(cd);
  const utf8 = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
    if (c.getUint32(p, true) !== 0x02014b50) return undefined;
    const nameLength = c.getUint16(p + 28, true);
    entries.push({
      name: utf8.decode(cd.subarray(p + 46, p + 46 + nameLength)),
      method: c.getUint16(p + 10, true),
      compressed: c.getUint32(p + 20, true),
      local: c.getUint32(p + 42, true),
    });
    p += 46 + nameLength + c.getUint16(p + 30, true) + c.getUint16(p + 32, true);
  }
  return entries;
}

async function readRange(source: ZipSource, start: number, end: number): Promise<Uint8Array> {
  return source instanceof Blob ? new Uint8Array(await source.slice(start, end).arrayBuffer()) : source.subarray(start, end);
}

function dataView(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Reads `manifest.json` of a `.penpot` file (a zip) without loading the rest: only the
 * end-of-central-directory record, the central directory and the manifest entry are read.
 * Returns undefined when `source` is not a zip with a manifest; `name` is the first file's name.
 */
export async function readPenpotManifest(source: ZipSource): Promise<{ name: string | undefined } | undefined> {
  const entry = (await zipDirectory(source))?.find((e) => e.name === 'manifest.json');
  if (!entry) return undefined;
  if (entry.compressed > MANIFEST_MAX_BYTES || (entry.method !== 0 && entry.method !== 8)) return { name: undefined };
  const header = await readRange(source, entry.local, entry.local + 30);
  if (header.length < 30 || dataView(header).getUint32(0, true) !== 0x04034b50) return undefined;
  const start = entry.local + 30 + dataView(header).getUint16(26, true) + dataView(header).getUint16(28, true);
  const raw = await readRange(source, start, start + entry.compressed);
  try {
    const data = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: MANIFEST_MAX_BYTES });
    const name = (JSON.parse(new TextDecoder().decode(data)) as { files?: { name?: unknown }[] }).files?.[0]?.name;
    return { name: typeof name === 'string' && name.trim() ? name : undefined };
  } catch {
    return { name: undefined };
  }
}

/**
 * What identifies the content of a `.penpot` file in Penpot after its import: the ids of its pages and of
 * every shape on each page. Penpot's import gives the file (and its media) new ids but keeps page and shape
 * ids, and fig2pot derives them from the source's node ids, so two different designs do not share them.
 * Read from the zip's central directory only (`files/<file>/pages/<page>/<shape>.json`). Undefined when
 * `source` is not a zip with exactly one file and at least one page.
 */
export async function readPenpotContent(source: ZipSource): Promise<PenpotContent | undefined> {
  const entries = await zipDirectory(source);
  if (!entries) return undefined;
  const files = new Set<string>();
  const pages = new Map<string, Set<string>>();
  for (const { name } of entries) {
    const m = /^files\/([0-9a-f-]{36})\/pages\/([0-9a-f-]{36})(?:\.json|\/([0-9a-f-]{36})\.json)$/i.exec(name);
    if (!m) continue;
    files.add(m[1]!.toLowerCase());
    const page = m[2]!.toLowerCase();
    if (!pages.has(page)) pages.set(page, new Set());
    if (m[3]) pages.get(page)!.add(m[3].toLowerCase());
  }
  return files.size === 1 && pages.size > 0 ? { pages } : undefined;
}

/** Page id → ids of the shapes on that page (`readPenpotContent`). */
export interface PenpotContent {
  pages: Map<string, Set<string>>;
}

// --- Server-Sent Events ----------------------------------------------------

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser (WHATWG event-stream rules): LF, CR or CRLF line
 * endings, events and multi-byte characters split anywhere across chunks,
 * comment lines, multi-line `data:`.
 */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const line = (text: string): SseEvent | undefined => {
    if (text === '') {
      const out = data.length > 0 ? { event: event || 'message', data: data.join('\n') } : undefined;
      event = '';
      data = [];
      return out;
    }
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const name = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A trailing CR may be the first half of a CRLF: keep it until more input arrives.
      const re = /\r\n|\r(?!$)|\n/g;
      let start = 0;
      for (let m = re.exec(buffer); m; m = re.exec(buffer)) {
        const ev = line(buffer.slice(start, m.index));
        start = m.index + m[0].length;
        if (ev) yield ev;
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
        if (buffer !== '') line(buffer);
        const ev = line('');
        if (ev) yield ev;
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// --- transit ---------------------------------------------------------------

/**
 * Minimal transit-JSON reader (verbose and compact, with the key cache):
 * keywords, symbols and UUIDs become strings, sets and lists arrays, maps
 * plain objects with their (kebab-case) key names.
 */
export function decodeTransit(text: string): unknown {
  const cache: string[] = [];
  const CACHE_DIGITS = 44;
  const cacheable = (s: string, asKey: boolean): boolean =>
    s.length > 3 && (asKey || s.startsWith('~:') || s.startsWith('~$') || s.startsWith('~#'));

  const scalar = (s: string): unknown => {
    if (s.length < 2 || (s[0] !== '~' && s[0] !== '^')) return s;
    if (s[0] === '^') return s;
    switch (s[1]) {
      case '~':
      case '^':
      case '`':
        return s.slice(1);
      case ':':
      case '$':
      case 'u':
      case 'r':
        return s.slice(2);
      case '?':
        return s[2] === 't';
      case '_':
        return null;
      case 'i':
      case 'n':
      case 'd':
      case 'f':
      case 'm':
        return Number(s.slice(2));
      case 't':
        return Date.parse(s.slice(2));
      default:
        return s.slice(2);
    }
  };

  const readString = (s: string, asKey: boolean): string => {
    if (s.length > 1 && s[0] === '^' && s !== '^ ') {
      const idx = s.length === 2 ? s.charCodeAt(1) - 48 : (s.charCodeAt(1) - 48) * CACHE_DIGITS + (s.charCodeAt(2) - 48);
      return cache[idx] ?? s;
    }
    if (cacheable(s, asKey)) cache.push(s);
    return s;
  };

  const tagged = (tag: string, value: unknown): unknown => {
    switch (tag) {
      case 'set':
      case 'list':
        return value;
      case 'cmap': {
        const out: Record<string, unknown> = {};
        const arr = Array.isArray(value) ? value : [];
        for (let i = 0; i + 1 < arr.length; i += 2) out[String(arr[i])] = arr[i + 1];
        return out;
      }
      default:
        return value;
    }
  };

  const read = (v: unknown, asKey = false): unknown => {
    if (typeof v === 'string') return scalar(readString(v, asKey));
    if (Array.isArray(v)) {
      if (v[0] === '^ ') {
        const out: Record<string, unknown> = {};
        for (let i = 1; i + 1 < v.length; i += 2) out[String(read(v[i], true))] = read(v[i + 1]);
        return out;
      }
      if (v.length === 2 && typeof v[0] === 'string') {
        const head = readString(v[0], false);
        if (head.startsWith('~#')) return tagged(head.slice(2), read(v[1]));
        return [scalar(head), read(v[1])];
      }
      return v.map((x) => read(x));
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      const first = entries[0];
      if (entries.length === 1 && first && first[0].startsWith('~#')) return tagged(first[0].slice(2), read(first[1]));
      const out: Record<string, unknown> = {};
      for (const [k, x] of entries) out[String(read(k, true))] = read(x);
      return out;
    }
    return v;
  };

  return read(JSON.parse(text));
}
