/**
 * Text style helpers: font weight / italic derivation and the mapping of a
 * kiwi `NodeChange`'s text properties to an `ir.TextStyle`.
 */
import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { guidToString } from '../tree.ts';
import type { TranslateContext } from './context.ts';

/** `0xFFFFFFFF:0xFFFFFFFF`: a style-reference sentinel meaning "explicitly no style". */
const NO_STYLE_GUID = '4294967295:4294967295';

/** OpenType axis tag `wght`. */
const WGHT_TAG = 0x77676874;

/** Fallback intrinsic line height (× font size) when the font's metrics are unknown. */
const DEFAULT_FONT_LINE_HEIGHT = 1.2;

/**
 * CSS weight from a font style name ("Semi Bold Italic" → 600). Tolerates
 * spacing, case, hyphens and underscores ("SemiBold", "semi-bold",
 * "ExtraBoldItalic", "UltraLight"). Unknown names → 400.
 */
export function fontWeightFromStyleName(styleName: string): number {
  const s = styleName.toLowerCase().replace(/[\s\-_]+/g, '');
  const numeric = /(?:^|\D)([1-9]00)(?:\D|$)/.exec(styleName);
  if (numeric) return Number(numeric[1]);
  const table: [RegExp, number][] = [
    [/(extra|ultra)black/, 900],
    [/(extra|ultra)bold/, 800],
    [/(semi|demi)bold/, 600],
    [/(extra|ultra)light/, 200],
    [/(extra|ultra)thin/, 100],
    [/hairline|thin/, 100],
    [/(semi|demi)light/, 300],
    [/light/, 300],
    [/black|heavy/, 900],
    [/bold/, 700],
    [/medium/, 500],
    [/regular|normal|book|roman|plain/, 400],
    [/demi/, 600],
  ];
  for (const [re, weight] of table) if (re.test(s)) return weight;
  return 400;
}

export function isItalicStyleName(styleName: string): boolean {
  return /italic|oblique/i.test(styleName);
}

function sameFont(a: fig.FontName | undefined, b: fig.FontName | undefined): boolean {
  return !!a && !!b && a.family === b.family && a.style === b.style;
}

/** The node's font metadata (derived layout data first, then the legacy `textData` copy). */
export function fontMetaDataOf(change: fig.NodeChange): fig.FontMetaData[] {
  const derived = change.derivedTextData?.fontMetaData;
  if (derived && derived.length > 0) return derived;
  return change.textData?.fontMetaData ?? [];
}

/**
 * Resolves a style reference (`styleIdForText`, …) to the GUID string of the
 * local style node, or undefined. `assetRef` references are resolved through
 * the style node's publish `key`.
 */
export function resolveStyleRef(ref: fig.StyleId | undefined, ctx: TranslateContext): string | undefined {
  if (!ref) return undefined;
  if (ref.guid) {
    const id = guidToString(ref.guid);
    return id === NO_STYLE_GUID ? undefined : id;
  }
  const key = ref.assetRef?.key;
  if (!key) return undefined;
  return styleKeyIndex(ctx).get(key);
}

const keyIndexCache = new WeakMap<object, Map<string, string>>();

function styleKeyIndex(ctx: TranslateContext): Map<string, string> {
  let index = keyIndexCache.get(ctx.doc);
  if (!index) {
    index = new Map();
    for (const node of ctx.doc.byGuid.values()) {
      const key = node.change.key;
      if (key && node.change.styleType && !index.has(key)) index.set(key, node.guid);
    }
    keyIndexCache.set(ctx.doc, index);
  }
  return index;
}

/**
 * Text properties a shared text style defines. When a node (or run) refers
 * to a text style, Figma lays it out with the STYLE's values; the node's own
 * copies can be stale (seen in real files: node `fontName` "Whyte" while the
 * style, the REST API and the glyph font metadata all say "Inter"). Style
 * nodes omit default values, so an absent key means the default.
 */
const TEXT_STYLE_KEYS = [
  'fontName',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'textCase',
  'textDecoration',
  'paragraphSpacing',
  'paragraphIndent',
  'fontVariations',
  'textTracking',
  'toggledOnOTFeatures',
  'toggledOffOTFeatures',
  'fontVariantCommonLigatures',
  'fontVariantContextualLigatures',
  'fontVariantDiscretionaryLigatures',
  'fontVariantHistoricalLigatures',
  'fontVariantOrdinal',
  'fontVariantSlashedZero',
  'fontVariantNumericFigure',
  'fontVariantNumericSpacing',
  'fontVariantNumericFraction',
  'fontVariantCaps',
  'fontVariantPosition',
  'leadingTrim',
  'listSpacing',
  'hangingPunctuation',
  'hangingList',
] as const;

