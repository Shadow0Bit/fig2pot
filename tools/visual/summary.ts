/**
 * Batch totals shared by batch.ts and rediff.ts: one row per fixture, the worst boards and the
 * stable `SUMMARY …` line. README "Batch".
 */
import type { DiffResult } from './diff.ts';
import { boardPasses, compareBoards, metricValue, ruleText, type MetricName, type PassRule } from './run.ts';

export interface BoardResult {
  nodeId: string | null;
  name: string;
  page: string;
  status: string;
  metrics?: DiffResult;
}

export interface Row {
  fixture: string;
  boards: number;
  compared: number;
  /** Boards passing the rule (trivial boards pass). */
  passed: number;
  /** Trivial boards (no salient pixel, one flat colour): excluded from the visual means / minima. */
  trivial: number;
  meanVisual: number;
  minVisual: number;
  minLocal: number;
  meanPerceptual: number;
  minPerceptual: number;
  meanContent: number;
  minContent: number;
  meanFull: number;
  warnings: number;
  ms: number;
  error?: string;
  /** --only-failed: not re-run, copied from the previous summary.json. */
  carried?: boolean;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
/** A metric of a board; not compared (or an old report without it) = 0. */
export const valueOf = (board: BoardResult, m: MetricName): number => metricValue(board.metrics, m) ?? 0;
const nonTrivial = (boards: BoardResult[]): BoardResult[] => boards.filter((b) => !b.metrics?.trivial);

/** The per-fixture numbers of a row (everything but warnings / ms / error). */
export function fixtureRow(fixture: string, boards: BoardResult[], rule: PassRule): Omit<Row, 'warnings' | 'ms'> {
  const nt = nonTrivial(boards);
  const of = (list: BoardResult[], m: MetricName): number[] => list.map((b) => valueOf(b, m));
  return {
    fixture,
    boards: boards.length,
    compared: boards.filter((b) => b.metrics).length,
    passed: boards.filter((b) => boardPasses(b.metrics, rule)).length,
    trivial: boards.length - nt.length,
    meanVisual: mean(of(nt, 'visual')),
    minVisual: Math.min(...of(nt, 'visual'), 1),
    minLocal: Math.min(...nt.map((b) => b.metrics?.localAccuracy ?? 0), 1),
    meanPerceptual: mean(of(boards, 'perceptual')),
    minPerceptual: Math.min(...of(boards, 'perceptual'), 1),
    meanContent: mean(of(boards, 'content')),
    minContent: Math.min(...of(boards, 'content'), 1),
    meanFull: mean(of(boards, 'full')),
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`.padStart(8);

export function printRows(rows: Row[]): void {
  console.log(`${'fixture'.padEnd(38)} boards  pass triv  visual-mean visual-min local-min  percept-mean  strict-mean  warnings    time`);
  for (const row of rows) {
    if (row.error) {
      console.log(`${row.fixture.padEnd(38)} ERROR ${row.error}`);
      continue;
    }
    console.log(
      `${row.fixture.padEnd(38)} ${String(row.boards).padStart(6)} ${String(row.passed).padStart(5)} ${String(row.trivial).padStart(4)}  ${pct(row.meanVisual)}   ${pct(row.minVisual)}  ${pct(row.minLocal)}     ${pct(row.meanPerceptual)}    ${pct(row.meanContent)}  ${String(row.warnings).padStart(8)}  ${(row.ms / 1000).toFixed(1).padStart(5)} s`,
    );
  }
}

/** Totals line, the worst boards (sorted as `compareBoards`: failing local first by local, then visual) and the SUMMARY line. */
export function printTotals(boards: (BoardResult & { fixture: string })[], rule: PassRule, wallMs?: number, worst = 25): void {
  const nt = nonTrivial(boards);
  const of = (list: BoardResult[], m: MetricName): number[] => list.map((b) => valueOf(b, m));
  const passed = boards.filter((b) => boardPasses(b.metrics, rule)).length;
  const trivial = boards.length - nt.length;
  console.log(
    `\nTOTAL ${boards.length} boards: ${passed} pass (${pct(passed / Math.max(boards.length, 1)).trim()}) on ${ruleText(rule)}; ${trivial} trivial; ` +
      `visual mean ${pct(mean(of(nt, 'visual'))).trim()} min ${pct(Math.min(...of(nt, 'visual'), 1)).trim()}, local min ${pct(Math.min(...nt.map((b) => b.metrics?.localAccuracy ?? 0), 1)).trim()}, ` +
      `perceptual mean ${pct(mean(of(boards, 'perceptual'))).trim()}, strict content mean ${pct(mean(of(boards, 'content'))).trim()}` +
      (wallMs === undefined ? '' : `; ${(wallMs / 1000).toFixed(1)} s wall`),
  );
  const failing = boards.filter((b) => !boardPasses(b.metrics, rule)).sort((a, b) => compareBoards(a, b, rule));
  if (failing.length) {
    console.log(`\nworst boards (${failing.length} failing):   local   regional  visual   percept.  strict`);
    for (const board of failing.slice(0, worst)) {
      const m = board.metrics;
      const nums = m
        ? `${pct(m.localAccuracy ?? 0)} ${pct(m.regionalAccuracy ?? 0)} ${pct(m.visualAccuracy ?? 0)} ${pct(m.perceptualAccuracy)} ${pct(m.contentAccuracy)}`
        : '     n/a      n/a      n/a      n/a      n/a';
      const at = m?.localWorst ? ` @${m.localWorst.x},${m.localWorst.y}` : '';
      console.log(`  ${nums}  ${board.status.padEnd(12)} ${board.fixture} ${board.nodeId} "${board.name}"${at}${m?.boundsMismatch ? ' BOUNDS' : ''}`);
    }
  }
  console.log(`\n${summaryLine(boards, rule)}`);
}

/** The stable, grep-able line: `SUMMARY boards= pass= visual_mean= visual_min= local_min= trivial= perceptual_mean= …`. */
export function summaryLine(boards: BoardResult[], rule: PassRule): string {
  const nt = nonTrivial(boards);
  const of = (list: BoardResult[], m: MetricName): number[] => list.map((b) => valueOf(b, m));
  const p = (v: number): string => (v * 100).toFixed(2);
  return (
    `SUMMARY boards=${boards.length} pass=${boards.filter((b) => boardPasses(b.metrics, rule)).length}` +
    ` visual_mean=${p(mean(of(nt, 'visual')))} visual_min=${p(Math.min(...of(nt, 'visual'), 1))} local_min=${p(Math.min(...nt.map((b) => b.metrics?.localAccuracy ?? 0), 1))}` +
    ` trivial=${boards.length - nt.length}` +
    ` perceptual_mean=${p(mean(of(boards, 'perceptual')))} perceptual_min=${p(Math.min(...of(boards, 'perceptual'), 1))} content_mean=${p(mean(of(boards, 'content')))} full_mean=${p(mean(of(boards, 'full')))}`
  );
}
