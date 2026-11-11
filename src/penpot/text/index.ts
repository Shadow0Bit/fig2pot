/**
 * Penpot text: IR `TextNode` → the text-specific attributes of
 * `context.addText(...)` (the `content` tree and `growType`).
 *
 * Penpot's content model (`app.common.types.shape.text/schema:content`):
 *   root {verticalAlign} → paragraph-set → paragraph {textAlign, text style…}
 *     → leaf {text, fontId, fontFamily, fontVariantId, fontSize, fontWeight,
 *             fontStyle, lineHeight, letterSpacing, textTransform,
 *             textDecoration, fills}
 * Every numeric text attribute is a string. Paragraphs repeat the style of
 * their first leaf. Empty lines are a single U+200B leaf: the SVG renderer
 * gives an empty leaf no line box at all.
 *
 * See README.md in this directory for the decisions and their sources.
 */
import type * as ir from '../../ir.ts';
import { SUBSTITUTED_GLYPH_EM, displayedCodePoint, balancedSpacing, glyphErrors, hasAdvances, lineError, lineInterval, penpotAdvance, segments, type GlyphCensus, type LineGlyph } from './advances.ts';
import { BULLET, listEmulation, type ListItem } from './lists.ts';
import { baselineShift, svgBaselines, tryModelLines, wasmBaselines, wasmHalfPixelLines, type ModelParagraph, type ShiftResult, type TextRenderer } from './baseline.ts';
import { textBox, type LocalBox } from './box.ts';
import { linesInconsistency, planLineBreaks, snapToCodePoint, type LineBreakPlan } from './breaks.ts';
import { resolveFont, type ResolvedFont } from './fonts.ts';
import { defaultAutoLineHeight, deriveAutoRatio, explicitRatio } from './line-height.ts';

export type { LocalBox } from './box.ts';
export { GlyphCensus, displayedCodePoint } from './advances.ts';

/** A Penpot fill object as accepted by @penpot/library (fillColor/fillOpacity/fillColorGradient/fillImage…). Structural placeholder until the core writer exports its own type. */
export type PenpotFill = Record<string, unknown>;

export interface TextDeps {
  reporter: ir.Reporter;
  /** Converts IR paints (bottom→top) to Penpot fill objects in Penpot's order. Provided by the core writer. */
  fills(paints: ir.Paint[]): PenpotFill[];
  /** `source` (default): reproduce the source's line breaks with explicit soft breaks; `reflow`: let Penpot wrap. */
  lineBreaks?: 'source' | 'reflow';
  /** The library typography registered for a shared text style, which leaves of that style link to. Provided by the core writer. */
  typographyRef?(styleId: string): { id: string; file: string } | undefined;
  /** Where the text lands, for baseline compensation (see baseline.ts). Without it the box is not shifted. */
  placement?: TextPlacement;
  /**
   * Letter spacing that corrects the glyph advances of Penpot's copy of the font (advances.ts; README "Line
   * width"): `line` one extra spacing per source line, so that its first and last glyphs land where the source
   * drew them; `glyph` per character (runs split into many leaves, `WriteOptions.pixelExact`); `none` (default
   * here; the writer's default is `line`).
   */
  textSpacing?: TextSpacing;
  /** The renderer the file is tuned for (`line` spacing; default `svg`). */
  renderer?: TextRenderer;
  /** How the document's source glyphs compare with Penpot's (`GlyphCensus`), for the advance correction. */
  glyphCensus?: GlyphCensus;
}

export type TextSpacing = 'line' | 'glyph' | 'none';

/**
 * The renderer the file is tuned for and, for the SVG renderer (which rounds
 * baselines in page space), the page-space y of the text's local origin. Only
 * meaningful for an unscaled, unrotated text; `pageY` undefined disables the
 * SVG compensation.
 */
export interface TextPlacement {
  renderer: TextRenderer;
  pageY?: number;
  /** The advance correction the text is written with (`TextDeps.textSpacing`; default `none`): Penpot's line widths. */
  textSpacing?: TextSpacing;
  /** As `TextDeps.glyphCensus` (`line` spacing). */
  glyphCensus?: GlyphCensus;
}

export type GrowType = 'auto-width' | 'auto-height' | 'fixed';

/** True when Penpot can render this font out of the box (built-in or Google Fonts catalogue) in the requested weight/italic. */
export function fontIsAvailable(style: ir.TextStyle): boolean {
  return resolveFont(style.fontFamily ?? '', style.fontWeight, style.italic).exact;
}

/**
 * Everything text-specific for `addText`: the `content` tree (root → paragraph-set → paragraph → text leaves),
 * `growType`, and any other text-only shape attributes. The caller merges this with the generic shape attributes
 * (id, name, x/y/width/height, transform, opacity, …) and calls `context.addText(...)`.
 */
export function buildTextAttrs(
  node: ir.TextNode,
  deps: TextDeps,
): { content: unknown; growType: GrowType } & Record<string, unknown> {
  return buildText(node, deps).attrs;
}

export interface TextBuild {
  attrs: { content: unknown; growType: GrowType };
  /** The Penpot box in the text's local space (see box.ts); `{0, 0, size}` when nothing needs to grow. */
  box: LocalBox;
  /** Every source line break was made explicit (`lineBreaks: 'source'` with consistent lines). */
  sourceBreaks: boolean;
}

/** `buildTextAttrs` plus the box the text needs so that Penpot neither clips nor re-wraps it. */
export function buildText(source: ir.TextNode, deps: TextDeps): TextBuild {
  const node = shownText(source);
  const builder = new TextBuilder(node, deps);
  const content = builder.content();
  const grow = growType(node, builder, node !== source);
  return { attrs: { content, growType: grow }, ...penpotTextBox(node, deps.lineBreaks ?? 'source', deps.placement) };
}

const NOT_REQUESTED = 'not requested';

/**
 * Why `buildText` does not reproduce the source's line breaks for `node`:
 * `NOT_REQUESTED` (reflow mode, justified text, no lines) or what is wrong
 * with the lines. Undefined when it does.
 */
function sourceBreaksBlocker(node: ir.TextNode, lineBreaks: 'source' | 'reflow'): string | undefined {
  // Justified: explicit breaks would end every line with a forced break, which is never justified.
  if (lineBreaks !== 'source' || node.alignHorizontal === 'justified') return NOT_REQUESTED;
  const lines = node.layout?.lines;
  if (!lines || lines.length === 0) return NOT_REQUESTED;
  const text = typeof node.characters === 'string' ? node.characters : '';
  return linesInconsistency(lines, text, node.autoResize === 'truncate');
}

/** Whether `buildText` reproduces the source's line breaks for `node` (pure; no warnings). */
export function usesSourceBreaks(node: ir.TextNode, lineBreaks: 'source' | 'reflow'): boolean {
  return sourceBreaksBlocker(node, lineBreaks) === undefined;
}

/**
 * The Penpot box `buildText` needs (pure; see box.ts), shifted vertically so
 * that the target renderer's baselines land on the source's (baseline.ts)
 * when `placement` is given. Lets the caller place paints before building.
 */
export function penpotTextBox(
  source: ir.TextNode,
  lineBreaks: 'source' | 'reflow',
  placement?: TextPlacement,
): { box: LocalBox; sourceBreaks: boolean; baseline?: ShiftResult } {
  const node = shownText(source);
  const sourceBreaks = usesSourceBreaks(node, lineBreaks);
  const grown = textBox(node, { growWidth: sourceBreaks || node.autoResize === 'width-and-height' });
  const dx = placement ? autoWidthAlignShift(node, lineBreaks, placement) : 0;
  const box = dx === 0 ? grown : { ...grown, x: grown.x + dx };
  const baseline = placement ? baselineCompensation(node, lineBreaks, box, placement) : undefined;
  if (!baseline || baseline.shift === 0) return { box, sourceBreaks, ...(baseline ? { baseline } : {}) };
  return { box: { ...box, y: box.y + baseline.shift }, sourceBreaks, baseline };
}

