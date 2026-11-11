import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { balancedSpacing, glyphErrors, lineError, lineSpacing, penpotAdvance, type LineAlign, type LineGlyph } from '../../../src/penpot/text/advances.ts';
import { buildTextAttrs, MAX_LINE_SEGMENTS, MIN_LINE_ERROR, penpotTextBox, type TextDeps } from '../../../src/penpot/text/index.ts';
import { doc, write } from '../helpers.ts';
import { testDeps as plainDeps, textNode } from './helpers.ts';

const lineDeps = (renderer: 'svg' | 'wasm' = 'svg'): ReturnType<typeof plainDeps> & TextDeps => ({ ...plainDeps(), textSpacing: 'line', renderer });

type Leaf = { text: string; letterSpacing: string; fontWeight?: string };
const leaves = (content: unknown): Leaf[] =>
  (content as { children: { children: { children: Leaf[] }[] }[] }).children[0]!.children.flatMap((p) => p.children);

const own = (c: string, variant = 'regular'): number => penpotAdvance('Inter', variant, c.codePointAt(0)!) ?? 0.5;

/** Figma's glyphs for `text` at `size`: Penpot's advances except where `em` says otherwise; lines start at x = 0. */
function source(text: string, size: number, em: (c: string, i: number) => number = (c) => own(c), lineStarts: number[] = [0]) {
  const glyphAdvances: { offset: number; x: number; y: number; advance: number }[] = [];
  let x = 0;
  let line = -1;
  for (let i = 0; i < text.length; i++) {
    if (lineStarts.includes(i)) {
      x = 0;
      line++;
    }
    if (text[i] === '\n') continue;
    const g = { offset: i, x, y: size * (line + 1), advance: em(text[i]!, i) * size };
    glyphAdvances.push(g);
    x += g.advance;
  }
  return glyphAdvances;
}

function lines(text: string, size: number, starts: number[], glyphs: { offset: number; x: number; advance: number }[]): ir.TextLine[] {
  return starts.map((start, k) => {
    const end = starts[k + 1] ?? text.length;
    const gs = glyphs.filter((g) => g.offset >= start && g.offset < end);
    const last = gs[gs.length - 1]!;
    return { start, end, baseline: { x: 0, y: size * (k + 1) }, width: last.x + last.advance, lineHeight: size * 1.2, ascent: size };
  });
}

describe('lineSpacing (the per-line model)', () => {
  const brute = (glyphs: LineGlyph[], first: number, last: number, align: LineAlign, renderer: 'svg' | 'wasm'): number => {
    let best = Infinity;
    for (let e = -3; e <= 3; e += 0.0005) best = Math.min(best, lineError(glyphs, first, last, align, renderer, e));
    return best;
  };

  it('left, SVG: the spacing of the gaps between the first and last glyph carries the whole drift, exactly', () => {
    const glyphs: LineGlyph[] = [0, 0.5, 0, 0.7, 0].map((delta) => ({ delta, weight: 1 }));
    const r = lineSpacing(glyphs, 0, 4, 'left', 'svg');
    expect(r.before).toBeCloseTo(1.2, 9);
    expect(r.extra).toBeCloseTo(1.2 / 4, 9);
    expect(r.error).toBeCloseTo(0, 9);
  });

  it('left, WASM: render-wasm also moves the first glyph by half its spacing, so the error is split between both ends', () => {
    const glyphs: LineGlyph[] = [0, 0.5, 0, 0.7, 0].map((delta) => ({ delta, weight: 1 }));
    const r = lineSpacing(glyphs, 0, 4, 'left', 'wasm');
    expect(r.extra).toBeCloseTo(1.2 / 5, 9);
    expect(r.error).toBeCloseTo(0.12, 9);
  });

  it('right and centre: the line keeps its anchor, the spacing of every character moves it', () => {
    // Right-aligned: uncorrected, the first glyph is the whole drift (+1.2) right, the last 0.
    const glyphs: LineGlyph[] = [0, 0.5, 0, 0.7, 0].map((delta) => ({ delta, weight: 1 }));
    for (const renderer of ['svg', 'wasm'] as const) {
      const right = lineSpacing(glyphs, 0, 4, 'right', renderer);
      expect(right.before).toBeCloseTo(1.2, 9);
      // 5 spacings move the first glyph, the last one's own spacing moves the last: e = 1.2 / 6 balances them.
      expect(right.extra).toBeCloseTo(1.2 / 6, 9);
      expect(right.error).toBeCloseTo(0.2, 9);
      const centre = lineSpacing(glyphs, 0, 4, 'center', renderer);
      expect(centre.before).toBeCloseTo(0.6, 9);
      // Centred: the first glyph moves by −2.5 e, the last by +1.5 e; e = 0.3 leaves both 0.15 left.
      expect(centre.extra).toBeCloseTo(0.3, 9);
      expect(centre.error).toBeCloseTo(0.15, 9);
    }
  });

  it('is the minimax of the two ends on random lines (every alignment and renderer)', () => {
    let seed = 11;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 120; t++) {
      const n = 2 + Math.floor(random() * 20);
      const glyphs: LineGlyph[] = Array.from({ length: n }, () => ({ delta: random() < 0.4 ? 0 : (random() - 0.3) * 0.8, weight: random() < 0.15 ? 0 : 1 }));
      const align = (['left', 'center', 'right'] as const)[t % 3]!;
      const renderer = t % 2 === 0 ? 'svg' : 'wasm';
      const first = Math.floor(random() * 2);
      const r = lineSpacing(glyphs, first, n - 1, align, renderer);
      expect(r.error).toBeLessThanOrEqual(brute(glyphs, first, n - 1, align, renderer) + 1e-3);
      expect(r.error).toBeLessThanOrEqual(r.before + 1e-9);
    }
  });
});

