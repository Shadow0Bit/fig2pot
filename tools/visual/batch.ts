/**
 * Converts fixtures and measures them against their Figma references in one go.
 *
 *   node tools/visual/batch.ts [name-filter…] [--renderer svg|wasm|both] [--metric visual|perceptual|content|full]
 *                              [--min 0.98] [--min-local 0.85] [--min-regional 0.92] [--tolerance-px 1]
 *                              [--only-failed] [--jobs 1] [-- <fig2pot convert options>]
 *
 * Convert options (the CLI's): --text <mode>, --booleans <mode>, --line-breaks <mode>, --no-components,
 * --no-bake, --bake-scale <n>, --no-image-profiles, --no-downsample, --pixel-exact, --text-spacing <mode> (--renderer is the batch's own).
 *
 * For every `test/refs/<fixture>/manifest.json` with a matching `.fig` in
 * test/fixtures or test/fixtures-large: convert → import → render → diff.
 * Writes tools/visual/.work/<fixture>/report.{json,html} (via run.ts) and
 * tools/visual/.work/summary.json, and prints one line per fixture, the worst
 * boards overall and a final `SUMMARY …` line (stable format, for grep).
 *
 * --only-failed  re-runs only the fixtures that had an error or a board failing the pass rule
 *                in the last summary.json; the other fixtures' rows are carried over
 *                into the new summary.json (`carried: true`) but not printed or counted.
 * --jobs <n>     fixtures processed in parallel (each run.ts still exports 4 boards at a time).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { convert, type ConvertOptions } from '../../src/index.ts';
import { MIN_LOCAL, MIN_REGIONAL } from './diff.ts';
import { boardPasses, DEFAULT_METRIC, METRICS, type MetricName, type PassRule } from './run.ts';
import { fixtureRow, printRows, printTotals, type BoardResult, type Row } from './summary.ts';

const ROOT = join(import.meta.dirname, '..', '..');
// FIG2POT_VISUAL_WORK lets two measurement runs coexist without overwriting each other's reports.
const WORK = process.env.FIG2POT_VISUAL_WORK ? resolve(process.env.FIG2POT_VISUAL_WORK) : join(import.meta.dirname, '.work');
const REFS = join(ROOT, 'test', 'refs');
const SUMMARY_PATH = join(WORK, 'summary.json');

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split === -1 ? argv : argv.slice(0, split);
const convertArgs = split === -1 ? [] : argv.slice(split + 1);

const VALUED = ['--renderer', '--min', '--min-local', '--min-regional', '--metric', '--tolerance-px', '--jobs'];
const SWITCHES = ['--only-failed'];
function flag(name: string, fallback: string): string {
  const index = own.indexOf(name);
  return index === -1 ? fallback : (own[index + 1] ?? fallback);
}
for (const [i, arg] of own.entries()) {
  if (arg.startsWith('--') && !VALUED.includes(arg) && !SWITCHES.includes(arg) && !VALUED.includes(own[i - 1] ?? '')) throw new Error(`unknown option ${arg}`);
}
const renderer = flag('--renderer', 'svg');
const min = Number(flag('--min', '0.98'));
const metric = flag('--metric', DEFAULT_METRIC) as MetricName;
if (!METRICS.includes(metric)) throw new Error(`--metric must be ${METRICS.join(', ')}`);
const rule: PassRule = { metric, min, minLocal: Number(flag('--min-local', String(MIN_LOCAL))), minRegional: Number(flag('--min-regional', String(MIN_REGIONAL))) };
const tolerancePx = flag('--tolerance-px', '');
const jobs = Math.max(1, Number(flag('--jobs', '1')) || 1);
const onlyFailed = own.includes('--only-failed');
const filters = own.filter((arg, i) => !arg.startsWith('--') && !VALUED.includes(own[i - 1] ?? ''));

// Tune the converted file for the renderer it is measured with (they draw gradients and blurs differently).
const options: ConvertOptions = { renderer: renderer === 'wasm' ? 'wasm' : 'svg' };
for (let i = 0; i < convertArgs.length; i++) {
  const arg = convertArgs[i];
  if (arg === '--text') options.textMode = convertArgs[++i] as ConvertOptions['textMode'];
  else if (arg === '--booleans') options.booleanMode = convertArgs[++i] as ConvertOptions['booleanMode'];
  else if (arg === '--no-components') options.components = false;
  else if (arg === '--line-breaks') options.textLineBreaks = convertArgs[++i] as ConvertOptions['textLineBreaks'];
  else if (arg === '--no-bake') options.bakeUnsupportedPaints = false;
  else if (arg === '--bake-scale') options.bakeScale = Number(convertArgs[++i]);
  else if (arg === '--no-image-profiles') options.convertImageProfiles = false;
  else if (arg === '--no-downsample') options.downsampleImages = false;
  else if (arg === '--pixel-exact') options.pixelExact = true;
  else if (arg === '--text-spacing') options.textSpacing = convertArgs[++i] as ConvertOptions['textSpacing'];
  else throw new Error(`unknown convert option ${arg} (known: --text, --booleans, --no-components, --line-breaks, --no-bake, --bake-scale, --no-image-profiles, --no-downsample, --pixel-exact, --text-spacing)`);
}

interface SummaryFile {
  renderer: string;
  metric?: MetricName;
  min: number;
  minLocal?: number;
  minRegional?: number;
  tolerancePx?: number | null;
  jobs?: number;
  rows: Row[];
  boards: (BoardResult & { fixture: string })[];
}

function figPath(fixture: string): string | undefined {
  for (const dir of ['test/fixtures', 'test/fixtures-large']) {
    const candidate = join(ROOT, dir, `${fixture}.fig`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}


// --- which fixtures
const previous: SummaryFile | null = existsSync(SUMMARY_PATH) ? (JSON.parse(readFileSync(SUMMARY_PATH, 'utf8')) as SummaryFile) : null;
let fixtures = readdirSync(REFS)
  .sort()
  .filter((fixture) => filters.length === 0 || filters.some((filter) => fixture.includes(filter)))
  .filter((fixture) => figPath(fixture) && existsSync(join(REFS, fixture, 'manifest.json')));
if (onlyFailed) {
  if (!previous) throw new Error(`--only-failed: no ${SUMMARY_PATH} yet`);
  // Failing on the rule selected NOW (an old summary without the metric counts as failing).
  const failing = new Set(
    previous.rows
      .filter((row) => row.error || previous.boards.some((board) => board.fixture === row.fixture && !boardPasses(board.metrics, rule)) || row.boards === 0)
      .map((row) => row.fixture),
  );
  fixtures = fixtures.filter((fixture) => failing.has(fixture));
  console.log(`--only-failed: ${fixtures.length} fixture(s) had a failure in the last summary: ${fixtures.join(', ') || '(none)'}`);
}

// --- run
mkdirSync(join(WORK, 'out'), { recursive: true });

function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function measure(fixture: string): Promise<{ row: Row; boards: (BoardResult & { fixture: string })[] }> {
  const t0 = Date.now();
  let row: Row = { ...fixtureRow(fixture, [], rule), warnings: 0, ms: 0 };
  const done = (boards: (BoardResult & { fixture: string })[] = []) => ((row.ms = Date.now() - t0), { row, boards });
  const penpotPath = join(WORK, 'out', `${fixture}.penpot`);
  try {
    const { penpot, warnings } = await convert(readFileSync(figPath(fixture)!), options);
    writeFileSync(penpotPath, penpot);
    row.warnings = warnings.length;
  } catch (error) {
    row.error = `convert: ${(error as Error).message}`;
    return done();
  }

  const outDir = join(WORK, fixture);
  const args = [join(import.meta.dirname, 'run.ts'), '--penpot', penpotPath, '--refs', join(REFS, fixture), '--out', outDir];
  args.push('--renderer', renderer, '--metric', metric, '--min', String(min), '--min-local', String(rule.minLocal), '--min-regional', String(rule.minRegional));
  if (tolerancePx) args.push('--tolerance-px', tolerancePx);
  const run = await runCli(args);
  if (run.code === 2 || run.code === 3 || !existsSync(join(outDir, 'report.json'))) {
    row.error = `import/run failed (exit ${run.code}): ${run.output.trim().split('\n').slice(-6).join(' | ').slice(0, 900)}`;
    return done();
  }
  const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as { boards: BoardResult[] };
  // A reference that could not be compared at all counts as a complete miss (0).
  row = { ...row, ...fixtureRow(fixture, report.boards, rule) };
  return done(report.boards.map((board) => ({ ...board, fixture })));
}

const t0 = Date.now();
const results: Awaited<ReturnType<typeof measure>>[] = new Array(fixtures.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, fixtures.length) }, async () => {
    while (next < fixtures.length) {
      const i = next++;
      results[i] = await measure(fixtures[i]!);
      const { row } = results[i]!;
      process.stderr.write(`[batch] ${row.fixture}: ${row.error ? 'ERROR' : `${row.passed}/${row.boards} pass`} in ${(row.ms / 1000).toFixed(1)} s\n`);
    }
  }),
);
const wallMs = Date.now() - t0;
const rows = results.map((r) => r.row);
const boards = results.flatMap((r) => r.boards);

// --- print
console.log(`\npass/fail: ${metric === 'visual' ? 'visual rule' : metric} · renderer ${renderer}${tolerancePx ? ` · tolerance ${tolerancePx} px` : ''} · jobs ${jobs}`);
printRows(rows);
printTotals(boards, rule, wallMs);
const passed = boards.filter((board) => boardPasses(board.metrics, rule)).length;

// --- summary.json (with --only-failed, merged over the previous one)
const carriedRows = onlyFailed && previous ? previous.rows.filter((row) => !fixtures.includes(row.fixture)).map((row) => ({ ...row, carried: true })) : [];
const carriedBoards = onlyFailed && previous ? previous.boards.filter((board) => !fixtures.includes(board.fixture)) : [];
const summary: SummaryFile = {
  renderer,
  metric,
  min,
  minLocal: rule.minLocal,
  minRegional: rule.minRegional,
  tolerancePx: tolerancePx ? Number(tolerancePx) : null,
  jobs,
  rows: [...rows, ...carriedRows].sort((a, b) => a.fixture.localeCompare(b.fixture)),
  boards: [...boards, ...carriedBoards],
};
writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

process.exitCode = rows.some((row) => row.error) || passed < boards.length ? 1 : 0;