/**
 * Horizontal box shift of a right-aligned or centred auto-width text. Figma
 * aligns its lines inside its own box (as wide as the widest line, rounded up:
 * "Brand" 48.05 px in a 49 px box starts at 0.95), while Penpot lays auto-width
 * lines out inside a width of its own, from the box's left edge **[live]**:
 * - SVG: the widest line (the lines align among themselves): the widest line
 *   starts at the box edge;
 * - WASM: `ceil(w) + 1` px, `w` its widest line (render-wasm
 *   `text_layout_auto_width`; the 1 px is the HTML renderer's `.paragraph-set`
 *   right margin): the widest line starts `ceil(w) + 1 − w` (right) or half
 *   that (centre) from the edge.
 * The box moves so that Penpot's widest line ends (right) or is centred
 * (centre) where Figma's is. Penpot's width is Figma's minus the advance
 * differences of the line's characters (advances.ts), plus the line's
 * correction (`line` spacing: the extra spacing of each of its characters;
 * `glyph`: exactly Figma's width). Corpus right edges were −0.5…−1 px (SVG)
 * and +1 px (WASM) off before.
 */
function autoWidthAlignShift(node: ir.TextNode, lineBreaks: 'source' | 'reflow', placement: TextPlacement): number {
  if (node.autoResize !== 'width-and-height' || (node.alignHorizontal !== 'right' && node.alignHorizontal !== 'center')) return 0;
  let widest: ir.TextLine | undefined;
  let index = -1;
  (node.layout?.lines ?? []).forEach((line, k) => {
    if (!Number.isFinite(line.width) || !Number.isFinite(line.baseline?.x)) index = -2;
    else if (index !== -2 && (!widest || line.width > widest.width)) {
      widest = line;
      index = k;
    }
  });
  if (index < 0 || !widest || !(widest.width > 0)) return 0;
  const renderer = placement.renderer;
  const share = node.alignHorizontal === 'right' ? 1 : 0.5;
  const mode = placement.textSpacing ?? 'none';
  let width: number;
  // render-wasm sizes the box without the last character's added spacing: right-aligned "Button 5" (100.06 px
  // with its `line` correction, 0.19 px of it after the "5") got a 101 px box, not 102 [live].
  let trailing = 0;
  if (mode === 'glyph') width = widest.width;
  else {
    const fix = mode === 'line' ? new TextBuilder(node, { reporter: SILENT, fills: () => [], lineBreaks, textSpacing: 'line', renderer, ...(placement.glyphCensus ? { glyphCensus: placement.glyphCensus } : {}) }).lineFix(index) : undefined;
    width = Math.max(0, widest.width + (fix ? fix.widthChange : -advanceDifference(node, widest.start, widest.end)));
    trailing = fix?.trailing ?? 0;
  }
  const start = widest.baseline.x + share * (widest.width - width);
  const penpot = renderer === 'wasm' ? share * (Math.ceil(width - trailing - 1e-6) + 1 - width) : 0;
  const shift = Math.round((start - penpot) * 1000) / 1000;
  return Math.abs(shift) < 0.001 ? 0 : shift;
}

/**
 * Σ (source advance − Penpot's advance) over the characters [start, end) whose
 * glyph is the character's own (within `SUBSTITUTED_GLYPH_EM`): how much wider
 * the source drew them than Penpot will, px.
 */
function advanceDifference(node: ir.TextNode, start: number, end: number): number {
  const text = typeof node.characters === 'string' ? node.characters : '';
  let sum = 0;
  for (const g of node.layout?.glyphAdvances ?? []) {
    if (g.offset < start || g.offset >= end || !Number.isFinite(g.advance)) continue;
    const run = node.runs.find((r) => r.start <= g.offset && g.offset < r.end);
    if (!run || !(run.style.fontSize > 0)) continue;
    const font = resolveFont(run.style.fontFamily ?? '', run.style.fontWeight, run.style.italic);
    const cp = displayedCodePoint(text, g.offset, run.style.textCase);
    const own = font.exact && cp !== undefined ? penpotAdvance(font.fontFamily, font.fontVariantId, cp) : undefined;
    if (own === undefined) continue;
    const delta = g.advance - own * run.style.fontSize;
    if (Math.abs(delta) <= SUBSTITUTED_GLYPH_EM * run.style.fontSize) sum += delta;
  }
  return sum;
}

const SILENT: ir.Reporter = { warn() {} };

const ELLIPSIS = '\u2026';
const shown = new WeakMap<ir.TextNode, ir.TextNode>();

/**
 * What the source shows of a truncated text (`layout.truncationStart`): the
 * characters before the cut, without trailing white space, then an ellipsis
 * in the style of the last shown character, as Figma draws it ("…fill " +
 * "container" → "…fill…"). The hidden tail is never emitted: the SVG
 * renderer would clip it mid-line and render-wasm, which does not clip,
 * would draw it below the box. Other texts are returned as they are.
 */
export function shownText(node: ir.TextNode): ir.TextNode {
  const cut = node.layout?.truncationStart;
  const text = typeof node.characters === 'string' ? node.characters : '';
  if (cut === undefined || !Number.isInteger(cut) || cut < 0 || cut >= text.length) return node;
  const cached = shown.get(node);
  if (cached) return cached;
  let end = snapToCodePoint(text, cut);
  while (end > 0 && /[\s\u2028\u2029]/.test(text[end - 1]!)) end--;
  const characters = text.slice(0, end) + ELLIPSIS;
  const runs = (Array.isArray(node.runs) ? node.runs : [])
    .filter((r) => r.start < end || (end === 0 && r.start === 0))
    .map((r) => ({ ...r, end: Math.min(r.end, end) }));
  const last = runs[runs.length - 1];
  if (last) last.end = characters.length;
  const lines = (node.layout?.lines ?? []).filter((l, i) => i === 0 || l.start < end).map((l) => ({ ...l, end: Math.min(l.end, end) }));
  const lastLine = lines[lines.length - 1];
  if (lastLine) lastLine.end = characters.length;
  const out: ir.TextNode = { ...node, characters, runs, layout: { ...node.layout, ...(lines.length > 0 ? { lines } : {}) } };
  delete out.layout!.truncationStart;
  shown.set(node, out);
  return out;
}

/**
 * The box shift that puts every rendered line's baseline closest to the
 * source's `layout.lines`, for the renderer of `placement`. Undefined when
 * the lines cannot be matched one to one (Penpot wraps the text itself, a
 * font without known metrics, SVG without a page position).
 */
function baselineCompensation(node: ir.TextNode, lineBreaks: 'source' | 'reflow', box: LocalBox, placement: TextPlacement): ShiftResult | undefined {
  const lines = node.layout?.lines;
  if (!lines || lines.length === 0) return undefined;
  if (placement.renderer === 'svg' && (placement.pageY === undefined || !Number.isFinite(placement.pageY))) return undefined;
  if (!lines.every((l) => Number.isFinite(l.baseline?.y))) return undefined;
  const builder = new TextBuilder(node, { reporter: SILENT, fills: () => [], lineBreaks });
  builder.content();
  const model = tryModelLines(builder.modelParagraphs());
  if (!model) return undefined;
  // render-wasm rounds x.5 px lines either way: no model, no compensation.
  if (placement.renderer === 'wasm' && wasmHalfPixelLines(model)) return undefined;
  const align = node.alignVertical === 'center' || node.alignVertical === 'bottom' ? node.alignVertical : 'top';
  const all = placement.renderer === 'svg' ? svgBaselines(model, box.height, align) : wasmBaselines(model, box.height, align);
  const predicted = all.filter((_, i) => !model[i]!.spacer);
  // One rendered line per source line (a truncated text may render more lines than the source shows).
  if (predicted.length < lines.length || (predicted.length > lines.length && node.autoResize !== 'truncate')) return undefined;
  const targets = lines.map((l) => l.baseline.y - box.y);
  return baselineShift(placement.renderer, predicted.slice(0, lines.length), targets, (placement.pageY ?? 0) + box.y);
}

