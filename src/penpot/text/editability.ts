/**
 * `textMode: 'auto'`: whether a text stays editable or is drawn with the
 * source's glyph outlines. A text stays editable only when its editable
 * render is expected to match the source; each reason to outline has its own
 * warning code (README, "When `auto` outlines text").
 */
import type * as ir from '../../ir.ts';
import { SUBSTITUTED_GLYPH_EM, displayedCodePoint, penpotAdvance, type GlyphCensus } from './advances.ts';
import { COMMONLY_ABSENT, MEASURED, SUBSET_RANGES } from './coverage-data.ts';
import { findFamily, resolveFont } from './fonts.ts';
import { listEmulation } from './lists.ts';

export interface OutlineReason {
  code: string;
  message: string;
}

type Renderer = 'svg' | 'wasm';

/** Decoded `gap+length` ranges (coverage-data.ts). */
function decodeSet(spec: string): Set<number> {
  const out = new Set<number>();
  let position = 0;
  for (const part of spec.split(',')) {
    if (part === '') continue;
    const [gap, length] = part.split('+');
    const start = position + parseInt(gap!, 36);
    const n = parseInt(length!, 36);
    for (let i = 0; i < n; i++) out.add(start + i);
    position = start + n;
  }
  return out;
}

function parseRanges(spec: string): [number, number][] {
  return spec.split(',').map((part) => {
    const [a, b] = part.split('-');
    const from = parseInt(a!, 16);
    return [from, b === undefined ? from : parseInt(b, 16)];
  });
}

const measured = new Map<string, Set<number>>();
const subsetRanges = new Map<string, [number, number][]>();
let commonlyAbsent: Set<number> | undefined;

/**
 * Invisible format characters: Penpot draws nothing for them whatever the
 * font has (line / paragraph separators become breaks).
 */
function invisible(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0xad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff;
}

/**
 * Whether the font file the renderer loads for a run's family has `cp`
 * (otherwise the browser / Skia draws it with a fallback font of its own:
 * other shape and advance). `fontFamily` is the IR family.
 *
 * - Families measured in `coverage-data.ts` (those of `metrics.ts` and the
 *   built-in Source Sans Pro): the code points actually present in what the
 *   renderer loads. SVG: the subset `woff2` files of Penpot's Google Fonts CSS
 *   (each within its `unicode-range`; Cyrillic, Greek, Vietnamese… come from
 *   the family's own subsets); WASM: the family's full `ttf` (render-wasm
 *   loads `ttf-url`), which has e.g. Inter's ⇧ ⌥ ⌘ ↩ → ✓ ≠.
 * - Other catalogue families: the `unicode-range`s of the subsets the
 *   catalogue lists for them, without the latin / latin-ext code points at
 *   least half of the measured families lack (`COMMONLY_ABSENT`: most of
 *   latin-ext, U+2010–2012, U+2015, U+2021, U+2030, ↑ ↓, …). Sliced CJK
 *   subsets have no known ranges: not covered.
 * - Unknown families: not covered (they are outlined as unavailable anyway).
 */
export function characterCovered(fontFamily: string, cp: number, renderer: Renderer): boolean {
  if (invisible(cp)) return true;
  const family = findFamily(fontFamily);
  if (!family) return false;
  const key = `${family.family}|${renderer}`;
  let set = measured.get(key);
  if (set === undefined) {
    const data = MEASURED[family.family];
    if (data) measured.set(key, (set = decodeSet(renderer === 'svg' ? data.svg : data.wasm)));
  }
  if (set) return set.has(cp);
  commonlyAbsent ??= decodeSet(COMMONLY_ABSENT);
  if (commonlyAbsent.has(cp)) return false;
  return family.subsets.some((name) => {
    let ranges = subsetRanges.get(name);
    if (ranges === undefined) {
      const spec = SUBSET_RANGES[name];
      ranges = spec ? parseRanges(spec) : [];
      subsetRanges.set(name, ranges);
    }
    return ranges.some(([a, b]) => cp >= a && cp <= b);
  });
}

/** The distinct shown characters of `node` the renderer's copy of their run's font lacks. */
export function uncoveredCharacters(node: ir.TextNode, renderer: Renderer): string[] {
  const text = typeof node.characters === 'string' ? node.characters : '';
  const end = node.layout?.truncationStart ?? text.length;
  const out = new Set<string>();
  for (const run of node.runs) {
    const family = run.style.fontFamily ?? '';
    for (const ch of text.slice(Math.max(0, run.start), Math.min(end, run.end))) {
      if (!characterCovered(family, ch.codePointAt(0)!, renderer)) out.add(ch);
    }
  }
  return [...out];
}

/**
 * The share of a text's visible glyphs that Penpot's copy of the font draws
 * as another glyph than the source did: the source glyph's advance differs
 * from Penpot's for the character (after the case transform) by more than
 * `SUBSTITUTED_GLYPH_EM`. Figma's Inter (3.x) has narrower curly quotes and
 * apostrophes than the Inter 4 Penpot serves (“ 0.381 / 0.440 em Regular,
 * 0.42 / 0.54 Bold; ' 0.222 / 0.300), and Penpot has no font feature setting
 * to select another quote design. Fonts without an advance table count 0.
 * With the document's `census`, a character the document also draws with
 * Penpot's advance does not count: there it is a contextual alternate (the ×
 * of "5x5"), which Penpot draws too.
 */
