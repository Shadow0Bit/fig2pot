import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { finite } from './common.ts';
import type { TranslateContext } from './context.ts';
import { decodeGeometry } from './geometry.ts';
import { lineCapsOf } from './vector.ts';

/**
 * [topLeft, topRight, bottomRight, bottomLeft], or undefined when all are 0.
 * With `size`, the radii are clamped to the box the way Figma (and CSS)
 * render them: when two radii along one side add up to more than that side,
 * all four are scaled by the same factor
 * `min(1, w/(tl+tr), w/(bl+br), h/(tl+bl), h/(tr+br))` — a 302 px high pill
 * stored with radius 200 renders with 151.
 */
export function cornerRadiiOf(c: fig.NodeChange, size?: ir.Size): [number, number, number, number] | undefined {
  const r = Math.max(0, finite(c.cornerRadius, 0));
  const radii: [number, number, number, number] = c.rectangleCornerRadiiIndependent
    ? [
        Math.max(0, finite(c.rectangleTopLeftCornerRadius, r)),
        Math.max(0, finite(c.rectangleTopRightCornerRadius, r)),
        Math.max(0, finite(c.rectangleBottomRightCornerRadius, r)),
        Math.max(0, finite(c.rectangleBottomLeftCornerRadius, r)),
      ]
    : [r, r, r, r];
  if (!radii.some((v) => v > 0)) return undefined;
  return size ? clampRadii(radii, size) : radii;
}

export function clampRadii(radii: [number, number, number, number], { width, height }: ir.Size): [number, number, number, number] {
  const [tl, tr, br, bl] = radii;
  const ratio = (side: number, sum: number): number => (sum > 0 ? side / sum : Infinity);
  const f = Math.min(1, ratio(width, tl + tr), ratio(width, bl + br), ratio(height, tl + bl), ratio(height, tr + br));
  return f < 1 ? [tl * f, tr * f, br * f, bl * f] : radii;
}

/** Sets `cornerRadii` / `cornerSmoothing` on a frame or rect. */
export function applyCorners(target: ir.FrameNode | ir.RectNode, c: fig.NodeChange): void {
  const radii = cornerRadiiOf(c, target.size);
  if (radii && radii.some((v) => v > 0)) target.cornerRadii = radii;
  const smoothing = finite(c.cornerSmoothing, 0);
  if (radii && smoothing > 0) target.cornerSmoothing = Math.min(1, smoothing);
}

export function translateRect(base: ir.BaseNode, node: FigNode): ir.RectNode {
  const rect: ir.RectNode = { ...base, type: 'rect' };
  applyCorners(rect, node.change);
  return rect;
}

const FULL_TURN = Math.PI * 2;

export function isFullEllipse(arc: fig.ArcData | undefined): boolean {
  if (!arc) return true;
  const start = finite(arc.startingAngle, 0);
  const end = finite(arc.endingAngle, FULL_TURN);
  const inner = finite(arc.innerRadius, 0);
  return inner <= 1e-6 && Math.abs(end - start) >= FULL_TURN - 1e-4;
}

export function translateEllipse(base: ir.BaseNode, node: FigNode, ctx: TranslateContext): ir.EllipseNode | ir.PathNode {
  if (isFullEllipse(node.change.arcData)) return { ...base, type: 'ellipse' };
  return outlinePath(base, node, ctx);
}

/**
 * LINE: a single open segment along the local x axis. Figma strokes a LINE on
 * one side — its stroke outline spans y ∈ [−w, 0] — and keeps round and
 * square caps inside [0, length] (checked against `strokeGeometry` and the
 * renders of every stroked LINE in the fixtures). `paths` is the centre line
 * of that outline, so a centred stroke of it with the same caps reproduces
 * Figma's. Non-centre alignments, arrow caps, dashed lines with caps and
 * lines shorter than their caps were never observed and stay approximate.
 * With `node`, per-vertex caps from the LINE's vector network are applied.
 */
export function translateLine(base: ir.BaseNode, node?: FigNode, ctx?: TranslateContext): ir.PathNode {
  const stroke = base.stroke ? { ...base.stroke } : undefined;
  let exact = true;
  let y = 0;
  let start = 0;
  let end = base.size.width;
  if (stroke) {
    if (node && ctx) [stroke.startCap, stroke.endCap] = lineCapsOf(stroke, node, ctx);
    const w = stroke.weight;
    const inset = (cap: ir.StrokeCap): number | undefined => (cap === 'none' ? 0 : cap === 'round' || cap === 'square' ? w / 2 : undefined);
    const a = inset(stroke.startCap);
    const b = inset(stroke.endCap);
    y = -w / 2;
    if (stroke.align !== 'center' || a === undefined || b === undefined || (a + b > 0 && (a + b >= end || stroke.dashPattern.length > 0))) exact = false;
    else {
      start = a;
      end -= b;
    }
    if (!exact && node && ctx && stroke.paints.some((p) => p.visible)) {
      ctx.warn('vector-paths-approximated', `line stroke (${stroke.align}, caps ${stroke.startCap}/${stroke.endCap}) approximated; exact outline kept in geometry`, node);
    }
  }
  const line: ir.PathNode = {
    ...base,
    type: 'path',
    paths: [{ windingRule: 'nonzero', commands: [{ type: 'M', x: start, y }, { type: 'L', x: end, y }] }],
    pathsAreExact: exact,
  };
  if (stroke) line.stroke = stroke;
  return line;
}

/**
 * STAR, REGULAR_POLYGON, partial ELLIPSE: Figma's own fill outline is the
 * exact (closed) shape, and stroking it matches Figma's stroke.
 */
export function outlinePath(base: ir.BaseNode, node: FigNode, ctx: TranslateContext): ir.PathNode {
  const paths = base.geometry?.fill ?? decodeGeometry(node.change.fillGeometry, ctx, node);
  if (paths.length === 0) ctx.warn('missing-geometry', `${node.type} has no fill geometry; emitted as an empty path`, node);
  return { ...base, type: 'path', paths, pathsAreExact: true };
}
