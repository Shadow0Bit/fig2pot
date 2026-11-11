/**
 * Text fidelity fixes (review items A1–A7, B1–B4). The Penpot behaviour each
 * emission relies on is measured in test/penpot/live/text.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { MARGIN, SLACK_PX, SLACK_RATIO, textBox } from '../../../src/penpot/text/box.ts';
import { linesInconsistency, planLineBreaks, snapToCodePoint } from '../../../src/penpot/text/breaks.ts';
import { buildText, buildTextAttrs, MAX_EMULATED_SPACING, penpotTextBox } from '../../../src/penpot/text/index.ts';
import { defaultAutoLineHeight, deriveAutoRatio } from '../../../src/penpot/text/line-height.ts';
import { doc, rotateAbout, text, textStyle, translate, write } from '../helpers.ts';
import { BLACK, paragraphs, testDeps, textNode } from './helpers.ts';

const ZWSP = String.fromCharCode(0x200b);
const LSEP = String.fromCharCode(0x2028);
const EMSP = String.fromCharCode(0x2003);
const TRANSPARENT = [{ fillColor: '#000000', fillOpacity: 0 }];
const auto: ir.LineHeight = { unit: 'auto', value: 0 };

function line(start: number, end: number, y: number, extra: Partial<ir.TextLine> = {}): ir.TextLine {
  return { start, end, baseline: { x: 0, y }, width: 100, lineHeight: 24, ascent: 18, ...extra };
}

/** Lines for `text` cut at `starts` (offsets where a new line begins), 24 px apart. */
function linesAt(textValue: string, starts: number[]): ir.TextLine[] {
  const bounds = [0, ...starts, textValue.length];
  return bounds.slice(0, -1).map((s, i) => line(s, bounds[i + 1]!, 18 + 24 * i));
}

/** No lone surrogate (String#isWellFormed is ES2024, beyond our lib). */
const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

const leafTexts = (node: ir.TextNode, deps = testDeps()): string[][] =>
  paragraphs(buildTextAttrs(node, deps).content).map((p) => p.children.map((l) => l.text));

describe('A1: empty lines are never empty leaves', () => {
  it('empty paragraphs and paragraph-spacing spacers carry a zero-width space', () => {
    expect(leafTexts(textNode([['a\n\nb\n']]))).toEqual([['a'], [ZWSP], ['b'], [ZWSP]]);
    const ps = paragraphs(buildTextAttrs(textNode([['a\nb']], { paragraphSpacing: 10 }), testDeps()).content);
    expect(ps[1]!.children).toEqual([expect.objectContaining({ text: ZWSP, fills: TRANSPARENT })]);
    expect(Number(ps[1]!.fontSize) * Number(ps[1]!.lineHeight)).toBeCloseTo(10);
  });
});

describe('A2: auto line height of a run sharing a line with larger text', () => {
  it('uses the line height over the largest font size on that line', () => {
    const runs = [
      { start: 0, end: 1, fontSize: 20 },
      { start: 1, end: 2, fontSize: 40 },
      { start: 2, end: 4, fontSize: 20 },
    ];
    const lines = [line(0, 3, 38.75, { lineHeight: 48.4 }), line(3, 4, 67.8, { lineHeight: 24.2 })];
    // shares line 1 with the 40 px run only: round(48.4) / 40, not 48 / 20 = 2.4 (Figma applies the rounded intrinsic height)
    expect(deriveAutoRatio(runs[0]!, [lines[0]!], 4, runs)).toBeCloseTo(1.2);
    expect(deriveAutoRatio(runs[1]!, lines, 4, runs)).toBeCloseTo(1.2);
    // a run alone on a line keeps its own ratio
    expect(deriveAutoRatio(runs[2]!, lines, 4, runs)).toBeCloseTo(1.2);
    // without the other runs (old call shape) the ratio is relative to the run's own size
    expect(deriveAutoRatio(runs[0]!, [lines[0]!], 4)).toBeCloseTo(2.4);
  });

  it('gives the small span the large font ratio in the content tree', () => {
    const node = textNode([['H', { fontSize: 20, lineHeight: auto }], ['H', { fontSize: 40, lineHeight: auto }], ['\nH', { fontSize: 20, lineHeight: auto }]], {
      layout: { lines: [line(0, 3, 38.75, { lineHeight: 48.4 }), line(3, 4, 67.8, { lineHeight: 24.2 })] },
    });
    const ps = paragraphs(buildTextAttrs(node, testDeps()).content);
    expect(ps[0]!.children.map((l) => [l.fontSize, l.lineHeight])).toEqual([
      ['20', '1.2'],
      ['40', '1.2'],
    ]);
    expect(ps[1]!.children[0]!.lineHeight).toBe('1.2');
  });
});

