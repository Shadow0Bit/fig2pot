import { describe, expect, it } from 'vitest';
import { baselineShift, chromiumAscentDescent, svgBaselines, tryModelLines, wasmBaselines, type ModelParagraph } from '../../../src/penpot/text/baseline.ts';
import { penpotFontMetrics } from '../../../src/penpot/text/metrics.ts';
import { penpotTextBox } from '../../../src/penpot/text/index.ts';
import type * as ir from '../../../src/ir.ts';
import { textNode } from './helpers.ts';

function line(start: number, end: number, baselineY: number, width: number, lineHeight: number, ascent: number): ir.TextLine {
  return { start, end, baseline: { x: 0, y: baselineY }, width, lineHeight, ascent };
}

/** Three paragraphs "HHH" in one font, as the writer emits them. */
function three(fontFamily: string, fontSize: number, ratio: number): ModelParagraph[] {
  const p: ModelParagraph = { lineHeight: ratio, spacer: false, leaves: [{ text: 'HHH', fontFamily, fontSize, lineHeight: ratio }] };
  return [p, p, p];
}

// Measured on Penpot 2.19 (live sweep, 4× export): baselines of three lines, box at y = `pageY`, height `h`.
const SVG_MEASURED: [string, number, number, 'top' | 'center' | 'bottom', number, number, number[]][] = [
  ['Inter', 9, 1.4444, 'top', 0, 40, [8, 21, 34]],
  ['Inter', 21, 1.381, 'top', 0, 90, [21, 50, 79]],
  ['Poppins', 23, 1.3913, 'top', 0, 98, [23, 55, 87]],
  ['Noto Serif', 9, 1.4444, 'top', 0, 40, [10, 23, 36]],
  ['Roboto', 29, 1.1719, 'top', 0, 104, [26, 60, 94]],
  ['Inter', 19, 1.21, 'top', 0, 72, [18, 41, 64]],
  ['Inter', 21, 1.5238, 'center', 0.25, 105.37, [27, 59, 91]],
  ['Roboto', 14, 1.3121, 'bottom', 0.75, 64.37, [23, 41, 60]],
  ['Noto Serif', 28, 1.5, 'center', 0.5, 135.37, [36, 78, 120]],
];

describe('SVG renderer baseline model', () => {
  it.each(SVG_MEASURED)('%s %d px × %d (%s, y + %d) matches the live render', (family, size, ratio, align, pageY, h, measured) => {
    const lines = tryModelLines(three(family, size, ratio))!;
    const predicted = svgBaselines(lines, h, align).map((p) => Math.round(pageY + p));
    expect(predicted).toEqual(measured);
  });

  it("rounds ascent / descent like Chromium on Linux (a descent rounded down borrows 1 px from the ascent)", () => {
    const inter = penpotFontMetrics('Inter')!;
    expect(chromiumAscentDescent(inter, 9)).toEqual({ ascent: 8, descent: 3 }); // 8.72 / 2.17
    expect(chromiumAscentDescent(inter, 8)).toEqual({ ascent: 8, descent: 2 }); // 7.75 / 1.93
  });

  it('takes the tallest span of a mixed line', () => {
    const p: ModelParagraph = {
      lineHeight: 1.2,
      spacer: false,
      leaves: [
        { text: 'a', fontFamily: 'Inter', fontSize: 10, lineHeight: 1.2 },
        { text: 'B', fontFamily: 'Inter', fontSize: 40, lineHeight: 1.2 },
      ],
    };
    const [b] = svgBaselines(tryModelLines([p])!, 100, 'top');
    const [big] = svgBaselines(tryModelLines([{ ...p, leaves: [p.leaves[1]!] }])!, 100, 'top');
    expect(b).toBe(big);
  });

  it('has no model for fonts without metrics', () => {
    expect(tryModelLines(three('Unknown Sans', 12, 1.2))).toBeUndefined();
  });

  it('splits soft breaks into lines', () => {
    const lines = tryModelLines([{ lineHeight: 1.5, spacer: false, leaves: [{ text: 'a\nb\n', fontFamily: 'Inter', fontSize: 16, lineHeight: 1.5 }] }])!;
    expect(lines).toHaveLength(3);
  });
});

