/**
 * Visual-verification harness: import a `.penpot` into the local Penpot,
 * export boards with Penpot's own exporter and diff them against Figma
 * reference renders. See README.md.
 *
 *   node tools/visual/run.ts --penpot <file.penpot> --refs <dir> [--out <dir>] [--scale 1] [--metric visual] [--min 0.98] [--min-local 0.85] [--keep]
 *   node tools/visual/run.ts --penpot <file.penpot> --list
 *   node tools/visual/run.ts --penpot <file.penpot> --render-only [--out <dir>]
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { penpotId } from '../../src/penpot/ids.ts';
import { diffImages, MIN_LOCAL, MIN_REGIONAL, MIN_VISUAL, PERCEPTUAL_RADIUS, VISUAL_ALLOWANCE, visualPasses, type DiffOptions, type DiffResult, type Rect, type Size } from './diff.ts';
import {
  exporterLogs,
  isReady,
  PENPOT_VERSION,
  PenpotClient,
  PenpotError,
  PenpotImportError,
  topLevelBoards,
  up,
  type PenpotFile,
  type PenpotShape,
  type Renderer,
} from './penpot.ts';
import { renderHtmlReport } from './report.ts';

export const WORK_DIR = fileURLToPath(new URL('./.work/', import.meta.url));

/** A page-space rectangle as written by tools/figma-refs/capture.js. */
export interface ManifestRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManifestEntry {
  nodeId: string;
  name?: string;
  page?: string;
  scale?: number;
  type?: string;
  /** The node's own size (= box size). */
  width?: number;
  height?: number;
  /** The node's own bounding box, page space. */
  box?: ManifestRect;
  /** The page-space area the reference PNG covers (box + strokes, shadows, overflow). */
  renderBounds?: ManifestRect;
}

/**
 * Which pass rule decides pass/fail, sort order and exit code. 'visual' (the default) is the
 * acceptance rule (README "Acceptance"): visualAccuracy ≥ --min (or the small-board allowance)
 * AND regionalAccuracy ≥ --min-regional AND localAccuracy ≥ --min-local. The others are a
 * single ratio ≥ --min, kept for continuity.
 */
export type MetricName = 'visual' | 'perceptual' | 'content' | 'full';
export const METRICS: readonly MetricName[] = ['visual', 'perceptual', 'content', 'full'];
/** DiffResult field of each metric. */
export const METRIC_FIELD = {
  visual: 'visualAccuracy',
  perceptual: 'perceptualAccuracy',
  content: 'contentAccuracy',
  full: 'accuracy',
} as const satisfies Record<MetricName, keyof DiffResult>;
export const DEFAULT_METRIC: MetricName = 'visual';

/** The selected metric's value for a board (undefined: not compared, or a report from before the metric existed). */
export function metricValue(m: DiffResult | undefined, metric: MetricName): number | undefined {
  return m?.[METRIC_FIELD[metric]];
}

/** A pass rule: the metric, its threshold, and (visual only) the local and regional thresholds. */
export interface PassRule {
  metric: MetricName;
  min: number;
  minLocal: number;
  minRegional: number;
}

export const DEFAULT_RULE: PassRule = { metric: DEFAULT_METRIC, min: MIN_VISUAL, minLocal: MIN_LOCAL, minRegional: MIN_REGIONAL };

/** The rule a report was scored with (older reports: no local / regional thresholds → defaults). */
export function ruleOf(r: { metric?: MetricName; min?: number; minLocal?: number; minRegional?: number }): PassRule {
  return { metric: r.metric ?? 'perceptual', min: r.min ?? MIN_VISUAL, minLocal: r.minLocal ?? MIN_LOCAL, minRegional: r.minRegional ?? MIN_REGIONAL };
}

/** Whether a board's metrics pass the rule (no metrics, or no visual metric in an old report: fail). */
export function boardPasses(m: DiffResult | undefined, rule: PassRule): boolean {
  if (!m) return false;
  if (rule.metric === 'visual') return m.visualAccuracy !== undefined && visualPasses(m, rule.min, rule.minLocal, rule.minRegional);
  return (metricValue(m, rule.metric) ?? -1) >= rule.min;
}

/**
 * Worst-first order under a rule: boards without metrics, then failing boards, then passing
 * ones. With the visual rule failing boards are ordered by localAccuracy, then visualAccuracy;
 * otherwise by the metric, then strict content accuracy.
 */
