/**
 * Path geometry: IR path commands (local space) → Penpot path content (SVG
 * path data with only M/L/C/Z, absolute page coordinates).
 */
import type * as ir from '../ir.ts';
import { apply } from '../util/matrix.ts';
import { clean } from './geometry.ts';

export type AbsCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bezier circle constant: control-point distance for a quarter arc of radius 1. */
const KAPPA = 0.5522847498307936;

/**
 * Transforms commands by `m`, turning quadratics into cubics (Penpot only has
 * cubics) and making sure every sub-path starts with a move.
 */
export function bakeCommands(commands: readonly ir.PathCommand[], m: ir.Matrix): AbsCommand[] {
  const out: AbsCommand[] = [];
  let current: ir.Vec2 = { x: 0, y: 0 };
  let start: ir.Vec2 = { x: 0, y: 0 };
  let open = false;
  const ensureOpen = (): void => {
    if (!open) {
      const p = apply(m, current);
      out.push({ type: 'M', x: p.x, y: p.y });
      start = current;
      open = true;
    }
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M': {
        current = { x: c.x, y: c.y };
        start = current;
        const p = apply(m, current);
        out.push({ type: 'M', x: p.x, y: p.y });
        open = true;
        break;
      }
      case 'L': {
        ensureOpen();
        current = { x: c.x, y: c.y };
        const p = apply(m, current);
        out.push({ type: 'L', x: p.x, y: p.y });
        break;
      }
      case 'C': {
        ensureOpen();
        const p1 = apply(m, { x: c.x1, y: c.y1 });
        const p2 = apply(m, { x: c.x2, y: c.y2 });
        current = { x: c.x, y: c.y };
        const p = apply(m, current);
        out.push({ type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
        break;
      }
      case 'Q': {
        ensureOpen();
        const q0 = current;
        const c1 = { x: q0.x + (2 / 3) * (c.x1 - q0.x), y: q0.y + (2 / 3) * (c.y1 - q0.y) };
        const c2 = { x: c.x + (2 / 3) * (c.x1 - c.x), y: c.y + (2 / 3) * (c.y1 - c.y) };
        const p1 = apply(m, c1);
        const p2 = apply(m, c2);
        current = { x: c.x, y: c.y };
        const p = apply(m, current);
        out.push({ type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
        break;
      }
      case 'Z':
        if (open) out.push({ type: 'Z' });
        current = start;
        open = false;
        break;
    }
  }
  return out;
}

function fmt(n: number): string {
  return String(clean(n, 4));
}

export function serialize(commands: readonly AbsCommand[]): string {
  const parts: string[] = [];
  for (const c of commands) {
    switch (c.type) {
      case 'M':
      case 'L':
        parts.push(`${c.type} ${fmt(c.x)} ${fmt(c.y)}`);
        break;
      case 'C':
        parts.push(`C ${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x2)} ${fmt(c.y2)} ${fmt(c.x)} ${fmt(c.y)}`);
        break;
      case 'Z':
        parts.push('Z');
        break;
    }
  }
  return parts.join(' ');
}

/** True when the commands draw something (at least one segment). */
export function hasSegments(commands: readonly AbsCommand[]): boolean {
  return commands.some((c) => c.type === 'L' || c.type === 'C');
}

/**
 * The largest change of direction (radians, 0 … π) at a vertex of the outline: where two segments meet, and
 * where a closed sub-path closes. 0 for smooth outlines (an ellipse, a rounded box) and single segments.
 */
export function maxTurn(commands: readonly AbsCommand[]): number {
  let turn = 0;
  const angle = (a: ir.Vec2, b: ir.Vec2): number => {
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la < 1e-9 || lb < 1e-9) return 0;
    const cos = (a.x * b.x + a.y * b.y) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, cos)));
  };
  // Start and end tangents of every segment of the current sub-path.
  let segs: { start: ir.Vec2; end: ir.Vec2 }[] = [];
  let first: ir.Vec2 = { x: 0, y: 0 };
  let p: ir.Vec2 = first;
  const tangent = (...vs: ir.Vec2[]): ir.Vec2 => vs.find((v) => Math.hypot(v.x, v.y) > 1e-9) ?? { x: 0, y: 0 };
  const flush = (closed: boolean): void => {
    for (let i = 1; i < segs.length; i++) turn = Math.max(turn, angle(segs[i - 1]!.end, segs[i]!.start));
    if (closed && segs.length > 1) turn = Math.max(turn, angle(segs[segs.length - 1]!.end, segs[0]!.start));
    segs = [];
  };
  const line = (q: ir.Vec2): void => {
    const d = { x: q.x - p.x, y: q.y - p.y };
    if (Math.hypot(d.x, d.y) > 1e-9) segs.push({ start: d, end: d });
  };
  for (const c of commands) {
    if (c.type === 'M') {
      flush(false);
      first = p = { x: c.x, y: c.y };
    } else if (c.type === 'L') {
      line(c);
      p = { x: c.x, y: c.y };
    } else if (c.type === 'C') {
      const d1 = { x: c.x1 - p.x, y: c.y1 - p.y };
      const d2 = { x: c.x2 - p.x, y: c.y2 - p.y };
      const d3 = { x: c.x - p.x, y: c.y - p.y };
      const e1 = { x: c.x - c.x2, y: c.y - c.y2 };
      const e2 = { x: c.x - c.x1, y: c.y - c.y1 };
      if (Math.hypot(d3.x, d3.y) > 1e-9 || Math.hypot(d1.x, d1.y) > 1e-9 || Math.hypot(d2.x, d2.y) > 1e-9) segs.push({ start: tangent(d1, d2, d3), end: tangent(e1, e2, d3) });
      p = { x: c.x, y: c.y };
    } else {
      line(first);
      p = first;
      flush(true);
    }
  }
  flush(false);
  return turn;
}

