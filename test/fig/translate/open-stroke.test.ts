/**
 * Inside/outside strokes on OPEN paths vs Figma's own `strokeGeometry`, for
 * every such vector in every fixture: Figma strokes open sub-paths centred
 * whatever `strokeAlign` says (its stroke outline extends ≈ w/2 past the
 * path), so the IR keeps the path exact with a centred stroke, and stroking
 * `paths` centred with the IR weight / caps / join must reproduce the bounds
 * of Figma's stroke outline.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { FIXTURES, LARGE_FIXTURES, hasLarge, nodesOf, translateFixture } from './helpers.ts';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const empty = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const grow = (b: Box, x: number, y: number): void => {
  b.x0 = Math.min(b.x0, x);
  b.y0 = Math.min(b.y0, y);
  b.x1 = Math.max(b.x1, x);
  b.y1 = Math.max(b.y1, y);
};

/** Sub-paths as point lists, curves sampled finely. */
function polylines(paths: ir.Path[]): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  for (const path of paths) {
    let current: { x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    for (const c of path.commands) {
      if (c.type === 'Z') continue;
      if (c.type === 'M') {
        if (current.length > 1) out.push(current);
        current = [{ x: c.x, y: c.y }];
      } else if (c.type === 'L') current.push({ x: c.x, y: c.y });
      else {
        for (let i = 1; i <= 64; i++) {
          const t = i / 64;
          const u = 1 - t;
          current.push(
            c.type === 'Q'
              ? { x: u * u * x + 2 * u * t * c.x1 + t * t * c.x, y: u * u * y + 2 * u * t * c.y1 + t * t * c.y }
              : { x: u ** 3 * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, y: u ** 3 * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y },
          );
        }
      }
      x = c.x;
      y = c.y;
    }
    if (current.length > 1) out.push(current);
  }
  return out.map((pts) => pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y)).filter((pts) => pts.length > 1);
}

/** Bounds of an outline, curves sampled. */
function outlineBounds(paths: ir.Path[]): Box {
  const b = empty();
  for (const pts of polylines(paths)) for (const p of pts) grow(b, p.x, p.y);
  return b;
}

/** Bounds of a centred stroke of open polylines: bands, butt / round / square caps, miter / bevel / round joins. */
function strokedBounds(paths: ir.Path[], stroke: ir.Stroke): Box {
  const b = empty();
  const h = stroke.weight / 2;
  const circle = (p: { x: number; y: number }): void => (grow(b, p.x - h, p.y - h), grow(b, p.x + h, p.y + h));
  for (const pts of polylines(paths)) {
    const dir = (i: number): [number, number] => {
      const len = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
      return [(pts[i + 1]!.x - pts[i]!.x) / len, (pts[i + 1]!.y - pts[i]!.y) / len];
    };
    const last = pts.length - 2;
    for (let i = 0; i <= last; i++) {
      const [dx, dy] = dir(i);
      const s = i === 0 && stroke.startCap === 'square' ? h : 0;
      const e = i === last && stroke.endCap === 'square' ? h : 0;
      const a = pts[i]!;
      const z = pts[i + 1]!;
      for (const [px, py] of [[a.x - dx * s, a.y - dy * s], [z.x + dx * e, z.y + dy * e]] as const) {
        grow(b, px - dy * h, py + dx * h);
        grow(b, px + dy * h, py - dx * h);
      }
      if (i === 0 && stroke.startCap === 'round') circle(a);
      if (i === last && stroke.endCap === 'round') circle(z);
      if (i < last) {
        const v = z;
        if (stroke.join === 'round') circle(v);
        else if (stroke.join === 'miter') {
          const [ex, ey] = dir(i + 1);
          const cos = dx * ex + dy * ey; // cos of the turning angle
          const half = Math.sqrt((1 + cos) / 2); // cos of half the turning angle
          if (half > 1e-9 && 1 / half <= (stroke.miterLimit ?? 4)) {
            // Miter tip on the outer side, along the bisector of the two normals.
            const turn = dx * ey - dy * ex;
            const [nx, ny] = [-(dy + ey), dx + ex];
            const nl = Math.hypot(nx, ny);
            const sign = turn > 0 ? -1 : 1;
            if (nl > 0) grow(b, v.x + (sign * nx * h) / (nl * half), v.y + (sign * ny * h) / (nl * half));
          }
        }
      }
    }
  }
  return b;
}

type Point = { x: number; y: number };
const ARROWS = new Set<ir.StrokeCap>(['line-arrow', 'triangle-arrow', 'diamond', 'circle']);

/** Open ends drawn with an arrow-like cap. */
function arrowEnds(paths: ir.Path[], stroke: ir.Stroke): Point[] {
  return polylines(paths).flatMap((pts) => [
    ...(ARROWS.has(stroke.startCap) ? [pts[0]!] : []),
    ...(ARROWS.has(stroke.endCap) ? [pts[pts.length - 1]!] : []),
  ]);
}

