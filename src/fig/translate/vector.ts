import type * as ir from '../../ir.ts';
import { IDENTITY } from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode, NodeChange } from '../types.ts';
import { decodeVectorNetwork, VectorNetworkError, type NetworkSegment, type NetworkVertex, type VectorNetwork } from '../vector-network.ts';
import { finite } from './common.ts';
import type { TranslateContext } from './context.ts';
import { decodeGeometry } from './geometry.ts';
import { translatePaints } from './paints.ts';
import { strokeCapFromKiwi } from './stroke.ts';
import { fillStyleIdOf, styledPaints, withStyleId } from './styles.ts';

/** Decodes the node's vector network in local (size) space, or undefined (with a warning when malformed). */
export function networkOf(node: FigNode, ctx: TranslateContext): VectorNetwork | undefined {
  const vd = node.change.vectorData;
  if (vd?.vectorNetworkBlob === undefined) return undefined;
  const bytes = ctx.blob(vd.vectorNetworkBlob, node);
  if (!bytes) return undefined;
  const size = node.change.size;
  const ns = vd.normalizedSize;
  const scale = {
    x: ns && ns.x !== 0 && size ? finite(size.x / ns.x, 1) : 1,
    y: ns && ns.y !== 0 && size ? finite(size.y / ns.y, 1) : 1,
  };
  try {
    return decodeVectorNetwork(bytes, scale, vd.styleOverrideTable);
  } catch (error) {
    if (error instanceof VectorNetworkError && error.nonFinite) {
      ctx.warn('corrupt-geometry', `vector network rejected: ${error.message}`, node);
    } else {
      ctx.warn('invalid-vector-network', `could not decode vector network: ${(error as Error).message}`, node);
    }
    return undefined;
  }
}

/**
 * VECTOR (and LINE with a network) → path node built from the vector network,
 * or — when its regions carry different fills — a group of one fill path per
 * fill style plus a stroke-only path on top (see `regionFillRuns`).
 */
export function translateVector(base: ir.BaseNode, node: FigNode, ctx: TranslateContext): ir.PathNode | ir.GroupNode {
  const network = networkOf(node, ctx);
  if (!network || network.segments.length === 0) {
    const paths = base.geometry?.fill ?? decodeGeometry(node.change.fillGeometry, ctx, node);
    if (!network && paths.length === 0 && !base.geometry?.stroke) {
      ctx.warn('missing-geometry', 'vector has neither a vector network nor fill geometry', node);
    }
    // A fill outline strokes differently from the centre line Figma strokes.
    const stroked = !!base.stroke?.paints.some((p) => p.visible);
    return { ...base, type: 'path', paths, pathsAreExact: !stroked };
  }
  const runs = regionFillRuns(base, node, network, ctx);
  if (!runs) return buildPathNode(base, node, network, ctx);
  if (runs.length === 1) return buildPathNode({ ...base, fills: runs[0]!.fills }, node, network, ctx);
  return regionFillGroup(base, node, network, runs, ctx);
}

interface FillRun {
  fills: ir.Paint[];
  /** Figma's fill outlines for this run (empty when the run is rebuilt from the network). */
  paths: ir.Path[];
}

/**
 * Figma fills each region with its style's `fillPaints` (via
 * `vectorData.styleOverrideTable`), falling back to the node's fills. Returns
 * the fill outlines grouped into consecutive runs of identical paints, back →
 * front, or undefined when every region uses the node's own fills.
 */