// ---------------------------------------------------------------------------

type Leaf = Record<string, unknown> & { text: string };
type Paragraph = Record<string, unknown> & { type: 'paragraph'; children: Leaf[] };

/** Text-style attributes of a leaf, i.e. a leaf without its `text`. */
type LeafStyle = Record<string, unknown> & { lineHeight: string };

const TEXT_ALIGN: Record<ir.TextNode['alignHorizontal'], string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justified: 'justify',
};

const TEXT_TRANSFORM: Record<ir.TextStyle['textCase'], string> = {
  original: 'none',
  upper: 'uppercase',
  lower: 'lowercase',
  title: 'capitalize',
  'small-caps': 'none',
};

const TEXT_DECORATION: Record<ir.TextStyle['textDecoration'], string> = {
  none: 'none',
  underline: 'underline',
  strikethrough: 'line-through',
};

/** Penpot accepts line height / letter spacing in -200..200. */
const SPACING_LIMIT = 200;
/** Penpot's UI font-size range. */
const FONT_SIZE_MIN = 3;
const FONT_SIZE_MAX = 1000;
/**
 * Advance of U+2003 EM SPACE in Source Sans Pro (1792 / 2048 units, read from
 * the `sourcesanspro-regular.ttf` Penpot 2.19 serves; measured 21 px at 24 px).
 */
const SPACER_EM_SPACE_ADVANCE = 0.875;
/** Paragraph spacing / indent beyond this many px are clamped (an emulation has to fit in a sane number of characters). */
export const MAX_EMULATED_SPACING = 4000;
/**
 * Text of a line that has no characters. Penpot's SVG renderer gives an empty
 * leaf no line box at all (a blank line or spacer collapses to 0 px), so empty
 * lines carry one zero-width space; render-wasm is unaffected by it.
 */
const EMPTY_LINE_TEXT = '\u200b';
/** Penpot draws a leaf without fills black (SVG) or not at all (WASM); Figma draws nothing. */
function transparentFills(): PenpotFill[] {
  return [{ fillColor: '#000000', fillOpacity: 0 }];
}

const FALLBACK_STYLE: ir.TextStyle = {
  fontFamily: 'Source Sans Pro',
  fontStyle: 'Regular',
  fontWeight: 400,
  italic: false,
  fontSize: 14,
  lineHeight: { unit: 'auto', value: 0 },
  letterSpacing: { unit: 'px', value: 0 },
  textCase: 'original',
  textDecoration: 'none',
  fills: [],
};

