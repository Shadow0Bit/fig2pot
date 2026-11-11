/**
 * Live checks of the reviewed text fixes (J1, J2, J5, J6, J7, J11), in both
 * renderers. Skipped unless PENPOT_LIVE=1 (see harness.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { penpotAdvance } from '../../../src/penpot/text/advances.ts';
import type { Renderer } from '../../../tools/visual/penpot.ts';
import { textNode } from '../text/helpers.ts';
import { BLACK, PAD, RENDERERS, ink, inkRows, placed, renderBoards, SCALE, type Board, type Img } from './harness.ts';

const px = (value: number): ir.LineHeight => ({ unit: 'px', value });
const cases: Record<string, Board> = {};
const exactCases: Record<string, Board> = {};
const add = (to: Record<string, Board>, key: string, node: ir.TextNode, board: Partial<Board> = {}): void => {
  to[key] = { ...board, nodes: [placed(node)] };
};

// J1 — 140 % of 16 px is laid out at 22 px lines by Figma: 19 lines end 18 × 22 = 396 px below the first.
const tall = Array.from({ length: 19 }, () => 'HHH').join('\n');
add(cases, 'percent', textNode([[tall, { fontSize: 16, lineHeight: { unit: 'percent', value: 140 }, fills: [BLACK] }]], { size: { width: 80, height: 19 * 22 } }));

// J6 — a bulleted list item ("List item" of simple-design-system: bullet at 7.5, text at 24) and its text alone at 24.
const listGlyphs = [...'List item'].reduce<{ offset: number; x: number; y: number; advance: number }[]>((out, c, i) => {
  const advance = (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0.3) * 16;
  out.push({ offset: i, x: i === 0 ? 24 : out[i - 1]!.x + out[i - 1]!.advance, y: 16.82, advance });
  return out;
}, []);
add(
  cases,
  'list',
  textNode([['List item', { fontSize: 16, lineHeight: px(22), fills: [BLACK] }]], {
    size: { width: 89, height: 22 },
    autoResize: 'width-and-height',
    lists: [{ start: 0, type: 'unordered', level: 1 }],
    layout: {
      lines: [{ start: 0, end: 9, baseline: { x: 24, y: 16.82 }, width: 64.2, lineHeight: 22, ascent: 16.82 }],
      glyphAdvances: listGlyphs,
      markers: [{ start: 0, x: 7.5, y: 16.82, advance: 9, fontSize: 16 }],
    },
  }),
);
add(cases, 'listControl', textNode([['List item', { fontSize: 16, lineHeight: px(22), fills: [BLACK] }]], { size: { width: 89, height: 22 }, paragraphIndent: 24 }));

// J11 — right-aligned auto-width "Brand": Figma's 48.05 px line ends at its 49 px box's right edge; a fixed 49 px
// right-aligned box ends there in both renderers.
const brandWidth = [...'Brand'].reduce((w, c) => w + (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0) * 16, 0);
const brand = (autoResize: ir.TextNode['autoResize']): ir.TextNode =>
  textNode([['Brand', { fontSize: 16, lineHeight: px(22), fills: [BLACK] }]], {
    size: { width: Math.ceil(brandWidth), height: 22 },
    autoResize,
    alignHorizontal: 'right',
    layout: { lines: [{ start: 0, end: 5, baseline: { x: Math.ceil(brandWidth) - brandWidth, y: 17 }, width: brandWidth, lineHeight: 22, ascent: 17 }] },
  });
add(cases, 'rightAuto', brand('width-and-height'), { width: 120, height: 70 });
add(cases, 'rightFixed', brand('none'), { width: 120, height: 70 });

// J5 — Penpot draws the family's own Cyrillic / Greek / Vietnamese, and (WASM, full Inter) ⇧: not a fallback font's.
for (const [key, text] of [['cyrillic', 'Привет мир'], ['greek', 'Αβγδε ζηθ'], ['vietnamese', 'Tiếng Việt'], ['shift', '⇧ ⌘ ⌥']] as const) {
  add(cases, key, textNode([[text, { fontSize: 24, lineHeight: px(32), fills: [BLACK] }]], { size: { width: 200, height: 32 }, autoResize: 'width-and-height' }), { width: 260, height: 80 });
  add(cases, `${key}Fallback`, textNode([[text, { fontFamily: 'Definitely Not A Font', fontSize: 24, lineHeight: px(32), fills: [BLACK] }]], { size: { width: 200, height: 32 }, autoResize: 'width-and-height' }), { width: 260, height: 80 });
}

// J2 / J7 (pixelExact) — the advance correction of an upper-cased text, and of a text with a contextual alternate.
const sourceGlyphs = (text: string, em: (c: string, i: number) => number, size: number) => {
  let x = 0;
  return [...text].map((c, i) => {
    const g = { offset: i, x, y: size, advance: em(c, i) * size };
    x += g.advance;
    return g;
  });
};
const bold = (cp: number): number => penpotAdvance('Inter', '700', cp) ?? 0.5;
add(
  exactCases,
  'upper',
  textNode([['natural', { fontSize: 48, fontWeight: 700, fontStyle: 'Bold', textCase: 'upper', lineHeight: px(58), fills: [BLACK] }]], {
    size: { width: 300, height: 58 },
    autoResize: 'width-and-height',
    // Figma's glyphs: those of "NATURAL"; its "T" exactly Penpot's, so nothing needs correcting.
    layout: { glyphAdvances: sourceGlyphs('natural', (c) => bold(c.toUpperCase().codePointAt(0)!), 48) },
  }),
  { width: 360, height: 100 },
);
add(exactCases, 'upperControl', textNode([['NATURAL', { fontSize: 48, fontWeight: 700, fontStyle: 'Bold', lineHeight: px(58), fills: [BLACK] }]], { size: { width: 300, height: 58 }, autoResize: 'width-and-height' }), { width: 360, height: 100 });
const calt = 'Settings 5x5';
const regular = (cp: number): number => penpotAdvance('Inter', 'regular', cp) ?? 0.5;
add(
  exactCases,
  'calt',
  textNode([[calt, { fontSize: 32, lineHeight: px(40), fills: [BLACK] }]], {
    size: { width: 300, height: 40 },
    autoResize: 'width-and-height',
    // Figma's "t" is 0.3636 em (Penpot 0.3271): corrected; its "x" between digits is "×".
    layout: { glyphAdvances: sourceGlyphs(calt, (c, i) => (c === 't' ? 0.3636 : i === 10 ? regular(0xd7) : regular(c.codePointAt(0)!)), 32) },
  }),
  { width: 340, height: 80 },
);
// Uncorrected (one leaf, no spacing): Inter's contextual × in both renderers.
add(exactCases, 'caltControl', textNode([[calt, { fontSize: 32, lineHeight: px(40), fills: [BLACK] }]], { size: { width: 300, height: 40 }, autoResize: 'width-and-height' }), { width: 340, height: 80 });

const keys = Object.keys(cases);
const exactKeys = Object.keys(exactCases);
let renders: Record<Renderer, (Img | undefined)[]>;
let exactRenders: Record<Renderer, (Img | undefined)[]>;
const img = (r: Renderer, key: string): Img => {
  const out = keys.includes(key) ? renders[r][keys.indexOf(key)] : exactRenders[r][exactKeys.indexOf(key)];
  if (!out) throw new Error(`${key} failed to export with ${r}`);
  return out;
};

/** Pixels whose darkness differs by more than half between two renders of the same size. */
function differing(a: Img, b: Img, x0 = 0, x1 = a.width / SCALE): number {
  let n = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y++) {
    for (let x = Math.round(x0 * SCALE); x < Math.min(a.width, b.width, Math.round(x1 * SCALE)); x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      if (Math.abs(a.data[i]! - b.data[j]!) > 128) n++;
    }
  }
  return n;
}

