import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import type * as fig from '../../../src/fig/schema.d.ts';
import type { FigDocument, FigNode } from '../../../src/fig/types.ts';
import { decodeFig } from '../../../src/fig/decode.ts';
import { buildTree } from '../../../src/fig/tree.ts';
import { createContext } from '../../../src/fig/translate/context.ts';
import { translateText } from '../../../src/fig/translate/text.ts';
import { buildIndexMap } from '../../../src/fig/translate/text-index.ts';
import { fontWeightFromStyleName, isItalicStyleName } from '../../../src/fig/translate/text-style.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { LARGE_FIXTURES, hasLarge, nodesOf, translateFixture } from './helpers.ts';

// ---------------------------------------------------------------------------
// Synthetic helpers
// ---------------------------------------------------------------------------

/** Encodes path commands as a kiwi `commandsBlob`. */
function encodeCommands(commands: ir.PathCommand[]): Uint8Array {
  const parts: number[][] = [];
  for (const c of commands) {
    if (c.type === 'Z') parts.push([0]);
    else if (c.type === 'M') parts.push([1, c.x, c.y]);
    else if (c.type === 'L') parts.push([2, c.x, c.y]);
    else if (c.type === 'Q') parts.push([3, c.x1, c.y1, c.x, c.y]);
    else parts.push([4, c.x1, c.y1, c.x2, c.y2, c.x, c.y]);
  }
  const size = parts.reduce((n, p) => n + 1 + (p.length - 1) * 4, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;
  for (const p of parts) {
    bytes[o++] = p[0]!;
    for (const v of p.slice(1)) {
      view.setFloat32(o, v, true);
      o += 4;
    }
  }
  return bytes;
}

/** A unit square glyph (em units, y up) from (0,0) to (0.5,0.5). */
const SQUARE: ir.PathCommand[] = [
  { type: 'M', x: 0, y: 0 },
  { type: 'L', x: 0.5, y: 0 },
  { type: 'L', x: 0.5, y: 0.5 },
  { type: 'L', x: 0, y: 0.5 },
  { type: 'Z' },
];

interface Setup {
  change: fig.NodeChange;
  blobs?: Uint8Array[];
  styleNodes?: fig.NodeChange[];
}

function setup({ change, blobs = [], styleNodes = [] }: Setup) {
  const node: FigNode = { id: '1:1', guid: '1:1', type: 'TEXT', change: { type: 'TEXT', name: 'T', ...change }, children: [] };
  const byGuid = new Map<string, FigNode>([[node.guid, node]]);
  for (const s of styleNodes) {
    const guid = `${s.guid!.sessionID}:${s.guid!.localID}`;
    byGuid.set(guid, { id: guid, guid, type: 'TEXT', change: s, children: [] });
  }
  const doc = {
    file: { prelude: 'fig-kiwi', version: 0, message: {}, blobs, images: new Map() },
    root: node,
    pages: [],
    byId: new Map([[node.id, node]]),
    byGuid,
  } as unknown as FigDocument;
  const reporter = new CollectingReporter();
  const ctx = createContext(doc, reporter);
  return { node, ctx, reporter };
}

function baseOf(node: FigNode, fills: ir.Paint[] = []): ir.BaseNode {
  return {
    id: node.id,
    name: node.change.name ?? '',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'pass-through',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    size: { width: node.change.size?.x ?? 100, height: node.change.size?.y ?? 20 },
    fills,
    effects: [],
  };
}

function run(s: Setup, fills: ir.Paint[] = []) {
  const { node, ctx, reporter } = setup(s);
  return { text: translateText(node, baseOf(node, fills), ctx), reporter };
}

const BLACK: ir.Paint = { type: 'solid', visible: true, opacity: 1, blendMode: 'normal', color: { r: 0, g: 0, b: 0, a: 1 } };
const INTER = { family: 'Inter', style: 'Regular', postscript: '' };
const RED: fig.Paint = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' };

function textChange(characters: string, extra: Partial<fig.NodeChange> = {}, textData: Partial<fig.TextData> = {}): fig.NodeChange {
  return {
    fontName: INTER,
    fontSize: 16,
    lineHeight: { value: 100, units: 'PERCENT' },
    letterSpacing: { value: 0, units: 'PERCENT' },
    ...extra,
    textData: { characters, ...textData },
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

describe('translateText runs', () => {
  it('produces one run with the node style for plain text', () => {
    const { text } = run({ change: textChange('Hello') }, [BLACK]);
    expect(text.type).toBe('text');
    expect(text.characters).toBe('Hello');
    expect(text.runs).toHaveLength(1);
    expect(text.runs[0]).toMatchObject({ start: 0, end: 5 });
    expect(text.runs[0]!.style).toEqual({
      fontFamily: 'Inter',
      fontStyle: 'Regular',
      fontWeight: 400,
      italic: false,
      fontSize: 16,
      lineHeight: { unit: 'auto', value: 0 },
      letterSpacing: { unit: 'percent', value: 0 },
      textCase: 'original',
      textDecoration: 'none',
      fills: [BLACK],
    });
  });

  it('builds runs from characterStyleIDs, padding omitted trailing ids with 0 and merging identical styles', () => {
    const { text } = run({
      change: textChange('abcdefghij', {}, {
        characterStyleIDs: [0, 0, 1, 1, 2, 2, 3],
        styleOverrideTable: [
          { styleID: 1, fontName: { family: 'Inter', style: 'Bold', postscript: 'Inter-Bold' } },
          { styleID: 2, fontName: { family: 'Inter', style: 'Bold', postscript: 'Inter-Bold' } },
          { styleID: 3, fillPaints: [RED] },
        ],
      }),
    }, [BLACK]);
    expect(text.runs.map((r) => [r.start, r.end, r.style.fontStyle, r.style.fontWeight])).toEqual([
      [0, 2, 'Regular', 400],
      [2, 6, 'Bold', 700],
      [6, 7, 'Regular', 400],
      [7, 10, 'Regular', 400],
    ]);
    expect(text.runs[2]!.style.fills).toEqual([{ ...BLACK, color: { r: 1, g: 0, b: 0, a: 1 } }]);
    expect(text.runs[3]!.style.fills).toEqual([BLACK]);
  });

  it('keeps one empty run for an empty string', () => {
    const { text } = run({ change: textChange('') });
    expect(text.characters).toBe('');
    expect(text.runs).toHaveLength(1);
    expect(text.runs[0]).toMatchObject({ start: 0, end: 0 });
  });

  it('keeps line separators verbatim', () => {
    const s = `one two\nthree`;
    const { text } = run({ change: textChange(s) });
    expect(text.characters).toBe(s);
    expect(text.runs[0]).toMatchObject({ start: 0, end: s.length });
  });

  it('maps code-point style indices to UTF-16 offsets for astral characters', () => {
    // "a😀b": 3 code points, 4 UTF-16 units. Ids index code points; the last baseline ends at 3.
    const s = 'a😀b';
    const { text } = run({
      change: textChange(s, { derivedTextData: { baselines: [{ position: { x: 0, y: 12 }, lineY: 0, lineHeight: 16, width: 30, firstCharacter: 0, endCharacter: 3 }] } }, {
        characterStyleIDs: [0, 1, 0],
        styleOverrideTable: [{ styleID: 1, fontSize: 20 }],
      }),
    });
    expect(text.runs.map((r) => [r.start, r.end, r.style.fontSize])).toEqual([
      [0, 1, 16],
      [1, 3, 20],
      [3, 4, 16],
    ]);
    expect(text.layout?.lines?.[0]).toMatchObject({ start: 0, end: 4 });
  });

  it('switches to UTF-16 indexing when the layout says so', () => {
    const s = 'a😀b';
    const { text } = run({
      change: textChange(s, { derivedTextData: { baselines: [{ position: { x: 0, y: 12 }, lineY: 0, lineHeight: 16, width: 30, firstCharacter: 0, endCharacter: 4 }] } }, {
        characterStyleIDs: [0, 1, 1, 0],
        styleOverrideTable: [{ styleID: 1, fontSize: 20 }],
      }),
    });
    expect(text.runs.map((r) => [r.start, r.end, r.style.fontSize])).toEqual([
      [0, 1, 16],
      [1, 3, 20],
      [3, 4, 16],
    ]);
  });

  it('applies a referenced text style over stale node properties', () => {
    const { text } = run({
      change: textChange('Hi', {
        fontName: { family: 'Whyte', style: 'Bold', postscript: '' },
        fontSize: 32,
        paragraphSpacing: 12,
        styleIdForText: { guid: { sessionID: 9, localID: 1 } },
      }),
      styleNodes: [
        {
          guid: { sessionID: 9, localID: 1 },
          type: 'TEXT',
          styleType: 'TEXT',
          name: 'Body',
          fontName: { family: 'Inter', style: 'Medium', postscript: '' },
          fontSize: 16,
          lineHeight: { value: 24, units: 'PIXELS' },
        },
      ],
    });
    expect(text.paragraphSpacing).toBe(0);
    expect(text.runs[0]!.style).toMatchObject({ fontFamily: 'Inter', fontStyle: 'Medium', fontWeight: 500, fontSize: 16, lineHeight: { unit: 'px', value: 24 }, styleId: '9:1' });
  });

  describe('referenced text style vs the derived layout (scaled instances)', () => {
    const STYLE: fig.NodeChange = {
      guid: { sessionID: 9, localID: 1 },
      type: 'TEXT',
      styleType: 'TEXT',
      fontName: INTER,
      fontSize: 20,
      lineHeight: { value: 24, units: 'PIXELS' },
      letterSpacing: { value: 1, units: 'PIXELS' },
    };
    const glyphs = (fontSize: number): fig.Glyph[] => [0, 1].map((i) => ({ position: { x: i * 10, y: 15 }, fontSize, firstCharacter: i }));
    const scaled = (glyphSize: number) =>
      run({
        change: textChange('Hi', {
          // A 1.782× scaled instance: Figma stores (and lays out with) scaled copies.
          fontSize: 35.64,
          lineHeight: { value: 42.768, units: 'PIXELS' },
          letterSpacing: { value: 1.782, units: 'PIXELS' },
          styleIdForText: { guid: { sessionID: 9, localID: 1 } },
          derivedTextData: { baselines: [{ position: { x: 0, y: 30 }, lineY: 0, firstCharacter: 0, endCharacter: 2 }], glyphs: glyphs(glyphSize) },
        }),
        styleNodes: [STYLE],
      }).text.runs[0]!.style;

    it('keeps the node values when the glyphs agree with them and not with the style', () => {
      expect(scaled(35.64)).toMatchObject({ fontSize: 35.64, lineHeight: { unit: 'px', value: 42.768 }, letterSpacing: { unit: 'px', value: 1.782 }, styleId: '9:1' });
    });

    it('keeps the style values when the glyphs agree with the style', () => {
      expect(scaled(20)).toMatchObject({ fontSize: 20, lineHeight: { unit: 'px', value: 24 }, letterSpacing: { unit: 'px', value: 1 } });
    });

    it('lets the baseline advance decide the line height of multi-line text', () => {
      const style = run({
        change: textChange('a\nb', {
          fontSize: 20,
          lineHeight: { value: 30, units: 'PIXELS' },
          styleIdForText: { guid: { sessionID: 9, localID: 1 } },
          derivedTextData: {
            baselines: [
              { position: { x: 0, y: 20 }, lineY: 0, firstCharacter: 0, endCharacter: 2 },
              { position: { x: 0, y: 50 }, lineY: 30, firstCharacter: 2, endCharacter: 3 },
            ],
            glyphs: glyphs(20),
          },
        }),
        styleNodes: [STYLE],
      }).text.runs[0]!.style;
      expect(style).toMatchObject({ fontSize: 20, lineHeight: { unit: 'px', value: 30 } });
    });
  });

  it('drops the style reference for the "no style" sentinel in a run override', () => {
    const { text } = run({
      change: textChange('ab', { styleIdForText: { guid: { sessionID: 9, localID: 1 } } }, {
        characterStyleIDs: [0, 1],
        styleOverrideTable: [{ styleID: 1, styleIdForText: { guid: { sessionID: 4294967295, localID: 4294967295 } }, fontSize: 30 }],
      }),
      styleNodes: [{ guid: { sessionID: 9, localID: 1 }, type: 'TEXT', styleType: 'TEXT', fontName: INTER, fontSize: 16 }],
    });
    expect(text.runs.map((r) => [r.style.fontSize, r.style.styleId])).toEqual([
      [16, '9:1'],
      [30, undefined],
    ]);
  });

  it('maps hyperlinks, case and decoration', () => {
    const { text } = run({
      change: textChange('link', { textCase: 'UPPER', textDecoration: 'UNDERLINE', hyperlink: { url: 'https://example.com' } }),
    });
    expect(text.runs[0]!.style).toMatchObject({ textCase: 'upper', textDecoration: 'underline', hyperlink: 'https://example.com' });
    const empty = run({ change: textChange('x', { hyperlink: {} }) }).text;
    expect(empty.runs[0]!.style.hyperlink).toBeUndefined();
  });

  it('never throws on malformed nodes', () => {
    const { text, reporter } = run({ change: { textData: undefined } });
    expect(text.characters).toBe('');
    expect(text.runs).toHaveLength(1);
    expect(reporter.warnings.map((w) => w.code)).toContain('text-missing-data');

    const odd = run({
      change: textChange('abc', { fontSize: Number.NaN, lineHeight: { value: Number.NaN, units: 'PIXELS' } }, {
        characterStyleIDs: [7, 7, 7, 7, 7],
        styleOverrideTable: [],
      }),
    });
    expect(odd.text.runs[0]).toMatchObject({ start: 0, end: 3 });
    expect(odd.reporter.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['text-missing-style-override', 'text-style-ids-overflow']));
  });
});

// ---------------------------------------------------------------------------
// Node-level properties and style values
// ---------------------------------------------------------------------------

describe('translateText properties', () => {
  it('maps resize, alignment and paragraph settings', () => {
    const { text } = run({
      change: textChange('x', { textAutoResize: 'HEIGHT', textAlignHorizontal: 'JUSTIFIED', textAlignVertical: 'BOTTOM', paragraphSpacing: 8, paragraphIndent: 4 }),
    });
    expect(text).toMatchObject({ autoResize: 'height', alignHorizontal: 'justified', alignVertical: 'bottom', paragraphSpacing: 8, paragraphIndent: 4 });
    expect(run({ change: textChange('x', { textTruncation: 'ENDING' }) }).text.autoResize).toBe('truncate');
    expect(run({ change: textChange('x', { textAutoResize: 'WIDTH_AND_HEIGHT' }) }).text.autoResize).toBe('width-and-height');
    expect(run({ change: textChange('x') }).text).toMatchObject({ autoResize: 'none', alignHorizontal: 'left', alignVertical: 'top' });
  });

  it('maps line height units (PERCENT 100 = auto, RAW = × font size, PERCENT = % of intrinsic)', () => {
    const lh = (lineHeight: fig.Number, extra: Partial<fig.NodeChange> = {}) => run({ change: textChange('x', { lineHeight, ...extra }) }).text.runs[0]!.style.lineHeight;
    expect(lh({ value: 100, units: 'PERCENT' })).toEqual({ unit: 'auto', value: 0 });
    expect(lh({ value: 24, units: 'PIXELS' })).toEqual({ unit: 'px', value: 24 });
    expect(lh({ value: 1.5, units: 'RAW' })).toEqual({ unit: 'percent', value: 150 });
    const intrinsic = lh(
      { value: 150, units: 'PERCENT' },
      { derivedTextData: { fontMetaData: [{ key: INTER, fontLineHeight: 1.2, fontWeight: 400, fontStyle: 'NORMAL' }] } },
    );
    expect(intrinsic.unit).toBe('percent');
    expect(intrinsic.value).toBeCloseTo(180);
  });

  it('maps letter spacing units', () => {
    const ls = (letterSpacing: fig.Number) => run({ change: textChange('x', { letterSpacing }) }).text.runs[0]!.style.letterSpacing;
    expect(ls({ value: -2, units: 'PERCENT' })).toEqual({ unit: 'percent', value: -2 });
    expect(ls({ value: 1.5, units: 'PIXELS' })).toEqual({ unit: 'px', value: 1.5 });
  });

  it('derives weight from variable axes, then font metadata, then the style name', () => {
    const weight = (extra: Partial<fig.NodeChange>) => run({ change: textChange('x', extra) }).text.runs[0]!.style;
    const medium = { family: 'Inter', style: 'Medium', postscript: '' };
    expect(weight({ fontName: medium }).fontWeight).toBe(500);
    expect(weight({ fontName: medium, derivedTextData: { fontMetaData: [{ key: medium, fontWeight: 550, fontStyle: 'ITALIC' }] } })).toMatchObject({ fontWeight: 550, italic: true });
    expect(weight({ fontName: medium, fontVariations: [{ axisTag: 0x77676874, axisName: 'Weight', value: 450 }] }).fontWeight).toBe(450);
  });

  it('derives weight and italic from style names', () => {
    const cases: [string, number, boolean][] = [
      ['Thin', 100], ['Hairline', 100], ['ExtraLight', 200], ['Ultra Light', 200], ['Light Italic', 300],
      ['Regular', 400], ['Normal', 400], ['Book', 400], ['Italic', 400], ['Medium', 500], ['Semi Bold', 600],
      ['SemiBold Italic', 600], ['Demi-Bold', 600], ['DemiBold', 600], ['Bold', 700], ['Bold Oblique', 700],
      ['Extra Bold', 800], ['UltraBold', 800], ['Black', 900], ['Heavy', 900], ['ExtraBlack', 900], ['HouseScript', 400],
      ['W500', 500], ['600', 600],
    ].map(([name, w]) => [name as string, w as number, /italic|oblique/i.test(name as string)]);
    for (const [name, w, italic] of cases) {
      expect([name, fontWeightFromStyleName(name)]).toEqual([name, w]);
      expect([name, isItalicStyleName(name)]).toEqual([name, italic]);
    }
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('translateText layout', () => {
  const baselines: fig.Baseline[] = [{ position: { x: 0, y: 15 }, lineY: 2, lineHeight: 20, lineAscent: 15, width: 40, firstCharacter: 0, endCharacter: 4 }];

  it('transforms em-space glyph outlines (y up) to node space and groups them per run', () => {
    const { text } = run({
      change: textChange('abcd', {
        derivedTextData: {
          baselines,
          glyphs: [
            { commandsBlob: 0, position: { x: 0, y: 15 }, fontSize: 10, firstCharacter: 0 },
            { commandsBlob: 0, position: { x: 10, y: 15 }, fontSize: 10, firstCharacter: 1 },
            { commandsBlob: 1, position: { x: 20, y: 15 }, fontSize: 10, firstCharacter: 2 },
            { commandsBlob: 0, position: { x: 30, y: 15 }, fontSize: 20, firstCharacter: 3 },
          ],
        },
      }, { characterStyleIDs: [0, 0, 0, 1], styleOverrideTable: [{ styleID: 1, fontSize: 20 }] }),
      blobs: [encodeCommands(SQUARE), encodeCommands([{ type: 'Z' }])],
    });
    expect(text.layout?.lines).toEqual([{ start: 0, end: 4, baseline: { x: 0, y: 15 }, width: 40, lineHeight: 20, ascent: 13 }]);
    const outlines = text.layout!.outlines!;
    expect(outlines.map((o) => o.runIndex)).toEqual([0, 1]);
    expect(outlines[0]!.path.windingRule).toBe('nonzero');
    // Two squares in run 0 (the space-like glyph with only Z is skipped).
    expect(outlines[0]!.path.commands.slice(0, 5)).toEqual([
      { type: 'M', x: 0, y: 15 },
      { type: 'L', x: 5, y: 15 },
      { type: 'L', x: 5, y: 10 },
      { type: 'L', x: 0, y: 10 },
      { type: 'Z' },
    ]);
    expect(outlines[0]!.path.commands).toHaveLength(10);
    expect(outlines[1]!.path.commands[2]).toEqual({ type: 'L', x: 40, y: 5 });
  });

  it('skips non-finite glyph outline coordinates with a corrupt-geometry warning', () => {
    const { text, reporter } = run({
      change: textChange('a', { derivedTextData: { baselines, glyphs: [{ commandsBlob: 0, position: { x: 0, y: 15 }, fontSize: 10, firstCharacter: 0 }] } }),
      blobs: [encodeCommands([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: Number.NaN, y: 0 }, { type: 'L', x: 0.5, y: 0.5 }, { type: 'Z' }])],
    });
    expect(reporter.warnings.map((w) => w.code)).toContain('corrupt-geometry');
    const commands = text.layout!.outlines![0]!.path.commands;
    expect(commands.map((c) => c.type)).toEqual(['M', 'L', 'Z']);
    expect(commands.flatMap((c) => Object.values(c).filter((v) => typeof v === 'number')).every(Number.isFinite)).toBe(true);
  });

  it('drops glyphs hidden by truncation but keeps the ellipsis, and assigns bullets to the following text', () => {
    const { text } = run({
      change: textChange('abcd', {
        textTruncation: 'ENDING',
        derivedTextData: {
          truncationStartIndex: 2,
          baselines,
          glyphs: [
            { commandsBlob: 0, position: { x: 0, y: 15 }, fontSize: 10, styleID: 0 }, // bullet
            { commandsBlob: 0, position: { x: 10, y: 15 }, fontSize: 10, firstCharacter: 0 },
            { commandsBlob: 0, position: { x: 20, y: 15 }, fontSize: 10, firstCharacter: 1 },
            { commandsBlob: 0, position: { x: 30, y: 15 }, fontSize: 10, firstCharacter: 2 },
            { commandsBlob: 0, position: { x: 40, y: 15 }, fontSize: 10, firstCharacter: 3 },
            { commandsBlob: 0, position: { x: 30, y: 15 }, fontSize: 10 }, // ellipsis
          ],
        },
      }),
      blobs: [encodeCommands(SQUARE)],
    });
    const xs = text.layout!.outlines![0]!.path.commands.filter((c) => c.type === 'M').map((c) => (c as { x: number }).x);
    expect(xs).toEqual([0, 10, 20, 30]);
  });

  it('adds decoration rects to their run, wound like the glyphs', () => {
    const { text } = run({
      change: textChange('ab', {
        derivedTextData: {
          baselines,
          glyphs: [{ commandsBlob: 0, position: { x: 0, y: 15 }, fontSize: 10, firstCharacter: 0 }],
          decorations: [{ styleID: 0, rects: [{ x: 0, y: 16, w: 20, h: 1 }] }],
        },
      }),
      blobs: [encodeCommands(SQUARE)],
    });
    const cmds = text.layout!.outlines![0]!.path.commands;
    expect(cmds).toHaveLength(10);
    // Glyph square after the y flip runs (0,15) → (5,15) → (5,10): counter-clockwise on screen. So does the rect.
    expect(cmds.slice(5)).toEqual([
      { type: 'M', x: 0, y: 17 },
      { type: 'L', x: 20, y: 17 },
      { type: 'L', x: 20, y: 16 },
      { type: 'L', x: 0, y: 16 },
      { type: 'Z' },
    ]);
  });

  it('warns once per node for emoji glyphs without outlines', () => {
    const { text, reporter } = run({
      change: textChange('a😀😀', {
        derivedTextData: {
          baselines: [{ ...baselines[0]!, endCharacter: 3 }],
          glyphs: [
            { commandsBlob: 0, position: { x: 0, y: 15 }, fontSize: 10, firstCharacter: 0 },
            { position: { x: 10, y: 15 }, fontSize: 10, firstCharacter: 1, emojiCodePoints: [0x1f600] },
            { position: { x: 20, y: 15 }, fontSize: 10, firstCharacter: 2, emojiCodePoints: [0x1f600] },
          ],
        },
      }),
      blobs: [encodeCommands(SQUARE)],
    });
    expect(text.layout?.outlines).toHaveLength(1);
    expect(reporter.warnings.filter((w) => w.code === 'text-emoji-not-outlined')).toHaveLength(1);
  });

  it('falls back to the layout stored in textData (older files)', () => {
    const { text } = run({
      change: textChange('ab', {}, { baselines, glyphs: [{ commandsBlob: 0, position: { x: 0, y: 15 }, fontSize: 10, firstCharacter: 0 }] }),
      blobs: [encodeCommands(SQUARE)],
    });
    expect(text.layout?.lines).toHaveLength(1);
    expect(text.layout?.outlines).toHaveLength(1);
  });
});

describe('buildIndexMap', () => {
  it('is the identity for BMP strings', () => {
    const map = buildIndexMap('héllo ⌘', {});
    expect(map.unit).toBe('utf16');
    expect(map.toU16(3)).toBe(3);
  });

  it('defaults to code points for astral strings without evidence', () => {
    const map = buildIndexMap('😀x', {});
    expect(map.unit).toBe('code-point');
    expect([map.toU16(0), map.toU16(1), map.toU16(2)]).toEqual([0, 2, 3]);
  });

  it('uses UTF-16 when the style id array is longer than the code-point count', () => {
    expect(buildIndexMap('😀x', { styleIdsLength: 3 }).unit).toBe('utf16');
  });

  it('keeps code points when a glyph starts on the low half of a surrogate pair, whatever the other evidence', () => {
    // UTF-16 index 1 is inside "🍪": only a code-point layout starts a glyph there.
    const map = buildIndexMap('🍪 a', { glyphStarts: [0, 1, 2], styleIdsLength: 4, lastBaselineEnd: 4 });
    expect(map.unit).toBe('code-point');
    expect([map.toU16(1), map.toU16(3)]).toEqual([2, 4]);
  });

  it.skipIf(!hasLarge('simple-design-system.fig'))('indexes the real "🍪 We use cookies!" node by code point', () => {
    const t = translateFixture(`${LARGE_FIXTURES}simple-design-system.fig`);
    const id = 'I321:9720;192:31517;280:12049';
    const change = t.doc.byId.get(id)!.change;
    const characters = change.textData!.characters!;
    expect(characters.startsWith('🍪')).toBe(true);
    const glyphStarts = change.derivedTextData!.glyphs!.map((g) => g.firstCharacter!);
    expect(glyphStarts).toEqual([...Array([...characters].length).keys()]);
    const map = buildIndexMap(characters, {
      lastBaselineEnd: change.derivedTextData!.baselines!.at(-1)!.endCharacter,
      styleIdsLength: change.textData!.characterStyleIDs?.length ?? 0,
      glyphStarts,
    });
    expect(map.unit).toBe('code-point');
    // Even a style id array covering every UTF-16 unit cannot flip it.
    expect(buildIndexMap(characters, { glyphStarts, styleIdsLength: characters.length }).unit).toBe('code-point');
    const text = nodesOf(t).find((n) => n.id === id);
    expect(text?.type).toBe('text');
    const ir = text as ir.TextNode;
    expect(ir.runs.at(-1)!.end).toBe(characters.length);
    expect(ir.layout?.lines?.at(-1)?.end).toBe(characters.length);
  });
});

// ---------------------------------------------------------------------------
// Real fixture
// ---------------------------------------------------------------------------

describe('translateText on f2s-structure.fig', () => {
  it('translates the "ABC" text node', () => {
    const file = decodeFig(new Uint8Array(readFileSync(new URL('../../fixtures/f2s-structure.fig', import.meta.url))));
    const doc = buildTree(file);
    const node = [...doc.byGuid.values()].find((n) => n.type === 'TEXT')!;
    const reporter = new CollectingReporter();
    const ctx = createContext(doc, reporter);
    const text = translateText(node, baseOf(node, [BLACK]), ctx);
    expect(reporter.warnings).toEqual([]);
    expect(text.characters).toBe('ABC');
    expect(text.runs).toHaveLength(1);
    expect(text.runs[0]!.style).toMatchObject({ fontFamily: 'Inter', fontStyle: 'Regular', fontWeight: 400, fontSize: 12, lineHeight: { unit: 'auto' } });
    expect(text.layout?.lines).toHaveLength(1);
    expect(text.layout!.lines![0]!.baseline.y).toBeCloseTo(11.8636, 3);
    expect(text.layout!.lines![0]!.ascent).toBeCloseTo(11.8636, 3);
    const outline = text.layout!.outlines![0]!;
    const ys = outline.path.commands.flatMap((c) => (c.type === 'Z' ? [] : [c.y]));
    // Cap height of Inter ≈ 0.727 em: the letters sit on the baseline (the
    // round "C" overshoots it slightly) and rise ≈ 8.7px above it.
    expect(Math.max(...ys)).toBeGreaterThan(11.8);
    expect(Math.max(...ys)).toBeLessThan(12.1);
    expect(Math.abs(Math.min(...ys) - (11.8636 - 0.727 * 12))).toBeLessThan(0.3);
  });
});

describe('translateText: truncation and fallback fonts', () => {
  const baselines = (ends: number[]) => {
    let start = 0;
    return ends.map((end, i) => {
      const b = { position: { x: 0, y: 12 + 16 * i }, lineY: 16 * i, lineHeight: 16, width: 30, firstCharacter: start, endCharacter: end };
      start = end;
      return b;
    });
  };

  it('records where a truncated text stops showing characters', () => {
    const { text } = run({
      change: textChange('one two three', { textTruncation: 'ENDING', derivedTextData: { baselines: baselines([4, 8, 13]), truncationStartIndex: 8 } }),
    });
    expect(text.autoResize).toBe('truncate');
    expect(text.layout?.truncationStart).toBe(8);
    expect(text.layout?.lines).toHaveLength(2);
  });

  it('has no truncationStart for a text that is not truncated', () => {
    const { text } = run({ change: textChange('one', { derivedTextData: { baselines: baselines([3]), truncationStartIndex: -1 } }) });
    expect(text.layout?.truncationStart).toBeUndefined();
  });

  it('lists fonts of fontMetaData that are neither a run font nor the node font as fallback fonts', () => {
    const symbols = { family: 'Noto Sans Symbols', style: 'Regular', postscript: '' };
    const whyte = { family: 'Whyte', style: 'Regular', postscript: '' };
    const { text } = run({
      change: textChange(
        'a⇧',
        {
          fontName: whyte,
          derivedTextData: {
            baselines: baselines([2]),
            fontMetaData: [
              { key: whyte, fontLineHeight: 1.2, fontWeight: 400, fontStyle: 'NORMAL' },
              { key: { ...INTER, style: 'Bold' }, fontLineHeight: 1.2, fontWeight: 700, fontStyle: 'NORMAL' },
              { key: symbols, fontLineHeight: 1.3, fontWeight: 400, fontStyle: 'NORMAL' },
            ],
          },
        },
        { characterStyleIDs: [1, 1], styleOverrideTable: [{ styleID: 1, fontName: INTER }] },
      ),
    });
    expect(text.runs.every((r) => r.style.fontFamily === 'Inter')).toBe(true);
    expect(text.layout?.fallbackFonts).toEqual([{ family: 'Noto Sans Symbols', style: 'Regular' }]);
  });
});

describe('translateText: glyph advances', () => {
  it('records each drawn character’s nominal advance in px (em × font size), skipping hidden and synthesised glyphs', () => {
    const { text } = run({
      change: textChange('ab c', {
        textTruncation: 'ENDING',
        derivedTextData: {
          baselines: [{ position: { x: 0, y: 12 }, lineY: 0, lineHeight: 16, width: 30, firstCharacter: 0, endCharacter: 4 }],
          truncationStartIndex: 3,
          glyphs: [
            { position: { x: 0, y: 12 }, fontSize: 16, firstCharacter: 0, advance: 0.5 },
            { position: { x: 8, y: 12 }, fontSize: 16, firstCharacter: 1, advance: 0.25 },
            { position: { x: 12, y: 12 }, fontSize: 16, firstCharacter: 3, advance: 0.5 },
            { position: { x: 12, y: 12 }, fontSize: 16, advance: 0.9 },
          ],
        },
      }),
    });
    expect(text.layout?.glyphAdvances).toEqual([
      { offset: 0, x: 0, y: 12, advance: 8 },
      { offset: 1, x: 8, y: 12, advance: 4 },
    ]);
  });
});