/** True when every sub-path is closed. */
export function isClosed(paths: readonly ir.Path[]): boolean {
  for (const path of paths) {
    let open = false;
    for (const c of path.commands) {
      if (c.type === 'Z') open = false;
      else if (c.type === 'M') {
        if (open) return false;
        open = true;
      } else open = true;
    }
    if (open) return false;
  }
  return true;
}

/** Tight bounds (curve extrema, like Penpot's `calc-selrect`), or undefined for empty content. */
export function bounds(commands: readonly AbsCommand[]): Bounds | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  let cx = 0;
  let cy = 0;
  for (const c of commands) {
    if (c.type === 'Z') continue;
    if (c.type === 'C') {
      for (const t of cubicExtrema(cx, c.x1, c.x2, c.x)) add(cubicAt(cx, c.x1, c.x2, c.x, t), cubicAt(cy, c.y1, c.y2, c.y, t));
      for (const t of cubicExtrema(cy, c.y1, c.y2, c.y)) add(cubicAt(cx, c.x1, c.x2, c.x, t), cubicAt(cy, c.y1, c.y2, c.y, t));
    }
    add(c.x, c.y);
    cx = c.x;
    cy = c.y;
  }
  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Parameters in (0,1) where the derivative of a 1D cubic vanishes. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

/** A (possibly rounded) rectangle outline in local space, clockwise from the top-left. */
export function rectCommands(width: number, height: number, radii?: readonly [number, number, number, number]): ir.PathCommand[] {
  const [tl, tr, br, bl] = clampRadii(width, height, radii ?? [0, 0, 0, 0]);
  const k = 1 - KAPPA;
  const cmds: ir.PathCommand[] = [{ type: 'M', x: tl, y: 0 }, { type: 'L', x: width - tr, y: 0 }];
  if (tr > 0) cmds.push({ type: 'C', x1: width - tr * k, y1: 0, x2: width, y2: tr * k, x: width, y: tr });
  cmds.push({ type: 'L', x: width, y: height - br });
  if (br > 0) cmds.push({ type: 'C', x1: width, y1: height - br * k, x2: width - br * k, y2: height, x: width - br, y: height });
  cmds.push({ type: 'L', x: bl, y: height });
  if (bl > 0) cmds.push({ type: 'C', x1: bl * k, y1: height, x2: 0, y2: height - bl * k, x: 0, y: height - bl });
  cmds.push({ type: 'L', x: 0, y: tl });
  if (tl > 0) cmds.push({ type: 'C', x1: 0, y1: tl * k, x2: tl * k, y2: 0, x: tl, y: 0 });
  cmds.push({ type: 'Z' });
  return cmds;
}

/**
 * Corner radii scaled down together by the CSS rule (`min(1, w/(tl+tr), w/(bl+br), h/(tl+bl), h/(tr+br))`),
 * which the IR already guarantees; a no-op for valid input. Clamping each corner to half the short side
 * instead would change radii the source draws (e.g. 90/10 on a 100-wide box).
 */
function clampRadii(width: number, height: number, radii: readonly [number, number, number, number]): [number, number, number, number] {
  const [tl, tr, br, bl] = radii.map((r) => (Number.isFinite(r) ? Math.max(0, r) : 0)) as [number, number, number, number];
  const ratio = (side: number, sum: number): number => (sum > 0 ? Math.max(0, side) / sum : 1);
  const f = Math.min(1, ratio(width, tl + tr), ratio(width, bl + br), ratio(height, tl + bl), ratio(height, tr + br));
  return [tl * f, tr * f, br * f, bl * f];
}

