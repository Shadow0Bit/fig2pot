import type { Vec2, WindingRule } from '../ir.ts';
import type { NodeChange } from './types.ts';

/**
 * A decoded `vectorData.vectorNetworkBlob`.
 *
 * Coordinates are already scaled from `vectorData.normalizedSize` space into
 * the node's `size` space (i.e. the node's local space).
 */
export interface VectorNetwork {
  vertices: NetworkVertex[];
  segments: NetworkSegment[];
  regions: NetworkRegion[];
}

export interface NetworkVertex {
  x: number;
  y: number;
  /** Entry of `styleOverrideTable` (cornerRadius, strokeCap, handleMirroring, …), if any. */
  style?: NodeChange;
}

export interface NetworkSegment {
  start: number;
  end: number;
  /** Tangent at `start`, relative to the start vertex. */
  tangentStart: Vec2;
  /** Tangent at `end`, relative to the end vertex. */
  tangentEnd: Vec2;
  style?: NodeChange;
}

export interface NetworkRegion {
  /** Each loop is a list of segment indices forming a closed ring (in any orientation). */
  loops: number[][];
  windingRule: WindingRule;
  /** Region style (typically per-region `fillPaints`), if any. */
  style?: NodeChange;
}

export class VectorNetworkError extends Error {
  override name = 'VectorNetworkError';
  /** True when the blob is well-formed but holds NaN / infinite coordinates. */
  readonly nonFinite: boolean;
  constructor(message: string, nonFinite = false) {
    super(message);
    this.nonFinite = nonFinite;
  }
}

/**
 * Decodes a vector network blob. Layout (all little endian):
 *
 *   u32 vertexCount, u32 segmentCount, u32 regionCount
 *   vertex  × n: u32 styleID, f32 x, f32 y
 *   segment × n: u32 styleID, u32 start, f32 tsx, f32 tsy, u32 end, f32 tex, f32 tey
 *   region  × n: u32 flags (bit 0 = NONZERO, rest = styleID), u32 loopCount,
 *                loop × n: u32 count, u32 segment × count
 *
 * `scale` maps blob coordinates to node-local ones: `size / normalizedSize`.
 * Throws `VectorNetworkError` on truncated or inconsistent data, and on any
 * non-finite vertex or tangent coordinate (`nonFinite` set).
 */
export function decodeVectorNetwork(
  bytes: Uint8Array,
  scale: Vec2 = { x: 1, y: 1 },
  styleOverrideTable: readonly NodeChange[] = [],
): VectorNetwork {
  if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y)) throw new VectorNetworkError('non-finite scale', true);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const need = (n: number): void => {
    if (offset + n > bytes.length) throw new VectorNetworkError('vector network blob is truncated');
  };
  const u32 = (): number => {
    need(4);
    const v = view.getUint32(offset, true);
    offset += 4;
    return v;
  };
  const f32 = (): number => {
    need(4);
    const v = view.getFloat32(offset, true);
    if (!Number.isFinite(v)) throw new VectorNetworkError(`non-finite coordinate at byte ${offset}`, true);
    offset += 4;
    return v;
  };

  const styles = new Map<number, NodeChange>();
  for (const entry of styleOverrideTable) {
    if (entry.styleID !== undefined) styles.set(entry.styleID, entry);
  }
  const styleFor = (id: number): NodeChange | undefined => (id === 0 ? undefined : styles.get(id));

  const vertexCount = u32();
  const segmentCount = u32();
  const regionCount = u32();
  // Cheap sanity check before allocating: every record needs at least 12 bytes.
  if ((vertexCount + segmentCount + regionCount) * 8 > bytes.length) {
    throw new VectorNetworkError('vector network blob header is inconsistent with its length');
  }

  const vertices: NetworkVertex[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const style = styleFor(u32());
    const x = f32() * scale.x;
    const y = f32() * scale.y;
    vertices.push(style ? { x, y, style } : { x, y });
  }

  const segments: NetworkSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const style = styleFor(u32());
    const start = u32();
    const tangentStart = { x: f32() * scale.x, y: f32() * scale.y };
    const end = u32();
    const tangentEnd = { x: f32() * scale.x, y: f32() * scale.y };
    if (start >= vertexCount || end >= vertexCount) {
      throw new VectorNetworkError(`segment ${i} references a missing vertex`);
    }
    const segment: NetworkSegment = { start, end, tangentStart, tangentEnd };
    if (style) segment.style = style;
    segments.push(segment);
  }

  const regions: NetworkRegion[] = [];
  for (let i = 0; i < regionCount; i++) {
    const flags = u32();
    const loopCount = u32();
    const loops: number[][] = [];
    for (let l = 0; l < loopCount; l++) {
      const count = u32();
      need(count * 4);
      const loop: number[] = [];
      for (let s = 0; s < count; s++) {
        const index = u32();
        if (index >= segmentCount) throw new VectorNetworkError(`region ${i} references a missing segment`);
        loop.push(index);
      }
      loops.push(loop);
    }
    const region: NetworkRegion = { loops, windingRule: flags & 1 ? 'nonzero' : 'evenodd' };
    const style = styleFor(flags >>> 1);
    if (style) region.style = style;
    regions.push(region);
  }

  return { vertices, segments, regions };
}
