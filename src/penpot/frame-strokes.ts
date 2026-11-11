/**
 * Where a frame's stroke goes.
 *
 * Figma paints a frame's stroke above its children when the frame clips its
 * content and below them when it does not (auto-layout-playground
 * 2411:10586 "mail notification": a non-clipping frame whose child covers
 * its dashed stroke; 2411:10037 "resource": a clipping frame whose stroke
 * covers its child). Penpot paints a board's stroke above its children in
 * both renderers, whether it clips or not (live check in
 * test/penpot/live/strokes.test.ts). So when a non-clipping frame's stroke
 * meets a child, the stroke is taken off the board and drawn by a separate
 * shape, the board's first child, outside the flex flow.
 *
 * A separate shape is also needed for strokes Penpot cannot draw on a board:
 * Figma's dash layout (`dashes.ts`). A clipping board would clip a stroke
 * child that reaches outside its box, so a centre/outside stroke of a
 * clipping board stays on the board, unless the board can be written without
 * its clip because nothing overflows it (`clip.ts`).
 *
 * A board whose validity in Penpot depends on its exact child list never gets
 * a synthesized child: a component set (Penpot's variant container accepts
 * variant mains only), and no variant main gets a synthesized sibling inside
 * its set. Those keep Penpot's own stroke (dashes, order and per-side widths
 * approximated, with warnings).
 *
 * Component mains and copies must keep parallel shapes (every copy shape
 * refers to a main shape), so the decision is taken per class of frames
 * linked through `componentRef` / `instanceOf`: when any member needs the
 * separate shape, all of them get one (empty when the member draws its stroke
 * on the board, or has none).
 */
import type * as ir from '../ir.ts';
import { apply, multiply } from '../util/matrix.ts';
import type { ClipAnalysis } from './clip.ts';
import { centerOffset, dashCount, ellipseSegments, MAX_DASHES, normalizedPattern, rectSegments } from './dashes.ts';
import { hasVisibleStroke } from './strokes.ts';

export type FrameStroke =
  /** The stroke stays on the board. */
  | { kind: 'board' }
  /**
   * A separate shape draws it: `below` = first child (Figma: non-clipping frame), else last child;
   * `strokes` false = the shape is an empty stand-in (the board keeps the stroke, or there is none);
   * `band`: drawn as the stroke's band, filled (`shadowsStroke`: the WASM renderer shadows a shape that only
   * has a stroke as if it were filled).
   */
  | { kind: 'shape'; below: boolean; strokes: boolean; band: boolean }
  /**
   * A separate shape directly above the board, in the board's parent: the dashes of a clipping frame that
   * must keep its clip (its content overflows). Not for a page-level board (no parent), which keeps Penpot's
   * own dashes.
   */
  | { kind: 'sibling'; strokes: boolean }
  /**
   * `pixelExact`, SVG renderer: the board's fill and opaque inside stroke are drawn by its first child, a box inset by half
   * the stroke width with the stroke centred on it (no child reaches the stroke band, so the order does not
   * matter). Penpot clips an aligned stroke to the shape and the fill's anti-aliased edge shows through it
   * where the edge is not on a pixel boundary; Figma draws no such fringe (see `ShapeBuilder.centredBand`).
   */
  | { kind: 'band'; offset: number };

export class FrameStrokePlacement {
  private readonly parent = new Map<string, string>();
  private readonly wanted = new Set<string>();
  private readonly siblings = new Set<string>();
  private readonly dashed = new Set<string>();
  /** Classes whose stroke shape carries a member's drop shadow (`shadowsStroke`): drawn as a filled band. */
  private readonly banded = new Set<string>();
  /** Classes whose every member can draw its stroke as a band (`band` placement). */
  private readonly bands = new Map<string, boolean>();
  /** Classes with a member that must keep its exact child list (a component set). */
  private readonly fixed = new Set<string>();
  /**
   * Classes with a member whose parent cannot take a synthesized sibling: a variant main in its set (the set
   * must keep its exact child list), a mask group's member or a boolean's operand (the sibling would become
   * masked content / an operand).
   */
  private readonly fixedParent = new Set<string>();

