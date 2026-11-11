/**
 * Baseline model (src/penpot/text/baseline.ts) and the `auto` outline rules,
 * checked against a live Penpot in both renderers. Skipped unless
 * PENPOT_LIVE=1 (see harness.ts).
 *
 *   PENPOT_LIVE=1 pnpm exec vitest run test/penpot/live/text-baseline.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { svgBaselines, tryModelLines, wasmBaselines } from '../../../src/penpot/text/baseline.ts';
import { num, ratioString } from '../../../src/penpot/text/index.ts';
import type { Renderer } from '../../../tools/visual/penpot.ts';
import { textNode } from '../text/helpers.ts';
import { BLACK, RENDERERS, SCALE, renderBoards, type Board, type Img } from './harness.ts';

const FAMILIES = ['Inter', 'Roboto', 'Noto Serif'] as const;
const SIZES = [9, 12, 14, 16, 21, 28, 40, 72];
/** Board-relative offset of every text; the fractional part exercises the SVG renderer's page-space rounding. */
const X = 10;
const Y = 10.25;

interface Case {
  family: string;
  size: number;
  lineHeight: number;
  align: 'top' | 'center' | 'bottom';
  height: number;
}

const cases: Case[] = [];
for (const family of FAMILIES) {
  for (const size of SIZES) {
    const align = (['top', 'center', 'bottom'] as const)[size % 3]!;
    cases.push({ family, size, lineHeight: Math.round(size * 1.3) + 0.37, align, height: Math.round(3 * size * 1.4) + 5.37 });
  }
}

function caseNode(c: Case): ir.TextNode {
  const node = textNode([['HHH\nHHH\nHHH', { fontFamily: c.family, fontSize: c.size, lineHeight: { unit: 'px', value: c.lineHeight }, fills: [BLACK] }]], {
    size: { width: Math.ceil(2.6 * c.size) + 4, height: c.height },
    alignVertical: c.align,
  });
  return { ...node, transform: { ...node.transform, e: X, f: Y } };
}

/** Rows' bottom ink edges (the baselines of "H"), with sub-pixel coverage, in CSS px. */
function baselines(img: Img): number[] {
  const rows: number[] = [];
  for (let y = 0; y < img.height; y++) {
    let m = 0;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3]! / 255;
      const lum = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 765;
      m = Math.max(m, 1 - (lum * a + (1 - a)));
    }
    rows.push(m);
  }
  const out: number[] = [];
  for (let y = 0; y < rows.length; y++) {
    if (rows[y]! > 0.9 && !(rows[y + 1]! > 0.9)) {
      let bottom = y + 1;
      for (let k = y + 1; k < rows.length && rows[k]! > 0.02; k++) bottom += Math.min(1, rows[k]!);
      out.push(bottom / SCALE);
    }
  }
  return out;
}

const glyphBoards: Board[] = [
  // ⇧ is not in the font files Penpot serves for Inter: the browser draws its own fallback glyph.
  { nodes: [{ ...textNode([['⇧', { fontSize: 40, lineHeight: { unit: 'px', value: 48 }, fills: [BLACK] }]], { size: { width: 60, height: 48 } }), transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 } }], width: 80, height: 70 },
];

const GRADIENT: ir.GradientPaint = {
  type: 'gradient',
  gradientType: 'linear',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  handles: [
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 0, y: 1 },
  ],
  stops: [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ],
};
const at = (node: ir.TextNode): ir.TextNode => ({ ...node, transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 } });
// Gradient-filled text: SVG paints the whole box (why `auto` outlines it there), WASM the glyphs.
glyphBoards.push({ nodes: [at(textNode([['HHHH', { fontSize: 40, lineHeight: { unit: 'px', value: 48 }, fills: [GRADIENT] }]], { size: { width: 120, height: 48 } }))], width: 140, height: 70 });
// Truncated text: 3 source lines, the source shows the first one and an ellipsis; nothing may be drawn below it.
{
  const s = { fontSize: 20, lineHeight: { unit: 'px', value: 24 } as const, fills: [BLACK] };
  const node = textNode([['HHH HHH HHH HHH HHH HHH', s]], {
    size: { width: 125, height: 24 },
    autoResize: 'truncate',
    layout: { truncationStart: 8, lines: [{ start: 0, end: 8, baseline: { x: 0, y: 18.4 }, width: 118, lineHeight: 24.2, ascent: 18.4 }] },
  });
  glyphBoards.push({ nodes: [at(node)], width: 160, height: 140 });
}