describe.skipIf(process.env.PENPOT_LIVE !== '1')('Penpot text fidelity fixes (live)', () => {
  beforeAll(async () => {
    // Each renderer gets a file tuned for it (renderer-specific box shifts, J11).
    renders = { svg: [], wasm: [] };
    exactRenders = { svg: [], wasm: [] };
    for (const renderer of RENDERERS) {
      renders[renderer] = (await renderBoards(`text-fidelity-${renderer}`, keys.map((k) => cases[k]!), { renderer }))[renderer];
      exactRenders[renderer] = (await renderBoards(`text-fidelity-px-${renderer}`, exactKeys.map((k) => exactCases[k]!), { renderer, pixelExact: true }))[renderer];
    }
    if (process.env.PENPOT_LIVE_DEBUG) for (const r of RENDERERS) for (const k of [...keys, ...exactKeys]) console.log(r, k, JSON.stringify(ink(img(r, k))));
  }, 600_000);

  describe.each(RENDERERS)('%s renderer', (r) => {
    it('J1: percent line heights advance by whole px like Figma (19 lines, no drift)', () => {
      const lines = inkRows(img(r, 'percent'));
      expect(lines).toHaveLength(19);
      expect(Math.abs(lines[18]!.bottom - lines[0]!.bottom - 18 * 22)).toBeLessThanOrEqual(1);
    });

    it('J6: a bulleted item gets its bullet where Figma draws it and its text at the indent', () => {
      const band = (key: string, x0: number, x1: number) => {
        const image = img(r, key);
        let left = Infinity;
        let right = -1;
        for (let y = 0; y < image.height; y++) {
          for (let x = Math.round((PAD + x0) * SCALE); x < Math.round((PAD + x1) * SCALE); x++) {
            const i = (y * image.width + x) * 4;
            if (image.data[i]! < 128) {
              left = Math.min(left, x / SCALE - PAD);
              right = Math.max(right, (x + 1) / SCALE - PAD);
            }
          }
        }
        return { left, right };
      };
      const bullet = band('list', 0, 20);
      // Inter's bullet: 9 px advance with its dot centred, from x = 7.5.
      expect(Math.abs((bullet.left + bullet.right) / 2 - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(band('list', 20, 100).left - band('listControl', 20, 100).left)).toBeLessThanOrEqual(0.5);
      expect(band('listControl', 0, 20).right).toBe(-1);
    });

    it("J11: a right-aligned auto-width text ends at Figma's box edge, like a fixed right-aligned box", () => {
      const auto = ink(img(r, 'rightAuto'))!;
      const fixed = ink(img(r, 'rightFixed'))!;
      expect(Math.abs(auto.right - fixed.right)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(auto.left - fixed.left)).toBeLessThanOrEqual(0.5);
    });

    it("J5: Cyrillic, Greek and Vietnamese are drawn with the family's own font", () => {
      for (const key of ['cyrillic', 'greek', 'vietnamese']) expect(differing(img(r, key), img(r, `${key}Fallback`)), key).toBeGreaterThan(200);
    });

    if (r === 'wasm') {
      it('J5: render-wasm draws ⇧ ⌘ ⌥ with the full Inter, not a fallback', () => {
        expect(differing(img(r, 'shift'), img(r, 'shiftFallback'))).toBeGreaterThan(100);
      });
    }

    it('J2 (pixelExact): an upper-cased text is corrected for the glyphs it draws (no extra spacing)', () => {
      const upper = ink(img(r, 'upper'))!;
      const control = ink(img(r, 'upperControl'))!;
      expect(Math.abs(upper.right - control.right)).toBeLessThanOrEqual(0.5);
    });

    it('J7 (pixelExact): a corrected text keeps its contextual alternate (5x5 draws ×)', () => {
      const a = img(r, 'calt');
      const b = img(r, 'caltControl');
      // Only the two "t" are corrected (2 × 1.17 px); the "x" keeps no spacing (it would lose its × in SVG and
      // get a gap after it in WASM).
      const shift = ink(a)!.right - ink(b)!.right;
      expect(Math.abs(shift - 2 * (0.3636 - 0.3271) * 32)).toBeLessThanOrEqual(1);
      // "5x5" (its last 3 glyphs, ~2.2 × 0.62 em) has the same ink once aligned.
      const x1 = ink(b)!.right;
      const x0 = x1 - 2.2 * 32 * 0.62;
      const dx = Math.round(shift * SCALE);
      let mismatched = 0;
      for (let y = 0; y < Math.min(a.height, b.height); y++) {
        for (let x = Math.round(x0 * SCALE); x < Math.round(x1 * SCALE); x++) {
          const i = (y * b.width + x) * 4;
          const j = (y * a.width + x + dx) * 4;
          if (Math.abs(a.data[j]! - b.data[i]!) > 128) mismatched++;
        }
      }
      expect(mismatched).toBeLessThanOrEqual(60);
    });
  });
});
