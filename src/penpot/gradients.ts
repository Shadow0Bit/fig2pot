/**
 * IR gradient handles → Penpot gradient coordinates.
 *
 * IR handles live in the node's normalised space (Figma REST semantics):
 * h0 = start/centre, h1 = end of the gradient axis, h2 = end of the second
 * axis. Penpot coordinates are normalised to the Penpot shape's box, which is
 * the node box for box shapes but the content bounds for paths (their content
 * is baked into page space), hence the `toBox` matrix.
 *
 * Penpot's two renderers read these coordinates differently (measured on 2.19):
 *
 * - SVG renderer: bounding-box space. A linear gradient's iso-lines are
 *   perpendicular to start→end *in normalised space*; a radial gradient is an
 *   ellipse in normalised space with radius |start→end| along start→end and
 *   |start→end| · `width` perpendicular to it, stretched with the box.
 * - WASM renderer: pixel space. Linear iso-lines are perpendicular to
 *   start→end in pixels; a radial gradient is a pixel-space ellipse with radius
 *   |start→end| along start→end and |start→end| · `width` · (boxW / boxH)
 *   perpendicular to it.
 *
 * Figma's iso-lines run along h0→h2 and its radial ellipse is spanned by the
 * conjugate radii h1-h0 / h2-h0, whatever the box aspect. Both conversions
 * work in the target renderer's space: linear picks the end point from the
 * dual vector of the (h1-h0, h2-h0) frame, radial takes the principal axes of
 * the ellipse; both reproduce Figma's colour at every point. Since an affine
 * stretch preserves conjugacy and dual frames, one formula serves both spaces.
 */
import type * as ir from '../ir.ts';
import { apply } from '../util/matrix.ts';
import { hex, opacity } from './colors.ts';
import { clean } from './geometry.ts';
import type { PenpotGradient, PenpotGradientStop } from './library.ts';

export interface GradientSpace {
  /** Node-normalised (0..1) → Penpot-box-normalised (0..1). */
  toBox: ir.Matrix;
  /** Penpot box size in pixels. */
  width: number;
  height: number;
}

/** Penpot `MAX-GRADIENT-STOPS`. */
export const MAX_GRADIENT_STOPS = 16;

export interface GradientResult {
  gradient: PenpotGradient;
  /** Set when the result is an approximation; the value says why. */
  approximation?: string;
}

export type GradientRenderer = 'svg' | 'wasm';

export function convertGradient(paint: ir.GradientPaint, space: GradientSpace, renderer: GradientRenderer = 'svg'): GradientResult | undefined {
  const stops = convertStops(paint);
  if (stops.stops.length === 0) return undefined;
  const [a, b, c] = paint.handles.map((h) => apply(space.toBox, h)) as [ir.Vec2, ir.Vec2, ir.Vec2];
  const approximations: string[] = [];
  if (stops.truncated) approximations.push(`more than ${MAX_GRADIENT_STOPS} stops`);

  // Degenerate boxes (e.g. a horizontal line's content bounds) carry no aspect.
  const w = space.width > 1e-9 ? space.width : 1;
  const h = space.height > 1e-9 ? space.height : 1;
  const scale: Scale = renderer === 'wasm' ? { x: w, y: h } : { x: 1, y: 1 };
  let geometry: Omit<PenpotGradient, 'stops'> | undefined;
  switch (paint.gradientType) {
    case 'linear':
      geometry = linear(a, b, c, true, scale);
      break;
    case 'angular':
      approximations.push('angular gradient drawn as a linear gradient');
      geometry = linear(a, b, c, false, scale);
      break;
    case 'radial':
      geometry = radial(a, b, c, scale, renderer === 'wasm' ? h / w : 1);
      break;
    case 'diamond':
      approximations.push('diamond gradient drawn as a radial gradient');
      geometry = radial(a, b, c, scale, renderer === 'wasm' ? h / w : 1);
      break;
  }
  if (!geometry) return undefined;
  const result: GradientResult = { gradient: { ...geometry, stops: stops.stops } };
  if (approximations.length) result.approximation = approximations.join('; ');
  return result;
}

/** Box-normalised → renderer space: identity for SVG, the box size in pixels for WASM. */
interface Scale {
  x: number;
  y: number;
}