export function compareBoards(a: { metrics?: DiffResult }, b: { metrics?: DiffResult }, rule: PassRule): number {
  const ma = a.metrics;
  const mb = b.metrics;
  if (!ma || !mb) return (ma ? 1 : 0) - (mb ? 1 : 0);
  const pa = boardPasses(ma, rule) ? 1 : 0;
  const pb = boardPasses(mb, rule) ? 1 : 0;
  if (pa !== pb) return pa - pb;
  if (rule.metric === 'visual') return (ma.localAccuracy ?? -1) - (mb.localAccuracy ?? -1) || (ma.visualAccuracy ?? -1) - (mb.visualAccuracy ?? -1);
  return (metricValue(ma, rule.metric) ?? -1) - (metricValue(mb, rule.metric) ?? -1) || ma.contentAccuracy - mb.contentAccuracy;
}

/** Renderer choice on the command line: one engine, or both (primary = svg). */
export type RendererOption = Renderer | 'both';

export interface BoardTarget {
  nodeId: string | null;
  shapeId: string;
  pageId: string;
  pageName: string;
  name: string;
  width: number;
  height: number;
  scale: number;
  /** How the Penpot shape was found. */
  matchedBy: 'id' | 'name' | 'board';
  /** File stem used for the PNGs in the out dir. */
  key: string;
  referencePath?: string;
  /** Where the node box sits in the reference PNG, reference px (from the manifest). */
  referenceBox?: Rect;
  /** Expected reference PNG size (render bounds × scale), when the manifest has it. */
  referenceRenderSize?: Size;
  /** The Penpot shape's bounding box in reference px (registration priors). */
  candidateBox?: Rect;
  /** Predicted area of Penpot's export in reference px (`exportBounds`; the 'bounds' prior). */
  candidateExtent?: Rect;
}

export interface RendererFiles {
  candidate?: string;
  diff?: string;
}

export interface BoardReport {
  nodeId: string | null;
  shapeId: string | null;
  name: string;
  page: string;
  scale: number;
  matchedBy: BoardTarget['matchedBy'] | null;
  status: 'ok' | 'below-min' | 'missing-shape' | 'export-failed';
  error?: string;
  exportMs?: number;
  attempts?: number;
  /** Metrics of the primary renderer (`Report.renderer`); pass/fail is decided on these. */
  metrics?: DiffResult;
  files?: { reference?: string; candidate?: string; diff?: string };
  /** Every renderer of the run (with `--renderer both`: svg and wasm). */
  metricsByRenderer?: Partial<Record<Renderer, DiffResult>>;
  filesByRenderer?: Partial<Record<Renderer, RendererFiles>>;
  errorsByRenderer?: Partial<Record<Renderer, string>>;
}

export interface Summary {
  boards: number;
  compared: number;
  failed: number;
  /** Boards passing the run's rule. */
  passed: number;
  /** Trivial boards (no salient pixel, one flat colour): pass, excluded from the visual / local / regional stats. */
  trivial: number;
  accuracy: Stats;
  contentAccuracy: Stats;
  perceptualAccuracy: Stats;
  visualAccuracy: Stats;
  localAccuracy: Stats;
  regionalAccuracy: Stats;
}

export interface Stats {
  mean: number;
  median: number;
  min: number;
  /** Share of boards with value ≥ 0.98 (failures count as 0). */
  shareAtLeast98: number;
  /** Share of boards with value ≥ the run's `--min` (failures count as 0). */
  shareAtLeastMin: number;
}

export interface Report {
  tool: 'fig2pot-visual';
  penpotVersion: string;
  /** The primary renderer: `metrics`, `summary`, status and exit code refer to it. */
  renderer: Renderer;
  /** Every renderer of the run, primary first. */
  renderers: Renderer[];
  input: string;
  fileId: string;
  workspaceUrl: string | null;
  kept: boolean;
  min: number;
  /** The metric `min` applies to; `status` and the sort order follow it. */
  metric: MetricName;
  /** Visual rule: thresholds of localAccuracy and regionalAccuracy. */
  minLocal: number;
  minRegional: number;
  /** Neighbourhood radius of `perceptualAccuracy`, px (`--tolerance-px`). */
  tolerancePx: number;
  timings: { importMs: number; exportsMs: number; totalMs: number };
  summary: Summary;
  summaryByRenderer: Partial<Record<Renderer, Summary>>;
  warnings: string[];
  boards: BoardReport[];
}

