/**
 * Numeric comparison of the translated IR with Figma REST API dumps of the
 * same community files. Skipped when the large fixtures are not present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LARGE_FIXTURES, FIXTURES, hasLarge, translateFixture } from './helpers.ts';
import { combinePageDumps, compareWithRest, formatReport, type OracleReport } from './oracle.ts';

interface Case {
  name: string;
  fig: string;
  rest: string;
  minNodes: number;
  /** Known, explained mismatches per field (see comments). */
  budget: Record<string, number>;
}

const CASES: Case[] = [
  { name: 'radix-icons', fig: `${FIXTURES}radix-icons.fig`, rest: 'rest/radix-icons.document.json', minNodes: 2000, budget: {} },
  {
    name: 'auto-layout-playground',
    fig: `${LARGE_FIXTURES}auto-layout-playground.fig`,
    rest: 'rest/auto-layout-playground.document.json',
    minNodes: 7000,
    budget: {},
  },
];

function assertWithinBudget(report: OracleReport, budget: Record<string, number>): void {
  const over = Object.entries(report.fields)
    .filter(([field, s]) => s.mismatched > (budget[field] ?? 0))
    .map(([field, s]) => `${field}: ${s.mismatched} mismatched\n    ${s.samples.join('\n    ')}`);
  expect(over, over.join('\n')).toEqual([]);
}

describe('REST oracle', () => {
  for (const c of CASES) {
    const available = hasLarge(c.rest) && (c.fig.startsWith(FIXTURES) || hasLarge(c.fig.slice(LARGE_FIXTURES.length)));
    it.skipIf(!available)(`${c.name}: IR agrees with the REST API for every non-instance node`, () => {
      const rest = JSON.parse(readFileSync(`${LARGE_FIXTURES}${c.rest}`, 'utf8'));
      const t = translateFixture(c.fig);
      const report = compareWithRest(t, rest);
      console.log(formatReport(c.name, report));
      expect(report.missing).toEqual({});
      expect(report.nodes).toBeGreaterThan(c.minNodes);
      for (const field of ['absoluteBoundingBox', 'relativeTransform', 'fills.count', 'strokeWeight', 'effects.count']) {
        expect(report.fields[field]?.compared ?? 0, field).toBeGreaterThan(0);
      }
      assertWithinBudget(report, c.budget);
    });

    it.skipIf(!available)(`${c.name}: instance descendants (informational)`, () => {
      const rest = JSON.parse(readFileSync(`${LARGE_FIXTURES}${c.rest}`, 'utf8'));
      const report = compareWithRest(translateFixture(c.fig), rest, { includeInstanceChildren: true, sampleLimit: 3 });
      const mismatched = Object.values(report.fields).reduce((n, s) => n + s.mismatched, 0);
      const compared = Object.values(report.fields).reduce((n, s) => n + s.compared, 0);
      console.log(`${c.name} incl. instance descendants: ${report.nodes} nodes, ${mismatched}/${compared} field checks mismatched, missing ${JSON.stringify(report.missing)}`);
      // Depends on resolveInstances as well; only guard against wholesale breakage here.
      expect(mismatched / compared).toBeLessThan(0.01);
    });
  }
});

/**
 * Per-page REST dumps in test/refs/<fixture>/pages/*.json (not in git; only
 * `absoluteBoundingBox`, no `size`/`relativeTransform`, so geometry is
 * checked in page space). Fixtures with a full document dump above are
 * covered there.
 */
const REFS = fileURLToPath(new URL('../../refs/', import.meta.url));
const PAGE_BUDGETS: Record<string, Record<string, number>> = {
  // LAYER_BLUR next to NOISE / TEXTURE: progressive blurs are dropped with a `progressive-blur` warning (effects.ts).
  'f2s-noise-and-grain': { 'effects.count': 2 },
};
const pageCases = existsSync(REFS)
  ? readdirSync(REFS)
      .filter((name) => existsSync(`${REFS}${name}/pages`) && !CASES.some((c) => c.name === name))
      .map((name) => ({ name, fig: [`${FIXTURES}${name}.fig`, `${LARGE_FIXTURES}${name}.fig`].find((f) => existsSync(f)) }))
      .filter((c): c is { name: string; fig: string } => !!c.fig)
  : [];

describe('REST oracle (per-page dumps)', () => {
  if (pageCases.length === 0) it.skip('no test/refs/*/pages dumps present', () => {});
  for (const c of pageCases) {
    it(`${c.name}: IR agrees with the per-page REST dumps, incl. page-space bounds`, () => {
      const dir = `${REFS}${c.name}/pages`;
      const pages = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
      const report = compareWithRest(translateFixture(c.fig), combinePageDumps(pages), { includeInstanceChildren: true });
      console.log(formatReport(c.name, report));
      expect(report.missing).toEqual({});
      expect(report.fields['absoluteBoundingBox']?.compared ?? 0).toBe(report.nodes);
      assertWithinBudget(report, PAGE_BUDGETS[c.name] ?? {});
    });
  }
});