/** Plain decimal string (no exponent, no trailing zeros, no "-0"). */
export function num(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return '0';
  const s = value.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const warned = new WeakMap<ir.Reporter, Set<string>>();

/** Reports `warning` unless one with the same `key` already went to this reporter. */
function warnOnce(reporter: ir.Reporter, key: string, warning: ir.Warning): void {
  let seen = warned.get(reporter);
  if (!seen) warned.set(reporter, (seen = new Set()));
  if (seen.has(key)) return;
  seen.add(key);
  reporter.warn(warning);
}

interface RunInfo {
  start: number;
  end: number;
  style: ir.TextStyle;
}

class TextBuilder {
  private readonly text: string;
  private readonly runs: RunInfo[];
  private readonly leafStyles = new Map<RunInfo, LeafStyle>();
  private readonly ratios = new Map<RunInfo, number>();
  private readonly nodeWarned = new Set<string>();
  private readonly spacers = new WeakSet<Paragraph>();
  private built: Paragraph[] = [];
  private readonly node: ir.TextNode;
  private readonly deps: TextDeps;
  private plan: LineBreakPlan | undefined;
  private planned = false;
  private listItems: Map<number, ListItem> | undefined;

  constructor(node: ir.TextNode, deps: TextDeps) {
    this.node = node;
    this.deps = deps;
    this.text = typeof node.characters === 'string' ? node.characters : '';
    const length = this.text.length;
    // Run boundaries never split a surrogate pair (a half pair makes render-wasm's export fail).
    const cut = (i: number): number => snapToCodePoint(this.text, clamp(i, 0, length));
    this.runs = (Array.isArray(node.runs) ? node.runs : [])
      .filter((r) => r && r.style && Number.isFinite(r.start) && Number.isFinite(r.end))
      .map((r) => ({ start: cut(Math.floor(r.start)), end: cut(Math.ceil(r.end)), style: r.style }))
      .filter((r) => r.end > r.start || length === 0)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (this.runs.length === 0) {
      this.warnNode('text-without-runs', 'Text has no style runs; using Penpot default text style.');
      this.runs.push({ start: 0, end: length, style: { ...FALLBACK_STYLE, fills: node.fills ?? [] } });
    }
  }

  content(): unknown {
    const paragraphs: Paragraph[] = [];
    const ranges = this.paragraphRanges();
    const spacing = this.clampedEmulation(this.node.paragraphSpacing, 'spacing');
    const indent = this.clampedEmulation(this.node.paragraphIndent, 'indent');
    if (!this.planned) this.plan = this.linePlan();
    this.planned = true;
    const lists = listEmulation(this.node);
    if (lists && 'problem' in lists) {
      this.warnNode('text-list-unsupported', `Penpot text has no lists and this one cannot be emulated (${lists.problem}); bullets / numbers and indentation are dropped.`);
    } else if (lists) {
      this.listItems = lists.items;
      this.warnNode('text-list-emulated', 'Penpot text has no lists; each bullet is a "•" character between invisible spacers.');
    }
    if (spacing > 0 && ranges.length > 1) {
      this.warnNode(
        'text-paragraph-spacing-emulated',
        `Paragraph spacing (${num(spacing, 2)}px) has no Penpot equivalent; emulated with spacer lines between paragraphs.`,
      );
    }
    if (indent > 0 && ranges.some(([s, e]) => e > s)) {
      this.warnNode(
        'text-paragraph-indent-emulated',
        `Paragraph indent (${num(indent, 2)}px) has no Penpot equivalent; emulated with a leading spacer.`,
      );
    }
    ranges.forEach(([start, end], i) => {
      if (i > 0 && spacing > 0) {
        const spacer = this.spacerParagraph(spacing);
        this.spacers.add(spacer);
        paragraphs.push(spacer);
      }
      paragraphs.push(this.paragraph(start, end, indent));
    });
    this.built = paragraphs;
    return {
      type: 'root',
      verticalAlign: this.node.alignVertical === 'center' || this.node.alignVertical === 'bottom' ? this.node.alignVertical : 'top',
      children: [{ type: 'paragraph-set', children: paragraphs }],
    };
  }

  /** The built paragraphs reduced to what decides line positions (after `content()`). */
  modelParagraphs(): ModelParagraph[] {
    return this.built.map((p) => ({
      lineHeight: Number(p.lineHeight),
      spacer: this.spacers.has(p),
      leaves: p.children.map((leaf) => ({ text: leaf.text, fontFamily: String(leaf.fontFamily), fontSize: Number(leaf.fontSize), lineHeight: Number(leaf.lineHeight) })),
    }));
  }

  private clampedEmulation(value: number | undefined, what: 'spacing' | 'indent'): number {
    const v = finitePositive(value);
    if (v <= MAX_EMULATED_SPACING) return v;
    this.warnNode(
      `text-paragraph-${what}-clamped`,
      `Paragraph ${what} of ${num(v, 2)}px is beyond what can be emulated; clamped to ${MAX_EMULATED_SPACING}px.`,
    );
    return MAX_EMULATED_SPACING;
  }

  /** The source line breaks to reproduce, or undefined to let Penpot wrap (reflow). */
  private linePlan(): LineBreakPlan | undefined {
    const problem = sourceBreaksBlocker(this.node, this.deps.lineBreaks ?? 'source');
    if (problem === undefined) return planLineBreaks(this.node.layout!.lines!, this.text, this.node.alignHorizontal);
    if (problem !== NOT_REQUESTED) {
      this.warnNode('text-line-breaks-inconsistent', `The source's line layout does not match the text (${problem}); Penpot wraps the text itself.`);
    }
    return undefined;
  }

  /** `text[a, b)` as leaf text: soft breaks inserted, dropped spaces removed, U+2028 → '\n'. */
  private leafText(a: number, b: number): string {
    const plan = this.plan;
    if (!plan) return this.text.slice(a, b).replace(/\u2028/g, '\n');
    let out = '';
    for (let i = a; i < b; i++) {
      if (!plan.dropped.has(i)) {
        const ch = this.text[i]!;
        out += ch === '\u2028' ? '\n' : ch;
      }
      if (plan.breaks.has(i + 1)) out += '\n';
    }
    return out;
  }

  // --- structure -----------------------------------------------------------

  private paragraphRanges(): [number, number][] {
    const ranges: [number, number][] = [];
    let start = 0;
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) {
        ranges.push([start, i]);
        start = i + 1;
      }
    }
    ranges.push([start, this.text.length]);
    return ranges;
  }

  /** The run styling offset `i`: the one containing it, else the closest preceding one, else the first. */
  private runAt(i: number): RunInfo {
    let candidate: RunInfo | undefined;
    for (const run of this.runs) {
      if (run.start <= i && i < run.end) return run;
      if (run.start <= i) candidate = run;
    }
    return candidate ?? this.runs[0]!;
  }

  private paragraph(start: number, end: number, indent: number): Paragraph {
    const leaves: Leaf[] = [];
    if (end > start) {
      const cuts = new Set<number>([start, end]);
      for (const run of this.runs) {
        if (run.start > start && run.start < end) cuts.add(run.start);
        if (run.end > start && run.end < end) cuts.add(run.end);
      }
      const points = [...cuts].sort((a, b) => a - b);
      for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k]!;
        const b = points[k + 1]!;
        const run = this.runAt(a);
        this.noteRunFeatures(run);
        const base = this.leafStyle(run);
        for (const seg of this.advanceSegments(run, base, a, b)) {
          // U+2028 (Figma's soft line break) is a line break inside the paragraph.
          const text = this.leafText(seg.start, seg.end);
          if (text === '') continue;
          const style = seg.extra === 0 ? base : { ...base, letterSpacing: num(clamp(Number(base.letterSpacing) + seg.extra, -SPACING_LIMIT, SPACING_LIMIT), 3) };
          const last = leaves[leaves.length - 1];
          if (last && sameStyle(last, style)) last.text += text;
          else leaves.push({ ...style, text });
        }
      }
    }
    if (leaves.length === 0) {
      // Empty line: Figma styles it with its own '\n' (or, at the very end, the previous one).
      const run = this.runAt(start < this.text.length ? start : Math.max(0, this.text.length - 1));
      leaves.push({ ...this.leafStyle(run), text: EMPTY_LINE_TEXT });
    }

    const first = leaves[0]!;
    const { text: _text, ...firstStyle } = first;
    let lineHeight = Number(first.lineHeight);
    for (const leaf of leaves) lineHeight = Math.min(lineHeight, Number(leaf.lineHeight));

    // An empty item has an entry only when the source drew its marker (`listEmulation`).
    const item = this.listItems?.get(start);
    const children = item
      ? [...this.listLeaves(item, first, num(lineHeight)), ...leaves]
      : indent > 0 && end > start
        ? [...this.indentLeaves(indent, num(lineHeight), Number(first.fontSize)), ...leaves]
        : leaves;
    return {
      type: 'paragraph',
      textAlign: TEXT_ALIGN[this.node.alignHorizontal] ?? 'left',
      ...firstStyle,
      lineHeight: num(lineHeight),
      children,
    };
  }

  /**
   * `[a, b)` of one run, split into segments of one extra letter spacing each
   * by the advance correction (`TextDeps.textSpacing`): `line`, at most one
   * segment per source line (`lineSegments`); `glyph`, wherever the source's
   * glyph advances (`layout.glyphAdvances`) differ from Penpot's copy of the
   * font (advances.ts). Each segment carries the extra letter spacing that
   * keeps its glyphs where the source drew them. A leaf boundary is a new
   * shaping run for the browser, so two guards keep what shaping does: a pair
   * the source kerned is never split (the kerning would be lost), and a glyph
   * covering several characters (Inter's "->" arrow) stays in a leaf without
   * extra spacing (letter spacing disables contextual alternates). One segment
   * without correction when either side's advances are unknown.
   */
  private advanceSegments(run: RunInfo, style: LeafStyle, a: number, b: number): { start: number; end: number; extra: number }[] {
    const whole = [{ start: a, end: b, extra: 0 }];
    const mode = this.deps.textSpacing ?? 'none';
    if (mode === 'line') return this.lineSegments(a, b);
    if (mode !== 'glyph') return whole;
    const glyphs = this.glyphAnalysis(run, style, a, b);
    if (!glyphs) return whole;
    const { source, inCluster, delta, next, previous, spacing } = glyphs;
    // The source kerned the pair ending at `i` when its glyph does not start where the previous one's advance ends.
    const kerned = (i: number): boolean => {
      const g = source.get(i);
      const prev = source.get(previous(i));
      if (!g || !prev || Math.abs(g.y - prev.y) > 0.01) return false;
      return Math.abs(g.x - (prev.x + prev.advance + spacing)) > 0.05;
    };
    // Never inside a grapheme cluster: before a combining mark, a ZWJ, a variation selector (J8).
    const boundary = (i: number): boolean => this.graphemeBoundaries().has(i);
    const canCut = (i: number): boolean => boundary(i) && !kerned(i);
    const out: { start: number; end: number; extra: number }[] = [];
    let i = a;
    while (i < b) {
      const cluster = inCluster(i);
      let j = i;
      while (j < b && inCluster(j) === cluster) j = next(j);
      while (j < b && !boundary(j)) j = next(j);
      if (cluster) out.push({ start: i, end: j, extra: 0 });
      else out.push(...segments(i, j, delta, canCut));
      i = j;
    }
    const rounded = out.map((seg) => ({ ...seg, extra: Math.abs(seg.extra) < 0.0005 ? 0 : seg.extra }));
    if (!rounded.some((seg) => seg.extra !== 0)) return whole;
    warnOnce(this.deps.reporter, 'pixel-exact-text-spacing', {
      code: 'pixel-exact-text-spacing',
      message:
        'pixelExact: text runs were split into leaves whose letter spacing corrects the glyph advances of Penpot\'s copy of the font; typing inside such a leaf inherits its spacing.',
    });
    return rounded;
  }

  /**
   * The source glyphs of the run piece `[a, b)` compared with Penpot's copy of
   * its font, or undefined when either side's advances are unknown.
   * `delta(i)`: source advance − Penpot's advance of the character as drawn
   * (after the text case transform, J2), px; 0 inside a cluster. `inCluster`:
   * the character is (next to) a glyph Penpot must shape as the source did.
   */
  private glyphAnalysis(run: RunInfo, style: LeafStyle, a: number, b: number) {
    const source = this.sourceGlyphs();
    const family = String(style.fontFamily);
    const variant = String(style.fontVariantId);
    if (!source || !this.font(run.style).exact || !hasAdvances(family, variant)) return undefined;
    const size = Number(style.fontSize);
    const spacing = Number(style.letterSpacing) || 0;
    const text = this.text;
    const next = (i: number): number => i + ((text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);
    const previous = (i: number): number => (i >= 2 && snapToCodePoint(text, i - 1) !== i - 1 ? i - 2 : i - 1);
    const isBreak = (i: number): boolean => i >= text.length || text[i] === '\n' || text[i] === '\u2028';
    // Characters drawn by a glyph of an earlier character (ligatures, contextual alternates).
    const covered = (i: number): boolean => !source.has(i) && !isBreak(i);
    // Penpot's advance of the character as drawn: after the text case transform (J2).
    const own = (i: number): number | undefined => {
      const cp = displayedCodePoint(text, i, run.style.textCase);
      return cp === undefined ? undefined : penpotAdvance(family, variant, cp);
    };
    // A glyph whose advance is not Penpot's for the character is another glyph (a contextual alternate: Inter's
    // "5x5" draws ×; small caps): Chromium drops contextual alternates in a letter-spaced span, so it gets no
    // correction and shares an unspaced leaf with its neighbours, its context (J7).
    // Not when every occurrence of the character in the document has that same other advance: then it is the
    // source's version of the font that differs (Figma's Inter 3 quotes are 0.381 em, Penpot's Inter 4 ones 0.440),
    // whatever the context, and only the spacing can be corrected.
    const substituted = (i: number): boolean => {
      const g = source.get(i);
      const advance = own(i);
      if (g === undefined || advance === undefined || Math.abs(g.advance / size - advance) <= SUBSTITUTED_GLYPH_EM) return false;
      const cp = displayedCodePoint(text, i, run.style.textCase);
      return !(cp !== undefined && this.deps.glyphCensus?.versionGlyph(family, cp));
    };
    const inCluster = (i: number): boolean =>
      covered(i) ||
      (source.has(i) && i + 1 <= text.length && covered(next(i))) ||
      substituted(i) ||
      (i > a && substituted(previous(i))) ||
      (next(i) < b && substituted(next(i)));
    const delta = (i: number): number => {
      const g = source.get(i);
      if (!g || inCluster(i)) return 0;
      const advance = own(i);
      return advance === undefined ? 0 : g.advance - advance * size;
    };
    // A glyph Penpot draws only when the leaf has no letter spacing (Chromium; `line` spacing guard).
    const alternate = (i: number): boolean => (covered(i) && !/\s/u.test(text[i]!)) || substituted(i);
    return { source, inCluster, delta, next, previous, spacing, size, alternate };
  }

  private fixes: (LineFix | undefined)[] | undefined;

  /**
   * The `line` correction of source line `k` (undefined: none). For every
   * source line, the characters Penpot draws on it (dropped spaces and
   * trailing white space left out) get one extra letter spacing, chosen by
   * `balancedSpacing` so that the line's first and last ink glyphs land where
   * the source drew them, without its other glyphs drifting more than
   * `INNER_SLACK` times as far. Consecutive lines share one value when one
   * keeps each of them within `MIN_LINE_ERROR` (or its own best +
   * `GROUP_SLACK`) at its ends and inside, so a paragraph's lines stay one
   * leaf; 0 when that suits them all.
   * A line whose glyphs drift more than `REFINE_DRIFT` inside it (wider and
   * narrower glyphs that cancel at its ends) is split into at most
   * `MAX_LINE_SEGMENTS` leaves (`segments`), never inside a kerned pair or a
   * cluster. Otherwise leaves are only split where a run or a line already
   * ends. A run piece takes no extra spacing when its font's advances are
   * unknown, or (SVG renderer) when its source spacing is 0 and the line draws
   * a glyph of several characters or a contextual alternate in it: Chromium
   * draws neither in a letter-spaced span (render-wasm keeps them, J7). Its
   * advance differences still count. Justified text is never corrected.
   */
  lineFix(k: number): LineFix | undefined {
    if (!this.planned) {
      this.plan = this.linePlan();
      this.planned = true;
    }
    this.fixes ??= this.lineFixes();
    return this.fixes[k];
  }

  private lineFixes(): (LineFix | undefined)[] {
    const node = this.node;
    const lines = node.layout?.lines;
    const text = this.text;
    if (!lines || !this.sourceGlyphs() || node.alignHorizontal === 'justified') return [];
    if (linesInconsistency(lines, text, node.autoResize === 'truncate') !== undefined) return [];
    const renderer = this.deps.renderer ?? 'svg';
    const align: 'left' | 'center' | 'right' = node.alignHorizontal === 'center' || node.alignHorizontal === 'right' ? node.alignHorizontal : 'left';
    const boundaries = this.graphemeBoundaries();
    const source = this.sourceGlyphs()!;
    const pieces = new Map<string, Piece>();
    const data = lines.map((line): LineData | undefined => {
      const drawn: { i: number; piece: Piece }[] = [];
      for (let i = line.start; i < line.end; i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1) {
        const ch = text[i]!;
        if (ch === '\n' || ch === '\u2028' || this.plan?.dropped.has(i)) continue;
        const [a, b] = this.pieceAt(i);
        const key = `${a}:${b}`;
        let piece = pieces.get(key);
        if (!piece) {
          const run = this.runAt(a);
          const glyphs = this.glyphAnalysis(run, this.leafStyle(run), a, b);
          pieces.set(key, (piece = { key, glyphs }));
        }
        drawn.push({ i, piece });
      }
      while (drawn.length > 0 && /\s/u.test(text[drawn[drawn.length - 1]!.i]!)) drawn.pop();
      // The SVG guard is per line: the same piece may be corrected on its other lines.
      const skip = new Set<string>();
      for (const { i, piece } of drawn) {
        if (!piece.glyphs) skip.add(piece.key);
        else if (renderer === 'svg' && piece.glyphs.spacing === 0 && piece.glyphs.alternate(i)) skip.add(piece.key);
      }
      const glyphs: LineGlyph[] = drawn.map(({ i, piece }) => {
        const delta = piece.glyphs?.delta(i) ?? 0;
        const glyph: LineGlyph = { delta, weight: !skip.has(piece.key) && boundaries.has(i) && source.has(i) ? 1 : 0 };
        // Another design (only the source's font version gets past `substituted`): its ink stays at its origin.
        if (piece.glyphs && Math.abs(delta) > SUBSTITUTED_GLYPH_EM * piece.glyphs.size) glyph.ink = 0;
        return glyph;
      });
      const ink = drawn.flatMap(({ i }, k) => (source.has(i) && !/\s/u.test(text[i]!) ? [k] : []));
      if (ink.length === 0 || !glyphs.some((g) => g.weight === 1)) return undefined;
      const best = balancedSpacing(glyphs, ink, align, renderer, INNER_SLACK);
      return { line, drawn, glyphs, ink, skip, best };
    });
    const fixes: (LineFix | undefined)[] = lines.map(() => undefined);
    const fix = (d: LineData, extras: number[], segs: { start: number; end: number; extra: number }[]): LineFix => {
      let spacing = 0;
      let total = 0;
      d.glyphs.forEach((g, k) => {
        spacing += g.weight * (extras[k] ?? 0);
        total += g.delta;
      });
      const last = d.glyphs.length - 1;
      return { segments: segs, widthChange: spacing - total, trailing: d.glyphs[last]!.weight * (extras[last] ?? 0), skip: d.skip };
    };
    const uniform = (d: LineData, value: number): LineFix =>
      fix(
        d,
        d.glyphs.map((g) => g.weight * value),
        [{ start: d.line.start, end: d.line.end, extra: value }],
      );
    const error = (d: LineData, e: number): number => lineError(d.glyphs, d.ink[0]!, d.ink[d.ink.length - 1]!, align, renderer, e);
    // Lines split where they drift inside; the others are grouped.
    let group: { k: number; d: LineData }[] = [];
    let lo = -Infinity;
    let hi = Infinity;
    const flush = (): void => {
      if (group.length === 0) return;
      const worst = (e: number): number => Math.max(...group.map(({ d }) => error(d, e)));
      let value = 0;
      if (!(lo <= 0 && 0 <= hi)) {
        // The worst error is convex in e: ternary search inside the common interval.
        let a = lo;
        let b = hi;
        for (let n = 0; n < 60; n++) {
          const m1 = a + (b - a) / 3;
          const m2 = b - (b - a) / 3;
          if (worst(m1) <= worst(m2)) b = m2;
          else a = m1;
        }
        value = roundSpacing((a + b) / 2, worst, [lo, hi]);
      }
      if (value !== 0) for (const { k, d } of group) fixes[k] = uniform(d, value);
      group = [];
      lo = -Infinity;
      hi = Infinity;
    };
    data.forEach((d, k) => {
      if (!d) return flush();
      const refined = this.refinedLine(d, align, renderer);
      if (refined) {
        flush();
        fixes[k] = fix(d, refined.extras, refined.segments);
        return;
      }
      // Ends within MIN_LINE_ERROR or their best + GROUP_SLACK, and no glyph drifting further than with the line's own best.
      const ends = lineInterval(d.glyphs, [d.ink[0]!, d.ink[d.ink.length - 1]!], align, renderer, Math.max(MIN_LINE_ERROR, d.best.error + GROUP_SLACK));
      const inside = glyphErrors(d.glyphs, d.glyphs.map((g) => g.weight * d.best.extra), align, renderer);
      const drift = Math.max(...d.ink.map((k) => Math.abs(inside[k]!)));
      const all = lineInterval(d.glyphs, d.ink, align, renderer, Math.max(MIN_LINE_ERROR, drift + GROUP_SLACK));
      const interval: [number, number] = ends && all && Math.max(ends[0], all[0]) <= Math.min(ends[1], all[1]) ? [Math.max(ends[0], all[0]), Math.min(ends[1], all[1])] : [d.best.extra, d.best.extra];
      const maxSize = Math.max(...d.drawn.map(({ piece }) => finitePositive(piece.glyphs?.size)));
      const bound = MAX_LINE_SPACING_EM * maxSize;
      let [l, h] = [Math.max(interval[0], -bound), Math.min(interval[1], bound)];
      if (l > h) l = h = clamp(d.best.extra, -bound, bound);
      if (group.length > 0 && (group[group.length - 1]!.k !== k - 1 || Math.max(lo, l) > Math.min(hi, h))) flush();
      group.push({ k, d });
      lo = Math.max(lo, l);
      hi = Math.min(hi, h);
    });
    flush();
    return fixes;
  }

  /**
   * A line whose glyphs drift more than `REFINE_DRIFT` inside it with its best
   * single spacing, split into at most `MAX_LINE_SEGMENTS` segments of one
   * spacing each (`segments`, with the smallest tolerance that needs no more),
   * when that brings its worst glyph `REFINE_GAIN` closer. Only a line drawn
   * by one corrected run piece; never cut inside a grapheme cluster, a pair
   * the source kerned or a cluster / contextual alternate's context.
   */
  private refinedLine(d: LineData, align: 'left' | 'center' | 'right', renderer: TextRenderer): { segments: { start: number; end: number; extra: number }[]; extras: number[] } | undefined {
    const piece = d.drawn[0]!.piece;
    const glyphs = piece.glyphs;
    if (!glyphs || d.skip.size > 0 || d.drawn.some((x) => x.piece !== piece)) return undefined;
    const inkWorst = (errors: number[]): number => Math.max(...d.ink.map((k) => Math.abs(errors[k]!)));
    const single = inkWorst(glyphErrors(d.glyphs, d.glyphs.map((g) => g.weight * d.best.extra), align, renderer));
    if (single <= REFINE_DRIFT) return undefined;
    const start = d.line.start;
    // Up to the last ink glyph: its own advance difference moves nothing after it, and must not pull the last
    // segment's spacing (it takes that spacing).
    const end = d.drawn[d.ink[d.ink.length - 1]!]!.i;
    if (end <= start) return undefined;
    const boundaries = this.graphemeBoundaries();
    const kerned = (i: number): boolean => {
      const g = glyphs.source.get(i);
      const prev = glyphs.source.get(glyphs.previous(i));
      if (!g || !prev || Math.abs(g.y - prev.y) > 0.01) return false;
      return Math.abs(g.x - (prev.x + prev.advance + glyphs.spacing)) > 0.05;
    };
    const canCut = (i: number): boolean => boundaries.has(i) && !kerned(i) && !glyphs.inCluster(i) && !glyphs.inCluster(glyphs.previous(i));
    const index = new Map(d.drawn.map(({ i }, k) => [i, k]));
    // The smallest tolerance (bisection, 0.01 px) whose greedy split needs at most MAX_LINE_SEGMENTS segments.
    const split = (tolerance: number) => segments(start, end, (i) => (index.has(i) ? glyphs.delta(i) : 0), canCut, tolerance);
    let lo = REFINE_MIN_TOLERANCE;
    let hi = single;
    let segs = split(hi);
    if (segs.length > MAX_LINE_SEGMENTS) return undefined;
    if (split(lo).length <= MAX_LINE_SEGMENTS) segs = split((hi = lo));
    while (hi - lo > 0.01) {
      const mid = (lo + hi) / 2;
      const s = split(mid);
      if (s.length <= MAX_LINE_SEGMENTS) {
        hi = mid;
        segs = s;
      } else lo = mid;
    }
    if (segs.length < 2) return undefined;
    const rounded = segs.map((seg) => ({ ...seg, extra: Math.round(seg.extra * 1000) / 1000 }));
    const extras = d.drawn.map(({ i }, k) => d.glyphs[k]!.weight * (rounded.find((seg) => seg.start <= i && i < seg.end)?.extra ?? 0));
    if (inkWorst(glyphErrors(d.glyphs, extras, align, renderer)) > single - REFINE_GAIN) return undefined;
    rounded[rounded.length - 1]!.end = d.line.end;
    return { segments: rounded, extras };
  }

  /** The paragraph() leaf boundaries around offset `i`: the paragraph's bounds and the run starts / ends inside it. */
  private pieceAt(i: number): [number, number] {
    const text = this.text;
    const start = text.lastIndexOf('\n', i - 1) + 1;
    let end = text.indexOf('\n', i);
    if (end === -1) end = text.length;
    let a = start;
    let b = end;
    for (const run of this.runs) {
      for (const cut of [run.start, run.end]) {
        if (cut > start && cut < end) {
          if (cut <= i && cut > a) a = cut;
          if (cut > i && cut < b) b = cut;
        }
      }
    }
    return [a, b];
  }

  /** `[a, b)` of one run piece split at the source lines, each with its `line` correction (warned once per document). */
  private lineSegments(a: number, b: number): { start: number; end: number; extra: number }[] {
    const lines = this.node.layout?.lines ?? [];
    const out: { start: number; end: number; extra: number }[] = [];
    const key = this.pieceAt(a).join(':');
    lines.forEach((line, k) => {
      if (Math.min(b, line.end) <= Math.max(a, line.start)) return;
      const fix = this.lineFix(k);
      const parts = fix && !fix.skip.has(key) ? fix.segments : [{ start: line.start, end: line.end, extra: 0 }];
      for (const part of parts) {
        const start = Math.max(a, part.start);
        const end = Math.min(b, part.end);
        if (end <= start) continue;
        const last = out[out.length - 1];
        if (last && last.extra === part.extra && last.end === start) last.end = end;
        else out.push({ start, end, extra: part.extra });
      }
    });
    // Characters outside every line (a truncated tail; never with consistent lines) keep the run's spacing.
    if (out.length === 0 || out[0]!.start > a || out[out.length - 1]!.end < b) return [{ start: a, end: b, extra: 0 }];
    if (out.some((seg) => seg.extra !== 0)) {
      warnOnce(this.deps.reporter, 'text-spacing-corrected', {
        code: 'text-spacing-corrected',
        message:
          "Penpot's copy of the font has other glyph advances than the source's: each line's letter spacing was adjusted so that it starts and ends where the source drew it (typing in a line keeps its spacing).",
      });
    }
    return out;
  }

  private boundaries: Set<number> | undefined;

  /** UTF-16 offsets where a grapheme cluster starts (and the text's end). */
  private graphemeBoundaries(): Set<number> {
    if (!this.boundaries) {
      this.boundaries = new Set([this.text.length]);
      for (const { index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this.text)) this.boundaries.add(index);
    }
    return this.boundaries;
  }

  private glyphs: Map<number, { x: number; y: number; advance: number }> | null | undefined;

  private sourceGlyphs(): Map<number, { x: number; y: number; advance: number }> | undefined {
    if (this.glyphs === undefined) {
      const list = this.node.layout?.glyphAdvances;
      this.glyphs =
        list && list.length > 0 ? new Map(list.filter((g) => [g.advance, g.x, g.y].every(Number.isFinite)).map((g) => [g.offset, g])) : null;
    }
    return this.glyphs ?? undefined;
  }

  /** An empty, invisible line exactly `height` px tall. */
  private spacerParagraph(height: number): Paragraph {
    const fontSize = clamp(height, FONT_SIZE_MIN, FONT_SIZE_MAX);
    const style = spacerStyle(num(fontSize, 3), num(clamp(height / fontSize, 0, SPACING_LIMIT)), '0');
    return {
      type: 'paragraph',
      textAlign: TEXT_ALIGN[this.node.alignHorizontal] ?? 'left',
      ...style,
      children: [{ ...style, text: EMPTY_LINE_TEXT }],
    };
  }

  /**
   * Invisible Source Sans Pro em spaces, letter spacing 0, adding up to
   * `indent`. Letter spacing cannot carry the indent: render-wasm shifts a
   * letter-spaced leaf by half its spacing. The spacer's font size stays at or
   * below the following text's, with the paragraph's line height, so its line
   * box fits inside that text's and the line keeps its height.
   */
  private indentLeaves(indent: number, lineHeight: string, nextFontSize: number): Leaf[] {
    const maxSize = Number.isFinite(nextFontSize) && nextFontSize > 0 ? nextFontSize : FALLBACK_STYLE.fontSize;
    const count = Math.max(1, Math.ceil(indent / (SPACER_EM_SPACE_ADVANCE * maxSize)));
    const fontSize = Math.max(1, indent / (count * SPACER_EM_SPACE_ADVANCE));
    return [{ ...spacerStyle(num(fontSize, 3), lineHeight, '0'), text: '\u2003'.repeat(count) }];
  }

  /** A list item's marker: spacers up to the bullet, the bullet in the item's style (no letter spacing), spacers up to the text. */
  private listLeaves(item: ListItem, first: Leaf, lineHeight: string): Leaf[] {
    const { text: _text, ...style } = first;
    const size = Number(first.fontSize);
    const out: Leaf[] = [];
    if (item.markerX > 0.01) out.push(...this.indentLeaves(item.markerX, lineHeight, size));
    out.push({ ...style, letterSpacing: '0', text: BULLET });
    const gap = item.textX - item.markerX - item.bulletAdvance;
    if (gap > 0.01) out.push(...this.indentLeaves(gap, lineHeight, size));
    return out;
  }

  // --- styles --------------------------------------------------------------

  private leafStyle(run: RunInfo): LeafStyle {
    const cached = this.leafStyles.get(run);
    if (cached) return cached;
    const style = run.style;
    const fontSize = finitePositive(style.fontSize) || FALLBACK_STYLE.fontSize;
    const font = this.font(style);
    const leaf: LeafStyle = {
      fontId: font.fontId,
      fontFamily: font.fontFamily,
      fontVariantId: font.fontVariantId,
      fontSize: num(fontSize, 3),
      fontWeight: font.fontWeight,
      fontStyle: font.fontStyle,
      lineHeight: ratioString(this.lineHeightRatio(run, fontSize), fontSize),
      letterSpacing: num(clamp(letterSpacingPx(style.letterSpacing, fontSize), -SPACING_LIMIT, SPACING_LIMIT), 3),
      textTransform: TEXT_TRANSFORM[style.textCase] ?? 'none',
      textDecoration: TEXT_DECORATION[style.textDecoration] ?? 'none',
      fills: this.fills(style.fills),
    };
    const typography = style.styleId === undefined ? undefined : this.deps.typographyRef?.(style.styleId);
    if (typography) {
      leaf.typographyRefId = typography.id;
      leaf.typographyRefFile = typography.file;
    }
    this.leafStyles.set(run, leaf);
    return leaf;
  }

  private fills(paints: ir.Paint[] | undefined): PenpotFill[] {
    const visible = (paints ?? []).filter((p) => p && p.visible !== false);
    if (visible.length === 0) return transparentFills();
    try {
      const out = this.deps.fills(visible);
      return Array.isArray(out) && out.length > 0 ? out : transparentFills();
    } catch (error) {
      this.warnNode('text-fill-failed', `Could not convert text fills: ${String(error)}`);
      return transparentFills();
    }
  }

  private font(style: ir.TextStyle): ResolvedFont {
    const family = typeof style.fontFamily === 'string' ? style.fontFamily : '';
    const italic = style.italic === true;
    const font = resolveFont(family, style.fontWeight, italic);
    if (font.backend === 'unavailable') {
      warnOnce(this.deps.reporter, `font-unavailable|${family}|${style.fontStyle}`, {
        code: 'font-unavailable',
        message: `Font "${family} ${style.fontStyle}" is neither built into Penpot nor in its Google Fonts catalogue; upload it to the Penpot team (family "${font.fontFamily}") for it to render.`,
        nodeId: this.node.id,
        nodeName: this.node.name,
      });
    } else if (!font.exact) {
      warnOnce(this.deps.reporter, `font-variant-unavailable|${font.fontId}|${font.variant.weight}|${italic}|${style.fontWeight}`, {
        code: 'font-variant-unavailable',
        message: `Font "${family}" has no weight ${style.fontWeight}${italic ? ' italic' : ''} in Penpot; using ${font.fontWeight}${font.fontStyle === 'italic' ? ' italic' : ''}.`,
        nodeId: this.node.id,
        nodeName: this.node.name,
      });
    }
    return font;
  }

  private lineHeightRatio(run: RunInfo, fontSize: number): number {
    const cached = this.ratios.get(run);
    if (cached !== undefined) return cached;
    let ratio: number | undefined;
    const lh = run.style.lineHeight ?? FALLBACK_STYLE.lineHeight;
    if (lh.unit === 'px' || lh.unit === 'percent') ratio = explicitRatio(lh, fontSize, this.linePitches(run));
    if (ratio === undefined) {
      const sizes = this.runs.map((r) => ({ start: r.start, end: r.end, fontSize: finitePositive(r.style.fontSize) || FALLBACK_STYLE.fontSize }));
      ratio = deriveAutoRatio({ start: run.start, end: run.end, fontSize }, this.node.layout?.lines, this.text.length, sizes);
    }
    if (ratio === undefined) {
      const fallback = defaultAutoLineHeight(run.style.fontFamily ?? '');
      ratio = fallback.ratio;
      warnOnce(this.deps.reporter, `text-line-height-estimated|${run.style.fontFamily}`, {
        code: 'text-line-height-estimated',
        message: `Automatic line height of "${run.style.fontFamily}" is unknown without the source's line layout; assuming ${num(ratio)}× the font size${fallback.known ? '' : ' (Penpot default)'}.`,
        nodeId: this.node.id,
        nodeName: this.node.name,
      });
    }
    this.ratios.set(run, ratio);
    return ratio;
  }

  /** Baseline-to-baseline distances of consecutive source lines that only this run's characters fill. */
  private linePitches(run: RunInfo): number[] {
    const lines = this.node.layout?.lines ?? [];
    const out: number[] = [];
    for (let k = 1; k < lines.length; k++) {
      const p = lines[k - 1]!;
      const q = lines[k]!;
      if (p.end <= p.start || q.end <= q.start || p.start < run.start || q.end > run.end) continue;
      // A paragraph break adds paragraph spacing.
      if (this.text[p.end - 1] === '\n' && finitePositive(this.node.paragraphSpacing) > 0) continue;
      const pitch = q.baseline.y - p.baseline.y;
      if (Number.isFinite(pitch) && pitch > 0) out.push(pitch);
    }
    return out;
  }

  private noteRunFeatures(run: RunInfo): void {
    if (run.style.hyperlink) {
      this.warnNode('text-hyperlink-unsupported', 'Penpot text has no hyperlinks; link dropped.');
    }
    if (run.style.textCase === 'small-caps') {
      this.warnNode('text-small-caps-unsupported', 'Penpot has no small caps; rendered with original case.');
    }
  }

  warnNode(code: string, message: string): void {
    if (this.nodeWarned.has(code)) return;
    this.nodeWarned.add(code);
    this.deps.reporter.warn({ code, message, nodeId: this.node.id, nodeName: this.node.name });
  }
}

