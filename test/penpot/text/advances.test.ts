import { describe, expect, it } from 'vitest';
import { GlyphCensus, TOLERANCE, penpotAdvance, segments } from '../../../src/penpot/text/advances.ts';
import { buildTextAttrs } from '../../../src/penpot/text/index.ts';
import { testDeps as plainDeps, textNode } from './helpers.ts';

/** Advance correction is `pixelExact` only. */
const testDeps = () => ({ ...plainDeps(), textSpacing: 'glyph' as const });

type Leaf = { text: string; letterSpacing: string };
const leaves = (content: unknown): Leaf[] =>
  (content as { children: { children: { children: Leaf[] }[] }[] }).children[0]!.children.flatMap((p) => p.children);

describe('penpotAdvance', () => {
  it("knows the advances of the Inter files Penpot serves", () => {
    // Read from the served woff2 (2048 units per em)
    expect(penpotAdvance('Inter', 'regular', 't'.codePointAt(0)!)).toBeCloseTo(0.3271, 3);
    expect(penpotAdvance('Inter', '700', 't'.codePointAt(0)!)).toBeCloseTo(0.3662, 3);
    expect(penpotAdvance('Inter', 'regular', 0x4e00)).toBeUndefined();
    expect(penpotAdvance('Roboto', 'regular', 65)).toBeUndefined();
  });
});

describe('segments', () => {
  it('isolates a character whose correction differs and keeps every glyph within the tolerance', () => {
    const delta = [0, 0, 2, 0, 0, 0.05, 0.05];
    const segs = segments(0, delta.length, (i) => delta[i]!);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3],
      [3, 7],
    ]);
    // every glyph start within the tolerance of the exact cumulative correction
    let exact = 0;
    let drawn = 0;
    for (const s of segs) {
      for (let i = s.start; i < s.end; i++) {
        expect(Math.abs(drawn - exact)).toBeLessThanOrEqual(TOLERANCE + 1e-9);
        exact += delta[i]!;
        drawn += s.extra;
      }
    }
    expect(drawn).toBeCloseTo(exact, 9);
  });

  /** The definition, quadratic: every glyph start of a candidate segment is checked against its mean. */
  function reference(start: number, end: number, delta: (i: number) => number, canCut: (i: number) => boolean) {
    const out: { start: number; end: number; extra: number }[] = [];
    let s = start;
    while (s < end) {
      let e = s + 1;
      let sum = delta(s);
      while (e < end) {
        const next = sum + delta(e);
        const mean = next / (e + 1 - s);
        let error = 0;
        let ok = true;
        for (let k = s; k <= e && ok; k++) {
          if (Math.abs(error) > TOLERANCE) ok = false;
          error += delta(k) - mean;
        }
        if (!ok && canCut(e)) break;
        sum = next;
        e++;
      }
      out.push({ start: s, end: e, extra: sum / (e - s) });
      s = e;
    }
    return out;
  }

  it('matches the quadratic definition on random corrections', () => {
    let seed = 7;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(random() * 60);
      const scale = [0.02, 0.1, 0.4, 2][t % 4]!;
      const delta = Array.from({ length: n }, () => (random() < 0.3 ? 0 : (random() - 0.4) * scale));
      const forbidden = new Set(Array.from({ length: n }, (_, i) => i).filter(() => random() < 0.1));
      const canCut = (i: number): boolean => !forbidden.has(i);
      const got = segments(0, n, (i) => delta[i]!, canCut);
      const want = reference(0, n, (i) => delta[i]!, canCut);
      expect(got.map((g) => [g.start, g.end])).toEqual(want.map((g) => [g.start, g.end]));
      got.forEach((g, i) => expect(g.extra).toBeCloseTo(want[i]!.extra, 9));
    }
  });

  it('is fast on long texts (100 000 equal corrections in one segment)', () => {
    const started = performance.now();
    const segs = segments(0, 100_000, () => 0.3);
    expect(performance.now() - started).toBeLessThan(200);
    expect(segs).toHaveLength(1);
    const mixed = segments(0, 100_000, (i) => (i % 7 === 0 ? 1.1 : 0.02 * (i % 3)));
    expect(performance.now() - started).toBeLessThan(400);
    expect(mixed.length).toBeGreaterThan(1);
  });

  it('never cuts where the caller forbids it (inside a surrogate pair)', () => {
    const delta = [0, 3, 0, 0];
    const segs = segments(0, 4, (i) => delta[i]!, (i) => i !== 1);
    expect(segs.every((s) => s.start !== 1)).toBe(true);
  });
});

/** Source glyphs laid out without kerning (or with `kern[i]` px before character i), one glyph per character unless `skip` has it. */
function glyphs(text: string, advance: (c: string) => number, kern: Record<number, number> = {}, skip: number[] = []) {
  const out: { offset: number; x: number; y: number; advance: number }[] = [];
  let x = 0;
  [...text].forEach((c, i) => {
    x += kern[i] ?? 0;
    if (!skip.includes(i)) out.push({ offset: i, x, y: 20, advance: advance(c) });
    x += advance(c);
  });
  return out;
}

