/**
 * Re-scores an existing work directory without re-rendering: recomputes every board's metrics
 * from the reference / candidate PNGs already on disk, the refs manifest and the shapes of the
 * `.penpot` that was rendered. Use it after changing diff.ts (or run.ts's geometry) to see what
 * the change does to a whole corpus in minutes instead of a full batch run. See README "Re-scoring".
 *
 *   node tools/visual/rediff.ts <work-dir> [fixture-filter…] [--out <dir>] [--refs <dir>] [--delta 1] [--no-png]
 *                               [--metric visual|perceptual|content|full] [--min 0.98] [--min-local 0.85] [--min-regional 0.92]
 *
 * <work-dir> is a batch directory (`<fixture>/report.json` + `out/<fixture>.penpot`, as written
 * by batch.ts) or a single run.ts `--out` directory (`report.json`). Results go to `--out`
 * (default: in place) with the same layout: `<fixture>/report.{json,html}`, `<fixture>/diff/`,
 * and for a batch directory `summary.json`. Image paths in the new reports point at the
 * original PNGs. Every board is re-judged with the pass rule given here (default: the visual
 * rule, whatever the old run used). Prints every board whose verdict changed (old rule of the old
 * report → this rule), every board whose `perceptualAccuracy` moved by more than `--delta`
 * points with what changed, the batch table, worst boards and `SUMMARY …` line.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { diffImages, type DiffResult } from './diff.ts';
import type { PenpotShape, Renderer } from './penpot.ts';
import { renderHtmlReport } from './report.ts';
import { MIN_LOCAL, MIN_REGIONAL, MIN_VISUAL } from './diff.ts';
import {
  boardGeometry,
  boardPasses,
  compareBoards,
  DEFAULT_METRIC,
  METRICS,
  ruleOf,
  ruleText,
  summarize,
  summarizeRenderer,
  type BoardReport,
  type ManifestEntry,
  type MetricName,
  type PassRule,
  type Report,
} from './run.ts';
import { fixtureRow, printRows, printTotals } from './summary.ts';

const ROOT = join(import.meta.dirname, '..', '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    refs: { type: 'string' },
    delta: { type: 'string', default: '1' },
    'no-png': { type: 'boolean', default: false },
    metric: { type: 'string', default: DEFAULT_METRIC },
    min: { type: 'string', default: String(MIN_VISUAL) },
    'min-local': { type: 'string', default: String(MIN_LOCAL) },
    'min-regional': { type: 'string', default: String(MIN_REGIONAL) },
  },
});
if (!METRICS.includes(values.metric as MetricName)) {
  console.error(`--metric must be ${METRICS.join(', ')}`);
  process.exit(3);
}
const rule: PassRule = { metric: values.metric as MetricName, min: Number(values.min), minLocal: Number(values['min-local']), minRegional: Number(values['min-regional']) };
const src = positionals[0] ? resolve(positionals[0]) : undefined;
if (!src || !existsSync(src)) {
  console.error('usage: node tools/visual/rediff.ts <work-dir> [fixture-filter…] [--out <dir>] [--refs <dir>] [--delta 1] [--no-png]');
  process.exit(3);
}
const filters = positionals.slice(1);
const out = values.out ? resolve(values.out) : src;
const delta = Number(values.delta) / 100;
const single = existsSync(join(src, 'report.json'));

/** Shapes of every page of a `.penpot` archive, by page id (the ids run.ts saw after import). */
function readShapes(penpotPath: string): Map<string, Record<string, PenpotShape>> {
  const pages = new Map<string, Record<string, PenpotShape>>();
  const files = unzipSync(new Uint8Array(readFileSync(penpotPath)), { filter: (f) => /^files\/[^/]+\/pages\/[^/]+\/[^/]+\.json$/.test(f.name) });
  for (const [name, bytes] of Object.entries(files)) {
    const pageId = name.split('/')[3]!;
    const shape = JSON.parse(new TextDecoder().decode(bytes)) as PenpotShape;
    let objects = pages.get(pageId);
    if (!objects) pages.set(pageId, (objects = {}));
    objects[shape.id] = shape;
  }
  return pages;
}

function findShape(pages: Map<string, Record<string, PenpotShape>>, id: string | null): { shape: PenpotShape; objects: Record<string, PenpotShape> } | null {
  if (!id) return null;
  for (const objects of pages.values()) if (objects[id]) return { shape: objects[id]!, objects };
  return null;
}

interface Change {
  fixture: string;
  board: BoardReport;
  before: DiffResult;
  after: DiffResult;
  causes: string[];
}