/**
 * Penpot grow type. A truncated text (the `truncate` flag, or a line limit on
 * an auto-height / fixed box: `layout.truncationStart` either way) is written
 * as its shown text and an ellipsis in a `fixed` box: an auto-height box would
 * be regrown by Penpot to whatever the edited text needs, which the source's
 * line limit never does.
 */
function growType(node: ir.TextNode, builder: TextBuilder, truncated: boolean): GrowType {
  if (truncated) {
    builder.warnNode(
      'text-truncation-emulated',
      `Penpot cannot truncate text with an ellipsis${node.autoResize === 'truncate' ? '' : ' (line limit)'}; the shown text and an ellipsis were written in a fixed box instead (editing does not re-truncate).`,
    );
    return 'fixed';
  }
  switch (node.autoResize) {
    case 'width-and-height':
      return 'auto-width';
    case 'height':
      return 'auto-height';
    case 'truncate':
      builder.warnNode('text-truncation-unsupported', 'Penpot cannot truncate text with an ellipsis; overflowing text stays visible.');
      return 'fixed';
    default:
      return 'fixed';
  }
}

function finitePositive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A line height multiplier as emitted: 4 decimals, rounded up instead of to
 * the nearest when that would make `fontSize × ratio` smaller than intended.
 * Chromium floors the product to 1/64 px, so 9 px × 1.4444 (for 13 px) gives a
 * 12.984 px line, and the error adds up line after line; rounded up the line
 * is exact up to 156 px font size.
 */