function regionFillRuns(base: ir.BaseNode, node: FigNode, network: VectorNetwork, ctx: TranslateContext): FillRun[] | undefined {
  const styles = new Map<number, NodeChange>();
  for (const entry of node.change.vectorData?.styleOverrideTable ?? []) {
    if (entry.styleID !== undefined && !styles.has(entry.styleID)) styles.set(entry.styleID, entry);
  }
  const nodeKey = JSON.stringify(base.fills);
  const fillsOf = (style: NodeChange | undefined): ir.Paint[] => {
    if (!style) return base.fills;
    const styleId = fillStyleIdOf(style, ctx);
    if (style.fillPaints === undefined && !styleId) return base.fills;
    return withStyleId(translatePaints(styledPaints(style.fillPaints, styleId, ctx), ctx, node), styleId);
  };

  const entries: { fills: ir.Paint[]; paths: ir.Path[] }[] = [];
  const geometry = node.change.fillGeometry ?? [];
  if (geometry.length > 0) {
    for (const entry of geometry) {
      const style = entry.styleID ? styles.get(entry.styleID) : undefined;
      entries.push({ fills: fillsOf(style), paths: decodeGeometry([entry], ctx, node) });
    }
  } else {
    for (const region of network.regions) entries.push({ fills: fillsOf(region.style), paths: [] });
  }
  if (entries.every((e) => JSON.stringify(e.fills) === nodeKey)) return undefined;

  const runs: (FillRun & { key: string })[] = [];
  for (const entry of entries) {
    const key = JSON.stringify(entry.fills);
    const last = runs.at(-1);
    if (last && last.key === key) last.paths.push(...entry.paths);
    else runs.push({ key, fills: entry.fills, paths: [...entry.paths] });
  }
  if (geometry.length === 0 && runs.length > 1) {
    // No outlines to split by style: keep one path, paint it with the first style.
    ctx.warn('vector-paths-approximated', 'regions with different fills but no fill geometry; using the first region fill', node);
    return [runs[0]!];
  }
  return runs.map(({ fills, paths }) => ({ fills, paths }));
}

/** Per-region fills: `group(<id>) [fill path × runs…, stroke path]`, each child in the group's space. */
function regionFillGroup(base: ir.BaseNode, node: FigNode, network: VectorNetwork, runs: FillRun[], ctx: TranslateContext): ir.GroupNode {
  const { stroke, geometry, fills: _fills, ...rest } = base;
  const child = (suffix: string): ir.BaseNode => {
    const out: ir.BaseNode = {
      id: `${base.id}#${suffix}`,
      name: `${base.name} ${suffix}`,
      visible: true,
      locked: base.locked,
      opacity: 1,
      blendMode: 'pass-through',
      transform: { ...IDENTITY },
      size: { ...base.size },
      fills: [],
      effects: [],
    };
    if (base.componentRef) out.componentRef = `${base.componentRef}#${suffix}`;
    return out;
  };
  const children: ir.Node[] = [];
  runs.forEach((run, n) => {
    if (run.fills.length === 0 || run.paths.length === 0) return;
    children.push({ ...child(`fill${n}`), fills: run.fills, geometry: { fill: run.paths }, type: 'path', paths: run.paths, pathsAreExact: true });
  });
  if (stroke?.paints.some((p) => p.visible)) {
    const strokeBase: ir.BaseNode = { ...child('stroke'), stroke };
    // The fill outline stays with the stroke: an inside/outside stroke outline is clipped to it.
    if (geometry?.stroke) strokeBase.geometry = geometry.fill ? { fill: geometry.fill, stroke: geometry.stroke } : { stroke: geometry.stroke };
    children.push(buildPathNode(strokeBase, node, network, ctx));
  }
  return { ...rest, fills: [], type: 'group', children };
}

