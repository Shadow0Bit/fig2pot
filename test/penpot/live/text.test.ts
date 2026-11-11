/**
 * Penpot text behaviour the writer relies on, measured on a live Penpot in both
 * renderers. Skipped unless PENPOT_LIVE=1 (see harness.ts).
 *
 *   PENPOT_LIVE=1 pnpm exec vitest run test/penpot/live
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import type { Renderer } from '../../../tools/visual/penpot.ts';
import { textNode } from '../text/helpers.ts';
import { BLACK, PAD, RENDERERS, interBaseline, ink, inkRows, line, placed, renderBoards, type Board, type Img } from './harness.ts';

const px = (value: number): ir.LineHeight => ({ unit: 'px', value });
const auto: ir.LineHeight = { unit: 'auto', value: 0 };
const s20 = { fontSize: 20, lineHeight: px(40), fills: [BLACK] };
/** Inter 400 at 20 px: "H" advance 14.5 px (so "HHHHHHHHHH" ≈ 145 px). */
const H20 = 14.5;

const cases: Record<string, Board> = {};
function add(key: string, node: ir.TextNode, board: Partial<Board> = {}): void {
  cases[key] = { ...board, nodes: [placed(node)] };
}

// A1 — empty paragraphs and paragraph spacing keep their height.
add('blank', textNode([['H\n\nH', s20]], { size: { width: 200, height: 140 } }));
add('spacing', textNode([['H\nH', s20]], { size: { width: 200, height: 120 }, paragraphSpacing: 17 }));
add('spacingBlank', textNode([['H\n\nH', s20]], { size: { width: 200, height: 160 }, paragraphSpacing: 17 }));
// A2 — mixed sizes on one `auto` line: Figma's pitch is 48.4 − 38.75 + 19.375 = 29.03.
add(
  'mixedAuto',
  textNode([['H', { fontSize: 20, lineHeight: auto }], ['H', { fontSize: 40, lineHeight: auto }], ['\nH', { fontSize: 20, lineHeight: auto }]], {
    size: { width: 200, height: 80 },
    layout: { lines: [line(0, 3, 38.75, 40, 48.4, 38.75), line(3, 4, 48.4 + 19.375, 12, 24.2, 19.375)] },
  }),
);
// A3 — a run without visible paints draws nothing.
add('noFill', textNode([['Hamburg', { ...s20, fills: [] }]]));
// A4 — a run boundary inside a surrogate pair.
{
  const node = textNode([['a\u{1F600}b', s20]]);
  node.runs = [
    { start: 0, end: 2, style: node.runs[0]!.style },
    { start: 2, end: 4, style: { ...node.runs[0]!.style, fontSize: 30 } },
  ];
  add('astral', node);
}
// A7 — paragraph indent.
add('indent0', textNode([['HHH\nHHH', s20]], { size: { width: 200, height: 80 } }));
add('indent24', textNode([['HHH\nHHH', s20]], { size: { width: 200, height: 80 }, paragraphIndent: 24 }));
// B1 — the source's wraps are reproduced, also where Penpot would wrap elsewhere.
add(
  'sourceBreaks',
  textNode([['HHHH HHHH HHHH', s20]], {
    size: { width: 200, height: 80 },
    layout: { lines: [line(0, 5, interBaseline(20, 40), 4 * H20 + 5, 24.2, interBaseline(20, 40)), line(5, 14, 40 + interBaseline(20, 40), 9 * H20, 24.2, interBaseline(20, 40))] },
  }),
);
// B1 — the space at a wrap of right-aligned text does not shift the line (Chromium would count it).
add(
  'rightTrailing',
  textNode([['HHH HH', s20]], {
    size: { width: 200, height: 80 },
    alignHorizontal: 'right',
    layout: { lines: [line(0, 4, interBaseline(20, 40), 3 * H20 + 5, 24.2, interBaseline(20, 40), 200 - 3 * H20), line(4, 6, 40 + interBaseline(20, 40), 2 * H20, 24.2, interBaseline(20, 40), 200 - 2 * H20)] },
  }),
);
// B1 — consecutive and leading U+2028 soft breaks keep the pitch.
add('softBlank', textNode([['H\u2028\u2028H', s20]], { size: { width: 200, height: 140 } }));
add('softLeading', textNode([['\u2028H', s20]], { size: { width: 200, height: 100 } }));
// B2 — no clipping: a fixed box narrower than its line, a stale auto-width box, an overflowing height, a centred overflow.
const wide = (o: Partial<ir.TextNode>): ir.TextNode =>
  textNode([['HHHHHHHHHH', s20]], { layout: { lines: [line(0, 10, interBaseline(20, 40), 10 * H20, 24.2, interBaseline(20, 40), o.alignHorizontal === 'center' ? (60 - 10 * H20) / 2 : 0)] }, ...o });