describe('letter spacing from the source advances', () => {
  it("gives Inter's 't' the width Figma drew it with", () => {
    // Figma's Inter Bold "t" is 0.3885 em, Penpot's 0.3662 em: +0.535 px at 24 px.
    const advance = (c: string): number => (c === 't' ? 0.3885 : (penpotAdvance('Inter', '700', c.codePointAt(0)!) ?? 0)) * 24;
    const text = 'Button';
    const node = textNode([[text, { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { layout: { glyphAdvances: glyphs(text, advance) } });
    const ls = leaves(buildTextAttrs(node, testDeps()).content);
    expect(ls.map((l) => l.text).join('')).toBe(text);
    const t = ls.find((l) => l.text.includes('t'))!;
    expect(Number(t.letterSpacing)).toBeCloseTo(0.535, 2);
    expect(ls.find((l) => l.text.startsWith('B'))!.letterSpacing).toBe('0');
  });

  it('is off by default: runs stay whole leaves (pixelExact only, warned once per document)', () => {
    const advance = (c: string): number => (c === 't' ? 0.3885 : (penpotAdvance('Inter', '700', c.codePointAt(0)!) ?? 0)) * 24;
    const node = textNode([['Button', { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { layout: { glyphAdvances: glyphs('Button', advance) } });
    const plain = plainDeps();
    expect(leaves(buildTextAttrs(node, plain).content)).toEqual([expect.objectContaining({ text: 'Button', letterSpacing: '0' })]);
    expect(plain.reporter.warnings.map((w) => w.code)).not.toContain('pixel-exact-text-spacing');
    const exact = testDeps();
    buildTextAttrs(node, exact);
    buildTextAttrs({ ...node, id: '1:3' }, exact);
    expect(exact.reporter.warnings.filter((w) => w.code === 'pixel-exact-text-spacing')).toHaveLength(1);
  });

  it('looks the advance up for the character as drawn after the text case transform', () => {
    // "natural" in Inter 700, upper case: Figma's advances are those of "NATURAL".
    const upper = (c: string): number => (penpotAdvance('Inter', '700', c.toUpperCase().codePointAt(0)!) ?? 0) * 24;
    const node = textNode([['natural', { fontSize: 24, fontWeight: 700, fontStyle: 'Bold', textCase: 'upper' }]], { layout: { glyphAdvances: glyphs('natural', upper) } });
    // Exactly Penpot's advances of the upper-case glyphs: nothing to correct.
    expect(leaves(buildTextAttrs(node, testDeps()).content)).toEqual([expect.objectContaining({ text: 'natural', letterSpacing: '0' })]);
    const title = textNode([['big top', { fontSize: 24, textCase: 'title' }]], {
      layout: { glyphAdvances: glyphs('big top', (c) => (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0) * 24).map((g, i) => (i === 0 || i === 4 ? { ...g, advance: (penpotAdvance('Inter', 'regular', 'BT'.codePointAt(i === 0 ? 0 : 1)!) ?? 0) * 24 } : g)) },
    });
    expect(leaves(buildTextAttrs(title, testDeps()).content)).toHaveLength(1);
  });

  it('maps through the case transform only where it keeps one character (ß → SS is not corrected)', async () => {
    const { displayedCodePoint } = await import('../../../src/penpot/text/index.ts');
    expect(displayedCodePoint('aß', 1, 'upper')).toBeUndefined();
    expect(displayedCodePoint('ab', 1, 'upper')).toBe(0x42);
    expect(displayedCodePoint('ab cd', 3, 'title')).toBe(0x43);
    expect(displayedCodePoint('ab cd', 4, 'title')).toBe(0x64);
    expect(displayedCodePoint("don't", 4, 'title')).toBe(0x74);
    expect(displayedCodePoint('AB', 0, 'lower')).toBe(0x61);
  });

  it('leaves a substituted glyph (contextual alternate) and its neighbours unspaced: 5x5 keeps its ×', () => {
    // Inter draws "x" between digits as "×" (calt). Chromium applies no contextual alternate in a letter-spaced
    // span, so the "x" must not get a correction, nor be cut from its context.
    const own = (c: string): number => (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0) * 32;
    const text = 'Settings 5x5 grid';
    const advance = (c: string, i: number): number => (c === 't' ? 0.3636 * 32 : i === 10 ? (penpotAdvance('Inter', 'regular', 0xd7)! * 32) : own(c));
    let x = 0;
    const ga = [...text].map((c, i) => {
      const g = { offset: i, x, y: 30, advance: advance(c, i) };
      x += g.advance;
      return g;
    });
    const ls = leaves(buildTextAttrs(textNode([[text, { fontSize: 32 }]], { layout: { glyphAdvances: ga } }), testDeps()).content);
    expect(ls.map((l) => l.text).join('')).toBe(text);
    expect(ls.some((l) => l.letterSpacing !== '0')).toBe(true);
    const ctx = ls.find((l) => l.text.includes('x'))!;
    expect(ctx.text).toContain('5x5');
    expect(ctx.letterSpacing).toBe('0');
  });

  it("still corrects a glyph the source's font version draws differently everywhere (curly quotes)", () => {
    // Every “ of the document is 0.3807 em (Penpot: 0.4404): the spacing is corrected, no context is at stake.
    const text = 'say “hi” now';
    const em = (c: string): number => (c === '“' || c === '”' ? 0.3807 : (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0));
    let x = 0;
    const ga = [...text].map((c, i) => {
      const g = { offset: i, x, y: 30, advance: em(c) * 32 };
      x += g.advance;
      return g;
    });
    const node = textNode([[text, { fontSize: 32 }]], { layout: { glyphAdvances: ga } });
    const census = new GlyphCensus();
    census.add(node);
    // One occurrence of each quote is not enough to tell a font version from a contextual alternate.
    expect(leaves(buildTextAttrs(node, { ...testDeps(), glyphCensus: census }).content).find((l) => l.text.includes('“'))!.letterSpacing).toBe('0');
    census.add({ ...node, id: '1:3' });
    const corrected = leaves(buildTextAttrs(node, { ...testDeps(), glyphCensus: census }).content);
    expect(corrected.find((l) => l.text.includes('“'))!.letterSpacing).not.toBe('0');
    // Without the census the quotes count as substituted glyphs: unspaced, with their neighbours.
    const literal = leaves(buildTextAttrs(node, testDeps()).content);
    expect(literal.find((l) => l.text.includes('“'))!.letterSpacing).toBe('0');
    expect(literal.find((l) => l.text.includes('“'))!.text).toContain(' “h');
  });

  it('never cuts inside a grapheme cluster (combining mark, ZWJ sequence, variation selector)', () => {
    const own = (c: string): number => (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0.5) * 48;
    for (const text of ['tt\u0301tt', 'tte\u0308tt', 'tt\u2764\ufe0ftt']) {
      let x = 0;
      const ga: { offset: number; x: number; y: number; advance: number }[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        // Every "t" 1.75 px wider than Penpot's: corrections everywhere; the marks get their own glyph.
        const g = { offset: i, x, y: 40, advance: own(c) + (c === 't' ? 1.75 : 0) };
        ga.push(g);
        x += g.advance;
      }
      const ls = leaves(buildTextAttrs(textNode([[text, { fontSize: 48 }]], { layout: { glyphAdvances: ga } }), testDeps()).content);
      expect(ls.map((l) => l.text).join('')).toBe(text);
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let offset = 0;
      const starts = new Set([...segmenter.segment(text)].map((g) => g.index).concat(text.length));
      for (const l of ls) {
        expect(starts.has(offset)).toBe(true);
        offset += l.text.length;
      }
    }
  });

  it('adds nothing without source advances or for fonts without a table', () => {
    expect(leaves(buildTextAttrs(textNode([['Button', {}]]), testDeps()).content)).toHaveLength(1);
    const roboto = textNode([['Button', { fontFamily: 'Roboto' }]], { layout: { glyphAdvances: [{ offset: 0, x: 0, y: 10, advance: 99 }] } });
    expect(leaves(buildTextAttrs(roboto, testDeps()).content)).toHaveLength(1);
  });

  it('never splits a pair the source kerned (a new shaping run would drop the kerning)', () => {
    // "Lay" at 72 px: the source kerns L|a; "y" would get its own correction otherwise.
    const advance = (c: string): number => (c === 'a' ? 0.6 : (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0)) * 72;
    const node = textNode([['Lay', { fontSize: 72 }]], { layout: { glyphAdvances: glyphs('Lay', advance, { 1: -3 }) } });
    const ls = leaves(buildTextAttrs(node, testDeps()).content);
    expect(ls.every((l) => !l.text.endsWith('L') || l.text.length > 1)).toBe(true);
    expect(ls.some((l) => l.text.startsWith('La'))).toBe(true);
  });

  it("keeps a glyph that covers several characters (Inter's -> arrow) in a leaf without extra spacing", () => {
    // Figma lists one glyph (the arrow, wider than "-") at "-" and none at ">".
    const advance = (c: string): number => (c === '-' ? 1.0 : c === 't' ? 0.3885 : (penpotAdvance('Inter', '700', c.codePointAt(0)!) ?? 0)) * 24;
    const text = 'Start ->';
    const node = textNode([[text, { fontSize: 24, fontWeight: 700, fontStyle: 'Bold' }]], { layout: { glyphAdvances: glyphs(text, advance, {}, [7]) } });
    const ls = leaves(buildTextAttrs(node, testDeps()).content);
    expect(ls.map((l) => l.text).join('')).toBe(text);
    const arrow = ls.find((l) => l.text.includes('->'))!;
    expect(arrow).toBeDefined();
    expect(arrow.letterSpacing).toBe('0');
  });
});