describe('A3: no visible paint → transparent fill', () => {
  it('for no paints, hidden paints, and paints the converter drops', () => {
    const hidden = { ...BLACK, visible: false };
    const node = textNode([['a', { fills: [] }], ['b', { fills: [hidden] }], ['c']]);
    const deps = testDeps();
    deps.fills = (paints) => (paints.length ? [] : [{ fillColor: '#ff0000' }]);
    const leaves = paragraphs(buildTextAttrs(node, deps).content)[0]!.children;
    expect(leaves.map((l) => l.fills)).toEqual([TRANSPARENT]);
  });
});

describe('A4: run boundaries never split a surrogate pair', () => {
  it('snaps cuts to code-point boundaries', () => {
    const s = 'a\u{1F600}b';
    expect(snapToCodePoint(s, 2)).toBe(1);
    expect(snapToCodePoint(s, 1)).toBe(1);
    expect(snapToCodePoint(s, 3)).toBe(3);
    const node = textNode([[s]]);
    node.runs = [
      { start: 0, end: 2, style: node.runs[0]!.style },
      { start: 2, end: 4, style: { ...node.runs[0]!.style, fontSize: 30 } },
    ];
    const leaves = paragraphs(buildTextAttrs(node, testDeps()).content)[0]!.children;
    expect(leaves.map((l) => l.text)).toEqual(['a', '\u{1F600}b']);
    for (const l of leaves) expect(wellFormed(l.text)).toBe(true);
  });

  it('also snaps an inserted line break', () => {
    const s = 'ab\u{1F600}cd';
    const node = textNode([[s]], { layout: { lines: [line(0, 3, 18), line(3, 6, 42)] } });
    const texts = leafTexts(node)[0]!;
    expect(texts.join('')).toBe('ab\n\u{1F600}cd');
    for (const t of texts) expect(wellFormed(t)).toBe(true);
  });
});

describe('A5: paragraph spacing and indent are bounded', () => {
  it('clamps absurd values and warns', () => {
    const deps = testDeps();
    const node = textNode([['a\nb']], { paragraphIndent: 1e9, paragraphSpacing: 1e9 });
    const ps = paragraphs(buildTextAttrs(node, deps).content);
    const spacer = ps[0]!.children[0]!;
    expect(spacer.text.length * 0.875 * Number(spacer.fontSize)).toBeCloseTo(MAX_EMULATED_SPACING, 0);
    expect(spacer.text.length).toBeLessThan(400);
    expect(Number(ps[1]!.fontSize) * Number(ps[1]!.lineHeight)).toBeCloseTo(MAX_EMULATED_SPACING, 0);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['text-paragraph-spacing-clamped', 'text-paragraph-indent-clamped']),
    );
  });
});

describe('A6: intrinsic line heights', () => {
  it('Poppins is 1.5 (hhea 1050 / −350 / gap 100, 1000 upm)', () => {
    expect(defaultAutoLineHeight('Poppins')).toEqual({ ratio: 1.5, known: true });
  });
});