add('fixedNarrow', wide({ size: { width: 60, height: 40 } }), { width: 240, height: 100 });
add('autoWidthStale', wide({ size: { width: 60, height: 40 }, autoResize: 'width-and-height' }), { width: 240, height: 100 });
add('centerNarrow', wide({ size: { width: 60, height: 40 }, alignHorizontal: 'center' }), { width: 240, height: 100 });
// A centred auto-width text whose stored box is a bit narrow: its lines must not move.
add(
  'autoWidthCentred',
  textNode([['HH\nHHHH', s20]], {
    size: { width: 55, height: 80 },
    autoResize: 'width-and-height',
    alignHorizontal: 'center',
    layout: { lines: [line(0, 3, interBaseline(20, 40), 2 * H20, 24.2, interBaseline(20, 40), H20), line(3, 7, 40 + interBaseline(20, 40), 4 * H20, 24.2, interBaseline(20, 40), 0)] },
  }),
  { width: 160, height: 120 },
);
cases.centerNarrow!.nodes = [placed(cases.centerNarrow!.nodes[0]!, 90, PAD)];
add(
  'tallOverflow',
  textNode([['HHH\nHHH', s20]], {
    size: { width: 200, height: 20 },
    layout: { lines: [line(0, 4, interBaseline(20, 40), 3 * H20, 24.2, interBaseline(20, 40)), line(4, 7, 40 + interBaseline(20, 40), 3 * H20, 24.2, interBaseline(20, 40))] },
  }),
  { height: 120 },
);
// B3 — first baseline for px line heights and every vertical alignment.
const B3: [number, number, ir.TextNode['alignVertical']][] = [];
for (const [fs, lh] of [[16, 24], [32, 36], [21, 28]] as const) for (const v of ['top', 'center', 'bottom'] as const) B3.push([fs, lh, v]);
for (const [fs, lh, v] of B3) {
  add(`baseline-${fs}-${lh}-${v}`, textNode([['HHH', { fontSize: fs, lineHeight: px(lh), fills: [BLACK] }]], { size: { width: 200, height: lh + 21 }, alignVertical: v }));
}
// B4 — Inter draws "->" as an arrow (contextual alternate) in both renderers.
add('arrowAscii', textNode([['(->)', { fontSize: 24, lineHeight: px(32), fills: [BLACK] }]], { size: { width: 120, height: 40 } }));
add('arrowGlyph', textNode([['(→)', { fontSize: 24, lineHeight: px(32), fills: [BLACK] }]], { size: { width: 120, height: 40 } }));

const keys = Object.keys(cases);
let renders: Record<Renderer, (Img | undefined)[]>;
const img = (r: Renderer, key: string): Img => {
  const out = renders[r][keys.indexOf(key)];
  if (!out) throw new Error(`${key} failed to export with ${r}`);
  return out;
};
const rows = (r: Renderer, key: string) => inkRows(img(r, key));

