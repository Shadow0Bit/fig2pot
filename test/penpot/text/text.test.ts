import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { penpotAdvance } from '../../../src/penpot/text/advances.ts';
import { buildTextAttrs, num, penpotTextBox } from '../../../src/penpot/text/index.ts';
import { BLACK, paragraphs, testDeps, textNode } from './helpers.ts';

const RED: ir.SolidPaint = { ...BLACK, color: { r: 1, g: 0, b: 0, a: 1 } };

function line(start: number, end: number, lineHeight: number, y = 0): ir.TextLine {
  return { start, end, baseline: { x: 0, y }, width: 100, lineHeight, ascent: lineHeight * 0.8 };
}

describe('buildTextAttrs: structure', () => {
  it('single run → root / paragraph-set / one paragraph / one leaf', () => {
    const deps = testDeps();
    const { content, growType } = buildTextAttrs(textNode([['Hello']]), deps);
    expect(growType).toBe('fixed');
    expect(content).toEqual({
      type: 'root',
      verticalAlign: 'top',
      children: [
        {
          type: 'paragraph-set',
          children: [
            {
              type: 'paragraph',
              textAlign: 'left',
              fontId: 'gfont-inter',
              fontFamily: 'Inter',
              fontVariantId: 'regular',
              fontSize: '16',
              fontWeight: '400',
              fontStyle: 'normal',
              lineHeight: '1.5',
              letterSpacing: '0',
              textTransform: 'none',
              textDecoration: 'none',
              fills: [{ fillColor: '#000000', fillOpacity: 1 }],
              children: [
                {
                  fontId: 'gfont-inter',
                  fontFamily: 'Inter',
                  fontVariantId: 'regular',
                  fontSize: '16',
                  fontWeight: '400',
                  fontStyle: 'normal',
                  lineHeight: '1.5',
                  letterSpacing: '0',
                  textTransform: 'none',
                  textDecoration: 'none',
                  fills: [{ fillColor: '#000000', fillOpacity: 1 }],
                  text: 'Hello',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(deps.reporter.warnings).toEqual([]);
  });

  it('splits on \\n, distributing runs across paragraphs and keeping empty lines', () => {
    // "ab\n\ncd\n" with a bold run "b\n\nc"
    const node = textNode([['a'], ['b\n\nc', { fontWeight: 700, fontStyle: 'Bold' }], ['d\n']]);
    const ps = paragraphs(buildTextAttrs(node, testDeps()).content);
    // empty lines carry a zero-width space (Penpot's SVG renderer collapses an empty leaf to 0 px)
    expect(ps.map((p) => p.children.map((l) => l.text))).toEqual([['a', 'b'], ['\u200b'], ['c', 'd'], ['\u200b']]);
    expect(ps[0]!.children.map((l) => l.fontWeight)).toEqual(['400', '700']);
    // empty line takes the style of its own '\n' (inside the bold run)
    expect(ps[1]!.children[0]!.fontWeight).toBe('700');
    expect(ps[1]!.fontWeight).toBe('700');
    expect(ps[1]!.fontSize).toBe('16');
    expect(ps[2]!.children.map((l) => l.fontVariantId)).toEqual(['700', 'regular']);
    // trailing empty paragraph takes the style of the final '\n'
    expect(ps[3]!.children[0]!.fontWeight).toBe('400');
  });

  it('handles empty text', () => {
    const node = textNode([['']]);
    const ps = paragraphs(buildTextAttrs(node, testDeps()).content);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.children).toEqual([expect.objectContaining({ text: '\u200b', fontId: 'gfont-inter' })]);
  });

  it('survives missing / malformed runs', () => {
    const deps = testDeps();
    const node = textNode([['xy']], {
      runs: [],
      fills: [RED],
    });
    const ps = paragraphs(buildTextAttrs(node, deps).content);
    expect(ps[0]!.children[0]).toMatchObject({ text: 'xy', fontId: 'sourcesanspro', fills: [{ fillColor: '#ff0000' }] });
    expect(deps.reporter.warnings.map((w) => w.code)).toContain('text-without-runs');

    // runs with a gap: gap takes the previous run's style
    const gappy = textNode([['abcd']], {
      runs: [
        { start: 0, end: 1, style: textNode([['a', { fontWeight: 700 }]]).runs[0]!.style },
        { start: 3, end: 4, style: textNode([['d']]).runs[0]!.style },
      ],
    });
    const leaves = paragraphs(buildTextAttrs(gappy, testDeps()).content)[0]!.children;
    expect(leaves.map((l) => [l.text, l.fontWeight])).toEqual([
      ['abc', '700'],
      ['d', '400'],
    ]);
  });

  it('mixed weights and italics map to variants', () => {
    const node = textNode([
      ['R'],
      ['B', { fontWeight: 700, fontStyle: 'Bold' }],
      ['I', { italic: true, fontStyle: 'Italic' }],
      ['S', { fontWeight: 600, italic: true, fontStyle: 'Semi Bold Italic' }],
    ]);
    const leaves = paragraphs(buildTextAttrs(node, testDeps()).content)[0]!.children;
    expect(leaves.map((l) => [l.text, l.fontVariantId, l.fontWeight, l.fontStyle])).toEqual([
      ['R', 'regular', '400', 'normal'],
      ['B', '700', '700', 'normal'],
      ['I', 'italic', '400', 'italic'],
      ['S', '600italic', '600', 'italic'],
    ]);
  });

  it('merges adjacent runs that map to identical Penpot styles', () => {
    const node = textNode([['ab', { hyperlink: 'https://x' }], ['cd']]);
    const deps = testDeps();
    const leaves = paragraphs(buildTextAttrs(node, deps).content)[0]!.children;
    expect(leaves.map((l) => l.text)).toEqual(['abcd']);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-hyperlink-unsupported']);
  });

  it('turns U+2028 into a soft break inside the paragraph', () => {
    const ps = paragraphs(buildTextAttrs(textNode([['a b']]), testDeps()).content);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.children[0]!.text).toBe('a\nb');
  });

  it('passes only visible paints to deps.fills; no visible paint → a transparent fill', () => {
    const hidden = { ...RED, visible: false };
    const node = textNode([['a', { fills: [BLACK, hidden] }], ['b', { fills: [] }]]);
    const leaves = paragraphs(buildTextAttrs(node, testDeps()).content)[0]!.children;
    expect(leaves[0]!.fills).toEqual([{ fillColor: '#000000', fillOpacity: 1 }]);
    // Penpot draws `[]` black (SVG) or not at all (WASM); Figma draws nothing.
    expect(leaves[1]!.fills).toEqual([{ fillColor: '#000000', fillOpacity: 0 }]);
  });

  it('never throws when deps.fills throws', () => {
    const deps = testDeps();
    deps.fills = () => {
      throw new Error('boom');
    };
    const leaves = paragraphs(buildTextAttrs(textNode([['a']]), deps).content)[0]!.children;
    expect(leaves[0]!.fills).toEqual([{ fillColor: '#000000', fillOpacity: 0 }]);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-fill-failed']);
  });
});

describe('buildTextAttrs: line height', () => {
  it('px and percent become multipliers of the run font size', () => {
    const node = textNode([['a\n', { lineHeight: { unit: 'px', value: 20 }, fontSize: 16 }], ['b', { lineHeight: { unit: 'percent', value: 140 } }]]);
    const ps = paragraphs(buildTextAttrs(node, testDeps()).content);
    expect(ps[0]!.lineHeight).toBe('1.25');
    // Figma lays 140 % × 16 = 22.4 out at 22 px.
    expect(ps[1]!.lineHeight).toBe('1.375');
  });

  it('percent line heights are laid out at whole px, as Figma does (no drift over many lines)', () => {
    // simple-design-system I715:12009;159:9768: 140 % at 16 px, 19 lines exactly 22 px apart in the source.
    const ratio = (pct: number, fontSize: number): number =>
      Number(paragraphs(buildTextAttrs(textNode([['x', { lineHeight: { unit: 'percent', value: pct }, fontSize }]]), testDeps()).content)[0]!.lineHeight);
    expect(ratio(140, 16) * 16).toBeCloseTo(22, 3);
    expect(ratio(130, 16) * 16).toBeCloseTo(21, 3);
    expect(ratio(150, 15) * 15).toBeCloseTo(23, 2); // 22.5 → 23
    expect(ratio(120, 20) * 20).toBeCloseTo(24, 3);
    // A px value stays exact unless the source's lines show it rounded.
    const px = (value: number, pitch?: number): number => {
      const lines = pitch === undefined ? undefined : [line(0, 3, 20), line(3, 5, 20, pitch)];
      const node = textNode([['ab\u2028cd', { lineHeight: { unit: 'px', value }, fontSize: 16 }]], lines ? { layout: { lines } } : {});
      return Number(paragraphs(buildTextAttrs(node, testDeps()).content)[0]!.lineHeight) * 16;
    };
    expect(px(22.4)).toBeCloseTo(22.4, 3);
    expect(px(22.4, 22.4)).toBeCloseTo(22.4, 3);
    expect(px(22.4, 22)).toBeCloseTo(22, 3);
  });

  it('auto derives the font ratio from layout lines (intrinsic height rounded to whole px, as Figma applies it)', () => {
    const node = textNode([['Hello world', { lineHeight: { unit: 'auto', value: 0 }, fontSize: 20 }]], {
      layout: { lines: [line(0, 6, 24.2), line(6, 11, 24.2, 24.2)] },
    });
    const deps = testDeps();
    const ps = paragraphs(buildTextAttrs(node, deps).content);
    expect(ps[0]!.lineHeight).toBe('1.2');
    expect(ps[0]!.children[0]!.lineHeight).toBe('1.2');
    expect(deps.reporter.warnings).toEqual([]);
  });

  it('auto with mixed sizes on one line: each span keeps its own ratio, paragraph takes the smallest', () => {
    // "Big small" on one line (driven by the 40px run), then "small" alone on a second line.
    const auto = { unit: 'auto', value: 0 } as const;
    const node = textNode(
      [
        ['Big ', { fontSize: 40, lineHeight: auto }],
        ['small small', { fontSize: 20, lineHeight: auto, fontFamily: 'Roboto' }],
      ],
      { layout: { lines: [line(0, 10, 48.4), line(10, 15, 23.44, 48.4)] } },
    );
    const p = paragraphs(buildTextAttrs(node, testDeps()).content)[0]!;
    expect(p.children.map((l) => l.lineHeight)).toEqual(['1.2', '1.15']);
    expect(p.lineHeight).toBe('1.15');
  });

  it('auto on an empty line uses the zero-length line', () => {
    const auto = { unit: 'auto', value: 0 } as const;
    const node = textNode([['a\n\n', { fontSize: 10, lineHeight: auto }], ['b', { fontSize: 20, lineHeight: auto }]], {
      layout: { lines: [line(0, 2, 12), line(2, 2, 12.5), line(3, 4, 24)] },
    });
    const ps = paragraphs(buildTextAttrs(node, testDeps()).content);
    expect(ps.map((p) => p.lineHeight)).toEqual(['1.2', '1.2', '1.2']);
  });

  it('auto without layout uses a per-family default and warns once per family', () => {
    const auto = { unit: 'auto', value: 0 } as const;
    const deps = testDeps();
    const node = textNode([['a', { lineHeight: auto, fontFamily: 'Roboto' }], ['b', { lineHeight: auto, fontFamily: 'Abel' }]]);
    const leaves = paragraphs(buildTextAttrs(node, deps).content)[0]!.children;
    expect(leaves.map((l) => l.lineHeight)).toEqual(['1.1719', '1.2']);
    buildTextAttrs(node, deps);
    const codes = deps.reporter.warnings.filter((w) => w.code === 'text-line-height-estimated');
    expect(codes).toHaveLength(2);
  });
});

describe('buildTextAttrs: spacing, case, decoration, alignment', () => {
  it('letter spacing: px as-is, percent of font size', () => {
    const node = textNode([
      ['a', { letterSpacing: { unit: 'px', value: -0.5 } }],
      ['b', { letterSpacing: { unit: 'percent', value: 5 }, fontSize: 20 }],
      ['c', { letterSpacing: { unit: 'percent', value: -2.5 }, fontSize: 14 }],
    ]);
    const leaves = paragraphs(buildTextAttrs(node, testDeps()).content)[0]!.children;
    expect(leaves.map((l) => l.letterSpacing)).toEqual(['-0.5', '1', '-0.35']);
  });

  it('text case and decoration', () => {
    const deps = testDeps();
    const node = textNode([
      ['a', { textCase: 'upper' }],
      ['b', { textCase: 'lower', textDecoration: 'underline' }],
      ['c', { textCase: 'title', textDecoration: 'strikethrough' }],
      ['d', { textCase: 'small-caps' }],
    ]);
    const leaves = paragraphs(buildTextAttrs(node, deps).content)[0]!.children;
    expect(leaves.map((l) => [l.textTransform, l.textDecoration])).toEqual([
      ['uppercase', 'none'],
      ['lowercase', 'underline'],
      ['capitalize', 'line-through'],
      ['none', 'none'],
    ]);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-small-caps-unsupported']);
  });

  it('horizontal and vertical alignment', () => {
    for (const [h, expected] of [
      ['left', 'left'],
      ['center', 'center'],
      ['right', 'right'],
      ['justified', 'justify'],
    ] as const) {
      const { content } = buildTextAttrs(textNode([['a\nb']], { alignHorizontal: h }), testDeps());
      expect(paragraphs(content).map((p) => p.textAlign)).toEqual([expected, expected]);
    }
    for (const v of ['top', 'center', 'bottom'] as const) {
      const { content } = buildTextAttrs(textNode([['a']], { alignVertical: v }), testDeps());
      expect((content as { verticalAlign: string }).verticalAlign).toBe(v);
    }
  });

  it('grow type', () => {
    const deps = testDeps();
    expect(buildTextAttrs(textNode([['a']], { autoResize: 'width-and-height' }), deps).growType).toBe('auto-width');
    expect(buildTextAttrs(textNode([['a']], { autoResize: 'height' }), deps).growType).toBe('auto-height');
    expect(buildTextAttrs(textNode([['a']], { autoResize: 'none' }), deps).growType).toBe('fixed');
    expect(deps.reporter.warnings).toEqual([]);
    expect(buildTextAttrs(textNode([['a']], { autoResize: 'truncate' }), deps).growType).toBe('fixed');
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-truncation-unsupported']);
  });

  it('paragraph spacing inserts exact-height invisible spacer paragraphs', () => {
    const deps = testDeps();
    const ps = paragraphs(buildTextAttrs(textNode([['a\n\nb']], { paragraphSpacing: 12 }), deps).content);
    const z = '\u200b';
    expect(ps.map((p) => p.children.map((l) => l.text))).toEqual([['a'], [z], [z], [z], ['b']]);
    const spacer = ps[1]!;
    const transparent = [{ fillColor: '#000000', fillOpacity: 0 }];
    expect(spacer).toMatchObject({ fontSize: '12', lineHeight: '1', fills: transparent });
    expect(spacer.children[0]).toMatchObject({ fontSize: '12', lineHeight: '1', fills: transparent });
    // small spacing keeps font size ≥ 3 and shrinks the multiplier instead
    const small = paragraphs(buildTextAttrs(textNode([['a\nb']], { paragraphSpacing: 1.5 }), testDeps()).content)[1]!;
    expect(Number(small.fontSize) * Number(small.lineHeight)).toBeCloseTo(1.5);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-paragraph-spacing-emulated']);
  });

  it('paragraph indent prepends an invisible spacer to non-empty paragraphs', () => {
    const deps = testDeps();
    const ps = paragraphs(buildTextAttrs(textNode([['a\n\nb']], { paragraphIndent: 24 }), deps).content);
    // Source Sans Pro em spaces (0.875 em), letter spacing 0, font size ≤ the following text's (16 px)
    const spacer = ps[0]!.children[0]!;
    expect(spacer).toMatchObject({ fontId: 'sourcesanspro', letterSpacing: '0', fills: [{ fillColor: '#000000', fillOpacity: 0 }] });
    expect(spacer.text).toBe('\u2003\u2003');
    expect(Number(spacer.fontSize)).toBeLessThanOrEqual(16);
    expect(2 * 0.875 * Number(spacer.fontSize)).toBeCloseTo(24, 2);
    expect(spacer.lineHeight).toBe(ps[0]!.lineHeight);
    expect(ps[0]!.children[1]!.text).toBe('a');
    expect(ps[1]!.children).toHaveLength(1);
    // paragraph style comes from the first real leaf, not the spacer
    expect(ps[0]!.fontId).toBe('gfont-inter');
    // wide indents use more em spaces, never a bigger font than the text
    const wide = paragraphs(buildTextAttrs(textNode([['a']], { paragraphIndent: 500 }), testDeps()).content)[0]!.children[0]!;
    expect(wide.text.length).toBe(36);
    expect(Number(wide.fontSize)).toBeLessThanOrEqual(16);
    expect(36 * 0.875 * Number(wide.fontSize)).toBeCloseTo(500, 1);
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['text-paragraph-indent-emulated']);
  });
});

describe('buildTextAttrs: fonts', () => {
  it('unavailable font keeps the family, warns once per family+style', () => {
    const deps = testDeps();
    const node = textNode([
      ['a', { fontFamily: 'Acme Sans', fontStyle: 'Medium', fontWeight: 500 }],
      ['b', { fontFamily: 'Acme Sans', fontStyle: 'Bold', fontWeight: 700 }],
    ]);
    const leaves = paragraphs(buildTextAttrs(node, deps).content)[0]!.children;
    expect(leaves[0]).toMatchObject({ fontId: '', fontFamily: 'Acme Sans', fontVariantId: 'normal-500', fontWeight: '500' });
    expect(leaves[1]).toMatchObject({ fontVariantId: 'normal-700' });
    buildTextAttrs(node, deps);
    const w = deps.reporter.warnings.filter((x) => x.code === 'font-unavailable');
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ nodeId: '1:2', nodeName: 'Text' });
  });

  it('missing variant of an existing family uses the nearest one and warns', () => {
    const deps = testDeps();
    const node = textNode([['a', { fontFamily: 'Abel', fontWeight: 700, fontStyle: 'Bold' }]]);
    const leaf = paragraphs(buildTextAttrs(node, deps).content)[0]!.children[0]!;
    expect(leaf).toMatchObject({ fontId: 'gfont-abel', fontFamily: 'Abel', fontVariantId: 'regular', fontWeight: '400' });
    expect(deps.reporter.warnings.map((w) => w.code)).toEqual(['font-variant-unavailable']);
  });

  it('is deterministic', () => {
    const node = textNode([['Hello\n'], ['World', { fontWeight: 700 }]], { paragraphSpacing: 4, paragraphIndent: 8 });
    expect(JSON.stringify(buildTextAttrs(node, testDeps()))).toBe(JSON.stringify(buildTextAttrs(node, testDeps())));
  });
});

describe('num', () => {
  it('formats plain decimals', () => {
    expect(num(1.5)).toBe('1.5');
    expect(num(2)).toBe('2');
    expect(num(-0.00001)).toBe('0');
    expect(num(1e-7)).toBe('0');
    expect(num(1 / 3)).toBe('0.3333');
    expect(num(Number.NaN)).toBe('0');
  });
});

describe('penpotTextBox: right-aligned / centred auto-width text (J11)', () => {
  // simple-design-system "Brand": Figma's 48.05 px line right-aligned in its 49 px auto-width box starts at 0.95.
  const brand = (alignHorizontal: ir.TextNode['alignHorizontal']) =>
    textNode([['Brand', { fontSize: 16 }]], {
      autoResize: 'width-and-height',
      alignHorizontal,
      size: { width: 49, height: 22 },
      layout: { lines: [{ start: 0, end: 5, baseline: { x: alignHorizontal === 'right' ? 0.95 : alignHorizontal === 'center' ? 0.475 : 0, y: 17 }, width: 48.05, lineHeight: 19.4, ascent: 17 }] },
    });

  it('SVG: moves the box so the widest line starts where Figma drew it (Penpot pins it to the box edge)', () => {
    expect(penpotTextBox(brand('right'), 'source', { renderer: 'svg', pageY: 0 }).box.x).toBeCloseTo(0.95, 3);
    expect(penpotTextBox(brand('center'), 'source', { renderer: 'svg', pageY: 0 }).box.x).toBeCloseTo(0.475, 3);
  });

  it('WASM: compensates the ceil(width) + 1 px render-wasm aligns the lines in', () => {
    // render-wasm: line at ceil(48.05) + 1 − 48.05 = 1.95 from the edge; Figma's at 0.95.
    expect(penpotTextBox(brand('right'), 'source', { renderer: 'wasm' }).box.x).toBeCloseTo(-1, 3);
    expect(penpotTextBox(brand('center'), 'source', { renderer: 'wasm' }).box.x).toBeCloseTo(-0.5, 3);
  });

  it("anchors the right edge (centre) by Penpot's own width when the source's glyphs are wider (no advance correction)", () => {
    // Figma's Inter "t" is 0.3636 em, Penpot's 0.3271: at 16 px each "t" is 0.584 px narrower in Penpot.
    const own = (c: string): number => (penpotAdvance('Inter', 'regular', c.codePointAt(0)!) ?? 0) * 16;
    const text = 'tttt';
    let x = 0;
    const glyphAdvances = [...text].map((_, i) => {
      const g = { offset: i, x, y: 17, advance: 0.3636 * 16 };
      x += g.advance;
      return g;
    });
    const figma = x;
    const penpot = [...text].reduce((w, c) => w + own(c), 0);
    const node = (alignHorizontal: ir.TextNode['alignHorizontal']) =>
      textNode([[text, { fontSize: 16 }]], {
        autoResize: 'width-and-height',
        alignHorizontal,
        size: { width: Math.ceil(figma), height: 22 },
        layout: { glyphAdvances, lines: [{ start: 0, end: 4, baseline: { x: alignHorizontal === 'right' ? Math.ceil(figma) - figma : (Math.ceil(figma) - figma) / 2, y: 17 }, width: figma, lineHeight: 19.4, ascent: 17 }] },
      });
    // SVG: Penpot's line starts at the box edge and must end where Figma's does.
    expect(penpotTextBox(node('right'), 'source', { renderer: 'svg', pageY: 0 }).box.x + penpot).toBeCloseTo(Math.ceil(figma), 3);
    expect(penpotTextBox(node('center'), 'source', { renderer: 'svg', pageY: 0 }).box.x + penpot / 2).toBeCloseTo(Math.ceil(figma) / 2, 3);
    // With the correction (pixelExact) Penpot's line is Figma's width: its start is Figma's.
    expect(penpotTextBox(node('right'), 'source', { renderer: 'svg', pageY: 0, textSpacing: 'glyph' }).box.x).toBeCloseTo(Math.ceil(figma) - figma, 3);
  });

  it('leaves left-aligned and fixed-width texts alone', () => {
    expect(penpotTextBox(brand('left'), 'source', { renderer: 'wasm' }).box.x).toBe(0);
    expect(penpotTextBox({ ...brand('right'), autoResize: 'height' }, 'source', { renderer: 'svg', pageY: 0 }).box.x).toBeLessThanOrEqual(0);
  });
});