function buildPathNode(base: ir.BaseNode, node: FigNode, network: VectorNetwork, ctx: TranslateContext): ir.PathNode {
  const c = node.change;
  const paths: ir.Path[] = [];
  const covered = new Set<number>();
  const subPaths: SubPath[] = [];
  let exact = true;
  const inexact = (reason: string): void => {
    if (exact) ctx.warn('vector-paths-approximated', `vector paths approximate the render (${reason}); exact outlines kept in geometry`, node);
    exact = false;
  };

  for (const region of network.regions) {
    const commands: ir.PathCommand[] = [];
    for (const loop of region.loops) {
      const segments = loop.map((i) => network.segments[i]).filter((s): s is NetworkSegment => !!s);
      loop.forEach((i) => covered.add(i));
      for (const sub of loopSubPaths(network, orientLoop(segments))) {
        subPaths.push(sub);
        commands.push(...subPathCommands(network, sub));
      }
    }
    if (commands.length > 0) paths.push({ windingRule: region.windingRule, commands });
  }

  const chains = chainSegments(network, covered);
  if (chains.length > 0) {
    subPaths.push(...chains);
    // With no regions at all Figma fills the open/closed chains themselves; use its winding rule.
    const winding = network.regions.length === 0 ? (base.geometry?.fill?.[0]?.windingRule ?? 'nonzero') : 'nonzero';
    const commands = chains.flatMap((chain) => subPathCommands(network, chain));
    if (commands.length > 0) paths.push({ windingRule: winding, commands });
    // Figma fills region-less networks itself; only simple chains are reproduced faithfully.
    const filled = base.fills.some((p) => p.visible);
    if (filled && network.regions.length > 0) inexact('segments outside any region');
    else if (filled && hasJunction(network, covered)) inexact('filled open network with junctions');
  }

  const nodeRadius = finite(c.cornerRadius, 0);
  if (nodeRadius > 0 || network.vertices.some((v) => finite(v.style?.cornerRadius, 0) > 0)) inexact('corner radius');
  if (c.variableWidthPoints && c.variableWidthPoints.length > 0) inexact('variable stroke width');

  const stroke = base.stroke ? { ...base.stroke } : undefined;
  if (stroke) {
    applyEndpointCaps(stroke, network, subPaths, node, ctx, inexact);
    applyVertexJoins(stroke, network, subPaths, c.strokeJoin, inexact);
    const visible = stroke.paints.some((p) => p.visible);
    const open = subPaths.some((sub) => !sub.closed);
    if (stroke.align !== 'center' && open && subPaths.every((sub) => !sub.closed)) {
      // Figma strokes open sub-paths centred whatever the alignment says, so
      // this is exactly a centred stroke. Except a dashed one on a node
      // without fill geometry, which Figma draws 2w wide (its strokeGeometry
      // and reference render, auto-layout-playground 1710:2035, 1620:2627).
      if (visible && stroke.dashPattern.length > 0 && !c.fillGeometry?.length) inexact(`dashed ${stroke.align} stroke on an open path without fill geometry`);
      else stroke.align = 'center';
    } else if (stroke.align !== 'center' && visible) {
      // Figma strokes an inside/outside path as a 2w band clipped to the fill,
      // which a target reproduces for simple closed paths only: one stroke
      // cannot be centred on the open parts and inside/outside on the closed
      // ones, and a self-crossing outline has no well-defined inside.
      if (open) inexact(`${stroke.align} stroke on a mix of open and closed sub-paths`);
      else {
        const crossing = crossesItself(paths);
        if (crossing === 'crosses') inexact(`${stroke.align} stroke on a self-intersecting path`);
        else if (crossing === 'unknown') inexact(`${stroke.align} stroke on a path too complex to check for self-intersection`);
      }
    }
  }
  const result: ir.PathNode = { ...base, type: 'path', paths, pathsAreExact: exact };
  if (stroke) result.stroke = stroke;
  return result;
}

function hasJunction(network: VectorNetwork, covered: ReadonlySet<number>): boolean {
  const degree = new Map<number, number>();
  network.segments.forEach((s, i) => {
    if (covered.has(i)) return;
    degree.set(s.start, (degree.get(s.start) ?? 0) + 1);
    degree.set(s.end, (degree.get(s.end) ?? 0) + 1);
  });
  return [...degree.values()].some((d) => d > 2);
}

interface Oriented {
  from: number;
  to: number;
  /** Absolute control points. */
  c1: ir.Vec2;
  c2: ir.Vec2;
  straight: boolean;
}

function orient(network: VectorNetwork, s: NetworkSegment, reversed: boolean): Oriented {
  const from = reversed ? s.end : s.start;
  const to = reversed ? s.start : s.end;
  const tFrom = reversed ? s.tangentEnd : s.tangentStart;
  const tTo = reversed ? s.tangentStart : s.tangentEnd;
  const a = network.vertices[from]!;
  const b = network.vertices[to]!;
  return {
    from,
    to,
    c1: { x: a.x + tFrom.x, y: a.y + tFrom.y },
    c2: { x: b.x + tTo.x, y: b.y + tTo.y },
    straight: tFrom.x === 0 && tFrom.y === 0 && tTo.x === 0 && tTo.y === 0,
  };
}