/** The style node a style reference points at, if it is in the file. */
export function styleNodeOf(ref: fig.StyleId | undefined, ctx: TranslateContext): FigNode | undefined {
  const id = resolveStyleRef(ref, ctx);
  return id ? ctx.doc.byGuid.get(id) : undefined;
}

/**
 * What Figma's own layout says about the values it used for one style id:
 * the glyphs' font sizes and, for single-style multi-line text, the baseline
 * advance (= the line height in px). See `textStyleEvidence` in text.ts.
 */
export interface TextStyleEvidence {
  fontSizes: number[];
  lineAdvance?: number;
}

/**
 * Replaces the text properties of `change` (in place) with those of the text
 * style `ref` points at. No-op when the reference is absent, the "no style"
 * sentinel, or not resolvable in this file.
 *
 * With `evidence`, Figma's derived layout arbitrates per property: a node
 * inside a scaled instance keeps the style reference but carries scaled
 * copies (font size 35.6 for a 20 px style, line height 42.8 for 24 px) and
 * Figma lays it out with those. The node's font size is kept when the glyphs
 * agree with it and not with the style's; its px-valued line height, letter
 * spacing and paragraph spacing / indent are then kept when they are the
 * style's values scaled by the same factor (or, for line height, when the
 * baseline advance agrees with the node's and not the style's).
 */
export function applyTextStyle(change: Record<string, unknown>, ref: fig.StyleId | undefined, ctx: TranslateContext, evidence?: TextStyleEvidence): void {
  const styleNode = styleNodeOf(ref, ctx);
  if (!styleNode || styleNode.change.styleType !== 'TEXT') return;
  const source = styleNode.change as Record<string, unknown>;
  const keep = evidence ? nodeValuesToKeep(change as fig.NodeChange, source as fig.NodeChange, evidence) : new Set<string>();
  for (const key of TEXT_STYLE_KEYS) {
    if (keep.has(key)) continue;
    if (source[key] === undefined) delete change[key];
    else change[key] = source[key];
  }
}

const near = (a: number, b: number, tolerance = 1e-3): boolean => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));

function nodeValuesToKeep(node: fig.NodeChange, style: fig.NodeChange, evidence: TextStyleEvidence): Set<string> {
  const keep = new Set<string>();
  const sizes = evidence.fontSizes.filter((v) => Number.isFinite(v));
  const agrees = (v: number | undefined): boolean => v !== undefined && Number.isFinite(v) && sizes.length > 0 && sizes.every((g) => near(g, v));
  const nodeSize = node.fontSize;
  const styleSize = style.fontSize ?? 12;
  let scale: number | undefined;
  if (agrees(nodeSize) && !agrees(styleSize)) {
    keep.add('fontSize');
    if (styleSize > 0) scale = nodeSize! / styleSize;
  }
  const scaled = (n: number | undefined, s: number | undefined): boolean =>
    scale !== undefined && n !== undefined && s !== undefined && Number.isFinite(n) && Number.isFinite(s) && n !== s && near(n, s * scale);
  const px = (v: fig.Number | undefined): number | undefined => (v?.units === 'PIXELS' ? v.value : undefined);

  const nodeLh = px(node.lineHeight);
  const styleLh = px(style.lineHeight);
  const advance = evidence.lineAdvance;
  if (nodeLh !== undefined && styleLh !== undefined && nodeLh !== styleLh) {
    if (advance !== undefined ? near(advance, nodeLh, 1e-2) && !near(advance, styleLh, 1e-2) : scaled(nodeLh, styleLh)) keep.add('lineHeight');
  }
  if (scaled(px(node.letterSpacing), px(style.letterSpacing))) keep.add('letterSpacing');
  if (scaled(node.paragraphSpacing, style.paragraphSpacing)) keep.add('paragraphSpacing');
  if (scaled(node.paragraphIndent, style.paragraphIndent)) keep.add('paragraphIndent');
  return keep;
}

export interface StyleInputs {
  /** Effective properties for this style: the node's change with the run override layered on top. */
  change: fig.NodeChange;
  /** The override entry (empty for the node's base style). */
  override: fig.NodeChange;
  /** Node-level fills (already translated). */
  baseFills: ir.Paint[];
}

