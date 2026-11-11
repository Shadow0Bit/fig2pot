/**
 * Whether a clipping frame's clip changes what is drawn.
 *
 * A clip edge that does not fall on a pixel boundary is anti-aliased, and so
 * is the content that ends exactly there: Penpot multiplies the two coverages
 * (a line along a board edge at y = 601.25 drew 56 % instead of Figma's 75 %,
 * auto-layout-playground 2495:1898), where Figma computes the coverage of the
 * clipped content itself. When everything a clipping frame contains lies inside
 * its box, the clip removes nothing, so the board can be written without it
 * (`showContent`), which draws the content exactly. Figma's clipping-frame
 * stroke order (stroke above the content) is what Penpot draws on a board
 * either way, and a non-clipping board does not isolate blend modes, which is
 * also what Figma's pass-through frames do.
 *
 * Dropping such a clip changes the design (the frame no longer clips what is
 * added to it later), so the writer does it for every frame only with
 * `pixelExact` (`shapes.ts`); by default only where a stroke drawn outside the
 * box by a separate shape needs it (`frame-strokes.ts`).
 *
 * The extent of a node is conservative: the node's box grown by its outward
 * stroke (paths: Figma's own outlines, or every control point grown by the
 * stroke), text by its glyph outlines, unclipped containers by their content,
 * and every node by its shadows (offset + blur + spread) and layer blur.
 */
import type * as ir from '../ir.ts';
import { apply, identity, multiply } from '../util/matrix.ts';
import { hasVisibleStroke } from './strokes.ts';

/** Overflow below this (px) is invisible (well under 1 % of a pixel's coverage). */
const TOLERANCE = 0.005;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class ClipAnalysis {
  private readonly cache = new Map<string, boolean>();
  private readonly roots = new Set<string>();

  constructor(doc: ir.Document) {
    for (const page of doc.pages) for (const node of page.children) this.roots.add(node.id);
  }

  /** Whether the node is a page-level node. */
  isRoot(node: ir.Node): boolean {
    return this.roots.has(node.id);
  }

  /**
   * Whether the frame's clip hides part of its content (or it is a page-level board, whose clip is always kept:
   * Penpot's exporter crops a non-clipping one to its box, losing an outside stroke). False for a frame that
   * does not clip, or whose clip removes nothing.
   */
  hidesContent(frame: ir.FrameNode): boolean {
    if (!frame.clipsContent) return false;
    if (this.roots.has(frame.id)) return true;
    let result = this.cache.get(frame.id);
    if (result === undefined) {
      result = overflows(frame);
      this.cache.set(frame.id, result);
    }
    return result;
  }
}

function overflows(frame: ir.FrameNode): boolean {
  const { width: w, height: h } = frame.size;
  // A rounded corner clips what reaches into its square (smoothing lengthens the curve: up to 1 + s radii).
  const k = 1 + Math.max(0, Math.min(1, frame.cornerSmoothing ?? 0));
  const [tl, tr, br, bl] = (frame.cornerRadii ?? [0, 0, 0, 0]).map((r) => Math.min(Math.max(0, r) * k, w / 2, h / 2)) as [number, number, number, number];
  const corners: Box[] = [
    { x0: 0, y0: 0, x1: tl, y1: tl },
    { x0: w - tr, y0: 0, x1: w, y1: tr },
    { x0: w - br, y0: h - br, x1: w, y1: h },
    { x0: 0, y0: h - bl, x1: bl, y1: h },
  ].filter((c) => c.x1 - c.x0 > TOLERANCE);
  for (const child of frame.children) {
    const box = extent(child, identity());
    if (!box) continue;
    if (box.x0 < -TOLERANCE || box.y0 < -TOLERANCE || box.x1 > w + TOLERANCE || box.y1 > h + TOLERANCE) return true;
    if (corners.some((c) => box.x0 < c.x1 - TOLERANCE && box.x1 > c.x0 + TOLERANCE && box.y0 < c.y1 - TOLERANCE && box.y1 > c.y0 + TOLERANCE)) return true;
  }
  return false;
}