/** Loop segments may be listed in either direction; chain them head to tail. */
function orientLoop(segments: NetworkSegment[]): { segment: NetworkSegment; reversed: boolean }[] {
  const out: { segment: NetworkSegment; reversed: boolean }[] = [];
  let cursor: number | undefined;
  segments.forEach((segment, i) => {
    let reversed = false;
    if (cursor === undefined) {
      const next = segments[i + 1];
      reversed = !!next && segment.end !== next.start && segment.end !== next.end && (segment.start === next.start || segment.start === next.end);
    } else {
      reversed = segment.start !== cursor && segment.end === cursor;
    }
    out.push({ segment, reversed });
    cursor = reversed ? segment.start : segment.end;
  });
  return out;
}

/**
 * Splits an oriented region loop into sub-paths at gaps. Figma lists an open
 * run of segments as a region loop too: it fills it with an implicit close but
 * does not stroke the closing edge, so only a run that returns to its start
 * vertex is closed.
 */
function loopSubPaths(network: VectorNetwork, loop: { segment: NetworkSegment; reversed: boolean }[]): SubPath[] {
  const out: SubPath[] = [];
  let steps: Oriented[] = [];
  const flush = (): void => {
    if (steps.length > 0) out.push({ steps, closed: steps[steps.length - 1]!.to === steps[0]!.from });
    steps = [];
  };
  for (const { segment, reversed } of loop) {
    const o = orient(network, segment, reversed);
    if (steps.length > 0 && steps[steps.length - 1]!.to !== o.from) flush();
    steps.push(o);
  }
  flush();
  return out;
}

function segmentCommand(network: VectorNetwork, o: Oriented): ir.PathCommand {
  const v = network.vertices[o.to]!;
  if (o.straight) return { type: 'L', x: v.x, y: v.y };
  return { type: 'C', x1: o.c1.x, y1: o.c1.y, x2: o.c2.x, y2: o.c2.y, x: v.x, y: v.y };
}

/** A run of head-to-tail segments; `closed` when it ends where it started. */
interface SubPath {
  steps: Oriented[];
  closed: boolean;
}

/**
 * Chains the segments not used by any region into maximal runs. Open runs
 * start at a dead end (a vertex of degree ≠ 2) so they are not split.
 */
function chainSegments(network: VectorNetwork, covered: ReadonlySet<number>): SubPath[] {
  const unused = new Set<number>();
  network.segments.forEach((_, i) => {
    if (!covered.has(i)) unused.add(i);
  });
  if (unused.size === 0) return [];
  const incident = new Map<number, number[]>();
  for (const i of unused) {
    const s = network.segments[i]!;
    for (const v of s.start === s.end ? [s.start] : [s.start, s.end]) {
      const list = incident.get(v) ?? [];
      list.push(i);
      incident.set(v, list);
    }
  }
  const degree = (v: number): number => (incident.get(v) ?? []).filter((i) => unused.has(i)).length;

  const chains: SubPath[] = [];
  while (unused.size > 0) {
    // Prefer an open end; otherwise any remaining segment (a cycle).
    let startSegment: number | undefined;
    let startVertex = -1;
    for (const i of unused) {
      const s = network.segments[i]!;
      if (degree(s.start) !== 2) {
        startSegment = i;
        startVertex = s.start;
        break;
      }
      if (degree(s.end) !== 2) {
        startSegment = i;
        startVertex = s.end;
        break;
      }
    }
    if (startSegment === undefined) {
      startSegment = unused.values().next().value!;
      startVertex = network.segments[startSegment]!.start;
    }

    const steps: Oriented[] = [];
    let current: number | undefined = startSegment;
    let at = startVertex;
    while (current !== undefined) {
      unused.delete(current);
      const s = network.segments[current]!;
      const reversed = s.start !== at;
      const o = orient(network, s, reversed);
      steps.push(o);
      at = o.to;
      if (at === startVertex) break;
      current = (incident.get(at) ?? []).find((i) => unused.has(i));
    }
    chains.push({ steps, closed: steps.length > 0 && steps[steps.length - 1]!.to === steps[0]!.from });
  }
  return chains;
}

