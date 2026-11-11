import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import type { FigDocument, FigNode, NodeChange } from '../../../src/fig/types.ts';
import { decodeVectorNetwork, VectorNetworkError } from '../../../src/fig/vector-network.ts';
import { decodeFig } from '../../../src/fig/decode.ts';
import { buildTree } from '../../../src/fig/tree.ts';
import { createContext } from '../../../src/fig/translate/context.ts';
import { translateBase } from '../../../src/fig/translate/base.ts';
import { crossesItself, MAX_CROSSING_EDGES, translateVector } from '../../../src/fig/translate/vector.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { FIXTURES, LARGE_FIXTURES, byId, byName, fixture, hasLarge, nodesOf } from './helpers.ts';
import { decodeCommandsBlob } from '../../../src/fig/blobs.ts';

interface Seg {
  start: number;
  end: number;
  t1?: [number, number];
  t2?: [number, number];
  style?: number;
}

/** Encodes a vector network blob (layout documented in src/fig/vector-network.ts). */
function encodeNetwork(
  vertices: { x: number; y: number; style?: number }[],
  segments: Seg[],
  regions: { loops: number[][]; nonzero?: boolean; style?: number }[],
): Uint8Array {
  const words: ({ u: number } | { f: number })[] = [];
  const u = (v: number): void => void words.push({ u: v });
  const f = (v: number): void => void words.push({ f: v });
  u(vertices.length);
  u(segments.length);
  u(regions.length);
  for (const v of vertices) {
    u(v.style ?? 0);
    f(v.x);
    f(v.y);
  }
  for (const s of segments) {
    u(s.style ?? 0);
    u(s.start);
    f(s.t1?.[0] ?? 0);
    f(s.t1?.[1] ?? 0);
    u(s.end);
    f(s.t2?.[0] ?? 0);
    f(s.t2?.[1] ?? 0);
  }
  for (const r of regions) {
    u(((r.style ?? 0) << 1) | (r.nonzero === false ? 0 : 1));
    u(r.loops.length);
    for (const loop of r.loops) {
      u(loop.length);
      loop.forEach(u);
    }
  }
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((w, i) => ('u' in w ? view.setUint32(i * 4, w.u, true) : view.setFloat32(i * 4, w.f, true)));
  return bytes;
}

/** A one-node document whose VECTOR uses `blob` as its vector network. */
function vectorDoc(blob: Uint8Array, change: Partial<NodeChange> = {}, extraBlobs: Uint8Array[] = []): { doc: FigDocument; node: FigNode } {
  const nodeChange: NodeChange = {
    guid: { sessionID: 1, localID: 2 },
    type: 'VECTOR',
    name: 'v',
    size: { x: 10, y: 10 },
    vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 10 } },
    strokePaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, visible: true, opacity: 1 }],
    strokeWeight: 1,
    ...change,
  };
  const node: FigNode = { id: '1:2', guid: '1:2', type: 'VECTOR', change: nodeChange, children: [] };
  const root: FigNode = { id: '0:0', guid: '0:0', type: 'DOCUMENT', change: { type: 'DOCUMENT' }, children: [node] };
  node.parent = root;
  const doc: FigDocument = {
    file: { prelude: 'fig-kiwi', version: 0, message: { nodeChanges: [] } as never, blobs: [blob, ...extraBlobs], images: new Map() },
    root,
    pages: [],
    byId: new Map([['1:2', node]]),
    byGuid: new Map([['1:2', node]]),
  };
  return { doc, node };
}

function translateAny(
  blob: Uint8Array,
  change: Partial<NodeChange> = {},
  extraBlobs: Uint8Array[] = [],
  componentRef?: string,
): { node: ir.PathNode | ir.GroupNode; reporter: CollectingReporter } {
  const { doc, node } = vectorDoc(blob, change, extraBlobs);
  if (componentRef) node.componentRef = componentRef;
  const reporter = new CollectingReporter();
  const ctx = createContext(doc, reporter);
  return { node: translateVector(translateBase(node, ctx), node, ctx), reporter };
}

