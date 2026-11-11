/**
 * Baseline placement: where each Penpot renderer puts every line's baseline,
 * and the vertical shift of the text box that brings those baselines closest
 * to the source's (`TextNode.layout.lines[k].baseline.y`).
 *
 * Both models were fitted on live Penpot 2.19 renders (README, "Vertical
 * placement"): 4 296 lines of "HHH" in Inter, Roboto, Poppins and Noto Serif,
 * 8–96 px, auto / px / fractional px / percent line heights, top / middle /
 * bottom alignment, box y at .0 / .25 / .5 / .75.
 *
 * **SVG renderer** (Chromium lays the content out as HTML in a foreignObject;
 * `p {font-size: 0; line-height: r}`, spans inherit `r`, so a span's line
 * height is `r × its own font size`). Exact for every measured line:
 * - per span: `L = floor64(size × r)` (LayoutUnit, 1/64 px); ascent and
 *   descent rounded to whole px, and when the descent rounds down one px moves
 *   from the ascent to the descent (Chromium's Linux "subpixel ascent/descent"
 *   hack); half leading `floor(trunc64((L − A − D) / 2))`;
 * - a line is `max(above)` + `max(below)` of its spans; lines stack;
 * - the root is a flex box of the shape's height (2 decimals) that aligns the
 *   lines top / centre / bottom;
 * - the baseline is then rounded to a whole px **in page space** (box y
 *   included; also at a 4× export).
 *
 * **render-wasm** (Skia paragraph): continuous half leading (`(L − a − d) / 2`)
 * with `L = size × max(paragraph r, span r)`, but every line height and the
 * first baseline offset within its line are rounded to whole px, relative to
 * the box (not snapped in page space). Exact for 85 % of the lines, the rest
 * within 0.3 px, except x.5 px line heights, which round either way: texts
 * with such a line are not compensated (`wasmHalfPixelLines`).
 */
import type { FontMetrics } from './metrics.ts';
import { penpotFontMetrics } from './metrics.ts';

export type TextRenderer = 'svg' | 'wasm';

/** What the writer will emit, reduced to what decides line positions. */
export interface ModelParagraph {
  /** The paragraph's line height multiplier (as emitted). */
  lineHeight: number;
  /** An emulation line with no source counterpart (paragraph spacing). */
  spacer: boolean;
  leaves: { text: string; fontFamily: string; fontSize: number; lineHeight: number }[];
}

interface Span {
  metrics: FontMetrics;
  size: number;
  leafRatio: number;
}

interface ModelLine {
  spans: Span[];
  ratio: number;
  spacer: boolean;
}

/** The rendered lines (one per paragraph and per `\n` inside it), or undefined when a font has no known metrics. */
export function modelLines(paragraphs: readonly ModelParagraph[]): ModelLine[] | undefined {
  const out: ModelLine[] = [];
  for (const p of paragraphs) {
    const lines: Span[][] = [[]];
    p.leaves.forEach((leaf, li) => {
      const metrics = penpotFontMetrics(leaf.fontFamily);
      const span = metrics && leaf.fontSize > 0 ? { metrics, size: leaf.fontSize, leafRatio: leaf.lineHeight } : undefined;
      const parts = leaf.text.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        const current = lines[lines.length - 1]!;
        // A leaf is on a line when it has characters there (its '\n' included), or when it ends the paragraph on an otherwise empty line.
        const onLine = part !== '' || i < parts.length - 1 || (li === p.leaves.length - 1 && current.length === 0);
        if (!onLine) return;
        if (!span) throw new UnknownFont();
        current.push(span);
      });
    });
    for (const spans of lines) out.push({ spans, ratio: p.lineHeight, spacer: p.spacer });
  }
  return out.every((l) => l.spans.length > 0) ? out : undefined;
}

class UnknownFont extends Error {}

/** `modelLines`, undefined instead of throwing for unknown fonts. */
export function tryModelLines(paragraphs: readonly ModelParagraph[]): ModelLine[] | undefined {
  try {
    return modelLines(paragraphs);
  } catch (error) {
    if (error instanceof UnknownFont) return undefined;
    throw error;
  }
}

/** Chromium's integer ascent / descent (`SimpleFontData` + the Linux descent hack). */
export function chromiumAscentDescent(m: FontMetrics, size: number): { ascent: number; descent: number } {
  const a = (m.ascender / m.unitsPerEm) * size;
  const d = (m.descender / m.unitsPerEm) * size;
  let ascent = Math.round(a);
  let descent = Math.round(d);
  if (descent < d && ascent >= 1) {
    descent++;
    ascent--;
  }
  return { ascent, descent };
}

/** Chromium's LayoutUnit (1/64 px) of a computed line height, as raw units. */
function layoutUnitsFloor(v: number): number {
  return Math.floor(v * 64 + 1e-7);
}

/**
 * SVG renderer: each rendered line's baseline relative to the box top, before
 * the renderer rounds it in page space.
 */