describe.skipIf(process.env.PENPOT_LIVE !== '1')('Penpot text rendering (live)', () => {
  beforeAll(async () => {
    renders = await renderBoards(
      'text',
      keys.map((k) => cases[k]!),
    );
    if (process.env.PENPOT_LIVE_DEBUG) for (const r of RENDERERS) for (const k of keys) console.log(r, k, JSON.stringify(inkRows(renders[r][keys.indexOf(k)]!)));
  }, 600_000);

  describe.each(RENDERERS)('%s renderer', (r) => {
    it('A1: blank lines and paragraph spacing keep their height', () => {
      const blank = rows(r, 'blank');
      expect(blank).toHaveLength(2);
      expect(blank[1]!.bottom - blank[0]!.bottom).toBeCloseTo(80, 0);
      const spacing = rows(r, 'spacing');
      expect(spacing[1]!.bottom - spacing[0]!.bottom).toBeCloseTo(57, 0);
      const both = rows(r, 'spacingBlank');
      expect(both[1]!.bottom - both[0]!.bottom).toBeCloseTo(114, 0);
    });

    it('A2: a small auto run next to a larger one does not grow the line', () => {
      const mixed = rows(r, 'mixedAuto');
      expect(mixed).toHaveLength(2);
      // (36 px before the fix; ink rows quantise to 0.5 px per line)
      expect(Math.abs(mixed[1]!.bottom - mixed[0]!.bottom - 29.03)).toBeLessThanOrEqual(1.5);
    });

    it('A3: a run without visible fills draws nothing', () => {
      expect(ink(img(r, 'noFill'))).toBeUndefined();
    });

    it('A4: a run boundary inside a surrogate pair still renders', () => {
      expect(ink(img(r, 'astral'))).toBeDefined();
    });

    it('A7: paragraph indent shifts the first line only, exactly', () => {
      const base = rows(r, 'indent0');
      const indented = rows(r, 'indent24');
      expect(Math.abs(indented[0]!.left - base[0]!.left - 24)).toBeLessThanOrEqual(0.75);
      expect(Math.abs(indented[1]!.left - base[1]!.left - 24)).toBeLessThanOrEqual(0.75);
      // the spacer does not change the line height
      expect(indented[0]!.bottom).toBeCloseTo(base[0]!.bottom, 0);
    });

    it("B1: the source's line breaks are reproduced", () => {
      const lines = rows(r, 'sourceBreaks');
      expect(lines).toHaveLength(2);
      expect(Math.abs(lines[0]!.right - lines[0]!.left - 4 * H20)).toBeLessThanOrEqual(3);
      // "HHHH HHHH": where Penpot itself would wrap after the second word instead
      expect(Math.abs(lines[1]!.right - lines[1]!.left - 8 * H20 - 5)).toBeLessThanOrEqual(4);
      expect(lines[1]!.bottom - lines[0]!.bottom).toBeCloseTo(40, 0);
    });

    it('B1: a stripped wrap space keeps right-aligned lines flush', () => {
      const lines = rows(r, 'rightTrailing');
      expect(lines).toHaveLength(2);
      expect(Math.abs(lines[0]!.right - lines[1]!.right)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(lines[1]!.right - (PAD + 200))).toBeLessThanOrEqual(2.5);
    });

    it('B1: consecutive and leading soft breaks keep the pitch', () => {
      const blank = rows(r, 'softBlank');
      expect(blank[1]!.bottom - blank[0]!.bottom).toBeCloseTo(80, 0);
      const leading = rows(r, 'softLeading');
      expect(leading).toHaveLength(1);
      expect(Math.abs(leading[0]!.bottom - (PAD + 40 + interBaseline(20, 40)))).toBeLessThanOrEqual(1.75);
    });

    it('B2: text is never clipped to (or re-wrapped in) a box smaller than what Figma drew', () => {
      for (const key of ['fixedNarrow', 'autoWidthStale']) {
        const lines = rows(r, key);
        expect(lines, key).toHaveLength(1);
        expect(lines[0]!.right, key).toBeGreaterThan(PAD + 10 * H20 - 4);
        expect(lines[0]!.left, key).toBeLessThan(PAD + 3);
      }
      const centred = rows(r, 'centerNarrow');
      expect(centred).toHaveLength(1);
      expect(Math.abs((centred[0]!.left + centred[0]!.right) / 2 - (90 + 30))).toBeLessThanOrEqual(1);
      // auto-width: lines are centred on the widest one, which starts at the box's left edge
      const autoCentred = rows(r, 'autoWidthCentred');
      expect(autoCentred).toHaveLength(2);
      expect(Math.abs(autoCentred[1]!.left - (PAD + 1.5))).toBeLessThanOrEqual(1);
      expect(Math.abs((autoCentred[0]!.left + autoCentred[0]!.right) / 2 - (autoCentred[1]!.left + autoCentred[1]!.right) / 2)).toBeLessThanOrEqual(1);
      const tall = rows(r, 'tallOverflow');
      expect(tall).toHaveLength(2);
      expect(tall[1]!.bottom - tall[0]!.bottom).toBeCloseTo(40, 0);
    });

    it('B3: the first baseline lands where Figma put it (residual: SVG snaps baselines to whole px)', () => {
      const tolerance = r === 'svg' ? 1.75 : 0.75;
      for (const [fs, lh, v] of B3) {
        const h = lh + 21;
        const top = v === 'top' ? 0 : v === 'center' ? (h - lh) / 2 : h - lh;
        const first = rows(r, `baseline-${fs}-${lh}-${v}`)[0]!;
        expect(Math.abs(first.bottom - PAD - top - interBaseline(fs, lh)), `${fs}/${lh} ${v}`).toBeLessThanOrEqual(tolerance);
      }
    });

    it('B4: "->" is drawn as the arrow glyph', () => {
      const ascii = ink(img(r, 'arrowAscii'))!;
      const glyph = ink(img('wasm', 'arrowGlyph'))!;
      expect(Math.abs(ascii.right - ascii.left - (glyph.right - glyph.left))).toBeLessThanOrEqual(0.5);
    });
  });
});