/** Builds the IR text style for one style id of a TEXT node. Never throws. */
export function buildTextStyle(input: StyleInputs, node: FigNode, ctx: TranslateContext, translatePaints: PaintTranslator): ir.TextStyle {
  const { change, override } = input;
  const fontName = change.fontName;
  const fontFamily = fontName?.family ?? '';
  const fontStyle = fontName?.style ?? 'Regular';
  const fontSize = finiteOr(change.fontSize, 12);
  const meta = fontMetaDataOf(change).find((m) => sameFont(m.key, fontName));

  // Weight: variable `wght` axis > font metadata > style name.
  let fontWeight: number | undefined;
  const wght = change.fontVariations?.find((v) => v.axisTag === WGHT_TAG || v.axisName === 'Weight');
  if (wght?.value !== undefined && Number.isFinite(wght.value) && wght.value > 0) fontWeight = Math.round(wght.value);
  if (fontWeight === undefined && meta?.fontWeight && meta.fontWeight > 0) fontWeight = meta.fontWeight;
  if (fontWeight === undefined) fontWeight = fontWeightFromStyleName(fontStyle);

  const italic = meta?.fontStyle === 'ITALIC' || isItalicStyleName(fontStyle);

  const style: ir.TextStyle = {
    fontFamily,
    fontStyle,
    fontWeight,
    italic,
    fontSize,
    lineHeight: lineHeightOf(change.lineHeight, meta, node, ctx),
    letterSpacing: letterSpacingOf(change.letterSpacing),
    textCase: textCaseOf(change.textCase),
    textDecoration: textDecorationOf(change.textDecoration),
    fills: input.baseFills,
  };

  if (override.fillPaints !== undefined || override.styleIdForFill !== undefined) {
    // A run with its own paints no longer uses the node's fill style unless it
    // names one itself; a named fill style's paints win over the stored copy.
    const runChange: fig.NodeChange = { ...change };
    if (override.styleIdForFill === undefined) delete runChange.styleIdForFill;
    if (override.inheritFillStyleID === undefined) delete runChange.inheritFillStyleID;
    const fillStyle = styleNodeOf(override.styleIdForFill, ctx);
    const paints = fillStyle?.change.fillPaints ?? override.fillPaints;
    if (paints !== undefined) style.fills = translatePaints(paints, ctx, { ...node, change: runChange });
  }

  const url = change.hyperlink?.url;
  if (url) style.hyperlink = url;

  const styleId = resolveStyleRef(change.styleIdForText, ctx);
  if (styleId) style.styleId = styleId;
  return style;
}

export type PaintTranslator = (paints: fig.Paint[] | undefined, ctx: TranslateContext, node?: FigNode) => ir.Paint[];

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/**
 * Kiwi line height:
 * - `PIXELS v` → v px
 * - `RAW f`    → f × font size (REST `FONT_SIZE_%` = f·100)
 * - `PERCENT p`→ p % of the font's *intrinsic* line height (REST `INTRINSIC_%`);
 *               `PERCENT 100` is Figma's "Auto".
 */
export function lineHeightOf(value: fig.Number | undefined, meta: fig.FontMetaData | undefined, node: FigNode, ctx: TranslateContext): ir.LineHeight {
  if (!value || !Number.isFinite(value.value)) return { unit: 'auto', value: 0 };
  switch (value.units) {
    case 'PIXELS':
      return { unit: 'px', value: value.value };
    case 'RAW':
      return { unit: 'percent', value: value.value * 100 };
    case 'PERCENT': {
      if (Math.abs(value.value - 100) < 1e-6) return { unit: 'auto', value: 0 };
      let intrinsic = meta?.fontLineHeight;
      if (!intrinsic || !Number.isFinite(intrinsic) || intrinsic <= 0) {
        ctx.warn('text-line-height-approximated', `intrinsic line height ${value.value}% approximated without font metrics`, node);
        intrinsic = DEFAULT_FONT_LINE_HEIGHT;
      }
      return { unit: 'percent', value: value.value * intrinsic };
    }
    default:
      return { unit: 'auto', value: 0 };
  }
}

export function letterSpacingOf(value: fig.Number | undefined): ir.LetterSpacing {
  if (!value || !Number.isFinite(value.value)) return { unit: 'percent', value: 0 };
  if (value.units === 'PIXELS') return { unit: 'px', value: value.value };
  if (value.units === 'RAW') return { unit: 'percent', value: value.value * 100 };
  return { unit: 'percent', value: value.value };
}

function textCaseOf(value: fig.TextCase | undefined): ir.TextStyle['textCase'] {
  switch (value) {
    case 'UPPER':
      return 'upper';
    case 'LOWER':
      return 'lower';
    case 'TITLE':
      return 'title';
    case 'SMALL_CAPS':
    case 'SMALL_CAPS_FORCED':
      return 'small-caps';
    default:
      return 'original';
  }
}

function textDecorationOf(value: fig.TextDecoration | undefined): ir.TextStyle['textDecoration'] {
  if (value === 'UNDERLINE') return 'underline';
  if (value === 'STRIKETHROUGH') return 'strikethrough';
  return 'none';
}
