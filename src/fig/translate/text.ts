/**
 * TEXT node → `ir.TextNode`.
 *
 * - `characters` is `textData.characters` verbatim. Figma stores a paragraph
 *   break as `\n` and a soft line break (Shift+Enter) as U+2028 LINE
 *   SEPARATOR; both are kept as-is (`textData.lines` has one entry per
 *   `\n`-separated paragraph).
 * - `runs` come from `textData.characterStyleIDs` (one id per character,
 *   trailing zeros may be omitted; 0 = the node's own style) and
 *   `textData.styleOverrideTable` (sparse NodeChanges keyed by `styleID`,
 *   layered over the node's properties). Adjacent runs with identical styles
 *   are merged. An empty string gets exactly one empty run `[0, 0)` carrying
 *   the node's style, so the font information is not lost.
 * - `layout` is Figma's computed layout (see text-layout.ts).
 */
import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import type { TranslateContext } from './context.ts';
import { translatePaints } from './paints.ts';
import { buildIndexMap } from './text-index.ts';
import { buildAdvances, buildLines, buildMarkers, buildOutlines, layoutSourceOf, type LayoutSource, type RunLookup } from './text-layout.ts';
import { applyTextStyle, buildTextStyle, type TextStyleEvidence } from './text-style.ts';

/** Properties of a style override that are not text styling and must not leak into the run. */
const OVERRIDE_IGNORED = new Set(['styleID', 'guid', 'guidPath']);

