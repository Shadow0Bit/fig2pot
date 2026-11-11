/**
 * Advance correction: Penpot's copy of a font can have other glyph advances
 * than the source's. Figma's Inter and the Inter Penpot serves (Google Fonts,
 * static instances) differ for some glyphs: "t" is 0.3636 em (Regular) /
 * 0.3800 (Semi Bold) / 0.3885 (Bold) in Figma and 0.3271 / 0.3530 / 0.3662 em in
 * Penpot's (the space and most letters agree within 0.006 em). So a line drifts by up to 2.6 px per
 * "t" at 72 px ("settings" ended 4.5 px early) in both renderers.
 *
 * Where the source records its advances (`layout.glyphAdvances`) and Penpot's
 * advances for the font are known (`advances-data.ts`), each character gets
 * the difference as extra letter spacing. Consecutive characters share one
 * leaf (one letter spacing) as long as every glyph in it stays within
 * `TOLERANCE` px of where the per-character correction would put it.
 */
import type * as ir from '../../ir.ts';
import { ADVANCES_DATA } from './advances-data.ts';
import { familyKey, resolveFont } from './fonts.ts';

/**
 * A source glyph whose advance differs from Penpot's for the character by more than this (em) is another glyph
 * than the character's own. Inter's "t" (Figma 0.3636 em, Penpot 0.3271), the largest difference of the same
 * glyph, stays below it.
 */
export const SUBSTITUTED_GLYPH_EM = 0.04;

/**
 * The code point the source draws at `i` under the run's text case (`upper`, `lower`, `title`: first letter of
 * each word), or undefined when the transform maps it to several characters (ß → SS) or it is not a code point
 * start. Small caps draw other glyphs: the advance check rejects them.
 */
export function displayedCodePoint(text: string, i: number, textCase: ir.TextStyle['textCase']): number | undefined {
  const cp = text.codePointAt(i);
  if (cp === undefined || (cp >= 0xdc00 && cp <= 0xdfff)) return undefined;
  const ch = String.fromCodePoint(cp);
  let mapped = ch;
  if (textCase === 'upper') mapped = ch.toUpperCase();
  else if (textCase === 'lower') mapped = ch.toLowerCase();
  else if (textCase === 'title') {
    const before = text.slice(Math.max(0, i - 2), i);
    const prev = before.length === 2 && /[\ud800-\udbff]/.test(before[0]!) ? before : before.slice(-1);
    if (!/[\p{L}\p{N}\p{M}'\u2019]/u.test(prev)) mapped = ch.toUpperCase();
  }
  const points = [...mapped];
  return points.length === 1 ? points[0]!.codePointAt(0) : undefined;
}

/** Largest position error a shared letter spacing may introduce inside one leaf, px. */
export const TOLERANCE = 0.15;

const decoded = new Map<string, Map<number, number> | null>();
const FAMILIES = new Map(Object.entries(ADVANCES_DATA).map(([family, data]) => [familyKey(family), data]));

function table(fontFamily: string, variantId: string): Map<number, number> | undefined {
  const key = `${familyKey(fontFamily)}|${variantId}`;
  let hit = decoded.get(key);
  if (hit === undefined) {
    const data = FAMILIES.get(familyKey(fontFamily));
    const spec = data?.variants[variantId];
    if (!data || spec === undefined) hit = null;
    else {
      hit = new Map();
      for (const part of spec.split(';')) {
        const [start, list] = part.split(':');
        let cp = parseInt(start!, 36);
        for (const v of list!.split(',')) hit.set(cp++, parseInt(v, 36) / data.unitsPerEm);
      }
    }
    decoded.set(key, hit);
  }
  return hit ?? undefined;
}

/** Penpot's advance of `codePoint` in em, for a Google family / Penpot variant id; undefined when unknown. */
export function penpotAdvance(fontFamily: string, variantId: string, codePoint: number): number | undefined {
  return table(fontFamily, variantId)?.get(codePoint);
}

/** Whether Penpot's advances of this font are known. */
export function hasAdvances(fontFamily: string, variantId: string): boolean {
  return table(fontFamily, variantId) !== undefined;
}

export interface Segment {
  start: number;
  end: number;
  /** Letter spacing to add to the leaf, px. */
  extra: number;
}

/**
 * Splits `[start, end)` into segments of one extra letter spacing each, from
 * the per-character corrections `delta(i)` (px, 0 where unknown): greedy, a
 * segment grows while every glyph start inside it stays within `tolerance` of
 * the exact per-character position. `canCut(i)` false lets a segment grow
 * over `i` even when that breaks the tolerance.
 *
 * Glyph k of a segment starting at s sits at P(k) = Σ delta[s, k) exactly and
 * at (k − s)·mean with the shared spacing, so the test is that every point
 * (k, P(k)) lies within ±tolerance of the line from (s, 0) to the segment's
 * end. Its extremes over the points are on their upper / lower convex hulls,
 * which grow in amortised O(1) per character and are searched in O(log n):
 * O(n log n) per text instead of O(n²) (10 000 equal deltas took 8 s).
 */
export function segments(
  start: number,
  end: number,
  delta: (i: number) => number,
  canCut: (i: number) => boolean = () => true,
  tolerance = TOLERANCE,
): Segment[] {
  const out: Segment[] = [];
  let s = start;
  let pending: number | undefined;
  while (s < end) {
    const upper = new Hull(1);
    const lower = new Hull(-1);
    upper.push(s, 0);
    lower.push(s, 0);
    let sum = pending ?? delta(s);
    pending = undefined;
    let e = s + 1;
    while (e < end) {
      const d = delta(e);
      const next = sum + d;
      const mean = next / (e + 1 - s);
      // The glyph at e starts after [s, e).
      upper.push(e, sum);
      lower.push(e, sum);
      const ok = upper.extreme(mean, s) <= tolerance && -lower.extreme(mean, s) <= tolerance;
      if (!ok && canCut(e)) {
        pending = d;
        break;
      }
      sum = next;
      e++;
    }
    out.push({ start: s, end: e, extra: sum / (e - s) });
    s = e;
  }
  return out;
}

/**
 * Upper (`sign` 1) or lower (`sign` −1) convex hull of points added in
 * increasing x; `extreme(m, s)` is the max (upper) / min (lower) of
 * y − (x − s)·m over the points.
 */
class Hull {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly sign: 1 | -1;

  constructor(sign: 1 | -1) {
    this.sign = sign;
  }

  push(x: number, y: number): void {
    const { xs, ys } = this;
    while (xs.length >= 2) {
      const n = xs.length;
      const cross = (xs[n - 1]! - xs[n - 2]!) * (y - ys[n - 2]!) - (ys[n - 1]! - ys[n - 2]!) * (x - xs[n - 2]!);
      if (this.sign * cross >= 0) {
        xs.pop();
        ys.pop();
      } else break;
    }
    xs.push(x);
    ys.push(y);
  }

  extreme(m: number, s: number): number {
    const { xs, ys } = this;
    const value = (i: number): number => ys[i]! - (xs[i]! - s) * m;
    // Unimodal along the hull: the extreme is where the edge slopes cross m.
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sign * (value(mid + 1) - value(mid)) > 0) lo = mid + 1;
      else hi = mid;
    }
    return value(lo);
  }
}

