#!/usr/bin/env node
import { openAsBlob } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { strFromU8 } from 'fflate';
import { decodeFig, FigDecodeError } from './fig/decode.ts';
import { buildTree } from './fig/tree.ts';
import type { FigNode } from './fig/types.ts';
import type { ConvertOptions } from './index.ts';
import {
  accessTokenProblem,
  DEFAULT_PENPOT_URL,
  normalizePenpotUrl,
  PenpotUploadError,
  readPenpotManifest,
  redactUrl,
  uploadToPenpot,
} from './penpot/upload.ts';
import { CollectingReporter } from './util/reporter.ts';

const USAGE = `fig2pot — convert Figma .fig files to .penpot

Usage:
  fig2pot <input.fig> [-o <output.penpot>] [options]   convert
  fig2pot <input.fig> --upload [-o <file>] [--json]    convert and import into Penpot
  fig2pot upload <file.penpot> [--json]                import an already converted file into Penpot
  fig2pot dump <input.fig> [--ir]                      print the decoded node tree (or the IR) as JSON

Options:
  -o, --output <file>        output path (default: <input name>.penpot in the current directory;
                             with --upload the file is written only when -o is given)
      --name <name>          document name (default: taken from the .fig file)
      --text <mode>          auto | editable | outline   (default: auto)
                             auto keeps text editable where Penpot draws it as Figma did and
                             outlines it otherwise: font or a character missing in Penpot,
                             truncation, underline / strikethrough, a list Penpot cannot
                             emulate, a gradient or image fill (svg renderer)
      --booleans <mode>      flatten | editable          (default: flatten)
                             flatten writes Figma's computed outline as one path (exact);
                             editable keeps the operands and lets Penpot recompute the result
      --line-breaks <mode>   source | reflow             (default: source)
                             source keeps Figma's line breaks exactly (each wrap becomes an
                             explicit break); reflow lets Penpot wrap editable text itself
      --no-components        emit components and instances as plain boards
      --no-bake              do not rasterise paints Penpot cannot draw (tiled or rotated images,
                             rotated crops, angular and diamond gradients); use Penpot's nearest
                             editable equivalent
      --bake-scale <n>       pixel density of baked and downsampled bitmaps (default: 2)
      --no-image-profiles    keep embedded colour profiles of images as they are (by default
                             images are stored as plain sRGB showing the colours Figma shows)
      --no-downsample        keep images at full resolution even where they are shown much
                             smaller (by default a copy filtered like Figma's is stored)
      --pixel-exact          also apply rewrites that only change sub-pixel anti-aliasing but alter
                             the design's structure: frames that hide nothing are written
                             non-clipping, inside/outside strokes are redrawn on inset boxes,
                             text spacing is corrected per glyph (--text-spacing glyph) and texts
                             whose glyphs Penpot's font draws with other shapes are outlined
      --text-spacing <mode>  line | glyph | none         (default: line; glyph with --pixel-exact)
                             letter spacing that corrects where Penpot's copy of a font has other
                             glyph widths than Figma's: line adjusts each line so that it starts
                             and ends where Figma drew it; glyph corrects every character (many
                             text leaves); none keeps Figma's spacing as it is
      --renderer <name>      svg | wasm                  (default: svg)
                             Penpot renderer the file is tuned for; they draw gradients and
                             blurs differently (svg is Penpot's default renderer)
  -q, --quiet                do not print warnings
      --verbose              print every warning instead of a summary
  -h, --help                 show this help

Upload:
      --upload               import the result into Penpot; prints the file's workspace URL
                             (first page) as the only line on stdout
      --json                 print one JSON object instead:
                             {url, fileId, teamId, projectId, name, pages: [{id, name, url}], warnings}
      --penpot-url <url>     Penpot base URL (default: $PENPOT_URL or ${DEFAULT_PENPOT_URL});
                             a bare host[:port] means https (http for localhost)
      --project <id>         target project id (default: $PENPOT_PROJECT_ID or your Drafts project)

Environment:
  PENPOT_ACCESS_TOKEN        personal access token, required to upload (never pass it as a flag).
                             Create one in Penpot → Your account → Access tokens.
  PENPOT_URL                 default for --penpot-url
  PENPOT_PROJECT_ID          default for --project
  HTTPS_PROXY, HTTP_PROXY,   proxy for the upload (it must support CONNECT); NO_PROXY lists hosts
  NO_PROXY                   to reach directly

Exit codes: 0 ok · 1 the input could not be read or converted · 2 usage error · 3 upload failed
`;