export function ratioString(ratio: number, fontSize: number): string {
  const r = clamp(ratio, 0, SPACING_LIMIT);
  const nearest = num(r);
  if (!(fontSize > 0) || Number(nearest) * fontSize >= r * fontSize - 1e-9) return nearest;
  return num(Math.min(SPACING_LIMIT, Math.ceil(r * 1e4 - 1e-6) / 1e4));
}

function letterSpacingPx(spacing: ir.LetterSpacing | undefined, fontSize: number): number {
  if (!spacing || !Number.isFinite(spacing.value)) return 0;
  return spacing.unit === 'percent' ? (spacing.value / 100) * fontSize : spacing.value;
}

function spacerStyle(fontSize: string, lineHeight: string, letterSpacing: string): LeafStyle {
  return {
    fontId: 'sourcesanspro',
    fontFamily: 'sourcesanspro',
    fontVariantId: 'regular',
    fontSize,
    fontWeight: '400',
    fontStyle: 'normal',
    lineHeight,
    letterSpacing,
    textTransform: 'none',
    textDecoration: 'none',
    fills: transparentFills(),
  };
}

function sameStyle(leaf: Leaf, style: LeafStyle): boolean {
  const { text: _text, ...rest } = leaf;
  return JSON.stringify(rest) === JSON.stringify(style);
}