export function translateText(node: FigNode, base: ir.BaseNode, ctx: TranslateContext): ir.TextNode {
  const change = node.change;
  const textData = change.textData;
  const characters = typeof textData?.characters === 'string' ? textData.characters : '';
  if (!textData) ctx.warn('text-missing-data', 'TEXT node has no textData; emitting empty text', node);

  const layoutSource = layoutSourceOf(change);
  const styleIds = textData?.characterStyleIDs ?? [];
  const map = buildIndexMap(characters, {
    lastBaselineEnd: layoutSource?.baselines.at(-1)?.endCharacter,
    styleIdsLength: styleIds.length,
    glyphStarts: layoutSource?.glyphs.flatMap((g) => (g.firstCharacter === undefined ? [] : [g.firstCharacter])),
  });
  if (styleIds.length > map.length) {
    ctx.warn('text-style-ids-overflow', `characterStyleIDs has ${styleIds.length} entries for ${map.length} characters`, node);
  }

  // --- styles per style id -------------------------------------------------
  // The node's own properties, with its text style's properties (if any) on top.
  // Figma's derived layout arbitrates between the node's copies and the style's.
  const evidence = (id: number): TextStyleEvidence => textStyleEvidence(layoutSource, styleIds, id);
  const effectiveRecord: Record<string, unknown> = { ...change };
  applyTextStyle(effectiveRecord, change.styleIdForText, ctx, evidence(0));
  const effective = effectiveRecord as fig.NodeChange;
  const overrides = new Map<number, fig.NodeChange>();
  for (const [i, entry] of (textData?.styleOverrideTable ?? []).entries()) {
    const id = entry.styleID ?? i + 1;
    if (!overrides.has(id)) overrides.set(id, entry);
  }
  const styleCache = new Map<number, ir.TextStyle>();
  const styleFor = (id: number): ir.TextStyle => {
    let style = styleCache.get(id);
    if (style) return style;
    let override: fig.NodeChange = {};
    if (id !== 0) {
      const found = overrides.get(id);
      if (found) override = found;
      else ctx.warn('text-missing-style-override', `style id ${id} is not in styleOverrideTable`, node);
    }
    const merged: Record<string, unknown> = { ...effective };
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined && !OVERRIDE_IGNORED.has(key)) merged[key] = value;
    }
    // A run that names its own text style takes that style's properties.
    if (override.styleIdForText) applyTextStyle(merged, override.styleIdForText, ctx, evidence(id));
    try {
      style = buildTextStyle({ change: merged as fig.NodeChange, override, baseFills: base.fills }, node, ctx, translatePaints);
    } catch (error) {
      ctx.warn('text-style-failed', `could not build text style ${id}: ${String(error)}`, node);
      style = fallbackStyle(base.fills);
    }
    styleCache.set(id, style);
    return style;
  };

  // --- runs ------------------------------------------------------------------
  const runs: ir.TextRun[] = [];
  const runKeys: string[] = [];
  const runStyleIds: number[][] = [];
  if (map.length === 0) {
    runs.push({ start: 0, end: 0, style: styleFor(0) });
  } else {
    let runStart = 0;
    let runId = styleIds[0] ?? 0;
    const flush = (endIndex: number, id: number): void => {
      const style = styleFor(id);
      const key = JSON.stringify(style);
      const start = map.toU16(runStart);
      const end = map.toU16(endIndex);
      const last = runs.at(-1);
      if (last && runKeys.at(-1) === key) {
        last.end = end;
        runStyleIds.at(-1)!.push(id);
      } else if (end > start) {
        runs.push({ start, end, style });
        runKeys.push(key);
        runStyleIds.push([id]);
      }
    };
    for (let i = 1; i < map.length; i++) {
      const id = styleIds[i] ?? 0;
      if (id !== runId) {
        flush(i, runId);
        runStart = i;
        runId = id;
      }
    }
    flush(map.length, runId);
  }
  if (runs.length > 0) {
    runs[0]!.start = 0;
    runs.at(-1)!.end = characters.length;
  }

  // --- layout ----------------------------------------------------------------
  let layout: ir.TextNode['layout'];
  if (layoutSource) {
    const lookup: RunLookup = {
      runAt(u16) {
        let lo = 0;
        let hi = runs.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (runs[mid]!.start <= u16) lo = mid;
          else hi = mid - 1;
        }
        return Math.max(0, lo);
      },
      runOfStyle(id) {
        const index = runStyleIds.findIndex((ids) => ids.includes(id));
        return index >= 0 ? index : undefined;
      },
    };
    try {
      const lines = buildLines(layoutSource, map);
      const outlines = buildOutlines(layoutSource, map, lookup, node, ctx);
      layout = {};
      if (lines.length > 0) layout.lines = lines;
      if (outlines.length > 0) layout.outlines = outlines;
      const cut = layoutSource.truncationStartIndex;
      if (cut >= 0) {
        const at = map.toU16(cut);
        if (at < characters.length) layout.truncationStart = at;
      }
      const advances = buildAdvances(layoutSource, map);
      if (advances.length > 0) layout.glyphAdvances = advances;
      // Only list markers: other synthesised glyphs (the truncation ellipsis) belong to no paragraph start.
      const listStarts = new Set(listParagraphs(textData?.lines, characters).map((l) => l.start));
      const markers = buildMarkers(layoutSource, map).filter((m) => listStarts.has(m.start));
      if (markers.length > 0) layout.markers = markers;
      const fallback = fallbackFontsOf(change.derivedTextData?.fontMetaData, runs, change.fontName?.family);
      if (fallback.length > 0) layout.fallbackFonts = fallback;
    } catch (error) {
      ctx.warn('text-layout-failed', `could not read the computed text layout: ${String(error)}`, node);
      layout = undefined;
    }
  } else if (characters.length > 0) {
    ctx.warn('text-missing-layout', 'TEXT node has no computed layout (baselines / glyphs)', node);
  }

  const result: ir.TextNode = {
    ...base,
    type: 'text',
    characters,
    runs,
    autoResize: autoResizeOf(change),
    alignHorizontal: alignHorizontalOf(change.textAlignHorizontal),
    alignVertical: alignVerticalOf(change.textAlignVertical),
    paragraphSpacing: finiteOr(effective.paragraphSpacing, 0),
    paragraphIndent: finiteOr(effective.paragraphIndent, 0),
  };
  const lists = listParagraphs(textData?.lines, characters);
  if (lists.length > 0) result.lists = lists;
  if (layout) result.layout = layout;
  return result;
}

/**
 * `textData.lines` has one entry per `\n`-separated paragraph; list lines
 * (`ORDERED_LIST` / `UNORDERED_LIST`) become `TextNode.lists`.
 */
function listParagraphs(lines: readonly fig.TextLineData[] | undefined, characters: string): NonNullable<ir.TextNode['lists']> {
  const out: NonNullable<ir.TextNode['lists']> = [];
  if (!lines?.length) return out;
  let start = 0;
  const paragraphs = characters.split('\n');
  paragraphs.forEach((paragraph, i) => {
    const line = lines[i];
    const type = line?.lineType === 'ORDERED_LIST' ? 'ordered' : line?.lineType === 'UNORDERED_LIST' ? 'unordered' : undefined;
    if (type && !(i === paragraphs.length - 1 && paragraph === '' && i > 0)) out.push({ start, type, level: Math.max(1, line!.indentationLevel ?? 1) });
    start += paragraph.length + 1;
  });
  return out;
}