const USAGE = `usage:
  node tools/visual/run.ts --penpot <file.penpot> --refs <dir> [--out <dir>] [--scale 1] [--min 0.98] [--min-local 0.85] [--keep]
  node tools/visual/run.ts --penpot <file.penpot> --list [--keep]
  node tools/visual/run.ts --penpot <file.penpot> --render-only [--out <dir>] [--scale 1] [--keep]
options:
  --renderer svg|wasm|both  render engine (default svg = what a Penpot 2.19 user sees by default);
                        both = export every board with svg and wasm, pass/fail on svg
  --concurrency <n>     parallel boards (default 4 for svg, 2 for wasm and both)
  --metric visual|perceptual|content|full
                        pass rule (default visual: visualAccuracy ≥ --min, or ≤ ${VISUAL_ALLOWANCE} mismatched
                        salient px, AND regionalAccuracy ≥ --min-regional AND localAccuracy ≥
                        --min-local; perceptual / content / full: that one ratio ≥ --min)
  --min <ratio>         pass threshold on that metric (default 0.98)
  --min-local <ratio>   visual rule: localAccuracy threshold (default ${MIN_LOCAL})
  --min-regional <ratio>
                        visual rule: regionalAccuracy threshold (default ${MIN_REGIONAL})
  --tolerance-px <n>    neighbourhood radius of the perceptual metric (default ${PERCEPTUAL_RADIUS}; 0 = strict)
  --keep                keep the imported file in Penpot (prints its workspace URL)
  --no-up               fail instead of starting the docker stack when Penpot is down
exit codes: 0 every board passes the rule, 1 some board fails / is missing / failed to export, 2 import failure, 3 usage / infra error`;

const log = (msg: string): void => {
  process.stderr.write(`[visual] ${msg}\n`);
};

export function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._;-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'file';
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function isTransient(error: unknown): boolean {
  if (error instanceof PenpotError) {
    const s = error.status;
    return s === undefined || s === 0 || s === 429 || s >= 500;
  }
  return true; // network errors, timeouts
}

export async function exportWithRetry(
  client: PenpotClient,
  params: Parameters<PenpotClient['exportShape']>[0],
  attempts = 3,
): Promise<{ png: Uint8Array; attempts: number; ms: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const t0 = Date.now();
    try {
      const png = await client.exportShape(params);
      return { png, attempts: attempt, ms: Date.now() - t0 };
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  throw lastError;
}

export function stats(values: number[], total: number, min = 0.98): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const padded = n < total ? [...Array(total - n).fill(0), ...sorted] : sorted;
  const m = padded.length;
  if (m === 0) return { mean: 0, median: 0, min: 0, shareAtLeast98: 0, shareAtLeastMin: 0 };
  const median = m % 2 ? padded[(m - 1) / 2]! : (padded[m / 2 - 1]! + padded[m / 2]!) / 2;
  return {
    mean: padded.reduce((s, v) => s + v, 0) / m,
    median,
    min: padded[0]!,
    shareAtLeast98: padded.filter((v) => v >= 0.98).length / m,
    shareAtLeastMin: padded.filter((v) => v >= min).length / m,
  };
}

/** Summary of one renderer's metrics (missing ones count as 0, as in `summarize`). */
export function summarizeRenderer(boards: BoardReport[], renderer: Renderer, rule: PassRule = DEFAULT_RULE): Summary {
  return summarize(boards.map((b) => ({ ...b, metrics: b.metricsByRenderer?.[renderer] })), rule);
}

/**
 * Totals. Missing boards and failed exports count as 0. The visual, local and regional stats
 * leave trivial boards out (of the values and of the total): an empty board says nothing.
 * `shareAtLeastMin` uses the rule's own threshold for each (min, minLocal, minRegional).
 */
export function summarize(boards: BoardReport[], rule: PassRule = DEFAULT_RULE): Summary {
  const compared = boards.filter((b) => b.metrics);
  const trivial = compared.filter((b) => b.metrics!.trivial).length;
  const of = (metric: MetricName): Stats => stats(compared.map((b) => metricValue(b.metrics, metric) ?? 0), boards.length, rule.min);
  const nonTrivial = compared.filter((b) => !b.metrics!.trivial);
  const visualOf = (get: (m: DiffResult) => number | undefined, min: number): Stats => stats(nonTrivial.map((b) => get(b.metrics!) ?? 0), boards.length - trivial, min);
  return {
    boards: boards.length,
    compared: compared.length,
    failed: boards.length - compared.length,
    passed: compared.filter((b) => boardPasses(b.metrics, rule)).length,
    trivial,
    accuracy: of('full'),
    contentAccuracy: of('content'),
    perceptualAccuracy: of('perceptual'),
    visualAccuracy: visualOf((m) => m.visualAccuracy, rule.min),
    localAccuracy: visualOf((m) => m.localAccuracy, rule.minLocal),
    regionalAccuracy: visualOf((m) => m.regionalAccuracy, rule.minRegional),
  };
}

