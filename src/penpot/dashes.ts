/**
 * Figma's dash layout, reproduced as geometry.
 *
 * Figma does not run one dash pattern around an outline. It dashes every
 * segment (each straight side and each corner arc of a rectangle, each edge
 * of a vector) on its own: the pattern is stretched so that a whole number of
 * periods fits, and the segment starts and ends with half a dash, so a dash
 * always straddles each vertex. A segment shorter than one dash is drawn
 * solid. Measured on the `strokeGeometry` of the auto-layout-playground REST
 * dump (23 distinct dashed rectangles/frames, every edge and corner):
 *   n = max(1, round(L / period)) (halves round up), scale s = L / (n · period),
 *   dashes at [0, d·s/2], [d·s/2 + g·s, …], …, [L − d·s/2, L].
 *
 * Penpot has a single dash/gap pair and no dash offset, and its renderers start
 * the pattern at the outline's first point, so it cannot draw this. The writer
 * draws the dashes as open sub-paths with a solid, centred stroke instead;
 * for inside/outside alignment the sub-paths lie on the stroke's centre line
 * (the outline offset by ∓w/2), with the dash ends perpendicular to the
 * outline, as Figma's clipped 2w band has them.
 */
import type * as ir from '../ir.ts';

/** One dashable piece of an outline, parametrised by outline arc length fraction u ∈ [0, 1]. */
export interface DashSegment {
  /** Length along the source outline (what Figma's dash layout measures). */
  length: number;
  /** Centre-line point at u. */
  at(u: number): ir.Vec2;
  /** Straight segments are drawn with one line, curved ones with cubics. */
  curved: boolean;
}

/** Dash intervals [a, b] (outline length units) of one segment, Figma's way; undefined = no dashes at all. */
export function segmentDashes(length: number, pattern: readonly number[]): [number, number][] | undefined {
  const p = normalizedPattern(pattern);
  if (!p) return undefined;
  if (length <= 1e-9) return [];
  const period = p.reduce((a, b) => a + b, 0);
  if (length < p[0]!) return [[0, length]];
  const n = Math.max(1, Math.floor(length / period + 0.5));
  const s = length / (n * period);
  const out: [number, number][] = [];
  // Phase: the segment starts half way into the first dash.
  let pos = (-p[0]! / 2) * s;
  for (let i = 0; pos < length - 1e-9; i++) {
    const len = p[i % p.length]! * s;
    if (i % 2 === 0) {
      const a = Math.max(0, pos);
      const b = Math.min(length, pos + len);
      if (b - a > 1e-9) out.push([a, b]);
    }
    pos += len;
  }
  return out;
}

/**
 * Beyond this many dashes on one shape the writer keeps Penpot's own dashes (`stroke-dash-approximated`):
 * a [0.01, 0.01] pattern around a 2000 px box would be 400,000 sub-paths (seconds to write, megabytes to
 * store, slow to draw), and at that density Figma's per-side layout is invisible anyway.
 */
export const MAX_DASHES = 2000;

/** How many dashes `segmentDashes` lays out on `segments` (without laying them out); 0 without a usable pattern. */
export function dashCount(segments: readonly DashSegment[], pattern: readonly number[]): number {
  const p = normalizedPattern(pattern);
  if (!p) return 0;
  const period = p.reduce((a, b) => a + b, 0);
  let count = 0;
  for (const seg of segments) {
    if (seg.length <= 1e-9) continue;
    if (seg.length < p[0]!) count += 1;
    // n periods of p.length / 2 dashes each, plus the half dash that ends the segment.
    else count += Math.max(1, Math.floor(seg.length / period + 0.5)) * (p.length / 2) + 1;
  }
  return count;
}

/** Even-length, finite, non-negative pattern with a positive first dash and a positive period; else undefined. */
export function normalizedPattern(pattern: readonly number[]): number[] | undefined {
  const p = pattern.filter((v) => Number.isFinite(v) && v >= 0);
  if (p.length === 0) return undefined;
  const even = p.length % 2 === 0 ? p : [...p, ...p];
  if (!(even[0]! > 1e-6) || even.every((v, i) => i % 2 === 0 || v <= 1e-9)) return undefined;
  return even;
}