describe('A7: paragraph indent without letter spacing', () => {
  it('uses Source Sans Pro em spaces no larger than the text', () => {
    const ps = paragraphs(buildTextAttrs(textNode([['a', { fontSize: 10 }]], { paragraphIndent: 30 }), testDeps()).content);
    const spacer = ps[0]!.children[0]!;
    expect(spacer).toMatchObject({ fontId: 'sourcesanspro', letterSpacing: '0', fills: TRANSPARENT });
    expect([...spacer.text].every((c) => c === EMSP)).toBe(true);
    expect(Number(spacer.fontSize)).toBeLessThanOrEqual(10);
    expect(spacer.text.length * 0.875 * Number(spacer.fontSize)).toBeCloseTo(30, 2);
  });
});

describe('B1: source line breaks', () => {
  const para = 'one two three four';

  it('turns every wrap into a soft break and drops the wrap spaces', () => {
    const node = textNode([[para]], { layout: { lines: linesAt(para, [4, 14]) } });
    expect(leafTexts(node)).toEqual([['one\ntwo three\nfour']]);
  });

  it('keeps runs and styles across inserted breaks', () => {
    // bold "two three f" spans both wraps
    const node = textNode([['one '], ['two three f', { fontWeight: 700, fontStyle: 'Bold' }], ['our']], { layout: { lines: linesAt(para, [4, 14]) } });
    const leaves = paragraphs(buildTextAttrs(node, testDeps()).content)[0]!.children;
    expect(leaves.map((l) => [l.text, l.fontWeight])).toEqual([
      ['one\n', '400'],
      ['two three\nf', '700'],
      ['our', '400'],
    ]);
  });

  it('leaves existing breaks alone and only breaks inside paragraphs', () => {
    const s = `aa bb\ncc${LSEP}dd ee`;
    const node = textNode([[s]], { layout: { lines: linesAt(s, [3, 6, 9, 12]) } });
    expect(leafTexts(node)).toEqual([['aa\nbb'], ['cc\ndd\nee']]);
  });

  it('breaks inside a word without dropping anything', () => {
    const s = 'abcdefgh';
    expect(leafTexts(textNode([[s]], { layout: { lines: linesAt(s, [5]) } }))).toEqual([['abcde\nfgh']]);
  });

  it('strips spaces before every line end of centred and right-aligned text, not of left-aligned', () => {
    const s = 'aa bb \ncc ';
    const lines = linesAt(s, [3, 7]);
    expect(leafTexts(textNode([[s]], { alignHorizontal: 'center', layout: { lines } }))).toEqual([['aa\nbb'], ['cc']]);
    expect(leafTexts(textNode([[s]], { alignHorizontal: 'right', layout: { lines } }))).toEqual([['aa\nbb'], ['cc']]);
    expect(leafTexts(textNode([[s]], { alignHorizontal: 'left', layout: { lines } }))).toEqual([['aa\nbb '], ['cc ']]);
  });

  it('keeps a line that is only a wrapped space run as an empty soft line', () => {
    const s = 'aa    bb';
    // Figma put the spaces on a line of their own
    expect(leafTexts(textNode([[s]], { layout: { lines: linesAt(s, [3, 6]) } }))).toEqual([['aa\n\nbb']]);
  });

  it('reflow mode, justified text and missing lines insert nothing', () => {
    const lines = linesAt(para, [4, 14]);
    expect(leafTexts(textNode([[para]], { layout: { lines } }), { ...testDeps(), lineBreaks: 'reflow' })).toEqual([[para]]);
    expect(leafTexts(textNode([[para]], { alignHorizontal: 'justified', layout: { lines } }))).toEqual([[para]]);
    expect(leafTexts(textNode([[para]]))).toEqual([[para]]);
  });

  it('falls back to reflow, with a warning, when the lines do not match the text', () => {
    const deps = testDeps();
    const node = textNode([[para]], { layout: { lines: [line(0, 4, 18), line(5, 18, 42)] } });
    expect(leafTexts(node, deps)).toEqual([[para]]);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-line-breaks-inconsistent']);
    expect(buildText(node, testDeps()).sourceBreaks).toBe(false);
  });

  it('validates lines', () => {
    const s = 'ab\ncd';
    expect(linesInconsistency(linesAt(s, [3]), s, false)).toBeUndefined();
    expect(linesInconsistency([], s, false)).toBe('no lines');
    expect(linesInconsistency([line(0, 5, 18)], s, false)).toMatch(/contains a line break/);
    expect(linesInconsistency([line(0, 3, 18)], s, false)).toMatch(/cover 3 of 5/);
    // truncated text: a prefix is fine
    expect(linesInconsistency([line(0, 3, 18)], s, true)).toBeUndefined();
    expect(linesInconsistency([line(0, 3, 42), line(3, 5, 18)], s, false)).toMatch(/reading order/);
    expect(linesInconsistency([line(0, 2.5, 18)], s, false)).toMatch(/non-integer/);
  });

  it('plans breaks and drops', () => {
    const s = 'aa  bb';
    const plan = planLineBreaks(linesAt(s, [4]), s, 'left');
    expect([...plan.breaks]).toEqual([4]);
    expect([...plan.dropped].sort()).toEqual([2, 3]);
  });
});