type GlyphAnalysis = NonNullable<ReturnType<TextBuilder['glyphAnalysis']>>;

/** A run piece of a paragraph (`TextBuilder.pieceAt`) and its glyphs compared with Penpot's font (undefined: not correctable). */
interface Piece {
  key: string;
  glyphs: GlyphAnalysis | undefined;
}

/** What `TextBuilder.lineFixes` knows about a source line. */
interface LineData {
  line: ir.TextLine;
  /** The characters Penpot draws on the line (no dropped or trailing spaces), with their run piece. */
  drawn: { i: number; piece: Piece }[];
  glyphs: LineGlyph[];
  /** Indexes into `drawn` of the glyphs with ink. */
  ink: number[];
  /** Run pieces (`a:b`) of the line that take no extra spacing. */
  skip: Set<string>;
  best: { extra: number; error: number; before: number };
}

/** A line's `line` correction (`TextBuilder.lineFix`). */
interface LineFix {
  /** The line's segments (offsets) and the letter spacing each adds to its corrected leaves, px. */
  segments: { start: number; end: number; extra: number }[];
  /** How much wider Penpot draws the line than the source (px): its correction minus its advance differences. */
  widthChange: number;
  /** The extra spacing of the line's last drawn character, px. */
  trailing: number;
  /** Run pieces (`a:b`) of the line that take no extra spacing. */
  skip: Set<string>;
}

