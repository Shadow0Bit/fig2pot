/**
 * Source line breaking (`textLineBreaks: 'source'`).
 *
 * Penpot lays text out again with its own engine (Chromium for the SVG
 * renderer, Skia for render-wasm). Their line widths differ from Figma's by
 * up to ~0.7 % per line, which is enough to move a wrap on any line that
 * nearly fills its box. In `source` mode every wrap Figma made inside a
 * paragraph becomes an explicit soft break, so Penpot never has to wrap.
 *
 * The plan is expressed in UTF-16 offsets of `characters`:
 * - `breaks`: a soft break goes right before the character at that offset;
 * - `dropped`: characters (U+0020 only) that are not emitted. These are the
 *   spaces Figma left at the end of a wrapped line, and — for centred or
 *   right-aligned text — the spaces before any line end. Figma aligns a line
 *   without its trailing spaces; render-wasm does too, but Chromium counts a
 *   space before a forced break, which would shift the line.
 */
import type * as ir from '../../ir.ts';

export interface LineBreakPlan {
  breaks: Set<number>;
  dropped: Set<number>;
}

const LF = 0x0a;
const LSEP = 0x2028;
const SPACE = 0x20;

function isLineEnd(code: number | undefined): boolean {
  return code === LF || code === LSEP;
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Moves `i` back by one when it would split a surrogate pair of `text`. */
export function snapToCodePoint(text: string, i: number): number {
  if (i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i))) return i - 1;
  return i;
}

/**
 * Why the source's lines cannot be trusted for `text`, or undefined when they
 * can: they must be contiguous from offset 0, in reading order, never contain
 * a line end before their last character, and cover the whole string (only a
 * prefix for truncated text).
 */
export function linesInconsistency(lines: readonly ir.TextLine[] | undefined, text: string, truncated: boolean): string | undefined {
  if (!lines || lines.length === 0) return 'no lines';
  let expected = 0;
  let previousY = -Infinity;
  for (const line of lines) {
    if (!line || !Number.isInteger(line.start) || !Number.isInteger(line.end)) return 'non-integer offsets';
    if (!Number.isFinite(line.baseline?.y)) return 'non-finite baseline';
    if (line.start !== expected) return `line starts at ${line.start}, expected ${expected}`;
    if (line.end < line.start || line.end > text.length) return `line ${line.start}..${line.end} is out of range`;
    for (let i = line.start; i < line.end - 1; i++) {
      if (isLineEnd(text.charCodeAt(i))) return `line ${line.start}..${line.end} contains a line break`;
    }
    if (line.baseline.y < previousY - 0.01) return 'lines are not in reading order';
    previousY = line.baseline.y;
    expected = line.end;
  }
  if (expected !== text.length && !truncated) return `lines cover ${expected} of ${text.length} characters`;
  return undefined;
}

/** The soft breaks and dropped spaces that reproduce `lines` exactly (lines must be consistent). */
export function planLineBreaks(lines: readonly ir.TextLine[], text: string, alignHorizontal: ir.TextNode['alignHorizontal']): LineBreakPlan {
  const breaks = new Set<number>();
  const dropped = new Set<number>();
  const dropSpacesBefore = (end: number, start: number): void => {
    for (let j = end - 1; j >= start && text.charCodeAt(j) === SPACE; j--) dropped.add(j);
  };
  const trimEveryLine = alignHorizontal === 'center' || alignHorizontal === 'right';
  lines.forEach((line, k) => {
    const next = lines[k + 1];
    const wraps = next !== undefined && next.start > 0 && next.start < text.length && !isLineEnd(text.charCodeAt(next.start - 1));
    if (wraps) {
      const at = snapToCodePoint(text, next.start);
      breaks.add(at);
      dropSpacesBefore(at, line.start);
    } else if (trimEveryLine) {
      const end = line.end > line.start && isLineEnd(text.charCodeAt(line.end - 1)) ? line.end - 1 : line.end;
      dropSpacesBefore(end, line.start);
    }
  });
  return { breaks, dropped };
}
