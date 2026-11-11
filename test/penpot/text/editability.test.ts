import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { GlyphCensus, penpotAdvance } from '../../../src/penpot/text/advances.ts';
import { autoOutlineReason, differentGlyphShare, uncoveredCharacters } from '../../../src/penpot/text/editability.ts';
import { buildText, shownText } from '../../../src/penpot/text/index.ts';
import { BLACK, testDeps, textNode } from './helpers.ts';

const gradient: ir.GradientPaint = {
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

describe('autoOutlineReason', () => {
  it('keeps plain Latin text in an available font editable', () => {
    expect(autoOutlineReason(textNode([['Hello – “world” ↑ é ẞ -> €', {}]]), 'svg')).toBeUndefined();
  });

  it('outlines unavailable fonts', () => {
    expect(autoOutlineReason(textNode([['a', { fontFamily: 'Whyte' }]]), 'svg')?.code).toBe('font-unavailable');
  });

  it('outlines characters Penpot would draw with a fallback font (emoji, ⇧ ⌘ in SVG)', () => {
    for (const text of ['→', '⇧', 'Press ⌘ + K', '⌥', 'Enter ↩', '❖']) {
      expect(autoOutlineReason(textNode([[text, {}]]), 'svg')?.code, text).toBe('text-outlined-fallback-glyphs');
    }
    for (const renderer of ['svg', 'wasm'] as const) expect(autoOutlineReason(textNode([['ok 😀', {}]]), renderer)?.code).toBe('text-outlined-fallback-glyphs');
    expect(uncoveredCharacters(textNode([['a⇧b⇧ c', {}]]), 'svg')).toEqual(['⇧']);
  });

  it('is renderer-aware: render-wasm loads the full Inter, which has ⇧ ⌥ ⌘ ↩ ❖ → ← ✓ ≠', () => {
    for (const text of ['→', '⇧', 'Press ⌘ + K', '⌥', 'Enter ↩', '❖', '← ✓ ≠']) {
      expect(autoOutlineReason(textNode([[text, {}]]), 'wasm'), text).toBeUndefined();
    }
    // Roboto's full file has no ⇧: outlined in both.
    expect(autoOutlineReason(textNode([['⇧', { fontFamily: 'Roboto' }]]), 'wasm')?.code).toBe('text-outlined-fallback-glyphs');
  });

  it("keeps the family's own Cyrillic, Greek and Vietnamese subsets editable in both renderers", () => {
    for (const renderer of ['svg', 'wasm'] as const) {
      for (const [text, fontFamily] of [
        ['Привет мир', 'Inter'],
        ['Αβγδε ζηθ', 'Inter'],
        ['Tiếng Việt', 'Inter'],
        ['Привет мир Αβγδ', 'Roboto'],
        ['Tiếng Việt', 'Montserrat'],
        // Not measured: the catalogue's subsets of the family.
        ['Привет мир', 'Alegreya'],
      ] as const) {
        expect(autoOutlineReason(textNode([[text, { fontFamily }]]), renderer), `${renderer} ${fontFamily} ${text}`).toBeUndefined();
      }
    }
    // A family without the subset: the browser falls back.
    expect(autoOutlineReason(textNode([['Привет', { fontFamily: 'Lato' }]]), 'svg')?.code).toBe('text-outlined-fallback-glyphs');
  });

  it('outlines characters of the latin range that the served files lack (U+2011 everywhere, ↑ in some families)', () => {
    for (const fontFamily of ['Inter', 'Roboto', 'Lato', 'Alegreya']) {
      expect(autoOutlineReason(textNode([['non\u2011breaking', { fontFamily }]]), 'svg')?.code, fontFamily).toBe('text-outlined-fallback-glyphs');
    }
    // render-wasm loads the full file, which has it for Inter and Roboto (not for Lato).
    expect(autoOutlineReason(textNode([['non\u2011breaking', {}]]), 'wasm')).toBeUndefined();
    expect(autoOutlineReason(textNode([['non\u2011breaking', { fontFamily: 'Lato' }]]), 'wasm')?.code).toBe('text-outlined-fallback-glyphs');
    for (const c of ['\u2010', '\u2012', '\u2015', '\u201b', '\u2021', '\u2030']) {
      expect(autoOutlineReason(textNode([[`a${c}b`, { fontFamily: 'Lato' }]]), 'svg')?.code, c).toBe('text-outlined-fallback-glyphs');
    }
    // ↑ is in Inter's latin file, not in Lato's; unmeasured families are not trusted with it.
    expect(autoOutlineReason(textNode([['↑', {}]]), 'svg')).toBeUndefined();
    expect(autoOutlineReason(textNode([['↑', { fontFamily: 'Lato' }]]), 'svg')?.code).toBe('text-outlined-fallback-glyphs');
    expect(autoOutlineReason(textNode([['↑', { fontFamily: 'Alegreya' }]]), 'svg')?.code).toBe('text-outlined-fallback-glyphs');
    // Invisible format characters never count.
    expect(autoOutlineReason(textNode([['a\u200bb\u00adc\u2028d', { fontFamily: 'Lato' }]]), 'svg')).toBeUndefined();
  });

  it("outlines a short text dominated by glyphs Penpot's Inter draws differently (Figma's curly quotes), with pixelExact only", () => {
    // Figma's Inter Regular “ ” are 0.3807 em wide, Penpot's 0.4404 em: another design.
    const quoted = (text: string): ir.TextNode => {
      let x = 0;
      const glyphAdvances = [...text].map((c, i) => {
        const em = c === '“' || c === '”' ? 0.3807 : (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0.5);
        const g = { offset: i, x, y: 12, advance: em * 16 };
        x += g.advance;
        return g;
      });
      return textNode([[text, { fontSize: 16 }]], { layout: { glyphAdvances } });
    };
    expect(differentGlyphShare(quoted('“Quote”')).share).toBeCloseTo(2 / 7, 5);
    const px = { glyphShapes: true };
    expect(autoOutlineReason(quoted('“Quote”'), 'svg', undefined, px)?.code).toBe('text-outlined-glyph-shapes');
    expect(autoOutlineReason(quoted('“Quote”'), 'wasm', undefined, px)?.code).toBe('text-outlined-glyph-shapes');
    // A long text with a couple of quotes stays editable.
    expect(autoOutlineReason(quoted('Select the “Fill” option to make the frame stretch'), 'svg', undefined, px)).toBeUndefined();
    // By default (no pixelExact) it stays editable: its spacing is corrected per line instead.
    expect(autoOutlineReason(quoted('“Quote”'), 'svg')).toBeUndefined();
  });

  it('does not count a contextual alternate (× in "5x5") when the document draws the character normally elsewhere', () => {
    const text = '5x5';
    const x = 0.6 * 16; // the × glyph's width, not "x"'s
    const node = textNode([[text, { fontSize: 16 }]], {
      layout: { glyphAdvances: [0, 1, 2].map((i) => ({ offset: i, x: i * 10, y: 12, advance: i === 1 ? x : penpotAdvance('Inter', 'regular', text.codePointAt(i)!)! * 16 })) },
    });
    const census = new GlyphCensus();
    census.add(node);
    // Alone, "x" is drawn differently everywhere: counted.
    expect(differentGlyphShare(node, census).share).toBeGreaterThan(0.3);
    census.add(textNode([['box', { fontSize: 16 }]], { layout: { glyphAdvances: [0, 1, 2].map((i) => ({ offset: i, x: i * 10, y: 12, advance: penpotAdvance('Inter', 'regular', 'box'.codePointAt(i)!)! * 16 })) } }));
    expect(differentGlyphShare(node, census).share).toBe(0);
    expect(autoOutlineReason(node, 'svg', census, { glyphShapes: true })).toBeUndefined();
  });

  it('outlines a text the source drew partly with a fallback font', () => {
    const node = textNode([['abc', {}]], { layout: { fallbackFonts: [{ family: 'Noto Sans Symbols', style: 'Regular' }] } });
    expect(autoOutlineReason(node, 'svg')?.code).toBe('text-outlined-fallback-glyphs');
  });

  it('outlines truncated text', () => {
    const node = textNode([['abc def', {}]], { autoResize: 'truncate', layout: { truncationStart: 4 } });
    expect(autoOutlineReason(node, 'wasm')?.code).toBe('text-outlined-truncated');
  });

  it('outlines gradient fills for the SVG renderer only', () => {
    const node = textNode([['abc', { fills: [gradient] }]]);
    expect(autoOutlineReason(node, 'svg')?.code).toBe('text-outlined-gradient-fill');
    expect(autoOutlineReason(node, 'wasm')).toBeUndefined();
    expect(autoOutlineReason(textNode([['abc', { fills: [{ ...gradient, visible: false }, BLACK] }]]), 'svg')).toBeUndefined();
  });
});

describe('truncated text, editable', () => {
  const line = (start: number, end: number, y: number): ir.TextLine => ({ start, end, baseline: { x: 0, y }, width: 100, lineHeight: 24, ascent: 18 });
  const node = textNode([['This is a text field set to fill ', {}], ['container in both dimensions', { fontWeight: 700, fontStyle: 'Bold' }]], {
    autoResize: 'truncate',
    alignHorizontal: 'center',
    size: { width: 240, height: 24 },
    layout: { truncationStart: 33, lines: [line(0, 33, 18)] },
  });

  it('keeps only what the source shows, then an ellipsis in the last shown style', () => {
    const shown = shownText(node);
    expect(shown.characters).toBe('This is a text field set to fill…');
    expect(shown.runs).toHaveLength(1);
    expect(shown.runs[0]!.end).toBe(shown.characters.length);
    expect(shown.layout!.lines!.at(-1)!.end).toBe(shown.characters.length);
    expect(shown.layout!.truncationStart).toBeUndefined();
  });

  it('never emits the hidden tail and warns that the truncation is emulated', () => {
    const deps = testDeps();
    const { attrs } = buildText(node, deps);
    const text = JSON.stringify(attrs.content);
    expect(text).toContain('fill…');
    expect(text).not.toContain('container');
    expect(deps.reporter.warnings.map((w) => w.code)).toContain('text-truncation-emulated');
  });

  it('warns and writes a fixed box for a line-limited (not truncate-flagged) auto-height text', () => {
    // Figma's "max lines" on an auto-height text: truncated without the truncate flag.
    const limited = { ...node, autoResize: 'height' as const };
    const deps = testDeps();
    const { attrs } = buildText(limited, deps);
    expect(JSON.stringify(attrs.content)).toContain('fill…');
    expect(attrs.growType).toBe('fixed');
    expect(deps.reporter.warnings.find((w) => w.code === 'text-truncation-emulated')?.message).toContain('line limit');
    // Not truncated: unchanged.
    expect(buildText({ ...limited, layout: { lines: limited.layout!.lines! } }, testDeps()).attrs.growType).toBe('auto-height');
  });

  it('drops a trailing line break before the cut', () => {
    const t = textNode([['one\ntwo\nthree', {}]], { autoResize: 'truncate', layout: { truncationStart: 8, lines: [line(0, 4, 18), line(4, 8, 42)] } });
    expect(shownText(t).characters).toBe('one\ntwo…');
  });
});