async function loadReferences(refsDir: string): Promise<{ nodeId: string; path: string | null; entry: ManifestEntry | null }[]> {
  if (!existsSync(refsDir)) throw new Error(`--refs directory not found: ${refsDir}`);
  const manifestPath = join(refsDir, 'manifest.json');
  const manifest = new Map<string, ManifestEntry>();
  if (existsSync(manifestPath)) {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as ManifestEntry[];
    if (!Array.isArray(parsed)) throw new Error(`${manifestPath}: expected an array of { nodeId, name?, page?, scale?, box?, renderBounds? }`);
    for (const e of parsed) manifest.set(e.nodeId, e);
  }
  const pngs = (await readdir(refsDir)).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const out: { nodeId: string; path: string | null; entry: ManifestEntry | null }[] = [];
  const seen = new Set<string>();
  for (const f of pngs) {
    const nodeId = basename(f, extname(f)).replace(/-/g, ':');
    seen.add(nodeId);
    out.push({ nodeId, path: join(refsDir, f), entry: manifest.get(nodeId) ?? null });
  }
  for (const [nodeId, entry] of manifest) if (!seen.has(nodeId)) out.push({ nodeId, path: null, entry });
  return out;
}

/** Finds the Penpot shape for a Figma node: by derived id first, then by (page, name). */
export function locate(file: PenpotFile, nodeId: string, entry: ManifestEntry | null): { shape: PenpotShape; pageId: string; pageName: string; matchedBy: 'id' | 'name' } | null {
  const id = penpotId(nodeId);
  for (const page of file.pages) {
    const shape = page.objects[id];
    if (shape) return { shape, pageId: page.id, pageName: page.name, matchedBy: 'id' };
  }
  if (entry?.name) {
    const candidates = file.pages
      .filter((p) => !entry.page || p.name === entry.page)
      .flatMap((p) => topLevelBoards(p).filter((s) => s.name === entry.name).map((s) => ({ shape: s, pageId: p.id, pageName: p.name })));
    if (candidates.length === 1) return { ...candidates[0]!, matchedBy: 'name' };
  }
  return null;
}

/**
 * Where the node's box sits inside the reference PNG, in reference px. New manifests give the
 * box and the render bounds the PNG covers; old ones only the size (PNG = box at the origin).
 */
export function referenceBox(entry: ManifestEntry | null, scale: number): Rect | undefined {
  if (entry?.box && entry.renderBounds) {
    return {
      x: Math.round((entry.box.x - entry.renderBounds.x) * scale),
      y: Math.round((entry.box.y - entry.renderBounds.y) * scale),
      width: entry.box.width * scale,
      height: entry.box.height * scale,
    };
  }
  if (entry?.width !== undefined && entry.height !== undefined) return { x: 0, y: 0, width: entry.width * scale, height: entry.height * scale };
  return undefined;
}

/**
 * Page-space axis-aligned bounding box of a Penpot shape: its transformed `points`, else its
 * `selrect`, else x/y/width/height. (For paths, `x`/`width`… are null and the selrect is the
 * path geometry's bounds, which for a Figma VECTOR can be smaller than the node box.)
 */