describe('balancedSpacing', () => {
  it('keeps the ends exact when nothing inside drifts, and trades end error for inner drift by INNER_SLACK otherwise', () => {
    const even: LineGlyph[] = [0.2, 0.2, 0.2, 0.2, 0.2].map((delta) => ({ delta, weight: 1 }));
    const ink = [0, 1, 2, 3, 4];
    expect(balancedSpacing(even, ink, 'left', 'svg', 1.5).extra).toBeCloseTo(lineSpacing(even, 0, 4, 'left', 'svg').extra, 6);
    // +1.5 px then −1.5 px: the ends agree without correction, the middle glyph is 1.5 px off whatever e is.
    const bump: LineGlyph[] = [1.5, 0, -1.5, 0, 0].map((delta) => ({ delta, weight: 1 }));
    const r = balancedSpacing(bump, ink, 'left', 'svg', 1.5);
    const errors = glyphErrors(bump, bump.map(() => r.extra), 'left', 'svg');
    expect(Math.max(Math.abs(errors[0]!), Math.abs(errors[4]!))).toBeLessThanOrEqual(Math.max(...errors.slice(1, 4).map(Math.abs)) / 1.5 + 1e-6);
    expect(r.extra).toBeGreaterThan(0);
  });
});

describe("textSpacing 'line'", () => {
  // Figma's Inter Bold "t" is 0.3885 em, Penpot's 0.3662 em: +0.535 px at 24 px.
  const bold = (c: string): number => (c === 't' ? 0.3885 : own(c, '700'));
  const button = (text = 'Button', overrides: Partial<ir.TextNode> = {}, style: Partial<ir.TextStyle> = {}) => {
    const glyphAdvances = source(text, 24, bold);
    return textNode([[text, { fontSize: 24, fontWeight: 700, fontStyle: 'Bold', ...style }]], { layout: { glyphAdvances, lines: lines(text, 24, [0], glyphAdvances) }, ...overrides });
  };

  it('gives the whole line one spacing, without splitting it: "Button" ends where Figma ends it', () => {
    const ls = leaves(buildTextAttrs(button(), lineDeps()).content);
    // Two "t" before the last glyph: 1.07 px over the 5 gaps between "B" and "n".
    expect(ls).toEqual([expect.objectContaining({ text: 'Button', letterSpacing: '0.21' })]);
  });

  it('adds to the source letter spacing', () => {
    const glyphAdvances = source('Button', 24, (c) => bold(c)).map((g, i) => ({ ...g, x: g.x + i * 1.5 }));
    const node = textNode([['Button', { fontSize: 24, fontWeight: 700, fontStyle: 'Bold', letterSpacing: { unit: 'px', value: 1.5 } }]], { layout: { glyphAdvances, lines: lines('Button', 24, [0], glyphAdvances) } });
    expect(leaves(buildTextAttrs(node, lineDeps()).content)).toEqual([expect.objectContaining({ letterSpacing: '1.71' })]);
  });

  it('is warned once per document', () => {
    const deps = lineDeps();
    buildTextAttrs(button(), deps);
    buildTextAttrs({ ...button(), id: '1:3' }, deps);
    expect(deps.reporter.warnings.filter((w) => w.code === 'text-spacing-corrected')).toHaveLength(1);
    expect(deps.reporter.warnings.map((w) => w.code)).not.toContain('pixel-exact-text-spacing');
  });

  it('per alignment and renderer: chooses the spacing that best puts the first and last glyph at the source', () => {
    // right, SVG: the 6 characters' spacings move "B", the last one's moves "n".
    const right = leaves(buildTextAttrs(button('Button', { alignHorizontal: 'right' }), lineDeps()).content);
    expect(Number(right[0]!.letterSpacing)).toBeCloseTo(1.07 / 7, 1);
    // left, WASM: render-wasm moves "B" by half its spacing.
    const wasm = leaves(buildTextAttrs(button(), lineDeps('wasm')).content);
    expect(Number(wasm[0]!.letterSpacing)).toBeCloseTo(1.07 / 6, 2);
  });

  it('skips a line whose ends are off by less than MIN_LINE_ERROR', () => {
    // One "t" at 10 px: 0.22 px.
    const glyphAdvances = source('ten', 10, bold);
    const node = textNode([['ten', { fontSize: 10, fontWeight: 700, fontStyle: 'Bold' }]], { layout: { glyphAdvances, lines: lines('ten', 10, [0], glyphAdvances) } });
    expect(0.0223 * 10).toBeLessThan(MIN_LINE_ERROR);
    expect(leaves(buildTextAttrs(node, lineDeps()).content)).toEqual([expect.objectContaining({ letterSpacing: '0' })]);
  });

  it('rounds to 0.01 px, or to 0.001 px where 0.01 would move the line end by more than 0.05 px', () => {
    // 120 characters: 0.005 px of rounding is 0.6 px at the end.
    const text = 'tttttttttt'.repeat(12);
    const glyphAdvances = source(text, 24, bold);
    const node = textNode([[text, { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { size: { width: 2000, height: 40 }, layout: { glyphAdvances, lines: lines(text, 24, [0], glyphAdvances) } });
    const spacing = leaves(buildTextAttrs(node, lineDeps()).content)[0]!.letterSpacing;
    expect(spacing).toBe('0.535');
  });

  it('one spacing per line; lines whose spacing rounds alike share a leaf (no leaf explosion)', () => {
    const text = 'Button settings\nButton settings\nplain words\nmore words';
    const starts = [0, 16, 32, 44];
    const glyphAdvances = source(text, 24, bold, starts);
    const node = textNode([[text, { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { size: { width: 300, height: 120 }, layout: { glyphAdvances, lines: lines(text, 24, starts, glyphAdvances) } });
    const ls = leaves(buildTextAttrs(node, lineDeps()).content);
    expect(ls.map((l) => l.text).join('\n')).toBe(text);
    // 4 paragraphs: the last two need no correction.
    expect(ls).toHaveLength(4);
    expect(ls[0]!.letterSpacing).toBe(ls[1]!.letterSpacing);
    expect(ls.slice(2).map((l) => l.letterSpacing)).toEqual(['0', '0']);
    // Wrapped lines (soft breaks) of one run: a leaf per distinct value at most.
    const wrapped = 'Button settings Button settings plain words';
    const wStarts = [0, 16, 32];
    const wg = source(wrapped, 24, bold, wStarts);
    const wnode = textNode([[wrapped, { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { size: { width: 300, height: 120 }, layout: { glyphAdvances: wg, lines: lines(wrapped, 24, wStarts, wg) } });
    const wl = leaves(buildTextAttrs(wnode, lineDeps()).content);
    expect(wl.length).toBeLessThanOrEqual(wStarts.length);
    expect(wl).toHaveLength(2);
    expect(wl[0]!.text).toBe('Button settings\nButton settings\n');
  });

  it('splits a line whose glyphs drift inside it into at most 3 leaves, never inside a kerned pair', () => {
    // "tttt" 1.17 px wider each at 32 px, then narrower glyphs that bring the line end back: the ends agree, the
    // middle is 4.7 px off with one spacing.
    const text = 'ttttoooooooooooooooo';
    const em = (c: string): number => (c === 't' ? 0.3636 : own(c) - 0.0091);
    const glyphAdvances = source(text, 32, em);
    const node = textNode([[text, { fontSize: 32 }]], { size: { width: 600, height: 40 }, layout: { glyphAdvances, lines: lines(text, 32, [0], glyphAdvances) } });
    const ls = leaves(buildTextAttrs(node, lineDeps()).content);
    expect(ls.map((l) => l.text).join('')).toBe(text);
    expect(ls.length).toBeGreaterThan(1);
    expect(ls.length).toBeLessThanOrEqual(MAX_LINE_SEGMENTS);
    // Every glyph within the split tolerance of where Figma drew it (left-aligned, SVG: the spacing after each glyph).
    let penpot = 0;
    let k = 0;
    for (const leaf of ls) {
      for (const c of leaf.text) {
        expect(Math.abs(penpot - glyphAdvances[k]!.x)).toBeLessThanOrEqual(0.75);
        penpot += own(c) * 32 + Number(leaf.letterSpacing);
        k++;
      }
    }
    // A pair the source kerned ("to" moved 2 px closer) is never cut.
    const kerned = glyphAdvances.map((g, i) => (i >= 4 ? { ...g, x: g.x - 2 } : g));
    const kl = leaves(buildTextAttrs({ ...node, layout: { ...node.layout!, glyphAdvances: kerned } }, lineDeps()).content);
    expect(kl.every((l) => !l.text.endsWith('t') || !kl[kl.indexOf(l) + 1]?.text.startsWith('o'))).toBe(true);
  });

  it('mixed styles on a line: every run of the line takes the same spacing, each stays one leaf', () => {
    const text = 'Bold text and regular text';
    const em = (c: string, i: number): number => (i < 9 ? bold(c) : c === 't' ? 0.3636 : own(c));
    const glyphAdvances = source(text, 24, em);
    const node = textNode(
      [
        ['Bold text', { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }],
        [' and regular text', { fontSize: 24 }],
      ],
      { size: { width: 400, height: 40 }, layout: { glyphAdvances, lines: lines(text, 24, [0], glyphAdvances) } },
    );
    const ls = leaves(buildTextAttrs(node, lineDeps()).content);
    expect(ls).toHaveLength(2);
    expect(ls[0]!.letterSpacing).toBe(ls[1]!.letterSpacing);
    expect(Number(ls[0]!.letterSpacing)).toBeGreaterThan(0);
  });

  it('guards: a contextual alternate keeps an unspaced leaf in SVG (not in WASM); no table, justified, no lines: nothing', () => {
    const text = 'Settings 5x5 grid';
    const em = (c: string, i: number): number => (c === 't' ? 0.3636 : i === 10 ? own('×') : own(c));
    const glyphAdvances = source(text, 32, em);
    const node = textNode([[text, { fontSize: 32 }]], { size: { width: 400, height: 40 }, layout: { glyphAdvances, lines: lines(text, 32, [0], glyphAdvances) } });
    expect(leaves(buildTextAttrs(node, lineDeps('svg')).content)).toEqual([expect.objectContaining({ letterSpacing: '0' })]);
    // render-wasm keeps the alternate in a spaced leaf. Both "t" are 1.17 px wider: the line is split there
    // (`refinedLine`), never next to the "x".
    const wasm = leaves(buildTextAttrs(node, lineDeps('wasm')).content);
    expect(wasm.map((l) => [l.text, l.letterSpacing])).toEqual([['Se', '0'], ['tt', '1.166'], ['ings 5x5 grid', '0']]);
    // With a source spacing the alternate is gone in Chromium anyway: corrected.
    const spaced = textNode([[text, { fontSize: 32, letterSpacing: { unit: 'px', value: 1 } }]], { size: { width: 400, height: 40 }, layout: { glyphAdvances: glyphAdvances.map((g, i) => ({ ...g, x: g.x + i })), lines: lines(text, 32, [0], glyphAdvances) } });
    expect(leaves(buildTextAttrs(spaced, lineDeps('svg')).content).some((l) => Number(l.letterSpacing) > 1)).toBe(true);
    // Inter's "->" is one glyph over two characters.
    const arrow = 'Settings -> next';
    const ag = source(arrow, 32, (c) => (c === 't' ? 0.3636 : own(c))).filter((g) => g.offset !== 10);
    const arrowNode = textNode([[arrow, { fontSize: 32 }]], { size: { width: 400, height: 40 }, layout: { glyphAdvances: ag, lines: lines(arrow, 32, [0], ag) } });
    expect(leaves(buildTextAttrs(arrowNode, lineDeps('svg')).content)[0]!.letterSpacing).toBe('0');
    // No advance table (Roboto), justified text: untouched.
    const roboto = textNode([['Button', { fontSize: 24, fontFamily: 'Roboto', fontWeight: 700, fontStyle: 'Bold' }]], { layout: button().layout! });
    expect(leaves(buildTextAttrs(roboto, lineDeps()).content)[0]!.letterSpacing).toBe('0');
    expect(leaves(buildTextAttrs(button('Button', { alignHorizontal: 'justified' }), lineDeps()).content)[0]!.letterSpacing).toBe('0');
    expect(leaves(buildTextAttrs(button('Button', { layout: { glyphAdvances: button().layout!.glyphAdvances! } }), lineDeps()).content)[0]!.letterSpacing).toBe('0');
  });

  it('looks advances up after the text case transform', () => {
    // Figma's glyphs are those of "NATURAL", all Penpot's advances: nothing to correct.
    const upper = (c: string): number => own(c.toUpperCase(), '700');
    const glyphAdvances = source('natural', 48, upper);
    const node = textNode([['natural', { fontSize: 48, fontWeight: 700, fontStyle: 'Bold', textCase: 'upper' }]], { layout: { glyphAdvances, lines: lines('natural', 48, [0], glyphAdvances) } });
    expect(leaves(buildTextAttrs(node, lineDeps()).content)[0]!.letterSpacing).toBe('0');
  });

  it("moves a right-aligned auto-width box by the corrected width (Penpot's line then ends at Figma's)", () => {
    const node = button('Button', { alignHorizontal: 'right', autoResize: 'width-and-height' });
    const figma = node.layout!.lines![0]!.width;
    node.size = { width: Math.ceil(figma), height: 30 };
    node.layout!.lines![0]!.baseline.x = Math.ceil(figma) - figma;
    const penpot = [...'Button'].reduce((w, c) => w + own(c, '700') * 24, 0);
    const extra = Number(leaves(buildTextAttrs(node, lineDeps()).content)[0]!.letterSpacing);
    const box = penpotTextBox(node, 'source', { renderer: 'svg', pageY: 0, textSpacing: 'line' }).box;
    expect(box.x + penpot + 6 * extra).toBeCloseTo(Math.ceil(figma), 3);
  });
});

describe('writer defaults', () => {
  const bold = (c: string): number => (c === 't' ? 0.3885 : own(c, '700'));
  const glyphAdvances = source('Button settings', 24, bold);
  const node = textNode([['Button settings', { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { id: 't', size: { width: 300, height: 40 }, layout: { glyphAdvances, lines: lines('Button settings', 24, [0], glyphAdvances) } });
  const leafCount = async (options: Parameters<typeof write>[1]) => {
    const w = await write(doc([node]), { textMode: 'editable', ...options });
    return { leaves: leaves(w.shape('t').content).length, codes: w.codes() };
  };

  it("is 'line' by default, 'glyph' with pixelExact, and textSpacing wins over pixelExact", async () => {
    expect(await leafCount({})).toEqual({ leaves: 1, codes: expect.arrayContaining(['text-spacing-corrected']) });
    expect((await leafCount({ pixelExact: true })).leaves).toBeGreaterThan(1);
    expect((await leafCount({ pixelExact: true })).codes).toContain('pixel-exact-text-spacing');
    expect(await leafCount({ pixelExact: true, textSpacing: 'line' })).toEqual({ leaves: 1, codes: expect.arrayContaining(['text-spacing-corrected']) });
    const none = await leafCount({ textSpacing: 'none' });
    expect(none.leaves).toBe(1);
    expect(none.codes).not.toContain('text-spacing-corrected');
  });
});