function subPathCommands(network: VectorNetwork, chain: SubPath): ir.PathCommand[] {
  const first = chain.steps[0];
  if (!first) return [];
  const v = network.vertices[first.from]!;
  const commands: ir.PathCommand[] = [{ type: 'M', x: v.x, y: v.y }];
  for (const step of chain.steps) commands.push(segmentCommand(network, step));
  if (chain.closed) commands.push({ type: 'Z' });
  return commands;
}

/** Per-vertex `strokeCap` overrides at the ends of open sub-paths → stroke start/end caps. */
function applyEndpointCaps(
  stroke: ir.Stroke,
  network: VectorNetwork,
  subPaths: SubPath[],
  figNode: FigNode,
  ctx: TranslateContext,
  inexact: (reason: string) => void,
): void {
  const open = subPaths.filter((sub) => !sub.closed && sub.steps.length > 0);
  if (open.length === 0) return;
  const capAt = (vertex: number): ir.StrokeCap => {
    const cap = network.vertices[vertex]?.style?.strokeCap;
    return cap === undefined ? stroke.startCap : strokeCapFromKiwi(cap, ctx, figNode);
  };
  const ends = open.map((sub) => [capAt(sub.steps[0]!.from), capAt(sub.steps[sub.steps.length - 1]!.to)] as const);
  const [startCap, endCap] = ends[0]!;
  stroke.startCap = startCap;
  stroke.endCap = endCap;
  if (ends.some(([s, e]) => s !== startCap || e !== endCap)) inexact('different caps on several open sub-paths');
}

const JOINS: Record<fig.StrokeJoin, ir.Stroke['join']> = { MITER: 'miter', BEVEL: 'bevel', ROUND: 'round' };

/**
 * Figma joins each corner with its vertex's `strokeJoin` override (else the
 * node's). One join for every visible corner becomes the stroke's join; a mix
 * cannot be expressed. Smooth (tangent-continuous) vertices show no join.
 */
function applyVertexJoins(
  stroke: ir.Stroke,
  network: VectorNetwork,
  subPaths: SubPath[],
  nodeJoin: fig.StrokeJoin | undefined,
  inexact: (reason: string) => void,
): void {
  const joins = new Set<ir.Stroke['join']>();
  const visit = (vertex: number, incoming: Oriented, outgoing: Oriented): void => {
    if (isSmooth(network, incoming, outgoing)) return;
    const join = network.vertices[vertex]?.style?.strokeJoin ?? nodeJoin ?? 'MITER';
    joins.add(JOINS[join] ?? 'miter');
  };
  for (const { steps, closed } of subPaths) {
    for (let i = 0; i + 1 < steps.length; i++) visit(steps[i]!.to, steps[i]!, steps[i + 1]!);
    if (closed && steps.length > 1) visit(steps[0]!.from, steps[steps.length - 1]!, steps[0]!);
  }
  if (joins.size === 1) stroke.join = [...joins][0]!;
  else if (joins.size > 1) inexact('different stroke joins on several vertices');
}

/** Whether the path continues through the shared vertex without a corner. */
function isSmooth(network: VectorNetwork, incoming: Oriented, outgoing: Oriented): boolean {
  const v = network.vertices[incoming.to]!;
  const from = network.vertices[incoming.from]!;
  const to = network.vertices[outgoing.to]!;
  const back = [incoming.c2, incoming.c1, from].find((p) => p.x !== v.x || p.y !== v.y);
  const ahead = [outgoing.c1, outgoing.c2, to].find((p) => p.x !== v.x || p.y !== v.y);
  if (!back || !ahead) return true;
  const ix = v.x - back.x;
  const iy = v.y - back.y;
  const ox = ahead.x - v.x;
  const oy = ahead.y - v.y;
  const li = Math.hypot(ix, iy);
  const lo = Math.hypot(ox, oy);
  if (li === 0 || lo === 0) return true;
  const cross = (ix * oy - iy * ox) / (li * lo);
  const dot = (ix * ox + iy * oy) / (li * lo);
  return dot > 0 && Math.abs(cross) < 0.01;
}