const openOnly = (paths: ir.Path[]): boolean => {
  const commands = paths.flatMap((p) => p.commands);
  return commands.some((c) => c.type === 'M') && !commands.some((c) => c.type === 'Z');
};

const fixtures = [
  ...readdirSync(FIXTURES).filter((f) => f.endsWith('.fig')).map((f) => `${FIXTURES}${f}`),
  ...['auto-layout-playground.fig', 'simple-design-system.fig'].filter(hasLarge).map((f) => `${LARGE_FIXTURES}${f}`),
];

describe('inside/outside strokes on open paths', () => {
  it('are centred, exact and reproduce the bounds of Figma\'s stroke outline', () => {
    const counts: Record<string, { exact: number; otherwiseInexact: number; dashedFallback: number; sidesMatched: number }> = {};
    const failures: string[] = [];
    for (const file of fixtures) {
      const t = translateFixture(file);
      const name = file.split('/').pop()!;
      for (const node of nodesOf(t)) {
        if (node.type !== 'path' || !node.stroke?.paints.some((p) => p.visible) || !openOnly(node.paths)) continue;
        const figId = node.id.replace(/#stroke$/, '');
        const source = t.doc.byId.get(figId)?.change;
        if (!source || source.type === 'LINE' || (source.strokeAlign !== 'INSIDE' && source.strokeAlign !== 'OUTSIDE')) continue;
        const outline = node.geometry?.stroke;
        if (!outline?.length) continue;
        const stat = (counts[name] ??= { exact: 0, otherwiseInexact: 0, dashedFallback: 0, sidesMatched: 0 });
        const want = outlineBounds(outline);
        const label = `${name} ${node.id} (${node.stroke.startCap}/${node.stroke.endCap} ${node.stroke.join}, w ${node.stroke.weight})`;
        /** Sides of Figma's outline bounds a centred `stroke` of `paths` misses by more than 0.05 px. */
        const offSides = (stroke: ir.Stroke): string[] => {
          const got = strokedBounds(node.paths, stroke);
          // Figma's arrowheads are not modelled: a side an arrow-capped end can reach only has to contain the shaft's stroke.
          const arrows = arrowEnds(node.paths, stroke);
          const h = stroke.weight / 2 + 0.05;
          const reach = { x0: (p: Point) => p.x - got.x0 <= h, y0: (p: Point) => p.y - got.y0 <= h, x1: (p: Point) => got.x1 - p.x <= h, y1: (p: Point) => got.y1 - p.y <= h };
          return (['x0', 'y0', 'x1', 'y1'] as const).filter((side) => {
            const outward = side.endsWith('0') ? got[side] - want[side] : want[side] - got[side];
            if (arrows.some(reach[side])) return outward < -0.05;
            stat.sidesMatched++;
            return Math.abs(outward) > 0.05;
          });
        };
        if (node.stroke.dashPattern.length > 0 && !source.fillGeometry?.length) {
          // Figma draws these 2w wide: they stay inexact (the baked outline is used) with their own alignment.
          stat.dashedFallback++;
          if (node.pathsAreExact || node.stroke.align === 'center') failures.push(`${label}: dashed without fill geometry must stay inexact, got exact ${node.pathsAreExact} align ${node.stroke.align}`);
          if (offSides({ ...node.stroke, weight: 2 * node.stroke.weight }).length > 0) failures.push(`${label}: Figma's outline is not a centred 2w stroke`);
          continue;
        }
        if (node.stroke.align !== 'center') failures.push(`${label}: align ${node.stroke.align}`);
        if (!node.pathsAreExact) {
          // Inexact for another reason (corner radius, mixed caps, …), never for the alignment.
          stat.otherwiseInexact++;
          const blamed = t.reporter.warnings.find((w) => w.nodeId === figId && w.code === 'vector-paths-approximated' && / stroke on /.test(w.message));
          if (blamed) failures.push(`${label}: ${blamed.message}`);
          continue;
        }
        stat.exact++;
        const bad = offSides(node.stroke);
        if (bad.length > 0) failures.push(`${label} ${bad.join(',')}: Figma ${JSON.stringify(want)} vs stroked paths ${JSON.stringify(strokedBounds(node.paths, node.stroke))}`);
      }
    }
    console.log('inside/outside strokes on open paths per fixture:', counts);
    // Exact only since open paths are stroked centred: 35 on radix-icons, 138 on auto-layout-playground, plus 5 dashed ones without fill geometry that Figma draws 2w wide.
    expect(counts['radix-icons.fig']?.exact ?? 0).toBeGreaterThanOrEqual(35);
    if (hasLarge('auto-layout-playground.fig')) {
      expect(counts['auto-layout-playground.fig']?.exact ?? 0).toBeGreaterThanOrEqual(138);
      expect(counts['auto-layout-playground.fig']?.dashedFallback).toBe(5);
    }
    expect(failures, `${failures.length} failures:\n${failures.slice(0, 15).join('\n')}`).toEqual([]);
  });
});
