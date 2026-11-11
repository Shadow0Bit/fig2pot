/**
 * IR stroke → Penpot strokes (one Penpot stroke per visible paint, top first).
 *
 * Penpot strokes carry the geometry (width, alignment, dash, caps) on every
 * entry. Penpot has no stroke join, no miter limit and no per-side widths
 * (that one is behind a feature flag); see `shapes.ts` for how per-side
 * strokes are drawn instead.
 *
 * Dashes: Figma draws the stroke caps on every dash (a zero-length dash with
 * round caps is a dot). Penpot's `dotted` style ignores the gap (its period is
 * width + 5), so dots are written as short dashes. Penpot's SVG renderer draws
 * the caps of an open path on its dashes; the WASM renderer and closed shapes
 * draw none, so there each dash is lengthened by the caps it lost (drawn square).
 */
import type * as ir from '../ir.ts';
import type { WriterContext } from './context.ts';
import { convertColors, type PaintTarget } from './fills.ts';
import { clean } from './geometry.ts';
import type { PenpotStroke, PenpotStrokeCap } from './library.ts';

const CAPS: Record<ir.StrokeCap, PenpotStrokeCap | undefined> = {
  none: undefined,
  round: 'round',
  square: 'square',
  'line-arrow': 'line-arrow',
  'triangle-arrow': 'triangle-arrow',
  diamond: 'diamond-marker',
  circle: 'circle-marker',
};

const ALIGN = { inside: 'inner', center: 'center', outside: 'outer' } as const;

export interface StrokeOptions {
  /** Open paths: centred strokes (as Figma draws them, whatever the alignment says) and caps. */
  open: boolean;
  /** Overrides `stroke.weight` (e.g. the uniform width of a per-side stroke). */
  weight?: number;
  /** Scale baked into the shape's geometry: applied to the width and the dash pattern. */
  scale?: number;
  /**
   * The largest change of direction (radians) at a vertex of the stroked outline (`maxTurn`), where the stroke
   * join shows: 0 for smooth outlines (ellipses, fully rounded boxes, single straight segments), π/2 for a box
   * with a sharp corner. Unknown (undefined): a join is assumed to show.
   */
  turn?: number;
}

/** Shortest dash written: the WASM renderer draws nothing for dashes of 0.1 or less. */
export const MIN_DASH = 1;

export function hasVisibleStroke(stroke: ir.Stroke | undefined): stroke is ir.Stroke {
  if (!stroke || !stroke.paints.some((p) => p.visible)) return false;
  if (stroke.perSide) {
    const { top, right, bottom, left } = stroke.perSide;
    return Math.max(top, right, bottom, left) > 0;
  }
  return stroke.weight > 0;
}

/**
 * Per-side widths that Penpot cannot draw as one uniform stroke: true unless
 * all four sides are equal and non-zero.
 */
export function needsSideStrokes(stroke: ir.Stroke | undefined): boolean {
  if (!hasVisibleStroke(stroke) || !stroke.perSide) return false;
  const { top, right, bottom, left } = stroke.perSide;
  return !(top > 0 && top === right && top === bottom && top === left);
}

export function convertStrokes(
  ctx: WriterContext,
  stroke: ir.Stroke | undefined,
  target: PaintTarget,
  options: StrokeOptions,
): PenpotStroke[] {
  if (!hasVisibleStroke(stroke)) return [];
  const scale = options.scale !== undefined && Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const width = scale * (options.weight ?? (stroke.perSide ? Math.max(stroke.perSide.top, stroke.perSide.right, stroke.perSide.bottom, stroke.perSide.left) : stroke.weight));
  const base: PenpotStroke = {
    strokeWidth: clean(width),
    strokeAlignment: options.open ? 'center' : ALIGN[stroke.align],
    ...dash(ctx, stroke, target, { width, scale, capsDrawn: options.open && ctx.options.renderer === 'svg' }),
  };
  if (options.open) {
    const start = CAPS[stroke.startCap];
    const end = CAPS[stroke.endCap];
    if (start) base.strokeCapStart = start;
    if (end) base.strokeCapEnd = end;
  }
  if (stroke.join !== 'miter' && (options.turn === undefined || joinDifference(stroke.join, options.turn, width) >= VISIBLE_JOIN)) {
    ctx.warnOnce('stroke-join-unsupported', `Penpot has no stroke joins; the ${stroke.join} join is drawn as miter`, target.node);
  }
  return convertColors(ctx, stroke.paints, target, 'stroke').map((c) => {
    const out: PenpotStroke = { ...base, strokeOpacity: c.opacity };
    if (c.color !== undefined) out.strokeColor = c.color;
    else if (c.gradient) out.strokeColorGradient = c.gradient;
    else if (c.image) out.strokeImage = c.image;
    if (c.refId) {
      out.strokeColorRefId = c.refId;
      out.strokeColorRefFile = ctx.fileId;
    }
    return out;
  });
}

/** A join drawn differently by less than this (px, at the corner's tip) is not reported. */
const VISIBLE_JOIN = 0.1;

/** SVG's default miter limit, which Penpot keeps: sharper corners are bevelled. */
const MITER_LIMIT = 4;

/**
 * How far (px) Penpot's miter join (bevelled beyond the miter limit) reaches past a `join` at a vertex turning by
 * `turn` radians, for a stroke `width` wide: miter tip at w/2 · sec(θ/2) from the vertex, round at w/2, bevel
 * at w/2 · cos(θ/2).
 */
export function joinDifference(join: 'bevel' | 'round', turn: number, width: number): number {
  if (!(turn > 1e-6)) return 0;
  const half = Math.min(turn, Math.PI) / 2;
  const cos = Math.cos(half);
  const miter = cos > 1 / MITER_LIMIT ? 1 / cos : cos;
  const other = join === 'round' ? 1 : cos;
  return (width / 2) * Math.abs(miter - other);
}

function dash(
  ctx: WriterContext,
  stroke: ir.Stroke,
  target: PaintTarget,
  geometry: { width: number; scale: number; capsDrawn: boolean },
): Pick<PenpotStroke, 'strokeStyle' | 'strokeDash' | 'strokeGap'> {
  const pattern = stroke.dashPattern.filter((v) => Number.isFinite(v) && v >= 0);
  if (pattern.length === 0 || pattern.every((v) => v === 0)) return { strokeStyle: 'solid' };
  const dashLength = pattern[0]!;
  const gap = pattern[1] ?? dashLength;
  const uniform = pattern.every((v, i) => v === pattern[i % 2]);
  if (!uniform) {
    ctx.warn('stroke-dash-approximated', `Dash pattern [${pattern.join(', ')}] approximated by ${dashLength}/${gap}`, target.node);
  }
  const period = (dashLength + gap) * geometry.scale;
  // Figma's caps lengthen every dash by half the stroke width at each end.
  const capped = stroke.startCap === 'round' || stroke.startCap === 'square';
  const capLength = capped && !geometry.capsDrawn ? geometry.width : 0;
  const drawn = Math.max(MIN_DASH, dashLength * geometry.scale + capLength);
  const drawnGap = period - drawn - (capped && geometry.capsDrawn ? geometry.width : 0);
  // Dashes that touch or overlap make a solid line.
  if (drawnGap <= 1e-6) return { strokeStyle: 'solid' };
  return { strokeStyle: 'dashed', strokeDash: clean(drawn), strokeGap: clean(period - drawn) };
}