function translate(blob: Uint8Array, change: Partial<NodeChange> = {}, extraBlobs: Uint8Array[] = []): { path: ir.PathNode; reporter: CollectingReporter } {
  const { node, reporter } = translateAny(blob, change, extraBlobs);
  if (node.type !== 'path') throw new Error('expected a path node');
  return { path: node, reporter };
}

describe('decodeVectorNetwork', () => {
  it('decodes vertices, segments, regions and scales into node space', () => {
    const blob = encodeNetwork(
      [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4, style: 7 }],
      [{ start: 0, end: 1 }, { start: 1, end: 2, t1: [1, 0], t2: [0, -1] }, { start: 2, end: 0 }],
      [{ loops: [[0, 1, 2]], nonzero: false }],
    );
    const net = decodeVectorNetwork(blob, { x: 2, y: 0.5 }, [{ styleID: 7, cornerRadius: 3 }]);
    expect(net.vertices).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2, style: { styleID: 7, cornerRadius: 3 } }]);
    expect(net.segments[1]).toEqual({ start: 1, end: 2, tangentStart: { x: 2, y: 0 }, tangentEnd: { x: 0, y: -0.5 } });
    expect(net.regions).toEqual([{ loops: [[0, 1, 2]], windingRule: 'evenodd' }]);
  });

  it('rejects truncated and inconsistent blobs', () => {
    const blob = encodeNetwork([{ x: 0, y: 0 }], [{ start: 0, end: 0 }], []);
    expect(() => decodeVectorNetwork(blob.subarray(0, blob.length - 4))).toThrow(VectorNetworkError);
    expect(() => decodeVectorNetwork(encodeNetwork([{ x: 0, y: 0 }], [{ start: 0, end: 5 }], []))).toThrow(/missing vertex/);
  });

  it.skipIf(!hasLarge('rest/radix-icons.document.json'))('matches the REST vectorNetwork of every radix-icons vector', () => {
    const doc = buildTree(decodeFig(readFileSync(`${FIXTURES}radix-icons.fig`)));
    const rest = JSON.parse(readFileSync(`${LARGE_FIXTURES}rest/radix-icons.document.json`, 'utf8'));
    let compared = 0;
    const visit = (r: { id: string; vectorNetwork?: { vertices: { position: ir.Vec2 }[]; segments: { start: number; end: number }[]; regions: { loops: number[][] }[] | null }; children?: unknown[] }): void => {
      for (const child of (r.children ?? []) as (typeof r)[]) visit(child);
      const vd = doc.byGuid.get(r.id)?.change.vectorData;
      if (!r.vectorNetwork || vd?.vectorNetworkBlob === undefined) return;
      // REST reports the network unscaled (normalizedSize space).
      const net = decodeVectorNetwork(doc.file.blobs[vd.vectorNetworkBlob]!);
      expect(net.vertices.map((v) => [v.x, v.y])).toEqual(r.vectorNetwork.vertices.map((v) => [expect.closeTo(v.position.x, 4), expect.closeTo(v.position.y, 4)]));
      expect(net.segments.map((s) => [s.start, s.end])).toEqual(r.vectorNetwork.segments.map((s) => [s.start, s.end]));
      expect(net.regions.map((g) => g.loops)).toEqual((r.vectorNetwork.regions ?? []).map((g) => g.loops));
      compared++;
    };
    visit(rest.document);
    expect(compared).toBeGreaterThan(800);
  });
});