  private readonly clip: ClipAnalysis;

  constructor(doc: ir.Document, clip: ClipAnalysis, options: { renderer?: 'svg' | 'wasm'; pixelExact?: boolean; components?: boolean } = {}) {
    this.clip = clip;
    const nodes = new Map<string, ir.Node>();
    const mains = new Map<string, string>();
    const parents = new Map<string, ir.Node>();
    const visit = (node: ir.Node, parent: ir.Node | undefined): void => {
      nodes.set(node.id, node);
      if (parent) parents.set(node.id, parent);
      if (node.type === 'frame' && node.componentId !== undefined && !mains.has(node.componentId)) mains.set(node.componentId, node.id);
      if ('children' in node) for (const child of node.children) visit(child, node);
    };
    doc.pages.forEach((p) => p.children.forEach((n) => visit(n, undefined)));
    for (const node of nodes.values()) {
      const ref = node.componentRef !== undefined ? nodes.get(node.componentRef) : undefined;
      if (ref && ref.type === node.type) this.union(node.id, ref.id);
      if (node.type === 'frame' && node.instanceOf !== undefined) {
        const main = mains.get(node.instanceOf);
        if (main !== undefined) this.union(node.id, main);
      }
    }
    const bandsAllowed = options.pixelExact === true && (options.renderer ?? 'svg') === 'svg';
    // Without components, a component set is a plain board.
    for (const node of nodes.values()) {
      if (node.type !== 'frame' || options.components === false) continue;
      if (fixedChildren(node)) this.fixed.add(this.find(node.id));
    }
    for (const node of nodes.values()) {
      if (node.type !== 'frame') continue;
      const parent = parents.get(node.id);
      const set = options.components !== false && parent?.type === 'frame' && fixedChildren(parent);
      if (set || (parent?.type === 'group' && parent.mask !== undefined) || parent?.type === 'boolean') this.fixedParent.add(this.find(node.id));
    }
    for (const node of nodes.values()) {
      if (node.type === 'frame') {
        const root = this.find(node.id);
        const hides = clip.hidesContent(node);
        const bound = keepsBox(node, clip);
        if (this.fixed.has(root)) {
          // Keeps its stroke on the board whatever it would need.
        } else if (wantsSibling(node, hides, clip.isRoot(node))) {
          // A sibling inside a variant container would break it: the board keeps Penpot's dashes then.
          if (!this.fixedParent.has(root)) {
            this.wanted.add(root);
            this.siblings.add(root);
          }
        } else if (wantsShape(node, bound)) {
          this.wanted.add(root);
          if (shadowsStroke(node) && !boxDashable(node)) this.banded.add(root);
        }
        this.bands.set(root, bandsAllowed && !this.fixed.has(root) && (this.bands.get(root) ?? true) && bandable(node));
      }
      if ((node.type === 'rect' || node.type === 'ellipse') && node.visible && boxDashable(node)) this.dashed.add(this.find(node.id));
    }
  }

  /**
   * Whether the frame must keep its exact child list (a component set, or a frame linked to one): no stroke
   * shape, band or per-side outline is added to it.
   */
  keepsChildren(frame: ir.FrameNode): boolean {
    return this.fixed.has(this.find(frame.id));
  }

  /**
   * Whether a rect / ellipse is drawn as {shape, stroke path}: when it or any shape linked to it (main, copies)
   * has a dashed stroke drawn Figma's way. A copy may override a main's solid stroke with dashes (or the
   * reverse); the shapes stay parallel.
   */
  strokeGroup(node: ir.RectNode | ir.EllipseNode): boolean {
    return this.dashed.has(this.find(node.id));
  }

  placement(frame: ir.FrameNode): FrameStroke {
    const root = this.find(frame.id);
    if (this.fixed.has(root)) return { kind: 'board' };
    if (!this.wanted.has(root)) return this.bands.get(root) ? { kind: 'band', offset: frame.stroke!.weight / 2 } : { kind: 'board' };
    if (this.siblings.has(root)) return { kind: 'sibling', strokes: hasVisibleStroke(frame.stroke) };
    return { kind: 'shape', below: !frame.clipsContent, strokes: canSeparate(frame, keepsBox(frame, this.clip)), band: this.banded.has(root) && !boxDashable(frame) };
  }