export function differentGlyphShare(node: ir.TextNode, census?: GlyphCensus): { share: number; characters: string[] } {
  const text = typeof node.characters === 'string' ? node.characters : '';
  let visible = 0;
  const different = new Set<string>();
  let count = 0;
  for (const g of node.layout?.glyphAdvances ?? []) {
    const ch = String.fromCodePoint(text.codePointAt(g.offset) ?? 0x20);
    if (/\s/u.test(ch)) continue;
    visible++;
    const run = node.runs.find((r) => r.start <= g.offset && g.offset < r.end);
    if (!run || !(run.style.fontSize > 0)) continue;
    const font = resolveFont(run.style.fontFamily ?? '', run.style.fontWeight, run.style.italic);
    const cp = displayedCodePoint(text, g.offset, run.style.textCase);
    const own = font.exact && cp !== undefined ? penpotAdvance(font.fontFamily, font.fontVariantId, cp) : undefined;
    if (own !== undefined && Math.abs(g.advance / run.style.fontSize - own) > SUBSTITUTED_GLYPH_EM && !census?.drawnNormally(font.fontFamily, cp!)) {
      count++;
      different.add(ch);
    }
  }
  return { share: visible > 0 ? count / visible : 0, characters: [...different] };
}

/**
 * `auto` outlines a text when at least this share of its visible glyphs are
 * drawn differently (`differentGlyphShare`). Measured on the 89 distinct corpus
 * texts with curly quotes (SVG, editable render vs Figma's outlines): the
 * 4 copies of "“Quote”" (share 0.29) reach visual 0.51 / local 0.36; texts below
 * 0.06 fail or pass on everything else in them (line ends, wraps), not on the
 * quotes.
 */
export const DIFFERENT_GLYPH_SHARE = 0.1;

function visiblePaints(paints: readonly ir.Paint[] | undefined): ir.Paint[] {
  return (paints ?? []).filter((p) => p && p.visible !== false && p.opacity > 0);
}

const hex = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Why `textMode: 'auto'` outlines `node` for `renderer`, or undefined when it stays editable.
 * `glyphShapes` (`pixelExact`): also outline a text whose glyphs Penpot's copy of the font draws with other
 * shapes (`differentGlyphShare`); by default such a text stays editable (its spacing is corrected per line).
 */
export function autoOutlineReason(node: ir.TextNode, renderer: Renderer, census?: GlyphCensus, options: { glyphShapes?: boolean } = {}): OutlineReason | undefined {
  const missing = node.runs.filter((r) => !resolveFont(r.style.fontFamily ?? '', r.style.fontWeight, r.style.italic).exact).map((r) => r.style.fontFamily);
  if (missing.length > 0) {
    return { code: 'font-unavailable', message: `Font not available in Penpot (${[...new Set(missing)].join(', ')}); the text was converted to outlines` };
  }
  const uncovered = uncoveredCharacters(node, renderer);
  if (uncovered.length > 0 || (node.layout?.fallbackFonts?.length ?? 0) > 0) {
    const what = uncovered.length > 0 ? `characters ${uncovered.map((c) => `${c} (${hex(c)})`).join(', ')}` : `glyphs drawn with ${node.layout!.fallbackFonts!.map((f) => f.family).join(', ')}`;
    return { code: 'text-outlined-fallback-glyphs', message: `Penpot's copy of the font lacks ${what}, which the ${renderer === 'svg' ? 'browser' : 'renderer'} would draw with a fallback font; the text was converted to outlines` };
  }
  const different = options.glyphShapes ? differentGlyphShare(node, census) : { share: 0, characters: [] };
  if (different.share >= DIFFERENT_GLYPH_SHARE) {
    return {
      code: 'text-outlined-glyph-shapes',
      message: `Penpot's copy of the font draws ${different.characters.join(' ')} with other shapes and widths (${Math.round(different.share * 100)} % of the glyphs); the text was converted to outlines`,
    };
  }
  if (node.layout?.truncationStart !== undefined) {
    return { code: 'text-outlined-truncated', message: 'Penpot cannot truncate text with an ellipsis; the truncated text was converted to outlines' };
  }
  const lists = listEmulation(node);
  if (lists && 'problem' in lists) {
    return { code: 'text-outlined-list', message: `Penpot text has no lists and this one cannot be emulated (${lists.problem}); the text was converted to outlines` };
  }
  if (node.runs.some((r) => r.style.textDecoration === 'underline' || r.style.textDecoration === 'strikethrough')) {
    // Chromium and Skia place and size the line from the font's own underline / strikeout metrics; Figma draws it
    // ~1 px lower and thinner (auto-layout-playground link lists, 2411:13149: every underline mismatched).
    return { code: 'text-outlined-decoration', message: 'Penpot draws underlines and strikethroughs at another position and thickness; the text was converted to outlines' };
  }
  if (renderer === 'svg' && node.runs.some((r) => visiblePaints(r.style.fills).some((p) => p.type !== 'solid'))) {
    return { code: 'text-outlined-gradient-fill', message: "Penpot's SVG renderer fills the whole text box with a gradient or image text fill instead of the glyphs; the text was converted to outlines" };
  }
  return undefined;
}