describe('vector network → PathNode', () => {
  it('emits one closed sub-path per region loop, re-orienting reversed segments', () => {
    const blob = encodeNetwork(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      // Second segment listed end → start.
      [{ start: 0, end: 1 }, { start: 2, end: 1 }, { start: 2, end: 0, t1: [-5, 0], t2: [0, 5] }],
      [{ loops: [[0, 1, 2]], nonzero: false }],
    );
    const { path } = translate(blob);
    expect(path.pathsAreExact).toBe(true);
    expect(path.paths).toEqual([
      {
        windingRule: 'evenodd',
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 10, y: 0 },
          { type: 'L', x: 10, y: 10 },
          { type: 'C', x1: 5, y1: 10, x2: 0, y2: 5, x: 0, y: 0 },
          { type: 'Z' },
        ],
      },
    ]);
  });

  it('chains segments outside regions into open sub-paths starting at a dead end', () => {
    const blob = encodeNetwork(
      [{ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ start: 0, end: 2 }, { start: 1, end: 0 }],
      [],
    );
    const { path } = translate(blob);
    expect(path.paths).toHaveLength(1);
    // Not split at the middle vertex; starts at the first dead end found (segment 0's end).
    expect(path.paths[0]!.commands).toEqual([
      { type: 'M', x: 10, y: 0 },
      { type: 'L', x: 5, y: 5 },
      { type: 'L', x: 0, y: 0 },
    ]);
  });

  it('takes stroke caps from the end vertices of an open path', () => {
    const blob = encodeNetwork(
      [{ x: 0, y: 0, style: 1 }, { x: 10, y: 0 }],
      [{ start: 0, end: 1 }],
      [],
    );
    const { path } = translate(blob, {
      strokeCap: 'ROUND',
      vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 10 }, styleOverrideTable: [{ styleID: 1, strokeCap: 'ARROW_LINES' }] },
    });
    expect(path.stroke?.startCap).toBe('line-arrow');
    expect(path.stroke?.endCap).toBe('round');
    expect(path.pathsAreExact).toBe(true);
  });

  it('marks paths inexact for vertex corner radius and keeps going', () => {
    const blob = encodeNetwork(
      [{ x: 0, y: 0, style: 1 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
      [{ loops: [[0, 1, 2]] }],
    );
    const { path, reporter } = translate(blob, {
      vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 10 }, styleOverrideTable: [{ styleID: 1, cornerRadius: 2 }] },
    });
    expect(path.pathsAreExact).toBe(false);
    expect(reporter.warnings.map((w) => w.code)).toContain('vector-paths-approximated');
  });

  it('falls back to the fill outline (with a warning) for a malformed network', () => {
    const { path, reporter } = translate(new Uint8Array([1, 0, 0, 0]));
    expect(path.type).toBe('path');
    expect(path.paths).toEqual([]);
    expect(reporter.warnings.map((w) => w.code)).toContain('invalid-vector-network');
  });
});

function as<T extends ir.Node['type']>(node: ir.Node, type: T): Extract<ir.Node, { type: T }> {
  if (node.type !== type) throw new Error(`expected ${type}, got ${node.type} (${node.id})`);
  return node as Extract<ir.Node, { type: T }>;
}

/** Encodes path commands as a kiwi `commandsBlob`. */
function encodeCommands(commands: ir.PathCommand[]): Uint8Array {
  const records: number[][] = commands.map((c) =>
    c.type === 'Z' ? [0] : c.type === 'M' ? [1, c.x, c.y] : c.type === 'L' ? [2, c.x, c.y] : c.type === 'Q' ? [3, c.x1, c.y1, c.x, c.y] : [4, c.x1, c.y1, c.x2, c.y2, c.x, c.y],
  );
  const bytes = new Uint8Array(records.reduce((n, r) => n + 1 + (r.length - 1) * 4, 0));
  const view = new DataView(bytes.buffer);
  let o = 0;
  for (const r of records) {
    bytes[o++] = r[0]!;
    for (const v of r.slice(1)) {
      view.setFloat32(o, v, true);
      o += 4;
    }
  }
  return bytes;
}

const SOLID = (r: number, g: number, b: number): NonNullable<NodeChange['fillPaints']>[number] => ({ type: 'SOLID', color: { r, g, b, a: 1 }, visible: true, opacity: 1 });
const vd = (styleOverrideTable: NodeChange[] = []): NodeChange['vectorData'] => ({ vectorNetworkBlob: 0, normalizedSize: { x: 10, y: 10 }, styleOverrideTable });