/**
 * Lines whose first and last ink glyphs are off by less than this without
 * correction get none (px): sub-pixel differences the anti-aliasing hides,
 * and every correction is a fractional spacing that typing inherits.
 */
export const MIN_LINE_ERROR = 0.25;
/**
 * A line's spacing minimises the worst error of its first and last ink glyphs
 * and of its other glyphs divided by this (`balancedSpacing`): the ends
 * matter most (alignment), but a glyph inside drifting twice as far as the
 * ends' optimum costs more than it saves. Measured on auto-layout-playground
 * (SVG, strict rule): ends only 202 boards, 1.5 → 214, all glyphs alike 214
 * with 3× more lines whose ends are off by > 0.5 px.
 */
const INNER_SLACK = 1.5;
/** A line may share its neighbours' spacing when that leaves its ends within its own best + this, px. */
const GROUP_SLACK = 0.1;
/** A line's extra spacing stays within this share of its largest font size (Inter's largest same-glyph difference is 0.037 em). */
const MAX_LINE_SPACING_EM = 0.05;
/** Extra error the 0.01 px rounding of a line's spacing may add before 0.001 px is used instead, px. */
const ROUNDING_ALLOWANCE = 0.05;
/** A line whose glyphs drift more than this inside it with one spacing is split (`refinedLine`), px. */
export const REFINE_DRIFT = 1;
/** At most this many leaves per line and run piece. */
export const MAX_LINE_SEGMENTS = 3;
/** The split uses the smallest tolerance (px; `segments`) that needs at most `MAX_LINE_SEGMENTS` segments, but no smaller than this. */
const REFINE_MIN_TOLERANCE = 0.25;
/** A split must bring the line's worst glyph at least this much closer, px. */
const REFINE_GAIN = 0.25;

/**
 * `value` rounded to 0.01 px when that costs at most `ROUNDING_ALLOWANCE` px
 * more `error` and stays inside `range`, else to 0.001 px; 0 below 0.0005.
 */
function roundSpacing(value: number, error: (e: number) => number, range: [number, number] = [-Infinity, Infinity]): number {
  const exact = error(value);
  const inside = (e: number): boolean => e >= range[0] - 1e-9 && e <= range[1] + 1e-9;
  const coarse = [Math.floor(value * 100) / 100, Math.ceil(value * 100) / 100].filter(inside).sort((x, y) => error(x) - error(y))[0];
  const chosen = coarse !== undefined && error(coarse) <= exact + ROUNDING_ALLOWANCE ? coarse : Math.round(value * 1000) / 1000;
  return Math.abs(chosen) < 0.0005 ? 0 : chosen;
}