/** A board whose verdict differs between the old report's rule and this run's. */
interface Verdict {
  fixture: string;
  board: BoardReport;
  before: DiffResult | undefined;
  passedBefore: boolean;
}

/** What differs between an old and a new result of the same board (for the change list). */
function causes(before: DiffResult, after: DiffResult): string[] {
  const out: string[] = [];
  const crop = after.reference.croppedPadding;
  if (crop) out.push(`reference margin cropped (${crop.left}/${crop.top}/${crop.right}/${crop.bottom})`);
  // Old offsets are relative to the uncropped PNG.
  const ox = before.offset.x - (crop?.left ?? 0);
  const oy = before.offset.y - (crop?.top ?? 0);
  if (ox !== after.offset.x || oy !== after.offset.y) out.push(`registration ${ox},${oy} → ${after.offset.x},${after.offset.y} (${after.registration.winner.join('+') || '?'}, ${after.registration.phase})`);
  if (before.candidate.background !== after.candidate.background || before.reference.background !== after.reference.background || before.backgroundMismatch !== after.backgroundMismatch) {
    out.push(`background ${before.reference.background}/${before.candidate.background} → ${after.reference.background}/${after.candidate.background}`);
  }
  if (before.boundsMismatch !== after.boundsMismatch) out.push(`boundsMismatch ${before.boundsMismatch} → ${after.boundsMismatch}`);
  return out;
}

function rescore(fixtureDir: string, outDir: string, fixture: string, changes: Change[], verdicts: Verdict[]): Report {
  const report = JSON.parse(readFileSync(join(fixtureDir, 'report.json'), 'utf8')) as Report;
  const oldRule = ruleOf(report);
  const refsDir = values.refs ? resolve(values.refs) : join(ROOT, 'test', 'refs', fixture);
  const manifestPath = join(refsDir, 'manifest.json');
  const manifest = new Map<string, ManifestEntry>();
  if (existsSync(manifestPath)) for (const e of JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[]) manifest.set(e.nodeId, e);
  const penpotPath = [report.input, join(dirname(fixtureDir), 'out', `${fixture}.penpot`)].find((p) => p && existsSync(p));
  if (!penpotPath) throw new Error(`${fixture}: no .penpot found (${report.input})`);
  const pages = readShapes(penpotPath);
  mkdirSync(join(outDir, 'diff'), { recursive: true });
  const rel = (p: string | undefined): string | undefined => (p === undefined ? undefined : relative(outDir, join(fixtureDir, p)));

  report.boards = report.boards.map((old) => {
    const board: BoardReport = structuredClone(old);
    const refPath = old.files?.reference;
    const found = findShape(pages, old.shapeId);
    if (!refPath || !found || !old.filesByRenderer) return board;
    const entry = old.nodeId ? (manifest.get(old.nodeId) ?? null) : null;
    const geometry = boardGeometry(entry, found.objects, found.shape, old.scale);
    const refBytes = new Uint8Array(readFileSync(join(fixtureDir, refPath)));
    for (const r of Object.keys(old.filesByRenderer) as Renderer[]) {
      const files = old.filesByRenderer[r]!;
      if (!files.candidate) continue;
      const { result, diffPng } = diffImages(refBytes, new Uint8Array(readFileSync(join(fixtureDir, files.candidate))), { ...geometry, perceptualRadius: report.tolerancePx });
      const diffPath = join(outDir, 'diff', basename(files.diff ?? files.candidate));
      if (!values['no-png']) writeFileSync(diffPath, diffPng);
      board.filesByRenderer![r] = { candidate: rel(files.candidate), diff: values['no-png'] ? undefined : relative(outDir, diffPath) };
      (board.metricsByRenderer ??= {})[r] = result;
    }
    board.metrics = board.metricsByRenderer?.[report.renderer];
    board.files = { reference: rel(refPath), ...board.filesByRenderer?.[report.renderer] };
    if (board.metrics && board.status !== 'export-failed') board.status = boardPasses(board.metrics, rule) ? 'ok' : 'below-min';
    const before = old.metrics;
    const after = board.metrics;
    if (before && after && Math.abs(after.perceptualAccuracy - before.perceptualAccuracy) > delta) changes.push({ fixture, board, before, after, causes: causes(before, after) });
    const passedBefore = boardPasses(before, oldRule);
    if (after && passedBefore !== boardPasses(after, rule)) verdicts.push({ fixture, board, before, passedBefore });
    return board;
  });
  report.metric = rule.metric;
  report.min = rule.min;
  report.minLocal = rule.minLocal;
  report.minRegional = rule.minRegional;
  report.boards.sort((a, b) => compareBoards(a, b, rule));
  report.summary = summarize(report.boards, rule);
  report.summaryByRenderer = Object.fromEntries(report.renderers.map((r) => [r, summarizeRenderer(report.boards, r, rule)]));
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(outDir, 'report.html'), renderHtmlReport(report));
  return report;
}