/**
 * One glyph of a line for the per-line correction (`lineSpacing`): its advance
 * difference (source − Penpot, px; 0 where unknown) and whether it takes the
 * line's letter spacing (`weight` 1).
 */
export interface LineGlyph {
  delta: number;
  weight: 0 | 1;
  /**
   * The share of `delta` by which the glyph's ink moves from its origin
   * (default 0.5: the advance centre). 0 for another design of the glyph
   * (a "1" or a quote of Figma's Inter 3), whose ink stays at the origin.
   */
  ink?: number;
}

export type LineAlign = 'left' | 'center' | 'right';

/**
 * The one extra letter spacing (px) for a line that puts its first and last
 * ink glyphs (`first`, `last`: indexes into `glyphs`, the characters Penpot
 * draws on the line in order) closest to where the source drew them: the
 * smallest worst error of the two **[live]**. A glyph's position is the
 * centre of its advance: with its origin exact, a last glyph whose advance
 * differs by δ ended its ink ≈ δ/2 off (30 corpus lines, both renderers:
 * Inter 3's wider "t" ends 1.1 px further at 72 px, "5" 0.5 px at 24 px),
 * except another design of the glyph (`LineGlyph.ink`: the "1" of
 * "Button 1" ended where its origin put it).
 *
 * Penpot without correction puts glyph k at the source's position minus the
 * advance differences before it (left), plus those after it (right: lines end
 * at the same edge), or half of both (centre). A letter spacing `e` moves
 * glyph k by `e` × (glyphs before k that take it), and the line's anchor by
 * −`e` × (all of them) (right) or half that (centre): both renderers count the
 * spacing of a line's last character in its width. render-wasm also moves a
 * left-aligned glyph by half its own spacing **[live]** ("HHHH" at 10 px
 * spacing: SVG left +0 / right edge −10, WASM left +5).
 */