export function shapeBox(shape: PenpotShape): Rect | null {
  const points = shape['points'];
  if (Array.isArray(points) && points.length > 0 && points.every((p) => typeof p?.x === 'number' && typeof p?.y === 'number')) {
    const xs = (points as Point[]).map((p) => p.x);
    const ys = (points as Point[]).map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  const sel = shape['selrect'] as Partial<Rect> | undefined;
  if (typeof sel?.x === 'number' && typeof sel.y === 'number' && typeof sel.width === 'number' && typeof sel.height === 'number') {
    return { x: sel.x, y: sel.y, width: sel.width, height: sel.height };
  }
  if ([shape.x, shape.y, shape.width, shape.height].every((v) => typeof v === 'number')) return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  return null;
}

/**
 * The Penpot shape's box in reference px. The converter keeps page coordinates, so with a
 * new-format manifest it is placed relative to the render bounds; with an old one (PNG = box
 * at the origin) it is placed relative to the Figma box, assuming the two share a centre.
 */
export function candidateBox(entry: ManifestEntry | null, shape: PenpotShape, scale: number): Rect | undefined {
  const box = shapeBox(shape);
  if (!box) return undefined;
  if (entry?.box && entry.renderBounds) {
    return { x: (box.x - entry.renderBounds.x) * scale, y: (box.y - entry.renderBounds.y) * scale, width: box.width * scale, height: box.height * scale };
  }
  if (entry?.width !== undefined && entry.height !== undefined) {
    return { x: ((entry.width - box.width) / 2) * scale, y: ((entry.height - box.height) / 2) * scale, width: box.width * scale, height: box.height * scale };
  }
  return undefined;
}

/** Children of a shape that Penpot's export does not reach into: clipping boards, masks, booleans. */
function stopsAt(shape: PenpotShape): boolean {
  return (shape.type === 'frame' && shape['showContent'] !== true) || shape.type === 'bool' || shape['maskedGroup'] === true;
}

/**
 * Page-space area Penpot's exporter renders for a shape, without stroke / shadow / blur
 * padding: its box, unioned with every descendant's box unless the shape clips (a board without
 * `showContent`, a masked group, a boolean). Descendants are visited the same way, so the
 * children of a clipping child board are not included. Invisible descendants count too (Penpot
 * sizes the export from geometry): this is what gives auto-layout-playground "Contents" its
 * 53 px of transparent overflow on the right.
 */
export function exportBounds(objects: Record<string, PenpotShape>, shape: PenpotShape): Rect | null {
  const base = shapeBox(shape);
  if (!base) return null;
  let x0 = base.x;
  let y0 = base.y;
  let x1 = base.x + base.width;
  let y1 = base.y + base.height;
  const seen = new Set<string>([shape.id]);
  const visit = (id: string): void => {
    const s = objects[id];
    if (!s || seen.has(id)) return;
    seen.add(id);
    const b = shapeBox(s);
    if (b) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    if (!stopsAt(s)) for (const c of s.shapes ?? []) visit(c);
  };
  if (!stopsAt(shape)) for (const c of shape.shapes ?? []) visit(c);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A page-space rectangle in reference px: relative to the render bounds (new manifest) or, as `candidateBox`, to the Figma box. */
function toReference(entry: ManifestEntry | null, rect: Rect, scale: number): Rect | undefined {
  if (entry?.box && entry.renderBounds) {
    return { x: (rect.x - entry.renderBounds.x) * scale, y: (rect.y - entry.renderBounds.y) * scale, width: rect.width * scale, height: rect.height * scale };
  }
  return undefined;
}

/**
 * Everything `diffImages` needs to know about where things sit, for one board: the Figma box
 * and expected PNG size from the manifest, the Penpot box and predicted export area from the
 * file. Used by run.ts and rediff.ts alike.
 */
export function boardGeometry(
  entry: ManifestEntry | null,
  objects: Record<string, PenpotShape> | undefined,
  shape: PenpotShape,
  scale: number,
): Pick<DiffOptions, 'referenceBox' | 'referenceRenderSize' | 'candidateBox' | 'candidateExtent'> {
  const extent = objects ? exportBounds(objects, shape) : null;
  return {
    referenceBox: referenceBox(entry, scale),
    referenceRenderSize: entry?.renderBounds ? scaled(entry.renderBounds, scale) : undefined,
    candidateBox: candidateBox(entry, shape, scale),
    candidateExtent: extent ? toReference(entry, extent, scale) : undefined,
  };
}

interface Point {
  x: number;
  y: number;
}

const scaled = (s: Size, scale: number): Size => ({ width: s.width * scale, height: s.height * scale });

function fmt(v: number | undefined): string {
  return v === undefined ? '   —   ' : `${(v * 100).toFixed(2).padStart(6)}%`;
}

/** Short description of a board's registration / bounds, for the console and the HTML report. */
export function boundsNote(m: DiffResult): string {
  const d = m.boundsDelta;
  return m.boundsMismatch ? `bounds Δ l${d.left} t${d.top} r${d.right} b${d.bottom}` : '';
}

/** One-line description of a pass rule. */
export function ruleText(rule: PassRule): string {
  return rule.metric === 'visual'
    ? `visual ≥ ${fmt(rule.min).trim()} (or ≤ ${VISUAL_ALLOWANCE} px) & regional ≥ ${fmt(rule.minRegional).trim()} & local ≥ ${fmt(rule.minLocal).trim()}`
    : `${rule.metric} ≥ ${fmt(rule.min).trim()}`;
}

function printSummary(label: string, s: Summary, rule: PassRule): void {
  const part = (name: string, st: Stats): string => `${name}: mean ${fmt(st.mean).trim()} median ${fmt(st.median).trim()} min ${fmt(st.min).trim()}`;
  console.log(
    `${label}${s.compared}/${s.boards} compared, ${s.passed} pass, ${s.trivial} trivial  ` +
      [part('visual', s.visualAccuracy), part('local', s.localAccuracy), part('perceptual', s.perceptualAccuracy), part('content', s.contentAccuracy), part('full', s.accuracy)].join('  |  ') +
      `  (pass: ${ruleText(rule)})`,
  );
}

function printTable(report: Report): void {
  const [primary, ...others] = report.renderers;
  const rule = ruleOf(report);
  const rows = report.boards.map((b) => [
    b.metrics ? fmt(b.metrics.visualAccuracy) : '   —   ',
    b.metrics ? fmt(b.metrics.localAccuracy) : '   —   ',
    b.metrics ? fmt(b.metrics.perceptualAccuracy) : '   —   ',
    b.metrics ? fmt(b.metrics.contentAccuracy) : '   —   ',
    b.metrics ? fmt(b.metrics.accuracy) : '   —   ',
    b.metrics ? b.metrics.ssim.toFixed(3) : '  —  ',
    ...others.map((r) => fmt(metricValue(b.metricsByRenderer?.[r], report.metric))),
    b.status === 'ok' ? 'ok' : b.status,
    `${b.nodeId ?? b.shapeId}`,
    `${b.page} / ${b.name}`.slice(0, 60) +
      (b.metrics?.boundsMismatch ? ` [${boundsNote(b.metrics)}]` : '') +
      (b.error ? ` — ${b.error.slice(0, 160)}` : ''),
  ]);
  const extra = others.map((r) => `${r.padEnd(7)}  `).join('');
  console.log(`visual    local     percept.  content   full     ssim   ${extra}status       node             board${others.length ? `   (visual…ssim: ${primary}; ${others.join(', ')}: ${report.metric})` : ''}`);
  for (const r of rows) {
    const k = 6 + others.length;
    console.log(`${r.slice(0, k).join('  ')}  ${r[k]!.padEnd(11)}  ${r[k + 1]!.padEnd(15)}  ${r[k + 2]}`);
  }
  console.log('');
  for (const r of report.renderers) printSummary(report.renderers.length > 1 ? `${r.padEnd(5)} ` : '', report.summaryByRenderer[r] ?? report.summary, rule);
}

function exporterWarnings(logs: string): string[] {
  return [
    ...new Set(
      logs
        .split('\n')
        .map((l) => l.replace(/^[^|]*\|\s*/, '').trim())
        // Penpot log levels: TRC DBG INF WRN ERR. Font fetch failures and
        // `wait-for-fonts timed out` are WRN and mean text used a fallback.
        .filter((l) => /^(WRN|ERR)\b/.test(l)),
    ),
  ].slice(0, 50);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        penpot: { type: 'string' },
        refs: { type: 'string' },
        out: { type: 'string' },
        scale: { type: 'string', default: '1' },
        min: { type: 'string', default: String(MIN_VISUAL) },
        'min-local': { type: 'string', default: String(MIN_LOCAL) },
        'min-regional': { type: 'string', default: String(MIN_REGIONAL) },
        metric: { type: 'string', default: DEFAULT_METRIC },
        'tolerance-px': { type: 'string', default: String(PERCEPTUAL_RADIUS) },
        keep: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        'render-only': { type: 'boolean', default: false },
        renderer: { type: 'string', default: 'svg' },
        concurrency: { type: 'string' },
        'no-up': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 3;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const mode = args.list ? 'list' : args['render-only'] ? 'render' : 'diff';
  if (!args.penpot || (mode === 'diff' && !args.refs)) {
    console.error(USAGE);
    return 3;
  }
  const rendererOption = args.renderer as RendererOption;
  if (rendererOption !== 'wasm' && rendererOption !== 'svg' && rendererOption !== 'both') {
    console.error(`--renderer must be svg, wasm or both`);
    return 3;
  }
  const metric = args.metric as MetricName;
  if (!METRICS.includes(metric)) {
    console.error(`--metric must be ${METRICS.join(', ')}`);
    return 3;
  }
  const tolerancePx = Number(args['tolerance-px']);
  if (!Number.isInteger(tolerancePx) || tolerancePx < 0) {
    console.error(`--tolerance-px must be an integer ≥ 0`);
    return 3;
  }
  const renderers: Renderer[] = rendererOption === 'both' ? ['svg', 'wasm'] : [rendererOption];
  const renderer = renderers[0]!;
  const scale = Number(args.scale);
  const min = Number(args.min);
  const rule: PassRule = { metric, min, minLocal: Number(args['min-local']), minRegional: Number(args['min-regional']) };
  if (![rule.min, rule.minLocal, rule.minRegional].every((v) => Number.isFinite(v))) {
    console.error('--min, --min-local and --min-regional must be numbers');
    return 3;
  }
  // The headless WASM renderer runs on a pool of 2 workers (PENPOT_WASM_WORKER_POOL_MAX);
  // more parallel requests only queue up and make an exporter temp-file race more likely.
  const concurrency = Math.max(1, Number(args.concurrency) || (rendererOption === 'svg' ? 4 : 2));
  const input = resolve(args.penpot);
  const outDir = resolve(args.out ?? join(WORK_DIR, sanitize(basename(input, extname(input)))));
  const started = Date.now();
  const startedIso = new Date(started - 2_000).toISOString();

  // --- stack + session
  try {
    if (!(await isReady())) {
      if (args['no-up']) throw new PenpotError('Penpot is not running (and --no-up was given)');
      await up({ log });
    }
  } catch (error) {
    console.error(`[visual] ${(error as Error).message}`);
    return 3;
  }
  const client = await PenpotClient.connect({ renderer });

  // --- import
  const bytes = new Uint8Array(await readFile(input));
  const importName = `${basename(input, extname(input))} (visual ${new Date(started).toISOString()})`;
  let fileId: string;
  let file: PenpotFile;
  const t0 = Date.now();
  try {
    log(`importing ${input} (${(bytes.length / 1024).toFixed(0)} KiB)…`);
    ({ fileId } = await client.importPenpotFile(bytes, importName));
    file = await client.getFile(fileId);
  } catch (error) {
    console.error(`[visual] IMPORT FAILED: ${(error as Error).message}`);
    if (error instanceof PenpotError && error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
    return error instanceof PenpotImportError ? 2 : 3;
  }
  const importMs = Date.now() - t0;
  log(`imported as ${fileId} in ${importMs} ms (${file.pages.length} page(s))`);

  const cleanup = async (): Promise<string | null> => {
    if (args.keep) {
      const url = client.workspaceUrl(fileId, file.pages[0]?.id);
      log(`kept file: ${url}`);
      return url;
    }
    await client.deleteFile(fileId).catch((e: unknown) => log(`could not delete ${fileId}: ${(e as Error).message}`));
    return null;
  };

  try {
    if (mode === 'list') {
      for (const page of file.pages) {
        const boards = topLevelBoards(page);
        console.log(`page ${page.id}  ${page.name}  (${boards.length} top-level board(s))`);
        for (const b of boards) console.log(`  ${b.id}  ${String(Math.round(b.width)).padStart(5)}x${String(Math.round(b.height)).padEnd(5)}  ${b.name}`);
      }
      await cleanup();
      return 0;
    }

    // --- targets
    const targets: BoardTarget[] = [];
    const reports: BoardReport[] = [];
    if (mode === 'render') {
      file.pages.forEach((page, pi) => {
        for (const b of topLevelBoards(page)) {
          targets.push({
            nodeId: null,
            shapeId: b.id,
            pageId: page.id,
            pageName: page.name,
            name: b.name,
            width: b.width,
            height: b.height,
            scale,
            matchedBy: 'board',
            key: `${pi}-${sanitize(b.name)}--${b.id.slice(0, 8)}`,
          });
        }
      });
    } else {
      for (const ref of await loadReferences(resolve(args.refs!))) {
        const entry = ref.entry;
        const found = locate(file, ref.nodeId, entry);
        const base: BoardReport = {
          nodeId: ref.nodeId,
          shapeId: found?.shape.id ?? null,
          name: found?.shape.name ?? entry?.name ?? '?',
          page: found?.pageName ?? entry?.page ?? '?',
          scale: entry?.scale ?? scale,
          matchedBy: found?.matchedBy ?? null,
          status: 'ok',
        };
        if (!ref.path) {
          reports.push({ ...base, status: 'missing-shape', error: 'listed in manifest.json but no reference PNG' });
        } else if (!found) {
          reports.push({ ...base, status: 'missing-shape', error: `no Penpot shape with id ${penpotId(ref.nodeId)} (= penpotId("${ref.nodeId}")) and no unique board named "${entry?.name ?? ''}"` });
        } else {
          targets.push({
            nodeId: ref.nodeId,
            shapeId: found.shape.id,
            pageId: found.pageId,
            pageName: found.pageName,
            name: found.shape.name,
            width: found.shape.width,
            height: found.shape.height,
            scale: base.scale,
            matchedBy: found.matchedBy,
            key: sanitize(ref.nodeId.replace(/:/g, '-')),
            referencePath: ref.path,
            ...boardGeometry(entry, file.pages.find((p) => p.id === found.pageId)?.objects, found.shape, base.scale),
          });
        }
      }
    }

    await rm(outDir, { recursive: true, force: true });
    for (const d of ['candidate', 'reference', 'diff']) await mkdir(join(outDir, d), { recursive: true });

    // --- export (+ diff)
    log(`exporting ${targets.length} board(s) with the ${renderers.join(' + ')} renderer${renderers.length > 1 ? 's' : ''}, ${concurrency} at a time…`);
    const t1 = Date.now();
    let done = 0;
    const results = await mapLimit(targets, concurrency, async (t): Promise<BoardReport> => {
      const report: BoardReport = { nodeId: t.nodeId, shapeId: t.shapeId, name: t.name, page: t.pageName, scale: t.scale, matchedBy: t.matchedBy, status: 'ok' };
      try {
        const refBytes = t.referencePath ? new Uint8Array(await readFile(t.referencePath)) : null;
        let reference: string | undefined;
        if (refBytes) {
          reference = join(outDir, 'reference', `${t.key}.png`);
          await writeFile(reference, refBytes);
        }
        for (const r of renderers) {
          // The primary renderer keeps the plain file names; others get a `.<renderer>` suffix.
          const suffix = r === renderer ? '' : `.${r}`;
          try {
            const { png, attempts, ms } = await exportWithRetry(client, { fileId, pageId: t.pageId, objectId: t.shapeId, scale: t.scale, renderer: r });
            const candidate = join(outDir, 'candidate', `${t.key}${suffix}.png`);
            await writeFile(candidate, png);
            const files: RendererFiles = { candidate: relative(outDir, candidate) };
            if (r === renderer) {
              report.exportMs = ms;
              report.attempts = attempts;
            }
            if (refBytes) {
              const { result, diffPng } = diffImages(refBytes, png, {
                referenceBox: t.referenceBox,
                referenceRenderSize: t.referenceRenderSize,
                candidateBox: t.candidateBox,
                candidateExtent: t.candidateExtent,
                perceptualRadius: tolerancePx,
              });
              const diff = join(outDir, 'diff', `${t.key}${suffix}.png`);
              await writeFile(diff, diffPng);
              files.diff = relative(outDir, diff);
              (report.metricsByRenderer ??= {})[r] = result;
            }
            (report.filesByRenderer ??= {})[r] = files;
          } catch (error) {
            (report.errorsByRenderer ??= {})[r] = (error as Error).message;
          }
        }
        const primaryFiles = report.filesByRenderer?.[renderer];
        report.files = { reference: reference && relative(outDir, reference), ...primaryFiles };
        report.metrics = report.metricsByRenderer?.[renderer];
        const primaryError = report.errorsByRenderer?.[renderer];
        if (primaryError) {
          report.status = 'export-failed';
          report.error = primaryError;
        } else if (report.metrics) {
          report.status = boardPasses(report.metrics, rule) ? 'ok' : 'below-min';
        }
        return report;
      } catch (error) {
        return { ...report, status: 'export-failed', error: (error as Error).message };
      } finally {
        done++;
        if (done % 10 === 0 || done === targets.length) log(`  ${done}/${targets.length}`);
      }
    });
    const exportsMs = Date.now() - t1;
    reports.push(...results);

    const warnings = exporterWarnings(await exporterLogs(startedIso));
    const workspaceUrl = await cleanup();

    if (mode === 'render') {
      for (const r of results) {
        const extra = renderers.slice(1).map((x) => `  ${x}: ${r.filesByRenderer?.[x]?.candidate ?? r.errorsByRenderer?.[x] ?? '—'}`).join('');
        console.log(`${r.status === 'ok' ? 'ok  ' : 'FAIL'}  ${r.shapeId}  ${r.page} / ${r.name}  ${r.files?.candidate ?? r.error ?? ''}${r.attempts && r.attempts > 1 ? `  (${r.attempts} attempts)` : ''}${extra}`);
      }
      const allOk = results.every((r) => r.status === 'ok' && !r.errorsByRenderer);
      console.log(`\nrendered ${results.filter((r) => r.status === 'ok').length}/${results.length} board(s) into ${join(outDir, 'candidate')} in ${exportsMs} ms`);
      if (warnings.length) console.log(`exporter warnings:\n  ${warnings.join('\n  ')}`);
      return allOk ? 0 : 1;
    }

    // worst first (see compareBoards)
    reports.sort((a, b) => compareBoards(a, b, rule));
    const summary = summarize(reports, rule);
    const report: Report = {
      tool: 'fig2pot-visual',
      penpotVersion: PENPOT_VERSION,
      renderer,
      renderers,
      input,
      fileId,
      workspaceUrl,
      kept: args.keep,
      min,
      metric,
      minLocal: rule.minLocal,
      minRegional: rule.minRegional,
      tolerancePx,
      timings: { importMs, exportsMs, totalMs: Date.now() - started },
      summary,
      summaryByRenderer: Object.fromEntries(renderers.map((r) => [r, summarizeRenderer(reports, r, rule)])),
      warnings,
      boards: reports,
    };
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(outDir, 'report.html'), renderHtmlReport(report));

    printTable(report);
    if (warnings.length) console.log(`\nexporter warnings (fonts may have fallen back):\n  ${warnings.join('\n  ')}`);
    console.log(`\nreport: ${join(outDir, 'report.html')}`);
    console.log(`import ${importMs} ms, ${targets.length} export(s) ${exportsMs} ms, total ${report.timings.totalMs} ms`);
    return reports.length > 0 && reports.every((r) => r.status === 'ok') ? 0 : 1;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`[visual] ${(error as Error).stack ?? String(error)}`);
      process.exitCode = 3;
    },
  );
}