export function svgBaselines(lines: readonly ModelLine[], boxHeight: number, align: 'top' | 'center' | 'bottom'): number[] {
  const metrics = lines.map((line) => {
    let above = 0;
    let below = 0;
    for (const s of line.spans) {
      const L = layoutUnitsFloor(s.size * line.ratio);
      const { ascent, descent } = chromiumAscentDescent(s.metrics, s.size);
      const half = Math.floor(Math.trunc((L - 64 * (ascent + descent)) / 2) / 64);
      const a = half + ascent;
      above = Math.max(above, a);
      below = Math.max(below, L / 64 - a);
    }
    return { above, height: above + below };
  });
  const content = metrics.reduce((sum, m) => sum + m.height, 0);
  const h = Math.round(boxHeight * 100) / 100;
  const offset = align === 'center' ? (h - content) / 2 : align === 'bottom' ? h - content : 0;
  const out: number[] = [];
  let top = offset;
  for (const m of metrics) {
    out.push(top + m.above);
    top += m.height;
  }
  return out;
}

/** render-wasm: each rendered line's baseline relative to the box top (final; no page-space snapping). */
export function wasmBaselines(lines: readonly ModelLine[], boxHeight: number, align: 'top' | 'center' | 'bottom'): number[] {
  const metrics = lines.map((line) => {
    let above = 0;
    let below = 0;
    for (const s of line.spans) {
      const L = s.size * Math.max(line.ratio, s.leafRatio);
      const a = (s.metrics.ascender / s.metrics.unitsPerEm) * s.size;
      const d = (s.metrics.descender / s.metrics.unitsPerEm) * s.size;
      const up = (L - a - d) / 2 + a;
      above = Math.max(above, up);
      below = Math.max(below, L - up);
    }
    return { above: Math.round(above), height: Math.round(above + below) };
  });
  const content = metrics.reduce((sum, m) => sum + m.height, 0);
  const offset = align === 'center' ? (boxHeight - content) / 2 : align === 'bottom' ? boxHeight - content : 0;
  const out: number[] = [];
  let top = offset;
  for (const m of metrics) {
    out.push(top + m.above);
    top += m.height;
  }
  return out;
}

/**
 * render-wasm rounds an x.5 px line height either way, depending on the font
 * and size (a sweep of 4 families × 9 sizes at 150 %: 14 of 36 not
 * `Math.round`), so the model cannot place such lines, and compensating them
 * made multi-line text up to 2 px worse than leaving it. True when a rendered
 * line's height is within `HALF_PIXEL_MARGIN` of x.5 px.
 */
export function wasmHalfPixelLines(lines: readonly ModelLine[]): boolean {
  return lines.some((line) =>
    line.spans.some((s) => {
      const L = s.size * Math.max(line.ratio, s.leafRatio);
      return Math.abs(L - Math.floor(L) - 0.5) < HALF_PIXEL_MARGIN;
    }),
  );
}

export const HALF_PIXEL_MARGIN = 0.05;

/** Largest box shift considered, px. The box moves with its text, so this never clips anything. */
export const MAX_SHIFT = 2;

export interface ShiftResult {
  shift: number;
  /** |rendered − source| per matched line, after the shift. */
  errors: number[];
  /** The same before the shift. */
  errorsBefore: number[];
}

/**
 * The vertical box shift that brings the renderer's baselines (`predicted`,
 * relative to the box top, one per source line) closest to `targets` (same
 * frame): smallest worst-line error, then smallest total error, then smallest
 * shift. For the SVG renderer the result is the middle of the range of
 * shifts that round every line the same way, `pageY` being the box top in
 * page space.
 */
export function baselineShift(renderer: TextRenderer, predicted: readonly number[], targets: readonly number[], pageY: number): ShiftResult | undefined {
  const n = Math.min(predicted.length, targets.length);
  if (n === 0) return undefined;
  const errorsAt = (shift: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const drawn = renderer === 'svg' ? Math.round(pageY + shift + predicted[k]!) - pageY : shift + predicted[k]!;
      out.push(Math.abs(drawn - targets[k]!));
    }
    return out;
  };
  const errorsBefore = errorsAt(0);
  if (renderer === 'wasm') {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < n; k++) {
      const d = targets[k]! - predicted[k]!;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    const shift = clampShift((lo + hi) / 2);
    return { shift, errors: errorsAt(shift), errorsBefore };
  }
  // SVG: the rounding only changes where some line's position crosses a half pixel.
  const cuts = new Set<number>([-MAX_SHIFT, MAX_SHIFT]);
  for (let k = 0; k < n; k++) {
    const base = pageY + predicted[k]!;
    for (let m = Math.floor(base - MAX_SHIFT) - 1; m <= Math.ceil(base + MAX_SHIFT) + 1; m++) {
      const cut = m + 0.5 - base;
      if (cut > -MAX_SHIFT && cut < MAX_SHIFT) cuts.add(cut);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  let best: { shift: number; worst: number; total: number } | undefined;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (b - a < 1e-3) continue;
    // The interval containing 0 is evaluated at 0 itself (no shift unless another interval is better), unless a
    // line sits so close to a half pixel that the renderer's own rounding could go either way.
    const mid = a < 0 && b > 0 && Math.min(-a, b) > 0.02 ? 0 : (a + b) / 2;
    const errors = errorsAt(mid);
    const worst = Math.max(...errors);
    const total = errors.reduce((s, e) => s + e, 0);
    if (!best || worst < best.worst - 1e-9 || (worst < best.worst + 1e-9 && (total < best.total - 1e-9 || (total < best.total + 1e-9 && Math.abs(mid) < Math.abs(best.shift))))) {
      best = { shift: mid, worst, total };
    }
  }
  if (!best) return undefined;
  const shift = roundShift(best.shift);
  return { shift, errors: errorsAt(shift), errorsBefore };
}

function clampShift(v: number): number {
  return roundShift(Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, v)));
}

function roundShift(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