export function lineSpacing(glyphs: readonly LineGlyph[], first: number, last: number, align: LineAlign, renderer: 'svg' | 'wasm'): { extra: number; error: number; before: number } {
  const [a, b] = endErrors(glyphs, first, last, align, renderer) as [EndError, EndError];
  const worst = (e: number): number => Math.max(Math.abs(a.base + a.slope * e), Math.abs(b.base + b.slope * e));
  const before = worst(0);
  const candidates = [0];
  const push = (num: number, den: number): void => {
    if (Math.abs(den) > 1e-9) candidates.push(num / den);
  };
  push(-a.base, a.slope);
  push(-b.base, b.slope);
  push(b.base - a.base, a.slope - b.slope);
  push(-(a.base + b.base), a.slope + b.slope);
  let extra = 0;
  let error = before;
  for (const e of candidates) {
    const err = worst(e);
    if (err < error - 1e-9 || (Math.abs(err - error) <= 1e-9 && Math.abs(e) < Math.abs(extra))) {
      extra = e;
      error = err;
    }
  }
  return { extra, error, before };
}

/**
 * `lineSpacing` over every ink glyph of the line (`ink`: indexes into
 * `glyphs`, in order): the spacing that minimises the worst of the first and
 * last glyphs' errors and the other glyphs' errors divided by `innerSlack`
 * (convex in `e`: ternary search). `error` is the ends' error, `before` the
 * ends' error without correction.
 */
export function balancedSpacing(glyphs: readonly LineGlyph[], ink: readonly number[], align: LineAlign, renderer: 'svg' | 'wasm', innerSlack: number): { extra: number; error: number; before: number } {
  const first = ink[0]!;
  const last = ink[ink.length - 1]!;
  const ends = lineSpacing(glyphs, first, last, align, renderer);
  const lines = glyphLines(glyphs, ink, align, renderer);
  const cost = (e: number): number => Math.max(...lines.map(({ base, slope }, n) => Math.abs(base + slope * e) / (n === 0 || n === lines.length - 1 ? 1 : innerSlack)));
  // The optimum lies where some glyph's error is ±(its bound); |e| beyond the largest drift / 1 gap never helps.
  const reach = Math.max(1, ...lines.map((l) => Math.abs(l.base))) * 2;
  let a = -reach;
  let b = reach;
  for (let n = 0; n < 100 && b - a > 1e-7; n++) {
    const m1 = a + (b - a) / 3;
    const m2 = b - (b - a) / 3;
    if (cost(m1) <= cost(m2)) b = m2;
    else a = m1;
  }
  let extra = (a + b) / 2;
  if (cost(ends.extra) <= cost(extra) + 1e-9) extra = ends.extra;
  if (cost(0) <= cost(extra) + 1e-9) extra = 0;
  return { extra, error: lineError(glyphs, first, last, align, renderer, extra), before: ends.before };
}

/** The worse of the first and last ink glyphs' errors (px) with extra spacing `e` (`lineSpacing`'s model). */
export function lineError(glyphs: readonly LineGlyph[], first: number, last: number, align: LineAlign, renderer: 'svg' | 'wasm', e: number): number {
  const [a, b] = endErrors(glyphs, first, last, align, renderer) as [EndError, EndError];
  return Math.max(Math.abs(a.base + a.slope * e), Math.abs(b.base + b.slope * e));
}

/**
 * The extra spacings `e` for which the errors of the glyphs at `indices` all
 * stay within `limit`: an interval (the worst error is convex in `e`), or
 * undefined when there is none.
 */