/** Every exact, visibly stroked path node of a translated fixture. */
function strokedExactPaths(t: ReturnType<typeof fixture>): ir.PathNode[] {
  return nodesOf(t).filter((n): n is ir.PathNode => n.type === 'path' && n.pathsAreExact && !!n.stroke?.paints.some((p) => p.visible));
}

describe('open region loops (V1)', () => {
  it('leaves a region loop that does not return to its start open, and takes its caps from its end vertices', () => {
    // Figma lists an open run 0→1→2→3 as a region loop: filled with an implicit close, not stroked along it.
    const blob = encodeNetwork(
      [{ x: 0, y: 0, style: 1 }, { x: 5, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 0 }],
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
      [{ loops: [[0, 1, 2]] }],
    );
    const { path } = translate(blob, { strokeCap: 'NONE', vectorData: vd([{ styleID: 1, strokeCap: 'ROUND' }]) });
    expect(path.paths[0]!.commands.map((c) => c.type)).toEqual(['M', 'L', 'L', 'L']);
    expect(path.stroke).toMatchObject({ startCap: 'round', endCap: 'none' });
    expect(path.pathsAreExact).toBe(true);
  });

  it('still closes a loop that returns to its start', () => {
    const blob = encodeNetwork([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }], [{ loops: [[0, 1, 2]] }]);
    expect(translate(blob).path.paths[0]!.commands.at(-1)).toEqual({ type: 'Z' });
  });

  it('never closes a sub-path with a chord on real icons (radix-icons 2001:5602)', () => {
    const t = fixture('radix-icons.fig');
    const open = as(byId(t, '2001:5602'), 'path');
    expect(open.paths.flatMap((p) => p.commands).some((c) => c.type === 'Z')).toBe(false);
    // Corpus-wide: every closed sub-path of an exact stroked path ends on its start point.
    for (const node of strokedExactPaths(t)) {
      for (const path of node.paths) {
        let start = { x: 0, y: 0 };
        let at = { x: 0, y: 0 };
        for (const c of path.commands) {
          if (c.type === 'M') start = at = { x: c.x, y: c.y };
          else if (c.type === 'Z') {
            expect(Math.hypot(at.x - start.x, at.y - start.y), `${node.id} closes with a chord`).toBeLessThan(1e-3);
            at = start;
          } else at = { x: c.x, y: c.y };
        }
      }
    }
  });
});

describe('exactness flag and joins (V3, V4)', () => {
  it('keeps the inexact verdict of the cap check (different caps on two open sub-paths)', () => {
    const blob = encodeNetwork(
      [{ x: 0, y: 0, style: 1 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }],
      [{ start: 0, end: 1 }, { start: 2, end: 3 }],
      [],
    );
    const { path, reporter } = translate(blob, { vectorData: vd([{ styleID: 1, strokeCap: 'ROUND' }]) });
    expect(path.pathsAreExact).toBe(false);
    expect(reporter.warnings.map((w) => w.code)).toContain('vector-paths-approximated');
    expect(as(byId(fixture('radix-icons.fig'), '2001:4229'), 'path').pathsAreExact).toBe(false);
  });

  const triangle = (styles: number[]) =>
    encodeNetwork(
      [{ x: 0, y: 0, style: styles[0] }, { x: 10, y: 0, style: styles[1] }, { x: 5, y: 8, style: styles[2] }],
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
      [],
    );
  const JOIN_STYLES = vd([{ styleID: 1, strokeJoin: 'ROUND' }, { styleID: 2, strokeJoin: 'BEVEL' }]);

  it('uses the per-vertex join when every corner shares it', () => {
    const { path } = translate(triangle([1, 1, 1]), { strokeJoin: 'MITER', vectorData: JOIN_STYLES });
    expect(path.stroke?.join).toBe('round');
    expect(path.pathsAreExact).toBe(true);
    expect(as(byId(fixture('radix-icons.fig'), '2001:4224'), 'path').stroke?.join).toBe('round');
  });

  it('marks mixed corner joins inexact', () => {
    const { path } = translate(triangle([1, 2, 0]), { strokeJoin: 'MITER', vectorData: JOIN_STYLES });
    expect(path.pathsAreExact).toBe(false);
  });
});

