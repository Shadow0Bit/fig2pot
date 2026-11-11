/**
 * Line height: IR `auto | px | percent` → Penpot's unitless multiplier of the
 * span's own font size.
 *
 * `auto` means "the font's intrinsic line height" (ascender + descender + line
 * gap, per font). We do not have font metrics, so we recover it from the
 * source's own line layout when present. Figma's `TextLine.lineHeight` is the
 * intrinsic line height of the largest font on the line (it is reported even
 * when the applied line height is px/percent: Inter 32 px gives 38.73 on a
 * 36 px line), so for a run R
 *
 *     ratio(R) = min over lines L that touch R of  round(L.lineHeight) / maxFontSize(L)
 *
 * where maxFontSize(L) is the largest font size of the runs on L. On a line
 * R drives this is R's own intrinsic ratio. On a line R shares with larger
 * text it is the larger font's ratio, which keeps R's line box inside the
 * larger one's: render-wasm lays every span out at
 * `fontSize × max(paragraphLineHeight, spanLineHeight)` with half leading and
 * aligns baselines, so a small span with `L.lineHeight / R.fontSize` would
 * stick out above and below and grow the line (measured: a 20 px run next to
 * a 40 px one gave a 36 px line pitch instead of Figma's 29; see README).
 *
 * Figma applies the intrinsic height rounded to whole px: its auto lines are
 * `round(lineHeight)` apart and the first baseline sits half of
 * `round(lineHeight) − lineHeight` below the intrinsic ascent (Inter 32 px:
 * 38.73 → 39, baseline 31.136).
 */
import type * as ir from '../../ir.ts';
import { familyKey } from './fonts.ts';

/**
 * Intrinsic ("auto") line heights for a few very common families, as
 * (hhea ascender + |descender| + lineGap) / unitsPerEm of the fonts as Figma
 * ships them. Used only when the source gave no line layout.
 */
const AUTO_LINE_HEIGHTS: Record<string, number> = {
  [familyKey('Inter')]: 1.21,
  [familyKey('Roboto')]: 1.171875,
  [familyKey('Open Sans')]: 1.361816,
  [familyKey('Lato')]: 1.2,
  [familyKey('Montserrat')]: 1.219,
  [familyKey('Poppins')]: 1.5,
  [familyKey('Source Sans Pro')]: 1.257,
  [familyKey('Noto Sans')]: 1.362,
};

/** Penpot's own default line height (`app.common.types.text/default-text-attrs`). */
export const DEFAULT_AUTO_LINE_HEIGHT = 1.2;

export function defaultAutoLineHeight(family: string): { ratio: number; known: boolean } {
  const known = AUTO_LINE_HEIGHTS[familyKey(family)];
  return known === undefined ? { ratio: DEFAULT_AUTO_LINE_HEIGHT, known: false } : { ratio: known, known: true };
}

function overlaps(line: ir.TextLine, start: number, end: number, length: number): boolean {
  if (line.end > line.start) return line.start < end && start < line.end;
  // Zero-length line (empty paragraph): belongs to the run holding that offset,
  // or to the last run when it sits at the very end of the text.
  return (start <= line.start && line.start < end) || (line.start >= length && end >= length);
}

/**
 * Derives the intrinsic multiplier of an `auto` run from the source's line
 * layout. Undefined when no usable line touches the run.
 */
export function deriveAutoRatio(
  run: { start: number; end: number; fontSize: number },
  lines: readonly ir.TextLine[] | undefined,
  textLength: number,
  runs: readonly { start: number; end: number; fontSize: number }[] = [],
): number | undefined {
  if (!lines || !(run.fontSize > 0)) return undefined;
  let best: number | undefined;
  for (const line of lines) {
    if (!(line.lineHeight > 0) || !Number.isFinite(line.lineHeight)) continue;
    if (!overlaps(line, run.start, run.end, textLength)) continue;
    let size = run.fontSize;
    if (line.end > line.start) {
      for (const other of runs) {
        if (other.fontSize > size && other.start < line.end && line.start < other.end) size = other.fontSize;
      }
    }
    // Figma lays an auto line out at its intrinsic height rounded to whole px (every multi-line auto text of the corpus).
    const ratio = (line.lineHeight >= 1 ? Math.round(line.lineHeight) : line.lineHeight) / size;
    if (best === undefined || ratio < best) best = ratio;
  }
  return best;
}

/**
 * Multiplier for an explicit (px / percent) line height, as the source lays it
 * out. Figma lays a percent line height out at whole px: `round(size × pct)`
 * (every percent pair of consecutive corpus lines, 1 062 / 1 062, all with a
 * fractional exact value, e.g. 140 % × 16 = 22.4 → lines 22.00 apart; every
 * one of 3 750 first baselines sits at the half leading of the rounded
 * height). The exact ratio drifted by up to 0.4 px per line (5 px on a
 * 19-line text). A px value is used as given (the corpus has no fractional
 * one), unless the source's own line pitches (`pitches`, lines this run fills
 * alone) show it rounded.
 */
export function explicitRatio(lineHeight: ir.LineHeight, fontSize: number, pitches: readonly number[] = []): number | undefined {
  if (!Number.isFinite(lineHeight.value)) return undefined;
  if (lineHeight.unit === 'percent') {
    const px = (fontSize * lineHeight.value) / 100;
    return fontSize > 0 && px >= 1 ? Math.round(px) / fontSize : lineHeight.value / 100;
  }
  if (lineHeight.unit === 'px' && fontSize > 0) {
    const px = lineHeight.value;
    const rounded = Math.round(px);
    const shownRounded = pitches.length > 0 && pitches.every((p) => Math.abs(p - rounded) < 0.02) && Math.abs(px - rounded) >= 0.02;
    return (shownRounded ? rounded : px) / fontSize;
  }
  return undefined;
}