const t0 = Date.now();
const changes: Change[] = [];
const verdicts: Verdict[] = [];
const fixtures = single
  ? [basename(src)]
  : readdirSync(src)
      .filter((d) => existsSync(join(src, d, 'report.json')))
      .filter((d) => filters.length === 0 || filters.some((f) => d.includes(f)))
      .sort();
const reports = new Map<string, Report>();
for (const fixture of fixtures) {
  const t1 = Date.now();
  const report = rescore(single ? src : join(src, fixture), single ? out : join(out, fixture), fixture, changes, verdicts);
  reports.set(fixture, report);
  process.stderr.write(`[rediff] ${fixture}: ${report.boards.length} boards in ${((Date.now() - t1) / 1000).toFixed(1)} s\n`);
}

const pct = (v: number | undefined): string => (v === undefined ? '   n/a' : (v * 100).toFixed(2).padStart(6));

console.log(`\nboards whose perceptual accuracy changed by more than ${values.delta} point(s): ${changes.length}`);
for (const c of changes.sort((a, b) => a.after.perceptualAccuracy - a.before.perceptualAccuracy - (b.after.perceptualAccuracy - b.before.perceptualAccuracy))) {
  console.log(`  ${pct(c.before.perceptualAccuracy)} → ${pct(c.after.perceptualAccuracy)}  ${c.fixture} ${c.board.nodeId} "${c.board.name}"  ${c.causes.join('; ') || 'other'}`);
}

const first = reports.values().next().value as Report | undefined;
if (first) {
  const oldRules = [...new Set([...reports.keys()].map((f) => JSON.stringify(ruleOf(JSON.parse(readFileSync(join(single ? src : join(src, f), 'report.json'), 'utf8')) as Report))))].map((r) => ruleText(JSON.parse(r) as PassRule));
  console.log(`\nverdict changes (old: ${oldRules.join(' / ')} → new: ${ruleText(rule)}): ${verdicts.length}`);
  for (const v of verdicts.sort((a, b) => Number(b.passedBefore) - Number(a.passedBefore) || compareBoards(a.board, b.board, rule))) {
    const m = v.board.metrics!;
    const at = m.localWorst ? ` @${m.localWorst.x},${m.localWorst.y}` : '';
    console.log(
      `  ${v.passedBefore ? 'pass → FAIL' : 'fail → pass'}  perceptual ${pct(v.before?.perceptualAccuracy)} → visual ${pct(m.visualAccuracy)} regional ${pct(m.regionalAccuracy)} local ${pct(m.localAccuracy)}${at}  ${v.fixture} ${v.board.nodeId} "${v.board.name}"`,
    );
  }
}

const all = [...reports.entries()].flatMap(([fixture, r]) => r.boards.map((b) => ({ ...b, fixture })));
if (first) {
  // Same shape as batch.ts's summary.json; warnings / ms are carried over from the old one.
  const previous = !single && existsSync(join(src, 'summary.json')) ? (JSON.parse(readFileSync(join(src, 'summary.json'), 'utf8')) as { rows: { fixture: string; warnings?: number; ms?: number }[] } & Record<string, unknown>) : null;
  const rows = [...reports.entries()].map(([fixture, r]) => {
    const old = previous?.rows.find((row) => row.fixture === fixture);
    return { ...fixtureRow(fixture, r.boards, rule), warnings: old?.warnings ?? 0, ms: old?.ms ?? 0 };
  });
  if (!single) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, 'summary.json'),
      JSON.stringify({ ...(previous ?? {}), metric: rule.metric, min: rule.min, minLocal: rule.minLocal, minRegional: rule.minRegional, tolerancePx: first.tolerancePx, rediff: true, rows, boards: all }, null, 2),
    );
  }
  const bounds = all.filter((b) => b.metrics?.boundsMismatch);
  console.log(`\nboundsMismatch: ${bounds.length} board(s)`);
  for (const b of bounds) {
    const d = b.metrics!.boundsDelta;
    console.log(`  ${pct(b.metrics!.perceptualAccuracy)}  ${b.fixture} ${b.nodeId} "${b.name}"  l${d.left} t${d.top} r${d.right} b${d.bottom}`);
  }
  console.log('');
  printRows(rows);
  printTotals(all, rule);
}
console.log(`rediff: ${fixtures.length} fixture(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${out}`);