/** LINE caps: per-vertex `strokeCap` overrides on the network's leftmost / rightmost vertex, else the node's cap. */
export function lineCapsOf(stroke: ir.Stroke, node: FigNode, ctx: TranslateContext): [ir.StrokeCap, ir.StrokeCap] {
  const network = networkOf(node, ctx);
  if (!network || network.vertices.length < 2) return [stroke.startCap, stroke.endCap];
  const sorted = [...network.vertices].sort((a, b) => a.x - b.x);
  const capOf = (vertex: NetworkVertex, fallback: ir.StrokeCap): ir.StrokeCap =>
    vertex.style?.strokeCap === undefined ? fallback : strokeCapFromKiwi(vertex.style.strokeCap, ctx, node);
  return [capOf(sorted[0]!, stroke.startCap), capOf(sorted[sorted.length - 1]!, stroke.endCap)];
}

/** Flattened edge count above which `crossesItself` answers `'unknown'` without looking. */
export const MAX_CROSSING_EDGES = 50_000;
/** Work budgets of `crossesItself` (grid entries, candidate pairs) before it answers `'unknown'`. */
const MAX_CROSSING_CELL_ENTRIES = 1 << 21;
const MAX_CROSSING_CANDIDATES = 8_000_000;

/**
 * Whether two non-adjacent edges of the outline (curves flattened in 8 steps)
 * properly cross. Edges are binned by bounding box into a uniform grid (cells
 * about one edge long) and only pairs sharing a cell are tested, each pair in
 * one cell only. Past the edge or work budget the answer is `'unknown'`,
 * which callers must treat as possibly crossing.
 */