describe('stroke alignment (V6)', () => {
  const square = encodeNetwork(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
    [{ loops: [[0, 1, 2, 3]] }],
  );
  // 0→1→3→2→0 crosses itself.
  const bowtie = encodeNetwork(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }],
    [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
    [{ loops: [[0, 1, 2, 3]] }],
  );
  const openPath = encodeNetwork([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], [{ start: 0, end: 1 }, { start: 1, end: 2 }], []);

  // A closed square plus a dangling open segment 2 → 4.
  const mixed = encodeNetwork(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 20, y: 20 }],
    [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }, { start: 2, end: 4 }],
    [{ loops: [[0, 1, 2, 3]] }],
  );
  const align = (path: ir.PathNode): string | undefined => path.stroke?.align;

  it('keeps inside/outside strokes exact on simple closed paths', () => {
    for (const strokeAlign of ['INSIDE', 'OUTSIDE'] as const) {
      const { path } = translate(square, { strokeAlign });
      expect([path.pathsAreExact, align(path)], `${strokeAlign} square`).toEqual([true, strokeAlign.toLowerCase()]);
      expect(translate(bowtie, { strokeAlign }).path.pathsAreExact, `${strokeAlign} bowtie`).toBe(false);
    }
    expect(translate(openPath, { strokeAlign: 'CENTER' }).path.pathsAreExact).toBe(true);
    expect(translate(bowtie, { strokeAlign: 'CENTER' }).path.pathsAreExact).toBe(true);
  });

  it('strokes an all-open path centred (as Figma does) and keeps it exact', () => {
    for (const strokeAlign of ['INSIDE', 'OUTSIDE'] as const) {
      const { path, reporter } = translate(openPath, { strokeAlign });
      expect([path.pathsAreExact, align(path)], strokeAlign).toEqual([true, 'center']);
      expect(reporter.warnings).toEqual([]);
    }
  });

  it('marks inside/outside strokes on a mix of open and closed sub-paths inexact', () => {
    for (const strokeAlign of ['INSIDE', 'OUTSIDE'] as const) {
      const { path, reporter } = translate(mixed, { strokeAlign });
      expect([path.pathsAreExact, align(path)], strokeAlign).toEqual([false, strokeAlign.toLowerCase()]);
      expect(reporter.warnings.map((w) => w.message)).toEqual([expect.stringContaining('mix of open and closed sub-paths')]);
    }
    expect(translate(mixed, { strokeAlign: 'CENTER' }).path.pathsAreExact).toBe(true);
  });

  it('keeps a dashed inside/outside open path without fill geometry inexact (Figma draws it 2w wide)', () => {
    const dashed: Partial<NodeChange> = { strokeAlign: 'INSIDE', dashPattern: [4, 4] };
    const { path, reporter } = translate(openPath, dashed);
    expect([path.pathsAreExact, align(path)]).toEqual([false, 'inside']);
    expect(reporter.warnings.map((w) => w.message)).toEqual([expect.stringContaining('dashed inside stroke on an open path without fill geometry')]);
    // With a fill geometry entry (even an empty one) Figma strokes it centred, w wide.
    const withFill = translate(openPath, { ...dashed, fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1 }] }, [encodeCommands([])]).path;
    expect([withFill.pathsAreExact, align(withFill)]).toEqual([true, 'center']);
  });
});