/**
 * Fonts Figma's layout used (`derivedTextData.fontMetaData`, one entry per
 * font file it drew glyphs with) whose family is no run's family: glyphs the
 * runs' fonts lack, drawn with a fallback font. The file does not say which
 * glyphs those are (a glyph only refers to its style). Same family in another
 * style (instance overrides) is not a fallback, nor is the node's own font
 * (listed even when every character overrides it: 35 auto-layout-playground
 * texts list Whyte or SignPainter that way and draw only Inter).
 */
function fallbackFontsOf(meta: readonly fig.FontMetaData[] | undefined, runs: readonly ir.TextRun[], nodeFamily: string | undefined): { family: string; style: string }[] {
  const key = (family: string): string => family.toLowerCase().replace(/[\s_-]+/g, '');
  const families = new Set(runs.map((r) => key(r.style.fontFamily ?? '')));
  // The node's own font is listed even when every character overrides it.
  if (nodeFamily) families.add(key(nodeFamily));
  const out: { family: string; style: string }[] = [];
  for (const m of meta ?? []) {
    const family = m.key?.family;
    if (typeof family !== 'string' || family === '' || families.has(key(family))) continue;
    const style = typeof m.key?.style === 'string' ? m.key.style : '';
    if (!out.some((f) => f.family === family && f.style === style)) out.push({ family, style });
  }
  return out;
}

/**
 * Derived-layout facts for style id `id`: the font sizes of the glyphs of its
 * characters (glyph `firstCharacter` indexes `characterStyleIDs`; omitted
 * trailing ids are 0) and, when the whole text uses this one id, the smallest
 * baseline-to-baseline advance (the line height; larger gaps add paragraph
 * spacing).
 */
function textStyleEvidence(source: LayoutSource | undefined, styleIds: readonly number[], id: number): TextStyleEvidence {
  const fontSizes: number[] = [];
  if (!source) return { fontSizes };
  for (const g of source.glyphs) {
    if (g.firstCharacter === undefined || g.fontSize === undefined) continue;
    if ((styleIds[g.firstCharacter] ?? 0) === id) fontSizes.push(g.fontSize);
  }
  const evidence: TextStyleEvidence = { fontSizes };
  if (styleIds.every((s) => s === id) && source.baselines.length > 1) {
    let advance = Infinity;
    for (let i = 1; i < source.baselines.length; i++) {
      const d = (source.baselines[i]!.position?.y ?? NaN) - (source.baselines[i - 1]!.position?.y ?? NaN);
      if (Number.isFinite(d) && d > 0 && d < advance) advance = d;
    }
    if (Number.isFinite(advance)) evidence.lineAdvance = advance;
  }
  return evidence;
}

function fallbackStyle(fills: ir.Paint[]): ir.TextStyle {
  return {
    fontFamily: '',
    fontStyle: 'Regular',
    fontWeight: 400,
    italic: false,
    fontSize: 12,
    lineHeight: { unit: 'auto', value: 0 },
    letterSpacing: { unit: 'percent', value: 0 },
    textCase: 'original',
    textDecoration: 'none',
    fills,
  };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function autoResizeOf(change: fig.NodeChange): ir.TextNode['autoResize'] {
  switch (change.textAutoResize) {
    case 'WIDTH_AND_HEIGHT':
      return 'width-and-height';
    case 'HEIGHT':
      return 'height';
    default:
      // REST reports `TRUNCATE` for a fixed-size box with "truncate text" on.
      return change.textTruncation === 'ENDING' ? 'truncate' : 'none';
  }
}

function alignHorizontalOf(value: fig.TextAlignHorizontal | undefined): ir.TextNode['alignHorizontal'] {
  switch (value) {
    case 'CENTER':
      return 'center';
    case 'RIGHT':
      return 'right';
    case 'JUSTIFIED':
      return 'justified';
    default:
      return 'left';
  }
}

function alignVerticalOf(value: fig.TextAlignVertical | undefined): ir.TextNode['alignVertical'] {
  if (value === 'CENTER') return 'center';
  if (value === 'BOTTOM') return 'bottom';
  return 'top';
}