export function lineInterval(glyphs: readonly LineGlyph[], indices: readonly number[], align: LineAlign, renderer: 'svg' | 'wasm', limit: number): [number, number] | undefined {
  let lo = -Infinity;
  let hi = Infinity;
  for (const { base, slope } of glyphLines(glyphs, indices, align, renderer)) {
    // |base + slope e| <= limit
    if (Math.abs(slope) < 1e-9) {
      if (Math.abs(base) > limit) return undefined;
      continue;
    }
    const a = (-limit - base) / slope;
    const b = (limit - base) / slope;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  return lo <= hi + 1e-12 ? [lo, Math.max(lo, hi)] : undefined;
}

/**
 * The error (Penpot − source, px) of every glyph of a line whose glyphs take
 * `extras[k]` px of extra spacing each (the `lineSpacing` model, one value per
 * glyph).
 */
export function glyphErrors(glyphs: readonly LineGlyph[], extras: readonly number[], align: LineAlign, renderer: 'svg' | 'wasm'): number[] {
  const alpha = align === 'left' ? 0 : align === 'right' ? -1 : -0.5;
  const beta = renderer === 'wasm' && align === 'left' ? 0.5 : 0;
  let total = 0;
  let spacing = 0;
  glyphs.forEach((g, k) => {
    total += g.delta;
    spacing += extras[k] ?? 0;
  });
  let p = 0;
  let w = 0;
  return glyphs.map((g, k) => {
    const x = extras[k] ?? 0;
    const error = -p - (g.ink ?? 0.5) * g.delta - alpha * total + w + alpha * spacing + beta * x;
    p += g.delta;
    w += x;
    return error;
  });
}

type EndError = { base: number; slope: number };

/** Error of glyphs `first` and `last` (Penpot − source, px) as `base + slope × e`. */
function endErrors(glyphs: readonly LineGlyph[], first: number, last: number, align: LineAlign, renderer: 'svg' | 'wasm'): EndError[] {
  return glyphLines(glyphs, [first, last], align, renderer);
}

/** Error of the glyphs at `indices` (Penpot − source, px) as `base + slope × e`. */
function glyphLines(glyphs: readonly LineGlyph[], indices: readonly number[], align: LineAlign, renderer: 'svg' | 'wasm'): EndError[] {
  const alpha = align === 'left' ? 0 : align === 'right' ? -1 : -0.5;
  const beta = renderer === 'wasm' && align === 'left' ? 0.5 : 0;
  let total = 0;
  let count = 0;
  for (const g of glyphs) {
    total += g.delta;
    count += g.weight;
  }
  return indices.map((k) => {
    let p = 0;
    let w = 0;
    for (let i = 0; i < k; i++) {
      p += glyphs[i]!.delta;
      w += glyphs[i]!.weight;
    }
    // At the glyph's advance centre: its ink moves with about half its own advance difference.
    return { base: -p - (glyphs[k]!.ink ?? 0.5) * glyphs[k]!.delta - alpha * total, slope: w + alpha * count + beta * glyphs[k]!.weight };
  });
}

/**
 * Every glyph of a document compared with Penpot's advance for its character
 * (fonts with an advance table only): tells a contextual alternate (Inter's ×
 * for the "x" of "5x5", while every other "x" is normal) from a glyph the
 * source's version of the font draws differently everywhere (Figma's Inter 3
 * curly quotes).
 */
const VERSION_MIN = 2;

/**
 * Every glyph of a document compared with Penpot's advance for its character
 * (fonts with an advance table only), per family and character over all its
 * weights: tells a contextual alternate (Inter's × for the "x" of "5x5",
 * while every other "x" is normal) from a glyph the source's version of the
 * font draws differently everywhere (Figma's Inter 3 curly quotes, in every
 * weight).
 */
export class GlyphCensus {
  private readonly stats = new Map<string, { normal: number; deviating: number }>();

  add(node: ir.TextNode): void {
    const text = typeof node.characters === 'string' ? node.characters : '';
    for (const g of node.layout?.glyphAdvances ?? []) {
      const run = node.runs.find((r) => r.start <= g.offset && g.offset < r.end);
      if (!run || !(run.style.fontSize > 0) || !Number.isFinite(g.advance)) continue;
      const font = resolveFont(run.style.fontFamily ?? '', run.style.fontWeight, run.style.italic);
      const cp = displayedCodePoint(text, g.offset, run.style.textCase);
      const advance = font.exact && cp !== undefined ? penpotAdvance(font.fontFamily, font.fontVariantId, cp) : undefined;
      if (advance === undefined) continue;
      const key = `${familyKey(font.fontFamily)}|${cp}`;
      let entry = this.stats.get(key);
      if (!entry) this.stats.set(key, (entry = { normal: 0, deviating: 0 }));
      if (Math.abs(g.advance / run.style.fontSize - advance) <= SUBSTITUTED_GLYPH_EM) entry.normal++;
      else entry.deviating++;
    }
  }

  /**
   * The source's font draws the character as another glyph everywhere: at least `VERSION_MIN` occurrences in
   * the family, none with Penpot's advance (a "5x5" alone in a document does not qualify).
   */
  versionGlyph(fontFamily: string, cp: number): boolean {
    const entry = this.stats.get(`${familyKey(fontFamily)}|${cp}`);
    return entry !== undefined && entry.normal === 0 && entry.deviating >= VERSION_MIN;
  }

  /** Some occurrence of the character has Penpot's advance: where it does not, a contextual alternate drew it. */
  drawnNormally(fontFamily: string, cp: number): boolean {
    return (this.stats.get(`${familyKey(fontFamily)}|${cp}`)?.normal ?? 0) > 0;
  }
}