describe('render-wasm baseline model', () => {
  const WASM_MEASURED: [string, number, number, 'top' | 'center' | 'bottom', number, number, number[]][] = [
    ['Inter', 16, 1.21, 'top', 0, 60, [16, 35, 54]],
    ['Inter', 15, 1.5, 'top', 0, 70, [17, 40, 63]],
    ['Inter', 21, 1.5238, 'center', 0.25, 105.37, [29, 61, 93]],
    ['Roboto', 14, 1.3121, 'bottom', 0.75, 64.37, [25, 43, 61]],
  ];
  it.each(WASM_MEASURED)('%s %d px × %d (%s, y + %d) is within 0.3 px of the live render', (family, size, ratio, align, pageY, h, measured) => {
    const predicted = wasmBaselines(tryModelLines(three(family, size, ratio))!, h, align).map((p) => pageY + p);
    predicted.forEach((p, i) => expect(Math.abs(p - measured[i]!)).toBeLessThanOrEqual(0.3));
  });
});

describe('baselineShift', () => {
  it('SVG: picks the shift whose rounding lands every line within 0.5 px', () => {
    // Renderer at 21.0 / 50.0 / 79.0, source at 22.14 / 51.14 / 80.14.
    const r = baselineShift('svg', [21, 50, 79], [22.14, 51.14, 80.14], 0)!;
    expect(Math.max(...r.errors)).toBeLessThanOrEqual(0.5);
    expect(Math.max(...r.errorsBefore)).toBeCloseTo(1.14);
    // the middle of the range that rounds to 22 / 51 / 80
    expect(r.shift).toBeCloseTo(1);
  });

  it('SVG: never worse than no shift, and no shift when nothing improves', () => {
    const r = baselineShift('svg', [10.2, 30.2], [10, 30], 0)!;
    expect(r.shift).toBe(0);
    expect(r.errors).toEqual(r.errorsBefore);
  });

  it('SVG: accounts for the page position of the box', () => {
    const a = baselineShift('svg', [10, 30], [10.5, 30.5], 0.4)!;
    expect(Math.max(...a.errors)).toBeLessThanOrEqual(0.5);
  });

  it('WASM: centres the error range', () => {
    const r = baselineShift('wasm', [16, 35, 54], [15.5, 34.4, 53.4], 0.3)!;
    expect(r.shift).toBeCloseTo(-0.55);
    expect(Math.max(...r.errors)).toBeCloseTo(0.05);
  });
});

describe('penpotTextBox baseline compensation', () => {
  const s = { fontSize: 21, lineHeight: { unit: 'px', value: 29 } } as const;
  // Figma's first baseline for 21 px on 29: (29 − 25.41) / 2 + 20.34 = 22.14
  const node = textNode([['HHH\nHHH', s]], {
    size: { width: 100, height: 58 },
    layout: { lines: [line(0, 4, 22.14, 40, 25.41, 22.14), line(4, 7, 51.14, 40, 25.41, 22.14)] },
  });

  it('shifts the SVG box so the rounded baselines land within 0.5 px', () => {
    const { box, baseline } = penpotTextBox(node, 'source', { renderer: 'svg', pageY: 0 });
    expect(Math.max(...baseline!.errorsBefore)).toBeGreaterThan(0.5);
    expect(Math.max(...baseline!.errors)).toBeLessThanOrEqual(0.5);
    expect(box.y).toBe(baseline!.shift);
  });

  it('does not shift without a placement, or an SVG text without a page position', () => {
    expect(penpotTextBox(node, 'source').box.y).toBe(0);
    expect(penpotTextBox(node, 'source', { renderer: 'svg' }).box.y).toBe(0);
  });

  it('shifts the WASM box continuously', () => {
    const { baseline } = penpotTextBox(node, 'source', { renderer: 'wasm' });
    expect(Math.max(...baseline!.errors)).toBeLessThanOrEqual(0.5);
  });

  it('does not compensate WASM lines of x.5 px (render-wasm rounds them either way), but still SVG ones', () => {
    // 9 px at 13.5 px lines: the sweep measured 13 or 14 px pitches depending on the family.
    const half = textNode([['HHH\nHHH\nHHH', { fontSize: 9, lineHeight: { unit: 'px', value: 13.5 } }]], {
      size: { width: 100, height: 41 },
      layout: { lines: [line(0, 4, 9.5, 30, 10.9, 9.5), line(4, 8, 23, 30, 10.9, 9.5), line(8, 11, 36.5, 30, 10.9, 9.5)] },
    });
    const wasm = penpotTextBox(half, 'source', { renderer: 'wasm' });
    expect(wasm.baseline).toBeUndefined();
    expect(wasm.box.y).toBe(0);
    expect(penpotTextBox(half, 'source', { renderer: 'svg', pageY: 0 }).baseline).toBeDefined();
  });
});
