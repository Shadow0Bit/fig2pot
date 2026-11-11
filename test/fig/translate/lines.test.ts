/**
 * LINE strokes vs Figma's own `strokeGeometry`, for every LINE in every
 * fixture: stroking `paths` with the IR stroke (centred, weight, caps) must
 * reproduce the bounds of Figma's stroke outline. Figma strokes a LINE on one
 * side (y ∈ [−w, 0]) and keeps round/square caps inside [0, length] — see the
 * reference render test/refs/radix-icons/2001-4196.png.
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

const grow = (b: Box, x: number, y: number): void => {
  b.x0 = Math.min(b.x0, x);
  b.y0 = Math.min(b.y0, y);
  b.x1 = Math.max(b.x1, x);
  b.y1 = Math.max(b.y1, y);
};
const empty = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

/** Bounds of an outline, curves sampled. */
function outlineBounds(paths: ir.Path[]): Box {
  const b = empty();
  for (const path of paths) {
    let x = 0;
    let y = 0;
    for (const c of path.commands) {
      if (c.type === 'Z') continue;
      if (c.type === 'C' || c.type === 'Q') {
        for (let i = 1; i < 64; i++) {
          const t = i / 64;
          const u = 1 - t;
          if (c.type === 'Q') grow(b, u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
          else grow(b, u ** 3 * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, u ** 3 * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y);
        }
      }
      grow(b, c.x, c.y);
      x = c.x;
      y = c.y;
    }
  }
  return b;
}

/** Bounds of a centred stroke of straight open polylines with butt / round / square caps. */
function strokedBounds(paths: ir.Path[], stroke: ir.Stroke): Box {
  const b = empty();
  const h = stroke.weight / 2;
  for (const path of paths) {
    const pts = path.commands.filter((c): c is Extract<ir.PathCommand, { type: 'M' | 'L' }> => c.type === 'M' || c.type === 'L');
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const z = pts[i + 1]!;
      const len = Math.hypot(z.x - a.x, z.y - a.y) || 1;
      const [dx, dy] = [(z.x - a.x) / len, (z.y - a.y) / len];
      const ext = (cap: ir.StrokeCap): number => (cap === 'square' ? h : 0);
      const s = i === 0 ? ext(stroke.startCap) : 0;
      const e = i + 2 === pts.length ? ext(stroke.endCap) : 0;
      for (const [px, py] of [[a.x - dx * s, a.y - dy * s], [z.x + dx * e, z.y + dy * e]] as const) {
        grow(b, px - dy * h, py + dx * h);
        grow(b, px + dy * h, py - dx * h);
      }
      if (i === 0 && stroke.startCap === 'round') (grow(b, a.x - h, a.y - h), grow(b, a.x + h, a.y + h));
      if (i + 2 === pts.length && stroke.endCap === 'round') (grow(b, z.x - h, z.y - h), grow(b, z.x + h, z.y + h));
    }
  }
  return b;
}

const fixtures = [
  ...readdirSync(FIXTURES).filter((f) => f.endsWith('.fig')).map((f) => `${FIXTURES}${f}`),
  ...['auto-layout-playground.fig', 'simple-design-system.fig'].filter(hasLarge).map((f) => `${LARGE_FIXTURES}${f}`),
];

describe('LINE stroke placement', () => {
  it('reproduces the bounds of Figma\'s stroke outline for every stroked LINE', () => {
    let lines = 0;
    const failures: string[] = [];
    for (const file of fixtures) {
      const t = translateFixture(file);
      for (const node of nodesOf(t)) {
        if (node.type !== 'path' || t.doc.byId.get(node.id)?.type !== 'LINE') continue;
        const outline = node.geometry?.stroke;
        if (!outline || !node.stroke?.paints.some((p) => p.visible)) continue;
        lines++;
        if (!node.pathsAreExact) {
          failures.push(`${file.split('/').pop()} ${node.id}: not exact`);
          continue;
        }
        const want = outlineBounds(outline);
        const got = strokedBounds(node.paths, node.stroke);
        const err = Math.max(Math.abs(want.x0 - got.x0), Math.abs(want.y0 - got.y0), Math.abs(want.x1 - got.x1), Math.abs(want.y1 - got.y1));
        if (err > 0.05) failures.push(`${file.split('/').pop()} ${node.id}: Figma ${JSON.stringify(want)} vs stroked paths ${JSON.stringify(got)}`);
      }
    }
    // radix-icons alone has 40 stroked LINEs (round and butt caps).
    expect(lines).toBeGreaterThanOrEqual(40);
    expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
  });
});