describe('B2: text box', () => {
  const wrapped = (extra: Partial<ir.TextNode> = {}): ir.TextNode =>
    textNode([['aaa bbb']], {
      size: { width: 100, height: 40 },
      layout: { lines: [line(0, 4, 18, { width: 90, ascent: 18 }), line(4, 7, 42, { width: 60, ascent: 18 })] },
      ...extra,
    });
  const slack = (w: number): number => SLACK_RATIO * w + SLACK_PX;

  it('grows to the right for left-aligned text and downwards for top-aligned text', () => {
    const box = textBox(wrapped(), { growWidth: true });
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBeCloseTo(Math.max(100, 90 + MARGIN + slack(90)), 3);
    // last baseline 42 + 0.25 × 16 + margin
    expect(box.height).toBeCloseTo(42 + 4 + MARGIN, 3);
  });

  it('grows to the left for right-aligned and bottom-aligned text', () => {
    const node = wrapped({
      alignHorizontal: 'right',
      alignVertical: 'bottom',
      layout: { lines: [line(0, 4, -6, { width: 120, ascent: 18, baseline: { x: -20, y: -6 } }), line(4, 7, 18, { width: 60, ascent: 18, baseline: { x: 40, y: 18 } })] },
    });
    const box = textBox(node, { growWidth: true });
    expect(box.x + box.width).toBeCloseTo(100, 3);
    expect(box.x).toBeCloseTo(-20 - MARGIN - slack(120), 3);
    expect(box.y + box.height).toBeCloseTo(40, 3);
    expect(box.y).toBeCloseTo(-24 - MARGIN, 3);
  });

  it('grows symmetrically for centred text', () => {
    const node = wrapped({ alignHorizontal: 'center', alignVertical: 'center', layout: { lines: [line(0, 7, 30, { width: 140, ascent: 18, baseline: { x: -20, y: 30 } })] } });
    const box = textBox(node, { growWidth: true });
    expect(box.x + box.width / 2).toBeCloseTo(50, 2);
    expect(box.y + box.height / 2).toBeCloseTo(20, 2);
    expect(box.x).toBeLessThanOrEqual(-20 - MARGIN - slack(140) + 1e-3);
  });

  it('grows auto-width text only to the right, whatever its alignment (Penpot pins its lines to the left edge)', () => {
    for (const alignHorizontal of ['left', 'center', 'right'] as const) {
      const node = wrapped({ autoResize: 'width-and-height', alignHorizontal, size: { width: 80, height: 40 } });
      const box = textBox(node, { growWidth: true });
      expect(box.x, alignHorizontal).toBe(0);
      expect(box.width, alignHorizontal).toBeGreaterThan(90);
    }
  });

  it('keeps the width of wrapping text in reflow mode, but not of auto-width text', () => {
    const fixed = wrapped({ size: { width: 80, height: 40 } });
    expect(penpotTextBox(fixed, 'reflow').box.width).toBe(80);
    expect(penpotTextBox(fixed, 'source').box.width).toBeGreaterThan(90);
    const autoWidth = wrapped({ size: { width: 80, height: 40 }, autoResize: 'width-and-height' });
    expect(penpotTextBox(autoWidth, 'reflow').box.width).toBeGreaterThan(90);
    // justified text reflows, so it keeps its width too
    expect(penpotTextBox(wrapped({ size: { width: 80, height: 40 }, alignHorizontal: 'justified' }), 'source').box.width).toBe(80);
  });

  it('covers the glyph outlines', () => {
    const node = wrapped({
      layout: {
        lines: [line(0, 7, 18, { width: 50 })],
        outlines: [{ runIndex: 0, path: { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 150, y: 70 }, { type: 'Z' }] } }],
      },
    });
    const box = textBox(node, { growWidth: true });
    expect(box.width).toBeGreaterThanOrEqual(150 + MARGIN);
    expect(box.height).toBeGreaterThanOrEqual(70 + MARGIN);
  });

  it('changes nothing without a source layout', () => {
    expect(textBox(textNode([['a']], { size: { width: 10, height: 5 } }), { growWidth: true })).toEqual({ x: 0, y: 0, width: 10, height: 5 });
  });

  it('places the grown box in the text local space (rotation), keeping the centre of centred text', async () => {
    const lines = [line(0, 5, 18, { width: 140, baseline: { x: -20, y: 18 } })];
    const style = textStyle({ fontFamily: 'Inter', lineHeight: { unit: 'px', value: 24 } });
    const node = text('t', 'hello', { size: { width: 100, height: 24 }, alignHorizontal: 'center', runs: [{ start: 0, end: 5, style }], layout: { lines } });
    for (const transform of [translate(10, 20), rotateAbout(30, 10, 20)]) {
      const w = await write(doc([{ ...node, transform }]));
      const s = w.shape('t');
      // centre of the IR box in page space
      const cx = transform.a * 50 + transform.c * 12 + transform.e;
      const cy = transform.b * 50 + transform.d * 12 + transform.f;
      // Penpot stores the unrotated box centred on the real centre: the top edge moved, so the centre
      // moves along the local y axis only, never along the local x axis.
      const dx = s.x + s.width / 2 - cx;
      const dy = s.y + s.height / 2 - cy;
      const alongX = dx * transform.a + dy * transform.b;
      expect(Math.abs(alongX)).toBeLessThan(1e-3);
      expect(s.width).toBeGreaterThan(140);
      expect(s.growType).toBe('fixed');
    }
  });
});

describe('B3: vertical placement', () => {
  it('top-aligned text never grows upwards and bottom-aligned never downwards (the first baseline stays put)', () => {
    const node = textNode([['a']], { size: { width: 50, height: 10 }, layout: { lines: [line(0, 1, 18, { ascent: 18 })] } });
    expect(textBox(node, { growWidth: false }).y).toBe(0);
    const bottom = { ...node, alignVertical: 'bottom' as const };
    const box = textBox(bottom, { growWidth: false });
    expect(box.y + box.height).toBe(10);
  });
});

describe('B4: arrows', () => {
  it('keeps "->" as typed (Penpot applies Inter\'s contextual arrow; U+2192 would fall back in SVG)', () => {
    const s = 'layout (->) here';
    const node = textNode([[s]], { layout: { lines: linesAt(s, [12]) } });
    expect(leafTexts(node)).toEqual([['layout (->)\nhere']]);
  });
});