export function crossesItself(paths: ir.Path[]): 'crosses' | 'simple' | 'unknown' {
  /** x0 y0 x1 y1 per edge. */
  const coords: number[] = [];
  /** Per edge: its sub-path, or −1 before the path's first move. */
  const sub: number[] = [];
  /** Per sub-path: first and last edge. */
  const subEdges: [number, number][] = [];
  for (const path of paths) {
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    let current = -1;
    const start = (): void => {
      current = subEdges.length;
      subEdges.push([sub.length, sub.length - 1]);
    };
    const edge = (nx: number, ny: number): void => {
      if (nx === x && ny === y) return;
      if (current >= 0) subEdges[current]![1] = sub.length;
      sub.push(current);
      coords.push(x, y, nx, ny);
      x = nx;
      y = ny;
    };
    for (const c of path.commands) {
      if (c.type === 'M') {
        x = sx = c.x;
        y = sy = c.y;
        start();
      } else if (c.type === 'Z') {
        edge(sx, sy);
        start();
      } else if (c.type === 'L') edge(c.x, c.y);
      else {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          const u = 1 - t;
          if (c.type === 'Q') edge(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
          else edge(u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
        }
      }
    }
  }
  const n = sub.length;
  if (n > MAX_CROSSING_EDGES) return 'unknown';

  // Consecutive edges of a sub-path share a vertex, and so do its first and last.
  const adjacent = (i: number, j: number): boolean => {
    const s = sub[i]!;
    if (s < 0 || s !== sub[j]) return false;
    const [first, last] = subEdges[s]!;
    return j === i + 1 || (i === first && j === last);
  };

  const box = new Float64Array(n * 4); // x0 y0 x1 y1, min → max
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let extent = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const x0 = Math.min(coords[i]!, coords[i + 2]!);
    const y0 = Math.min(coords[i + 1]!, coords[i + 3]!);
    const x1 = Math.max(coords[i]!, coords[i + 2]!);
    const y1 = Math.max(coords[i + 1]!, coords[i + 3]!);
    box.set([x0, y0, x1, y1], i);
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
    extent += Math.max(x1 - x0, y1 - y0);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  // A small outline is one cell (all pairs); otherwise cells about one edge long, at most ~4n of them.
  let cols = 1;
  let rows = 1;
  if (n > 256) {
    const cell = Math.max(extent / n, Math.sqrt((width * height) / n), Number.MIN_VALUE);
    cols = Math.max(1, Math.min(Math.ceil(width / cell), 2 * n));
    rows = Math.max(1, Math.min(Math.ceil(height / cell), Math.floor((4 * n) / cols)));
  }
  const scaleX = width > 0 ? cols / width : 0;
  const scaleY = height > 0 ? rows / height : 0;
  const col = (v: number): number => Math.min(cols - 1, Math.floor((v - minX) * scaleX));
  const row = (v: number): number => Math.min(rows - 1, Math.floor((v - minY) * scaleY));

  // Bin every edge into the cells its bounding box covers (compressed rows: cell k holds cells[start[k] … start[k+1]]).
  const start = new Int32Array(cols * rows + 1);
  let entries = 0;
  for (let i = 0; i < n; i++) {
    const c0 = col(box[i * 4]!);
    const c1 = col(box[i * 4 + 2]!);
    const r0 = row(box[i * 4 + 1]!);
    const r1 = row(box[i * 4 + 3]!);
    entries += (c1 - c0 + 1) * (r1 - r0 + 1);
    if (entries > MAX_CROSSING_CELL_ENTRIES) return 'unknown';
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * cols + c + 1]! += 1;
  }
  for (let k = 1; k < start.length; k++) start[k]! += start[k - 1]!;
  const next = start.slice(0, cols * rows);
  const cells = new Int32Array(entries);
  for (let i = 0; i < n; i++) {
    for (let r = row(box[i * 4 + 1]!); r <= row(box[i * 4 + 3]!); r++) {
      for (let c = col(box[i * 4]!); c <= col(box[i * 4 + 2]!); c++) cells[next[r * cols + c]!++] = i;
    }
  }

  let candidates = 0;
  for (let k = 0; k < cols * rows; k++) {
    const to = start[k + 1]!;
    for (let p = start[k]!; p < to; p++) {
      const i = cells[p]!;
      for (let q = p + 1; q < to; q++) {
        if (++candidates > MAX_CROSSING_CANDIDATES) return 'unknown';
        const j = cells[q]!;
        // Crossing edges' boxes overlap; test each pair only in the cell holding the overlap's min corner.
        const ox = Math.max(box[i * 4]!, box[j * 4]!);
        const oy = Math.max(box[i * 4 + 1]!, box[j * 4 + 1]!);
        if (ox > Math.min(box[i * 4 + 2]!, box[j * 4 + 2]!) || oy > Math.min(box[i * 4 + 3]!, box[j * 4 + 3]!)) continue;
        if (row(oy) * cols + col(ox) !== k) continue;
        if (i < j ? adjacent(i, j) : adjacent(j, i)) continue;
        if (properlyCross(coords, i * 4, j * 4)) return 'crosses';
      }
    }
  }
  return 'simple';
}

/** Whether edges `coords[a … a+3]` and `coords[b … b+3]` cross at a point interior to both. */
function properlyCross(e: readonly number[], a: number, b: number): boolean {
  const eps = 1e-9;
  const ax = e[a]!;
  const ay = e[a + 1]!;
  const adx = e[a + 2]! - ax;
  const ady = e[a + 3]! - ay;
  const bx = e[b]!;
  const by = e[b + 1]!;
  const bdx = e[b + 2]! - bx;
  const bdy = e[b + 3]! - by;
  const d1 = adx * (by - ay) - ady * (bx - ax);
  const d2 = adx * (e[b + 3]! - ay) - ady * (e[b + 2]! - ax);
  const d3 = bdx * (ay - by) - bdy * (ax - bx);
  const d4 = bdx * (e[a + 3]! - by) - bdy * (e[a + 2]! - bx);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}