describe('crossesItself', () => {
  const polyline = (points: [number, number][], close = false): ir.Path[] => [
    { windingRule: 'nonzero', commands: [...points.map(([x, y], i) => ({ type: i === 0 ? ('M' as const) : ('L' as const), x, y })), ...(close ? [{ type: 'Z' as const }] : [])] },
  ];

  it('finds no crossing on a 10k-edge simple polyline, fast', () => {
    // A zigzag and a closed 10k-gon: dense, non-crossing, adjacent edges share vertices.
    const zigzag = polyline(Array.from({ length: 10_001 }, (_, i) => [i, i % 2 ? 10 : 0]));
    const circle = polyline(Array.from({ length: 10_000 }, (_, i) => [Math.cos((i / 10_000) * 2 * Math.PI) * 100, Math.sin((i / 10_000) * 2 * Math.PI) * 100]), true);
    for (const paths of [zigzag, circle]) {
      const started = performance.now();
      expect(crossesItself(paths)).toBe('simple');
      // ~5 ms on a laptop; the old pair loop took ~2 s at 10k edges.
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it('finds the crossing of a bow-tie, and of two separate sub-paths', () => {
    expect(crossesItself(polyline([[0, 0], [10, 0], [0, 10], [10, 10]], true))).toBe('crosses');
    const plus: ir.Path[] = [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 5 }, { type: 'L', x: 10, y: 5 }, { type: 'M', x: 5, y: 0 }, { type: 'L', x: 5, y: 10 }] }];
    expect(crossesItself(plus)).toBe('crosses');
    // A crossing hidden in a long polyline (the grid path, > 256 edges).
    const long: [number, number][] = Array.from({ length: 2000 }, (_, i) => [i, i % 2 ? 10 : 0]);
    expect(crossesItself(polyline([...long, [1000.5, -5], [1000.5, 20]]))).toBe('crosses');
    expect(crossesItself(polyline(long))).toBe('simple');
  });

  it('answers unknown past its edge budget, which the translator treats as possibly crossing', () => {
    const huge = polyline(Array.from({ length: MAX_CROSSING_EDGES + 2 }, (_, i) => [i, i % 2]));
    expect(crossesItself(huge)).toBe('unknown');
    // A closed region past the budget: an inside stroke on it is marked inexact.
    const n = MAX_CROSSING_EDGES + 1;
    const vertices = Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * 2 * Math.PI) * 5 + 5, y: Math.sin((i / n) * 2 * Math.PI) * 5 + 5 }));
    const segments = vertices.map((_, i) => ({ start: i, end: (i + 1) % n }));
    const blob = encodeNetwork(vertices, segments, [{ loops: [segments.map((_, i) => i)] }]);
    const { path, reporter } = translate(blob, { strokeAlign: 'INSIDE' });
    expect(path.pathsAreExact).toBe(false);
    expect(reporter.warnings.map((w) => w.message)).toEqual([expect.stringContaining('too complex to check for self-intersection')]);
  });
});

describe('non-finite coordinates (V5)', () => {
  it('rejects a vector network with a NaN coordinate and falls back to the fill outline', () => {
    const blob = encodeNetwork([{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }], [{ start: 0, end: 1 }], []);
    const { path, reporter } = translate(blob);
    expect(reporter.warnings.map((w) => w.code)).toContain('corrupt-geometry');
    expect(JSON.stringify(path)).not.toContain('null');
  });

  it('decodeCommandsBlob returns only finite commands and reports the skipped records', () => {
    const bytes = encodeCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: Number.POSITIVE_INFINITY, y: 0 },
      { type: 'L', x: 1, y: 1 },
      { type: 'Z' },
      { type: 'M', x: Number.NaN, y: 0 },
      { type: 'L', x: 2, y: 2 },
      { type: 'M', x: 3, y: 3 },
      { type: 'L', x: 4, y: 4 },
    ]);
    const skipped: number[] = [];
    expect(decodeCommandsBlob(bytes, (offset) => skipped.push(offset))).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 1 },
      { type: 'Z' },
      { type: 'M', x: 3, y: 3 },
      { type: 'L', x: 4, y: 4 },
    ]);
    expect(skipped).toHaveLength(2);
    // Backward compatible: the callback is optional.
    expect(decodeCommandsBlob(bytes)).toHaveLength(5);
  });
});