  private find(id: string): string {
    let root = id;
    while (this.parent.has(root)) root = this.parent.get(root)!;
    // Path compression.
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic: the smaller id becomes the root.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

/**
 * A board whose child list Penpot validates as a whole: a component set, which becomes a variant container
 * holding variant mains only (`components.ts`). A synthesized child would turn its variants into plain
 * components (`variants-as-components`).
 */
export function fixedChildren(frame: ir.FrameNode): boolean {
  return frame.role === 'component-set';
}

/**
 * A stroke child of this board would show the whole stroke. `bound`: what lies outside the board's box is lost
 * (`keepsBox`), so only an inside stroke can be drawn by a child.
 */
function canSeparate(frame: ir.FrameNode, bound: boolean): boolean {
  return hasVisibleStroke(frame.stroke) && (!bound || frame.stroke.align === 'inside');
}

/**
 * Whether what a child draws outside the board's box is lost: its clip hides part of its content (`clip.ts`;
 * one that hides nothing can be dropped), or it is a page-level non-clipping board, which Penpot's exporters
 * crop to its box anyway (SVG cuts a centre stroke child's dashes in half, WASM drops them; a child reaching
 * into the stroke band is cropped). Such a board keeps a centre / outside stroke on itself.
 */
function keepsBox(frame: ir.FrameNode, clip: ClipAnalysis): boolean {
  return clip.hidesContent(frame) || (!frame.clipsContent && clip.isRoot(frame));
}

/**
 * A fill-less, non-clipping frame with a stroke and a drop shadow: Figma shadows its stroke only (a frame with
 * neither fill nor stroke shadows its children instead), Penpot shadows a fill-less board's children and not
 * its stroke. The stroke is drawn by a separate shape that carries the shadow (auto-layout-playground 1620:1472
 * "Tip": in Figma's render the stroke is 3 px on the left / top and 5 px on the right / bottom, the text inside
 * unshadowed; the fill-less, stroke-less tooltip 1620:1749 shadows its children).
 */
export function shadowsStroke(frame: ir.FrameNode): boolean {
  return (
    !frame.clipsContent &&
    !frame.fills.some((p) => p.visible) &&
    hasVisibleStroke(frame.stroke) &&
    frame.effects.some((e) => e.type === 'drop-shadow' && e.visible)
  );
}

/** A frame whose fill and inside stroke can be drawn by an inset child (`band` placement). */
function bandable(frame: ir.FrameNode): boolean {
  const stroke = frame.stroke;
  if (!frame.visible || !hasVisibleStroke(stroke) || stroke.align !== 'inside' || stroke.perSide || stroke.dashPattern.length > 0) return false;
  const top = stroke.paints.filter((p) => p.visible).at(-1);
  if (!top || top.type !== 'solid' || top.opacity < 1 || top.color.a < 1 || (top.blendMode !== 'normal' && top.blendMode !== 'pass-through')) return false;
  const fills = frame.fills.filter((p) => p.visible);
  if (fills.length === 0 || !fills.every((p) => p.type === 'solid')) return false;
  if (frame.effects.some((e) => e.visible && (e.type === 'inner-shadow' || e.type === 'background-blur'))) return false;
  const w = stroke.weight;
  if (frame.size.width <= w || frame.size.height <= w || frame.cornerRadii?.some((r) => r > 0 && r < w / 2)) return false;
  return !childrenMeetStroke(frame);
}

/** Dashes drawn Figma's way (`dashes.ts`): butt-capped, with a usable pattern. */
export function dashable(stroke: ir.Stroke | undefined): boolean {
  return hasVisibleStroke(stroke) && !stroke.perSide && stroke.startCap === 'none' && stroke.endCap === 'none' && normalizedPattern(stroke.dashPattern) !== undefined;
}

/**
 * Whether a box's dashes are drawn Figma's way: `dashable`, and not so many that Penpot's own dashes are
 * kept instead (`MAX_DASHES`, warned `stroke-dash-approximated` by the writer).
 */
export function boxDashable(node: ir.FrameNode | ir.RectNode | ir.EllipseNode): boolean {
  return dashable(node.stroke) && !tooManyBoxDashes(node);
}

/** A dashable box stroke with more than `MAX_DASHES` dashes. */
export function tooManyBoxDashes(node: ir.FrameNode | ir.RectNode | ir.EllipseNode): boolean {
  const stroke = node.stroke;
  if (!stroke || !dashable(stroke)) return false;
  const offset = centerOffset(stroke.align, stroke.weight);
  const { width, height } = node.size;
  const segments = node.type === 'ellipse' ? ellipseSegments(width, height, offset) : rectSegments(width, height, node.cornerRadii, offset);
  return dashCount(segments, stroke.dashPattern) > MAX_DASHES;
}

/**
 * Figma's dashes on a clipping frame whose stroke a child shape could not draw: its content overflows, so it
 * keeps its clip (see `FrameStroke`). A page-level board has no parent for the sibling.
 */
function wantsSibling(frame: ir.FrameNode, hides: boolean, root: boolean): boolean {
  if (!frame.visible || !frame.clipsContent || root || !boxDashable(frame)) return false;
  return !canSeparate(frame, hides);
}

function wantsShape(frame: ir.FrameNode, bound: boolean): boolean {
  if (!frame.visible || !canSeparate(frame, bound)) return false;
  if (boxDashable(frame) || shadowsStroke(frame)) return true;
  return !frame.clipsContent && childrenMeetStroke(frame);
}

/** Whether a visible child (or a non-clipping descendant) reaches into the band the frame's stroke covers. */
export function childrenMeetStroke(frame: ir.FrameNode): boolean {
  const stroke = frame.stroke!;
  const sides = stroke.perSide ?? { top: stroke.weight, right: stroke.weight, bottom: stroke.weight, left: stroke.weight };
  const k = stroke.align === 'inside' ? 1 : stroke.align === 'center' ? 0.5 : 0;
  const { width: w, height: h } = frame.size;
  const outer = { x0: -sides.left * (1 - k), y0: -sides.top * (1 - k), x1: w + sides.right * (1 - k), y1: h + sides.bottom * (1 - k) };
  const inner = { x0: sides.left * k, y0: sides.top * k, x1: w - sides.right * k, y1: h - sides.bottom * k };
  const extents: Box[] = [];
  for (const child of frame.children) collectExtents(child, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, extents);
  return extents.some((b) => {
    const meetsOuter = b.x1 > outer.x0 && b.x0 < outer.x1 && b.y1 > outer.y0 && b.y0 < outer.y1;
    const insideInner = b.x0 >= inner.x0 && b.y0 >= inner.y0 && b.x1 <= inner.x1 && b.y1 <= inner.y1;
    return meetsOuter && !insideInner;
  });
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Frame-space bounds of what a node draws: its box grown by its own outward stroke, and unclipped content. */
function collectExtents(node: ir.Node, parent: ir.Matrix, out: Box[]): void {
  if (!node.visible) return;
  const m = multiply(parent, node.transform);
  const s = node.stroke && hasVisibleStroke(node.stroke) ? outward(node.stroke) : 0;
  const pts = [
    { x: -s, y: -s },
    { x: node.size.width + s, y: -s },
    { x: node.size.width + s, y: node.size.height + s },
    { x: -s, y: node.size.height + s },
  ].map((p) => apply(m, p));
  const drawsItself = node.type === 'group' ? false : node.type === 'frame' ? node.fills.some((p) => p.visible) || hasVisibleStroke(node.stroke) || node.effects.length > 0 : true;
  if (drawsItself) {
    out.push({ x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) });
  }
  if ((node.type === 'group' || (node.type === 'frame' && !node.clipsContent)) && 'children' in node) {
    for (const child of node.children) collectExtents(child, m, out);
  }
}

function outward(stroke: ir.Stroke): number {
  const w = stroke.perSide ? Math.max(stroke.perSide.top, stroke.perSide.right, stroke.perSide.bottom, stroke.perSide.left) : stroke.weight;
  return stroke.align === 'outside' ? w : stroke.align === 'center' ? w / 2 : 0;
}