const TOKEN_HELP = `uploading needs a Penpot personal access token in the PENPOT_ACCESS_TOKEN environment variable.
Create one in Penpot → Your account → Access tokens, then: export PENPOT_ACCESS_TOKEN=<token>`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXIT_UPLOAD = 3;

class UsageError extends Error {
  readonly showUsage: boolean;
  constructor(message: string, showUsage = true) {
    super(message);
    this.showUsage = showUsage;
  }
}

/**
 * How a misplaced argument is shown: never in full, since it may be a secret pasted in the
 * wrong place. Only something that looks like a path (a `/`, or a short file extension at
 * the end) is hinted at, cut to a short prefix; with `words`, short lowercase words too.
 */
function hint(value: string, words = false): string | undefined {
  if (words && /^[a-z0-9-]{1,12}$/.test(value)) return `"${value}"`;
  if (!/\/|\.[a-z0-9]{1,6}$/i.test(value)) return undefined;
  return value.length <= 12 ? `"${value}"` : `"${value.slice(0, 12)}…"`;
}

function unexpectedArguments(extra: string[]): UsageError {
  const shown = extra.map((a) => hint(a)).filter((h): h is string => h !== undefined);
  const hidden = extra.length - shown.length;
  const list = [...shown, ...(hidden > 0 ? [`${hidden} not shown`] : [])].join(', ');
  return new UsageError(`${extra.length} unexpected argument${extra.length === 1 ? '' : 's'} (${list})`);
}

function invalidValue(flag: string, value: string, expected: string): UsageError {
  const shown = hint(value, true);
  return new UsageError(`invalid value for ${flag}${shown ? `: ${shown}` : ''} (expected ${expected})`);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw invalidValue(flag, value, allowed.join(' | '));
}

function bakeScaleOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) throw invalidValue('--bake-scale', value, 'a positive number');
  return scale;
}