describe('per-region fills (V7)', () => {
  // Two triangles; region 0 has its own red fill (style 3), region 1 uses the node's blue fill.
  const blob = encodeNetwork(
    [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 10 }, { x: 5, y: 10 }, { x: 10, y: 5 }],
    [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }, { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 3 }],
    [{ loops: [[0, 1, 2]], style: 3 }, { loops: [[3, 4, 5]] }],
  );
  const red = encodeCommands([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 5, y: 0 }, { type: 'L', x: 0, y: 5 }, { type: 'Z' }]);
  const blue = encodeCommands([{ type: 'M', x: 10, y: 10 }, { type: 'L', x: 5, y: 10 }, { type: 'L', x: 10, y: 5 }, { type: 'Z' }]);
  const change: Partial<NodeChange> = {
    fillPaints: [SOLID(0, 0, 1)],
    vectorData: vd([{ styleID: 3, fillPaints: [SOLID(1, 0, 0)] }]),
    fillGeometry: [
      { windingRule: 'NONZERO', commandsBlob: 1, styleID: 3 },
      { windingRule: 'NONZERO', commandsBlob: 2, styleID: 0 },
    ],
  };

  it('emits a group of one exact fill path per fill style plus a stroke-only path', () => {
    const { node } = translateAny(blob, change, [red, blue], 'C:1');
    const group = as(node, 'group');
    expect(group).toMatchObject({ id: '1:2', fills: [], componentRef: 'C:1' });
    expect(group.stroke).toBeUndefined();
    expect(group.children.map((c) => [c.id, c.componentRef])).toEqual([
      ['1:2#fill0', 'C:1#fill0'],
      ['1:2#fill1', 'C:1#fill1'],
      ['1:2#stroke', 'C:1#stroke'],
    ]);
    const [fill0, fill1, stroke] = group.children.map((c) => as(c, 'path'));
    expect(fill0!.fills.map((p) => p.type === 'solid' && p.color)).toEqual([{ r: 1, g: 0, b: 0, a: 1 }]);
    expect(fill1!.fills.map((p) => p.type === 'solid' && p.color)).toEqual([{ r: 0, g: 0, b: 1, a: 1 }]);
    expect(fill0!.paths[0]!.commands[1]).toEqual({ type: 'L', x: 5, y: 0 });
    expect([fill0!.pathsAreExact, fill0!.stroke]).toEqual([true, undefined]);
    expect(stroke!.fills).toEqual([]);
    expect(stroke!.stroke?.paints).toHaveLength(1);
    expect(stroke!.paths.flatMap((p) => p.commands).filter((c) => c.type === 'M')).toHaveLength(2);
  });

  it('keeps the fill outline on the stroke path, to clip an inside/outside stroke outline to', () => {
    const { node } = translateAny(blob, { ...change, strokeGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1 }] }, [red, blue]);
    const stroke = as(as(node, 'group').children.at(-1)!, 'path');
    expect(stroke.fills).toEqual([]);
    expect(stroke.geometry?.fill?.map((p) => p.commands.length)).toEqual([4, 4]);
    expect(stroke.geometry?.stroke).toHaveLength(1);
  });

  it('keeps a single path when every region shares one fill, using that fill', () => {
    const { path } = translate(blob, { ...change, fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1, styleID: 3 }] }, [red]);
    expect(path.fills.map((p) => p.type === 'solid' && p.color)).toEqual([{ r: 1, g: 0, b: 0, a: 1 }]);
    expect(path.pathsAreExact).toBe(true);
  });

  it('paints every region of f2s-vector "Complex" with its own colour, back to front', () => {
    const group = as(byName(fixture('f2s-vector.fig'), 'Complex'), 'group');
    const colours = group.children.filter((c) => c.id.includes('#fill')).map((c) => {
      const p = c.fills[0]!;
      return p.type === 'solid' ? [p.color.r, p.color.g, p.color.b].map((v) => Math.round(v * 100) / 100) : p.type;
    });
    // red, yellow, orange, purple, green, then the node's own blue for the unstyled region.
    expect(colours).toEqual([[1, 0, 0], [1, 1, 0], [1, 0.65, 0], [0.5, 0, 0.5], [0, 0.5, 0], [0, 0, 1]]);
    expect(group.children.at(-1)!.id).toBe('0:5#stroke');
  });
});
