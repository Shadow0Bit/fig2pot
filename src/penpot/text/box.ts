/**
 * Text box policy: the Penpot box of a text, in the text's local space.
 *
 * Figma never clips text to its box; Penpot's SVG renderer clips a text shape
 * to its stored box on both axes, whatever its grow type (measured on Penpot
 * 2.19, see README.md). So the box becomes a superset of what Figma drew (the
 * glyph outlines of `layout`, else its line boxes) plus `MARGIN`, and it only grows
 * on the sides where growing moves nothing: Penpot places lines inside the
 * box by alignment, so a left-aligned text may only grow to the right, a
 * centred one equally on both sides, a top-aligned one downwards, and so on.
 * Auto-width text is the exception horizontally: both renderers lay its lines
 * out at their own widest line, pinned to the box's left edge (alignment only
 * applies among the lines), so it only ever grows to the right.
 *
 * Width only grows when that cannot change line breaking: for auto-width text
 * (Penpot does not wrap it), or when every source line break is explicit
 * (`textLineBreaks: 'source'`). Then the box also gets `SLACK_RATIO` of the
 * widest line plus `SLACK_PX`, so that a line Penpot draws a bit wider than
 * Figma (up to ~0.7 % measured) never wraps again.
 */
import type * as ir from '../../ir.ts';

export interface LocalBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extra room around what Figma drew (anti-aliasing, hinting). */
export const MARGIN = 2;
/** Horizontal slack for engines that lay a line out wider than Figma (measured ≤ 0.7 %; 3 % + 2 px leaves ≥ 4× headroom). */
export const SLACK_RATIO = 0.03;
export const SLACK_PX = 2;

interface Extent {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function include(e: Extent | undefined, x0: number, y0: number, x1: number, y1: number): Extent {
  if (!e) return { left: x0, right: x1, top: y0, bottom: y1 };
  return { left: Math.min(e.left, x0), right: Math.max(e.right, x1), top: Math.min(e.top, y0), bottom: Math.max(e.bottom, y1) };
}

/**
 * What Figma drew, in local space: the glyph outline points (control points
 * included), or, without outlines, the line boxes (advance width × line top
 * to an estimated descent).
 */
export function sourceExtent(node: ir.TextNode): Extent | undefined {
  let e: Extent | undefined;
  for (const outline of node.layout?.outlines ?? []) {
    for (const c of outline.path?.commands ?? []) {
      if (c.type === 'Z') continue;
      const xs = c.type === 'C' ? [c.x, c.x1, c.x2] : c.type === 'Q' ? [c.x, c.x1] : [c.x];
      const ys = c.type === 'C' ? [c.y, c.y1, c.y2] : c.type === 'Q' ? [c.y, c.y1] : [c.y];
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i]!;
        const y = ys[i]!;
        if (Number.isFinite(x) && Number.isFinite(y)) e = include(e, x, y, x, y);
      }
    }
  }
  if (e) return e;
  const maxSize = Math.max(0, ...node.runs.map((r) => (Number.isFinite(r.style?.fontSize) ? r.style.fontSize : 0)));
  for (const line of node.layout?.lines ?? []) {
    const { x, y } = line.baseline ?? { x: NaN, y: NaN };
    if (![x, y, line.width, line.ascent].every(Number.isFinite)) continue;
    // The line box from its top to a descent estimate (line boxes keep empty lines' height).
    e = include(e, x, y - Math.max(0, line.ascent), x + Math.max(0, line.width), y + 0.25 * maxSize);
  }
  return e;
}

export function textBox(
  node: ir.TextNode,
  options: { growWidth: boolean },
): LocalBox {
  const w = Number.isFinite(node.size.width) ? node.size.width : 0;
  const h = Number.isFinite(node.size.height) ? node.size.height : 0;
  const ext = sourceExtent(node);
  if (!ext) return { x: 0, y: 0, width: w, height: h };

  let x0 = 0;
  let x1 = w;
  if (options.growWidth) {
    const slack = SLACK_RATIO * Math.max(0, ext.right - ext.left) + SLACK_PX;
    const left = ext.left - MARGIN - slack;
    const right = ext.right + MARGIN + slack;
    if (node.autoResize === 'width-and-height') x1 = Math.max(w, right);
    else if (node.alignHorizontal === 'right') x0 = Math.min(0, left);
    else if (node.alignHorizontal === 'center') {
      const d = Math.max(0, -left, right - w);
      x0 = -d;
      x1 = w + d;
    } else x1 = Math.max(w, right);
  }

  let y0 = 0;
  let y1 = h;
  const top = ext.top - MARGIN;
  const bottom = ext.bottom + MARGIN;
  if (node.alignVertical === 'bottom') y0 = Math.min(0, top);
  else if (node.alignVertical === 'center') {
    const d = Math.max(0, -top, bottom - h);
    y0 = -d;
    y1 = h + d;
  } else y1 = Math.max(h, bottom);

  return { x: round(x0), y: round(y0), width: round(x1 - x0), height: round(y1 - y0) };
}

function round(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}