/** Parent-space bounds of what a node draws (undefined: nothing), `parent` = node's parent → frame space. */
function extent(node: ir.Node, parent: ir.Matrix): Box | undefined {
  if (!node.visible) return undefined;
  const m = multiply(parent, node.transform);
  let box: Box | undefined;
  const add = (b: Box | undefined): void => {
    if (!b) return;
    box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  };
  const stroked = hasVisibleStroke(node.stroke);
  const own = (grow: number): Box => transformed(m, { x0: -grow, y0: -grow, x1: node.size.width + grow, y1: node.size.height + grow });
  switch (node.type) {
    case 'group':
    case 'boolean':
      if (node.type === 'boolean' && node.geometry && (node.geometry.fill?.length || node.geometry.stroke?.length)) {
        add(pathsBox(m, [...(node.geometry.fill ?? []), ...(node.geometry.stroke ?? [])], 0));
        if (!node.geometry.stroke?.length && stroked) add(own(strokeReach(node.stroke!)));
      } else {
        for (const child of node.children) add(extent(child, m));
        if (stroked) add(own(strokeReach(node.stroke!)));
      }
      break;
    case 'frame':
      add(own(stroked ? outward(node.stroke!) : 0));
      if (!node.clipsContent) for (const child of node.children) add(extent(child, m));
      break;
    case 'rect':
    case 'ellipse':
      add(own(stroked ? outward(node.stroke!) : 0));
      break;
    case 'path':
      if (node.geometry?.fill?.length || node.geometry?.stroke?.length) {
        add(pathsBox(m, [...(node.geometry.fill ?? []), ...(node.geometry.stroke ?? [])], 0));
        // No stroke outline: the editable paths are stroked.
        if (stroked && !node.geometry.stroke?.length) add(pathsBox(m, node.paths, strokeReach(node.stroke!)));
      } else {
        add(pathsBox(m, node.paths, stroked ? strokeReach(node.stroke!) : 0));
      }
      add(own(0));
      break;
    case 'text': {
      add(own(stroked ? strokeReach(node.stroke!) : 0));
      const outlines = node.layout?.outlines ?? [];
      if (outlines.length) add(pathsBox(m, outlines.map((o) => o.path), stroked ? strokeReach(node.stroke!) : 0));
      break;
    }
  }
  return box && grow(box, effectReach(node));
}

function transformed(m: ir.Matrix, b: Box): Box {
  const pts = [apply(m, { x: b.x0, y: b.y0 }), apply(m, { x: b.x1, y: b.y0 }), apply(m, { x: b.x1, y: b.y1 }), apply(m, { x: b.x0, y: b.y1 })];
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
}

/** Bounds of every point and control point (a curve stays inside its control polygon), grown by `pad`. */
function pathsBox(m: ir.Matrix, paths: readonly ir.Path[], pad: number): Box | undefined {
  let box: Box | undefined;
  const add = (x: number, y: number): void => {
    const p = apply(m, { x, y });
    box = box ? { x0: Math.min(box.x0, p.x), y0: Math.min(box.y0, p.y), x1: Math.max(box.x1, p.x), y1: Math.max(box.y1, p.y) } : { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  };
  for (const path of paths) {
    for (const c of path.commands) {
      if (c.type === 'Z') continue;
      if (c.type === 'C') {
        add(c.x1, c.y1);
        add(c.x2, c.y2);
      } else if (c.type === 'Q') add(c.x1, c.y1);
      add(c.x, c.y);
    }
  }
  if (!box || pad === 0) return box;
  // The pad is in the node's space: scale it by the transform's largest stretch.
  const s = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
  return grow(box, pad * s);
}

function grow(b: Box, by: number): Box {
  return by > 0 ? { x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by } : b;
}

function width(stroke: ir.Stroke): number {
  return stroke.perSide ? Math.max(stroke.perSide.top, stroke.perSide.right, stroke.perSide.bottom, stroke.perSide.left) : stroke.weight;
}

function outward(stroke: ir.Stroke): number {
  const w = width(stroke);
  return stroke.align === 'outside' ? w : stroke.align === 'center' ? w / 2 : 0;
}

/** How far a stroke of a path may reach past its points: caps, miters, arrowheads. */
function strokeReach(stroke: ir.Stroke): number {
  const w = width(stroke);
  const caps = [stroke.startCap, stroke.endCap].some((c) => c !== 'none' && c !== 'round' && c !== 'square');
  const miter = stroke.join === 'miter' ? Math.max(1, stroke.miterLimit ?? 4) : 1;
  return w * Math.max(caps ? 3 : 1, miter);
}

/** How far the node's effects draw past its content. */
function effectReach(node: ir.Node): number {
  let reach = 0;
  for (const e of node.effects) {
    if (!e.visible) continue;
    if (e.type === 'drop-shadow') reach = Math.max(reach, Math.max(Math.abs(e.offset.x), Math.abs(e.offset.y)) + Math.max(0, e.blur) + Math.max(0, e.spread));
    else if (e.type === 'layer-blur') reach = Math.max(reach, Math.max(0, e.radius));
  }
  return reach;
}