/**
 * The dashes of `segments` (in order around the outline) as open sub-paths in local space.
 * Dashes meeting at a segment boundary (every one does: segments start and end with half a dash)
 * are joined into one sub-path; on a closed outline the last joins the first.
 * Returns undefined when the pattern draws no gaps (a solid stroke does the job).
 */
export function dashPaths(segments: readonly DashSegment[], pattern: readonly number[], closed: boolean): ir.PathCommand[] | undefined {
  interface Run {
    pieces: { seg: DashSegment; u0: number; u1: number }[];
  }
  const runs: Run[] = [];
  let open: Run | undefined;
  let gaps = false;
  for (const seg of segments) {
    if (seg.length <= 1e-9) continue;
    const dashes = segmentDashes(seg.length, pattern);
    if (!dashes) return undefined;
    dashes.forEach(([a, b], i) => {
      const piece = { seg, u0: a / seg.length, u1: b / seg.length };
      const continues = i === 0 && a <= 1e-6 && open !== undefined;
      if (continues) open!.pieces.push(piece);
      else {
        open = { pieces: [piece] };
        runs.push(open);
      }
      if (b < seg.length - 1e-6) open = undefined;
    });
    if (dashes.length !== 1 || dashes[0]![0] > 1e-6 || dashes[0]![1] < seg.length - 1e-6) gaps = true;
  }
  if (!gaps || runs.length === 0) return undefined;
  if (closed && runs.length > 1) {
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    const lastPiece = last.pieces[last.pieces.length - 1]!;
    if (first.pieces[0]!.u0 <= 1e-6 && lastPiece.u1 >= 1 - 1e-6) {
      runs[0] = { pieces: [...last.pieces, ...first.pieces] };
      runs.pop();
    }
  }
  const out: ir.PathCommand[] = [];
  for (const run of runs) {
    const start = run.pieces[0]!;
    const p0 = start.seg.at(start.u0);
    out.push({ type: 'M', x: p0.x, y: p0.y });
    for (const piece of run.pieces) emit(out, piece.seg, piece.u0, piece.u1);
  }
  return out;
}

/** The whole centre line of `segments` as one sub-path (closed with Z when `closed`). */
export function fullPath(segments: readonly DashSegment[], closed: boolean): ir.PathCommand[] {
  const first = segments[0]?.at(0);
  if (!first) return [];
  const out: ir.PathCommand[] = [{ type: 'M', x: first.x, y: first.y }];
  for (const seg of segments) emit(out, seg, 0, 1);
  if (closed) out.push({ type: 'Z' });
  return out;
}

function emit(out: ir.PathCommand[], seg: DashSegment, u0: number, u1: number): void {
  if (!seg.curved) {
    const p = seg.at(u1);
    out.push({ type: 'L', x: p.x, y: p.y });
    return;
  }
  // Hermite cubics, at most 1/8 of a quarter arc each.
  const pieces = Math.max(1, Math.ceil((u1 - u0) * 8 - 1e-9));
  const h = 1e-4;
  const derivative = (u: number): ir.Vec2 => {
    const a = seg.at(Math.max(0, u - h));
    const b = seg.at(Math.min(1, u + h));
    const du = Math.min(1, u + h) - Math.max(0, u - h);
    return { x: (b.x - a.x) / du, y: (b.y - a.y) / du };
  };
  for (let i = 0; i < pieces; i++) {
    const a = u0 + ((u1 - u0) * i) / pieces;
    const b = u0 + ((u1 - u0) * (i + 1)) / pieces;
    const pa = seg.at(a);
    const pb = seg.at(b);
    const da = derivative(a);
    const db = derivative(b);
    const k = (b - a) / 3;
    out.push({ type: 'C', x1: pa.x + da.x * k, y1: pa.y + da.y * k, x2: pb.x - db.x * k, y2: pb.y - db.y * k, x: pb.x, y: pb.y });
  }
}

// --- outlines -------------------------------------------------------------------------------------------

/**
 * Straight segment from a to b; its centre line is offset by `offset` along `normal` and trimmed by
 * `trim` at each end (negative extends it): perpendicular projection inside, the trimmed ends at u = 0 / 1,
 * so that runs crossing a corner pass through the centre line's own corner.
 */