/** JSON view of the raw tree: typed arrays and bigints are summarised so the dump stays readable. */
function dumpNode(node: FigNode): unknown {
  return { id: node.id, type: node.type, ...node.change, children: node.children.map(dumpNode) };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * The converter (and the Penpot builder library it pulls in) is loaded only when a conversion is
 * requested, so `fig2pot upload` and usage errors stay light and fast.
 */
function loadConverter(): Promise<typeof import('./index.ts')> {
  return import('./index.ts');
}

function printWarnings(reporter: CollectingReporter, verbose: boolean): void {
  if (reporter.warnings.length === 0) return;
  if (verbose) {
    for (const w of reporter.warnings) {
      const where = w.nodeId ? ` [${w.nodeId}${w.nodeName ? ` "${w.nodeName}"` : ''}]` : '';
      console.error(`warning ${w.code}${where}: ${w.message}`);
    }
    return;
  }
  console.error(`${reporter.warnings.length} warning(s):`);
  for (const { code, count, sample } of reporter.summary()) {
    console.error(`  ${String(count).padStart(5)} × ${code} — e.g. ${sample.message}`);
  }
  console.error('Run with --verbose to list every warning.');
}

// --- upload ----------------------------------------------------------------

interface UploadTarget {
  baseUrl: string;
  accessToken: string;
  projectId: string | undefined;
}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

/** Validates the upload configuration before any work is done. */
function uploadTarget(values: { 'penpot-url'?: string | undefined; project?: string | undefined }): UploadTarget {
  const accessToken = env('PENPOT_ACCESS_TOKEN');
  if (!accessToken) throw new UsageError(TOKEN_HELP, false);
  const problem = accessTokenProblem(accessToken);
  if (problem) throw new UsageError(`PENPOT_ACCESS_TOKEN: ${problem}`, false);
  let baseUrl: string;
  try {
    baseUrl = normalizePenpotUrl(values['penpot-url'] ?? env('PENPOT_URL') ?? DEFAULT_PENPOT_URL);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const projectId = values.project?.trim() || env('PENPOT_PROJECT_ID');
  if (projectId !== undefined && !UUID_RE.test(projectId)) {
    throw new UsageError('invalid project id (expected a UUID like 1b6f6e2c-…, from the project URL)');
  }
  useProxyFromEnv();
  return { baseUrl, accessToken, projectId };
}

/**
 * Node's fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1 / --use-env-proxy is given;
 * http.setGlobalProxyFromEnv() (present in Node 24.18) turns the same support on from here.
 */
function useProxyFromEnv(): void {
  const name = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'].find((n) => process.env[n]?.trim());
  if (!name || process.env.NODE_USE_ENV_PROXY === '1') return;
  const setGlobalProxyFromEnv = (http as { setGlobalProxyFromEnv?: () => unknown }).setGlobalProxyFromEnv;
  if (typeof setGlobalProxyFromEnv !== 'function') {
    console.error(`fig2pot: ${name} is set but this Node version ignores it; run with NODE_USE_ENV_PROXY=1`);
    return;
  }
  try {
    setGlobalProxyFromEnv();
  } catch {
    // Node's message quotes the proxy URL, credentials included.
    throw new UsageError(`${name} is not a valid proxy URL (expected http://host:port): ${redactUrl(process.env[name]!.trim())}`, false);
  }
}

/** The document name stored in a `.penpot` file's manifest; throws a UsageError when it is not one. */
async function penpotName(file: Uint8Array | Blob, path: string): Promise<string | undefined> {
  const manifest = await readPenpotManifest(file);
  if (!manifest) {
    const head = file instanceof Blob ? new Uint8Array(await file.slice(0, 8).arrayBuffer()) : file.subarray(0, 8);
    const fig = extname(path).toLowerCase() === '.fig' || strFromU8(head) === 'fig-kiwi';
    throw new UsageError(
      fig ? `${path} is a .fig file; convert and upload it with: fig2pot ${path} --upload` : `${path} is not a .penpot file`,
      false,
    );
  }
  return manifest.name;
}

/** The file as a Blob read from disk on demand; file-system errors (missing, a directory…) are thrown up front. */
async function openFile(path: string): Promise<Blob> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) {
      throw Object.assign(new Error(`EISDIR: not a regular file, open '${path}'`), { code: 'EISDIR', syscall: 'open', path });
    }
  } finally {
    await handle.close();
  }
  return openAsBlob(path);
}

function printUploadError(error: PenpotUploadError): void {
  if (error.fileId !== undefined) {
    // The import succeeded: uploading again would create a second copy.
    console.error(`fig2pot: the file WAS imported into Penpot (file id ${error.fileId}), but a later step failed: ${error.message}`);
    if (error.url) console.error(`fig2pot: open it at ${error.url}`);
    console.error('fig2pot: do not upload it again, that would create a duplicate.');
    return;
  }
  console.error(`fig2pot: upload failed: ${error.message}`);
  if (error.importMayHaveCompleted === true) {
    console.error('fig2pot: Penpot MAY HAVE IMPORTED the file anyway. Uploading it again without checking could create a duplicate.');
  }
  if (error.projectUrl) console.error(`fig2pot: check the project: ${error.projectUrl}`);
  if (error.status === 401 || error.status === 403) {
    console.error('Check PENPOT_ACCESS_TOKEN (Penpot → Your account → Access tokens) and that it belongs to a member of the target project.');
  }
}

/** Writes to stdout; false instead of an EPIPE crash when nobody reads it any more (`| head -n0`). */
function writeStdout(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Kept: the error event may come after the write callback.
    process.stdout.on('error', () => resolve(false));
    process.stdout.write(text, (error) => resolve(!error));
  });
}