/** An ellipse inscribed in the box, clockwise from the top. */
export function ellipseCommands(width: number, height: number): ir.PathCommand[] {
  const rx = width / 2;
  const ry = height / 2;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    { type: 'M', x: rx, y: 0 },
    { type: 'C', x1: rx + ox, y1: 0, x2: width, y2: ry - oy, x: width, y: ry },
    { type: 'C', x1: width, y1: ry + oy, x2: rx + ox, y2: height, x: rx, y: height },
    { type: 'C', x1: rx - ox, y1: height, x2: 0, y2: ry + oy, x: 0, y: ry },
    { type: 'C', x1: 0, y1: ry - oy, x2: rx - ox, y2: 0, x: rx, y: 0 },
    { type: 'Z' },
  ];
}

/** Axis-aligned rectangle sub-path in local space. */
export function boxCommands(x: number, y: number, width: number, height: number): ir.PathCommand[] {
  return [
    { type: 'M', x, y },
    { type: 'L', x: x + width, y },
    { type: 'L', x: x + width, y: y + height },
    { type: 'L', x, y: y + height },
    { type: 'Z' },
  ];
}

/**
 * The same even-odd region, with every closed sub-path wound opposite to the sub-paths it sits in
 * (alternating by nesting depth), so that the nonzero rule gives the even-odd result too. Penpot's SVG
 * renderer clips an inside stroke (and masks an outside one) with the shape under the nonzero rule
 * whatever the path's fill rule: a hole wound like its outline then gets the doubled stroke on both
 * sides (auto-layout-playground 2411:12761, live check in test/penpot/live/strokes.test.ts). Content with
 * an open sub-path, or a single sub-path, is returned unchanged.
 */
export function windAlternately(commands: readonly AbsCommand[]): AbsCommand[] {
  const subs: AbsCommand[][] = [];
  for (const c of commands) {
    if (c.type === 'M' || subs.length === 0) subs.push([]);
    subs[subs.length - 1]!.push(c);
  }
  if (subs.length < 2 || subs.some((s) => s[s.length - 1]?.type !== 'Z' || s[0]?.type !== 'M')) return [...commands];
  const polygons = subs.map(polygon);
  const depth = polygons.map((p, i) => polygons.filter((q, j) => j !== i && contains(q, p[0]!)).length);
  const out: AbsCommand[] = [];
  subs.forEach((sub, i) => {
    const positive = signedArea(polygons[i]!) >= 0;
    out.push(...(positive === (depth[i]! % 2 === 0) ? sub : reverse(sub)));
  });
  return out;
}

function polygon(sub: readonly AbsCommand[]): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  let cx = 0;
  let cy = 0;
  for (const c of sub) {
    if (c.type === 'Z') continue;
    if (c.type === 'C') {
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        pts.push({ x: cubicAt(cx, c.x1, c.x2, c.x, t), y: cubicAt(cy, c.y1, c.y2, c.y, t) });
      }
    }
    pts.push({ x: c.x, y: c.y });
    cx = c.x;
    cy = c.y;
  }
  return pts;
}

function signedArea(p: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}

/** Even-odd point-in-polygon test. */
function contains(poly: readonly { x: number; y: number }[], p: { x: number; y: number }): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A closed sub-path (M … Z) traversed the other way round, from the same start point. */
function reverse(sub: readonly AbsCommand[]): AbsCommand[] {
  const start = sub[0] as { type: 'M'; x: number; y: number };
  type Segment = Extract<AbsCommand, { type: 'C' }> | { type: 'L'; x: number; y: number };
  const segs = sub.slice(1).filter((c) => c.type === 'L' || c.type === 'C') as Segment[];
  const points = [{ x: start.x, y: start.y }, ...segs.map((c) => ({ x: c.x, y: c.y }))];
  const end = points[points.length - 1]!;
  const out: AbsCommand[] = [{ type: 'M', x: start.x, y: start.y }];
  if (Math.hypot(end.x - start.x, end.y - start.y) > 1e-9) out.push({ type: 'L', x: end.x, y: end.y });
  for (let k = segs.length - 1; k >= 0; k--) {
    const c = segs[k]!;
    const to = points[k]!;
    if (c.type === 'L') out.push({ type: 'L', x: to.x, y: to.y });
    else out.push({ type: 'C', x1: c.x2, y1: c.y2, x2: c.x1, y2: c.y1, x: to.x, y: to.y });
  }
  out.push({ type: 'Z' });
  return out;
}