let renders: Record<Renderer, (Img | undefined)[]>;

describe.skipIf(process.env.PENPOT_LIVE !== '1')('baseline model (live)', () => {
  beforeAll(async () => {
    const boards: Board[] = cases.map((c) => ({ nodes: [caseNode(c)], width: Math.ceil(2.6 * c.size) + 30, height: Math.ceil(c.height) + 30 }));
    // Raw renderer behaviour: no compensation (no layout lines), so the model is what is measured.
    renders = await renderBoards('baseline', [...boards, ...glyphBoards], { renderer: 'svg' });
  }, 900_000);

  describe.each(RENDERERS)('%s renderer', (r) => {
    it('predicts every line of a size sweep (fractional box y, line height, alignment)', () => {
      const misses: string[] = [];
      cases.forEach((c, i) => {
        const img = renders[r][i];
        expect(img, `${c.family} ${c.size}`).toBeDefined();
        const measured = baselines(img!);
        const ratio = Number(ratioString(c.lineHeight / c.size, c.size));
        const lines = tryModelLines(Array(3).fill({ lineHeight: ratio, spacer: false, leaves: [{ text: 'HHH', fontFamily: c.family, fontSize: c.size, lineHeight: ratio }] }))!;
        const predicted =
          r === 'svg' ? svgBaselines(lines, c.height, c.align).map((p) => Math.round(Y + p)) : wasmBaselines(lines, c.height, c.align).map((p) => Y + p);
        // Roboto's H overshoots its baseline by ~0.09 px.
        const tolerance = r === 'svg' ? 0.15 : 0.35;
        predicted.forEach((p, k) => {
          if (!(Math.abs((measured[k] ?? NaN) - p) <= tolerance)) misses.push(`${c.family} ${c.size}/${num(c.lineHeight)} ${c.align} line ${k}: ${measured[k]} vs ${p}`);
        });
      });
      expect(misses).toEqual([]);
    });
  });

  it('SVG fills the whole box of a gradient-filled text, WASM only its glyphs', () => {
    const coverage = (img: Img): number => {
      // share of the text box (10..130 × 10..58 CSS px) that is coloured
      let n = 0;
      let total = 0;
      for (let y = 10 * SCALE; y < 58 * SCALE; y++) {
        for (let x = 10 * SCALE; x < 130 * SCALE; x++) {
          const i = (y * img.width + x) * 4;
          total++;
          if (img.data[i + 1]! < 128) n++;
        }
      }
      return n / total;
    };
    expect(coverage(renders.svg[cases.length + 1]!)).toBeGreaterThan(0.9);
    expect(coverage(renders.wasm[cases.length + 1]!)).toBeLessThan(0.5);
  });

  it.each(RENDERERS)('%s: a truncated text draws its shown line and nothing of the hidden tail', (r) => {
    const img = renders[r][cases.length + 2]!;
    const rowsWithInk: number[] = [];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3]! > 128 && img.data[i]! < 128) {
          rowsWithInk.push(y / SCALE);
          break;
        }
      }
    }
    expect(rowsWithInk.length).toBeGreaterThan(0);
    // one line: ink between the box top (10) and the line's descent
    expect(Math.max(...rowsWithInk)).toBeLessThan(10 + 24 + 1);
  });

  it('a character outside the served subsets is drawn with another glyph than the font has (why auto outlines it)', () => {
    // Both renderers draw something for ⇧, but not Inter's glyph: its ink differs between them.
    const svg = renders.svg[cases.length]!;
    const wasm = renders.wasm[cases.length]!;
    const inkCount = (img: Img): number => {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]! > 128 && img.data[i]! < 128) n++;
      return n;
    };
    expect(inkCount(svg)).toBeGreaterThan(0);
    expect(inkCount(wasm)).toBeGreaterThan(0);
    expect(Math.abs(inkCount(svg) - inkCount(wasm)) / Math.max(inkCount(svg), inkCount(wasm))).toBeGreaterThan(0.1);
  });
});