async function upload(penpot: Uint8Array | Blob, name: string, target: UploadTarget, json: boolean, warnings: number): Promise<void> {
  const size = penpot instanceof Blob ? penpot.size : penpot.length;
  console.error(`uploading ${(size / 1024).toFixed(0)} KiB to ${target.baseUrl} …`);
  const result = await uploadToPenpot(penpot, { ...target, name });
  if (result.recovered) console.error(`fig2pot: the import request failed (${result.recovered}), but the file is in the project: it was imported`);
  console.error(`imported "${result.name}" (${result.pages.length} page(s)) as file ${result.fileId}`);
  const out = json
    ? JSON.stringify({
        url: result.url,
        fileId: result.fileId,
        teamId: result.teamId,
        projectId: result.projectId,
        name: result.name,
        pages: result.pages,
        warnings,
      })
    : result.url;
  if (!(await writeStdout(`${out}\n`))) console.error(`fig2pot: stdout is closed; the file is at ${result.url}`);
}

/**
 * Writes `<input>.penpot` next to the input, or `<input>-1.penpot`, … — never over an existing file.
 * `uncertain`: the failed import may have gone through, so a retry is not offered as safe.
 */
async function saveFallback(penpot: Uint8Array, input: string, uncertain: boolean): Promise<void> {
  const stem = join(dirname(input), basename(input, extname(input)));
  for (let n = 0; n < 1000; n++) {
    const path = n === 0 ? `${stem}.penpot` : `${stem}-${n}.penpot`;
    try {
      await writeFile(path, penpot, { flag: 'wx' });
      console.error(
        uncertain
          ? `fig2pot: saved the converted file as ${path}; only if the project does not have it, upload it with: fig2pot upload ${path}`
          : `fig2pot: saved the converted file as ${path}; retry with: fig2pot upload ${path}`,
      );
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      console.error(`fig2pot: could not save the converted file (${(error as Error).message})`);
      return;
    }
  }
  console.error(`fig2pot: could not save the converted file: ${stem}.penpot and its numbered variants all exist`);
}