function linear(n0: ir.Vec2, n1: ir.Vec2, n2: ir.Vec2, useSecondAxis: boolean, scale: Scale): Omit<PenpotGradient, 'stops'> | undefined {
  const h0 = mul(n0, scale);
  const u = sub(mul(n1, scale), h0);
  const v = sub(mul(n2, scale), h0);
  const uu = dot(u, u);
  if (uu < 1e-18) return undefined;
  // Dual vector g: g·u = 1, g·v = 0, so t(p) = g·(p - h0) is Figma's gradient parameter.
  let g = { x: u.x / uu, y: u.y / uu };
  if (useSecondAxis) {
    const n = { x: -v.y, y: v.x };
    const nu = dot(n, u);
    if (Math.abs(nu) > 1e-9 * Math.sqrt(uu * dot(v, v)) && dot(v, v) > 1e-18) g = { x: n.x / nu, y: n.y / nu };
  }
  const gg = dot(g, g);
  const end = { x: (h0.x + g.x / gg) / scale.x, y: (h0.y + g.y / gg) / scale.y };
  return { type: 'linear', startX: clean(n0.x), startY: clean(n0.y), endX: clean(end.x), endY: clean(end.y), width: 1 };
}

/** `aspect`: the renderer's extra factor on `width` (boxH / boxW for WASM, 1 for SVG). */
function radial(n0: ir.Vec2, n1: ir.Vec2, n2: ir.Vec2, scale: Scale, aspect: number): Omit<PenpotGradient, 'stops'> | undefined {
  const u = mul(sub(n1, n0), scale);
  const v = mul(sub(n2, n0), scale);
  // Principal axes of the ellipse {u·cos t + v·sin t}: eigen-decomposition of [u v][u v]ᵀ.
  const a = u.x * u.x + v.x * v.x;
  const b = u.x * u.y + v.x * v.y;
  const c = u.y * u.y + v.y * v.y;
  const mid = (a + c) / 2;
  const diff = Math.hypot((a - c) / 2, b);
  const s1 = Math.sqrt(Math.max(mid + diff, 0));
  const s2 = Math.sqrt(Math.max(mid - diff, 0));
  if (s1 < 1e-9) return undefined;
  const theta = 0.5 * Math.atan2(2 * b, a - c);
  const major = { x: Math.cos(theta), y: Math.sin(theta) };
  const minor = { x: -major.y, y: major.x };
  // Use the principal axis closest to the source's main handle so the editing handles stay familiar.
  const alongMajor = Math.abs(dot(major, u)) >= Math.abs(dot(minor, u));
  let axis = alongMajor ? major : minor;
  const along = alongMajor ? s1 : s2;
  const across = alongMajor ? s2 : s1;
  if (along < 1e-9) return undefined;
  if (dot(axis, u) < 0) axis = { x: -axis.x, y: -axis.y };
  return {
    type: 'radial',
    startX: clean(n0.x),
    startY: clean(n0.y),
    endX: clean(n0.x + (axis.x * along) / scale.x),
    endY: clean(n0.y + (axis.y * along) / scale.y),
    width: clean((across / along) * aspect),
  };
}

function convertStops(paint: ir.GradientPaint): { stops: PenpotGradientStop[]; truncated: boolean } {
  const sorted = [...paint.stops].sort((x, y) => x.position - y.position);
  let picked = sorted;
  if (sorted.length > MAX_GRADIENT_STOPS) {
    // Keep the ends and an even spread in between.
    picked = Array.from({ length: MAX_GRADIENT_STOPS }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (MAX_GRADIENT_STOPS - 1))]!);
  }
  return {
    stops: picked.map((s) => ({
      color: hex(s.color),
      opacity: opacity(s.color.a * paint.opacity),
      offset: opacity(s.position),
    })),
    truncated: picked !== sorted,
  };
}

function sub(p: ir.Vec2, q: ir.Vec2): ir.Vec2 {
  return { x: p.x - q.x, y: p.y - q.y };
}

function mul(p: ir.Vec2, s: Scale): ir.Vec2 {
  return { x: p.x * s.x, y: p.y * s.y };
}

function dot(p: ir.Vec2, q: ir.Vec2): number {
  return p.x * q.x + p.y * q.y;
}