function line(a: ir.Vec2, b: ir.Vec2, normal: ir.Vec2, offset: number, trim: [number, number] = [0, 0]): DashSegment {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const t = length > 0 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 0, y: 0 };
  const lo = trim[0];
  const hi = length - trim[1];
  return {
    length,
    curved: false,
    at: (u) => {
      const s = u <= 0 ? lo : u >= 1 ? hi : Math.min(Math.max(u * length, Math.min(lo, hi)), Math.max(lo, hi));
      return { x: a.x + t.x * s + normal.x * offset, y: a.y + t.y * s + normal.y * offset };
    },
  };
}

function point(p: ir.Vec2, length: number): DashSegment {
  return { length, curved: false, at: () => p };
}

/**
 * Elliptical arc from parameter angle t0 to t1 (screen space, y down: increasing t runs clockwise), its
 * centre line offset by `offset` along the outward normal. Arc length is measured on the outline itself.
 */
function arc(c: ir.Vec2, rx: number, ry: number, t0: number, t1: number, offset: number): DashSegment {
  const N = 64;
  const point = (t: number): ir.Vec2 => ({ x: c.x + rx * Math.cos(t), y: c.y + ry * Math.sin(t) });
  const cumulative = [0];
  let prev = point(t0);
  for (let i = 1; i <= N; i++) {
    const p = point(t0 + ((t1 - t0) * i) / N);
    cumulative.push(cumulative[i - 1]! + Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  const length = cumulative[N]!;
  const paramAt = (u: number): number => {
    if (rx === ry || length <= 0) return t0 + (t1 - t0) * u;
    const target = u * length;
    let i = 1;
    while (i < N && cumulative[i]! < target) i++;
    const a = cumulative[i - 1]!;
    const b = cumulative[i]!;
    const f = b > a ? (target - a) / (b - a) : 0;
    return t0 + ((t1 - t0) * (i - 1 + f)) / N;
  };
  return {
    length,
    curved: true,
    at: (u) => {
      const t = paramAt(Math.min(1, Math.max(0, u)));
      const p = point(t);
      if (offset === 0) return p;
      // Outward normal of the ellipse at t.
      const nx = ry * Math.cos(t);
      const ny = rx * Math.sin(t);
      const len = Math.hypot(nx, ny) || 1;
      if (rx === ry) {
        // A circle: the offset stays a circle; a radius below zero collapses to the centre.
        const r = Math.max(0, rx + offset);
        return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
      }
      return { x: p.x + (nx / len) * offset, y: p.y + (ny / len) * offset };
    },
  };
}

/**
 * Segments of a (rounded) rectangle outline, clockwise from the top-left corner's end: top side, top-right
 * corner, right side, … Radii follow `rectCommands` (already clamped by the IR). `offset` > 0 moves the
 * centre line outwards.
 */
export function rectSegments(width: number, height: number, radii: readonly [number, number, number, number] | undefined, offset: number): DashSegment[] {
  const [tl, tr, br, bl] = (radii ?? [0, 0, 0, 0]).map((r) => (Number.isFinite(r) ? Math.max(0, r) : 0)) as [number, number, number, number];
  const H = Math.PI / 2;
  const o = offset;
  // How much each side's centre line is shortened at a corner: a sharp corner (Figma: miter) moves with the
  // offset; a rounded one keeps its ends unless the offset swallows the radius, which leaves a sharp corner.
  const trim = (r: number): number => (r === 0 ? -o : r + o > 0 ? 0 : -o - r);
  const corner = (c: ir.Vec2, r: number, t0: number, sharp: ir.Vec2): DashSegment | undefined => {
    if (r === 0) return undefined;
    if (r + o <= 0) return point(sharp, (Math.PI / 2) * r);
    return arc(c, r, r, t0, t0 + H, o);
  };
  const segs: (DashSegment | undefined)[] = [
    line({ x: tl, y: 0 }, { x: width - tr, y: 0 }, { x: 0, y: -1 }, o, [trim(tl), trim(tr)]),
    corner({ x: width - tr, y: tr }, tr, 3 * H, { x: width + o, y: -o }),
    line({ x: width, y: tr }, { x: width, y: height - br }, { x: 1, y: 0 }, o, [trim(tr), trim(br)]),
    corner({ x: width - br, y: height - br }, br, 0, { x: width + o, y: height + o }),
    line({ x: width - br, y: height }, { x: bl, y: height }, { x: 0, y: 1 }, o, [trim(br), trim(bl)]),
    corner({ x: bl, y: height - bl }, bl, H, { x: -o, y: height + o }),
    line({ x: 0, y: height - bl }, { x: 0, y: tl }, { x: -1, y: 0 }, o, [trim(bl), trim(tl)]),
    corner({ x: tl, y: tl }, tl, 2 * H, { x: -o, y: -o }),
  ];
  return segs.filter((s): s is DashSegment => s !== undefined);
}

/** The four quarter arcs of an ellipse inscribed in the box (Figma's ellipse has four vertices), from the top. */
export function ellipseSegments(width: number, height: number, offset: number): DashSegment[] {
  const H = Math.PI / 2;
  const c = { x: width / 2, y: height / 2 };
  return [0, 1, 2, 3].map((i) => arc(c, width / 2, height / 2, (3 + i) * H, (4 + i) * H, offset));
}

/** Centre-line offset of an aligned stroke of width w: inside −w/2, centre 0, outside +w/2. */
export function centerOffset(align: ir.Stroke['align'], weight: number): number {
  return align === 'inside' ? -weight / 2 : align === 'outside' ? weight / 2 : 0;
}

/**
 * Segments of IR path commands (one per drawing command, which is one edge of Figma's vector network),
 * drawn on the path itself: Figma strokes open paths centred. Sub-paths are dashed separately; the result
 * lists each sub-path's segments and whether it is closed.
 */
export function pathSegments(commands: readonly ir.PathCommand[]): { segments: DashSegment[]; closed: boolean }[] {
  const out: { segments: DashSegment[]; closed: boolean }[] = [];
  let current: { segments: DashSegment[]; closed: boolean } | undefined;
  let p: ir.Vec2 = { x: 0, y: 0 };
  let start: ir.Vec2 = p;
  const begin = (): void => {
    if (!current) {
      current = { segments: [], closed: false };
      out.push(current);
      start = p;
    }
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        current = undefined;
        p = { x: c.x, y: c.y };
        begin();
        break;
      case 'L': {
        begin();
        const q = { x: c.x, y: c.y };
        current!.segments.push(line(p, q, { x: 0, y: 0 }, 0));
        p = q;
        break;
      }
      case 'Q':
      case 'C': {
        begin();
        const p0 = p;
        const c1 = c.type === 'C' ? { x: c.x1, y: c.y1 } : { x: p0.x + (2 / 3) * (c.x1 - p0.x), y: p0.y + (2 / 3) * (c.y1 - p0.y) };
        const c2 = c.type === 'C' ? { x: c.x2, y: c.y2 } : { x: c.x + (2 / 3) * (c.x1 - c.x), y: c.y + (2 / 3) * (c.y1 - c.y) };
        const q = { x: c.x, y: c.y };
        current!.segments.push(cubicSegment(p0, c1, c2, q));
        p = q;
        break;
      }
      case 'Z':
        if (current) {
          if (Math.hypot(p.x - start.x, p.y - start.y) > 1e-9) current.segments.push(line(p, start, { x: 0, y: 0 }, 0));
          current.closed = true;
        }
        p = start;
        current = undefined;
        break;
    }
  }
  return out.filter((s) => s.segments.length > 0);
}

function cubicSegment(p0: ir.Vec2, p1: ir.Vec2, p2: ir.Vec2, p3: ir.Vec2): DashSegment {
  const N = 64;
  const point = (t: number): ir.Vec2 => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
  };
  const cumulative = [0];
  let prev = p0;
  for (let i = 1; i <= N; i++) {
    const q = point(i / N);
    cumulative.push(cumulative[i - 1]! + Math.hypot(q.x - prev.x, q.y - prev.y));
    prev = q;
  }
  const length = cumulative[N]!;
  return {
    length,
    curved: true,
    at: (u) => {
      const target = Math.min(1, Math.max(0, u)) * length;
      let i = 1;
      while (i < N && cumulative[i]! < target) i++;
      const a = cumulative[i - 1]!;
      const b = cumulative[i]!;
      const f = b > a ? (target - a) / (b - a) : 0;
      return point((i - 1 + f) / N);
    },
  };
}