// --- main ------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  if (argv.some((a) => /^--(penpot-)?(access-)?token(=|$)/.test(a))) {
    throw new UsageError('the access token is read only from the PENPOT_ACCESS_TOKEN environment variable, never from a flag', false);
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      name: { type: 'string' },
      text: { type: 'string' },
      booleans: { type: 'string' },
      'no-components': { type: 'boolean' },
      'line-breaks': { type: 'string' },
      'no-bake': { type: 'boolean' },
      'bake-scale': { type: 'string' },
      'no-image-profiles': { type: 'boolean' },
      'no-downsample': { type: 'boolean' },
      'pixel-exact': { type: 'boolean' },
      'text-spacing': { type: 'string' },
      renderer: { type: 'string' },
      ir: { type: 'boolean' },
      upload: { type: 'boolean' },
      json: { type: 'boolean' },
      'penpot-url': { type: 'string' },
      project: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length === 0) throw new UsageError('missing input file');

  const uploadCommand = positionals[0] === 'upload';
  const uploading = uploadCommand || values.upload === true;
  if (!uploading) {
    for (const flag of ['json', 'penpot-url', 'project'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} only applies with --upload or the upload command`);
    }
  }

  if (positionals[0] === 'dump') {
    if (values.upload) throw new UsageError('dump: --upload is not supported');
    const input = positionals[1];
    if (!input) throw new UsageError('dump: missing input file');
    const bytes = await readFile(input);
    if (values.ir) {
      const reporter = new CollectingReporter();
      const { figToIR } = await loadConverter();
      const document = figToIR(bytes, reporter);
      process.stdout.write(JSON.stringify(document, jsonReplacer, 2) + '\n');
      if (!values.quiet) printWarnings(reporter, values.verbose ?? false);
    } else {
      const doc = buildTree(decodeFig(bytes));
      const out = { version: doc.file.version, meta: doc.file.meta, document: dumpNode(doc.root) };
      process.stdout.write(JSON.stringify(out, jsonReplacer, 2) + '\n');
    }
    return 0;
  }

  if (uploadCommand) {
    const input = positionals[1];
    if (!input) throw new UsageError('upload: missing .penpot file');
    if (positionals.length > 2) throw unexpectedArguments(positionals.slice(2));
    for (const flag of ['output', 'text', 'booleans', 'no-components', 'line-breaks', 'no-bake', 'bake-scale', 'no-image-profiles', 'no-downsample', 'pixel-exact', 'text-spacing', 'renderer', 'ir'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`upload: --${flag} does not apply to an already converted file`);
    }
    const target = uploadTarget(values);
    // Streamed from disk: the file is never held in memory.
    const file = await openFile(input);
    const name = values.name ?? (await penpotName(file, input)) ?? basename(input, extname(input));
    try {
      await upload(file, name, target, values.json ?? false, 0);
    } catch (error) {
      if (!(error instanceof PenpotUploadError)) throw error;
      printUploadError(error);
      return EXIT_UPLOAD;
    }
    return 0;
  }

  const input = positionals[0]!;
  if (positionals.length > 1) throw unexpectedArguments(positionals.slice(1));
  const target = uploading ? uploadTarget(values) : undefined;
  const output = values.output ?? (uploading ? undefined : `${basename(input, extname(input))}.penpot`);
  const options: ConvertOptions = {
    name: values.name,
    textMode: oneOf(values.text, ['auto', 'editable', 'outline'] as const, '--text'),
    booleanMode: oneOf(values.booleans, ['editable', 'flatten'] as const, '--booleans'),
    components: values['no-components'] ? false : undefined,
    textLineBreaks: oneOf(values['line-breaks'], ['source', 'reflow'] as const, '--line-breaks'),
    bakeUnsupportedPaints: values['no-bake'] ? false : undefined,
    bakeScale: bakeScaleOf(values['bake-scale']),
    convertImageProfiles: values['no-image-profiles'] ? false : undefined,
    downsampleImages: values['no-downsample'] ? false : undefined,
    pixelExact: values['pixel-exact'] ? true : undefined,
    textSpacing: oneOf(values['text-spacing'], ['line', 'glyph', 'none'] as const, '--text-spacing'),
    renderer: oneOf(values.renderer, ['svg', 'wasm'] as const, '--renderer'),
  };

  const { convert } = await loadConverter();
  const { penpot, warnings } = await convert(await readFile(input), options);
  if (!values.quiet) {
    const reporter = new CollectingReporter();
    for (const w of warnings) reporter.warn(w);
    printWarnings(reporter, values.verbose ?? false);
  }
  if (output !== undefined) {
    await writeFile(output, penpot);
    console.error(`wrote ${output} (${(penpot.length / 1024).toFixed(0)} KiB)`);
  }
  if (!target) return 0;

  const name = values.name ?? (await penpotName(penpot, input)) ?? basename(input, extname(input));
  try {
    await upload(penpot, name, target, values.json ?? false, warnings.length);
  } catch (error) {
    if (!(error instanceof PenpotUploadError)) throw error;
    printUploadError(error);
    // Not known to be imported: keep the converted file so the upload can be retried without converting again.
    if (output === undefined && error.fileId === undefined) await saveFallback(penpot, input, error.importMayHaveCompleted === true);
    return EXIT_UPLOAD;
  }
  return 0;
}

/** Safety net: whatever ends up on stderr (a path, a stack trace…), the token is not printed. */
function redactStderr(secret: string | undefined): void {
  if (secret === undefined || secret.length < 8) return;
  const write = process.stderr.write.bind(process.stderr) as (chunk: unknown, ...rest: unknown[]) => boolean;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(typeof chunk === 'string' ? chunk.split(secret).join('<redacted>') : chunk, ...rest)) as typeof process.stderr.write;
}

redactStderr(env('PENPOT_ACCESS_TOKEN'));
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (error instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
      console.error(`fig2pot: ${(error as Error).message}\n`);
      if (!(error instanceof UsageError) || error.showUsage) console.error(USAGE);
      process.exitCode = 2;
    } else if (error instanceof PenpotUploadError) {
      printUploadError(error);
      process.exitCode = EXIT_UPLOAD;
    } else if (error instanceof FigDecodeError) {
      console.error(`fig2pot: ${error.message}`);
      process.exitCode = 1;
    } else if (typeof (error as NodeJS.ErrnoException).syscall === 'string' && (error as NodeJS.ErrnoException).code) {
      // File-system errors (missing file, directory given, permission denied…): one line, no stack.
      console.error(`fig2pot: ${(error as Error).message}`);
      process.exitCode = 1;
    } else {
      console.error(error);
      process.exitCode = 1;
    }
  },
);
