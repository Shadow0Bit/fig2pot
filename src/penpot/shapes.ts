/**
 * IR nodes → the intermediate Penpot shape tree (`pnode.ts`).
 *
 * Children keep the IR order (back → front): the library appends each shape to
 * its parent's `shapes` vector and Penpot paints that vector in order, so the
 * last shape is on top. Flex boards are the exception Penpot itself makes; see
 * `layout.ts` for how their order is preserved.
 */
import type * as ir from '../ir.ts';
import { apply, identity, multiply } from '../util/matrix.ts';
import { opacity } from './colors.ts';
import type { WriterContext } from './context.ts';
import { convertEffects } from './effects.ts';
import { boundsSpace, boxSpace, convertFills, type PaintTarget } from './fills.ts';
import type { GradientSpace } from './gradients.ts';
import { boxGeometry, clean, MAX_COORD, orientation, pageBounds, unitBox, type BoxFit } from './geometry.ts';
import { constraints, layoutChild, layoutContainer } from './layout.ts';
import type {
  BoardParams,
  CornerRadii,
  GroupParams,
  LayoutChildAttrs,
  PathParams,
  PenpotBlendMode,
  PenpotBoolType,
  ShapeCommon,
  TextParams,
} from './library.ts';
import { ClipAnalysis } from './clip.ts';
import { centerOffset, dashCount, dashPaths, ellipseSegments, fullPath, MAX_DASHES, pathSegments, rectSegments, type DashSegment } from './dashes.ts';
import { boxDashable, childrenMeetStroke, dashable, FrameStrokePlacement, shadowsStroke, tooManyBoxDashes } from './frame-strokes.ts';
import { bakeCommands, bounds, boxCommands, ellipseCommands, hasSegments, isClosed, maxTurn, rectCommands, serialize, windAlternately, type AbsCommand, type Bounds } from './paths.ts';
import { shapeId, type BoardNode, type GroupNode, type PathNode, type PNode } from './pnode.ts';
import { convertStrokes, hasVisibleStroke, needsSideStrokes } from './strokes.ts';
import { fillGroups, TextOutlineClasses, type OutlineGrouping } from './text/classes.ts';
import { buildTextAttrs, penpotTextBox, type TextDeps } from './text/index.ts';

type Parent = ir.ContainerNode | undefined;
type Common = ShapeCommon & LayoutChildAttrs;

/** One visual layer of a node drawn as paths: geometry + its own paint. */
interface PathPart {
  paths: readonly ir.Path[];
  fills: readonly ir.Paint[];
  stroke?: ir.Stroke | undefined;
  suffix: string;
  /**
   * Keep only the part of the geometry inside / outside these paths: Figma's stroke outline of an
   * inside / outside stroke is the full 2w band around the path, which Figma clips to (inside) or
   * removes from (outside) the fill shape. Drawn as a mask group.
   */
  clip?: { paths: readonly ir.Path[]; keep: 'inside' | 'outside' };
}

const BOOL_TYPES: Record<ir.BooleanNode['operation'], PenpotBoolType> = {
  union: 'union',
  subtract: 'difference',
  intersect: 'intersection',
  exclude: 'exclude',
};

const BLEND_MODES: Record<ir.BlendMode, PenpotBlendMode> = {
  'pass-through': 'normal',
  normal: 'normal',
  darken: 'darken',
  multiply: 'multiply',
  'linear-burn': 'darken',
  'color-burn': 'color-burn',
  lighten: 'lighten',
  screen: 'screen',
  'linear-dodge': 'color-dodge',
  'color-dodge': 'color-dodge',
  overlay: 'overlay',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

const DEFAULT_NAMES: Record<ir.NodeType, string> = {
  frame: 'Board',
  group: 'Group',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  path: 'Path',
  boolean: 'Boolean',
  text: 'Text',
};

export class ShapeBuilder {
  private readonly ctx: WriterContext;
  private readonly strokePlacement: FrameStrokePlacement;
  private readonly clip: ClipAnalysis;
  private byId: Map<string, ir.Node> | undefined;
  private textClasses: TextOutlineClasses | undefined;
  private opaqueBackdrop: Map<string, { frame: ir.FrameNode; toFrame: ir.Matrix }> | undefined;

  constructor(ctx: WriterContext) {
    this.ctx = ctx;
    this.clip = new ClipAnalysis(ctx.doc);
    this.strokePlacement = new FrameStrokePlacement(ctx.doc, this.clip, ctx.options);
  }

  /**
   * Whether to draw a path from its editable paths. A component copy follows its main, so that both get
   * the same shapes (every copy shape needs a counterpart): e.g. a copy whose corner radius override makes
   * Figma's outline differ (auto-layout-playground `I2411:10503;485:923`, radius 1) stays editable like its main.
   */
  private pathsExact(node: ir.PathNode): boolean {
    const own = drawnExact(node);
    if (!this.ctx.options.components || node.componentRef === undefined) return own;
    if (!this.byId) {
      const byId = new Map<string, ir.Node>();
      const visit = (n: ir.Node): void => {
        byId.set(n.id, n);
        if ('children' in n) n.children.forEach(visit);
      };
      this.ctx.doc.pages.forEach((p) => p.children.forEach(visit));
      this.byId = byId;
    }
    const main = this.byId.get(node.componentRef);
    if (main?.type !== 'path') return own;
    const mainExact = drawnExact(main);
    if (mainExact === own) return own;
    if (mainExact && !own) {
      this.ctx.warn('copy-geometry-approximated', "The copy's vector outline differs from its main's; it is drawn as one editable path like the main (a closed path from its own fill outline), so that it stays linked", node);
    }
    return mainExact;
  }

  /**
   * Whether the node's shadows land on opaque content in Figma's composition, so that a grey `multiply` shadow
   * can be written as the black normal shadow that darkens it the same (`effects.ts`): the node's nearest
   * enclosing frame has an opaque fill (also when that frame is exported on its own; Figma's references are such
   * exports: a fill-less board shows its shadows over transparency, auto-layout-playground 2411:10790), and
   * - no group between them isolates its content (opacity below 1, a blend mode other than pass-through, a
   *   mask): Figma composes the shadow inside that group first, over transparency, where multiply draws the
   *   shadow colour itself — which is what Penpot draws for the unconverted shadow;
   * - the frame clips, or every drop shadow of the node stays inside its box (else it spills onto whatever is
   *   under the frame, which may not be opaque).
   */
  private overOpaque(node: ir.Node): boolean {
    if (!this.opaqueBackdrop) {
      const map = new Map<string, { frame: ir.FrameNode; toFrame: ir.Matrix }>();
      // `within`: the opaque frame the children of `n` sit on, and `n`'s local space → that frame's.
      const visit = (n: ir.Node, within: { frame: ir.FrameNode; toFrame: ir.Matrix } | undefined): void => {
        if (!('children' in n)) return;
        let inner: { frame: ir.FrameNode; toFrame: ir.Matrix } | undefined;
        if (n.type === 'frame') inner = opaqueFrame(n) ? { frame: n, toFrame: identity() } : undefined;
        else if (n.type === 'group' && within && !isolates(n)) inner = within;
        for (const c of n.children) {
          const own = inner ? { frame: inner.frame, toFrame: multiply(inner.toFrame, c.transform) } : undefined;
          if (own) map.set(c.id, own);
          visit(c, own);
        }
      };
      this.ctx.doc.pages.forEach((p) => p.children.forEach((c) => visit(c, undefined)));
      this.opaqueBackdrop = map;
    }
    const backdrop = this.opaqueBackdrop.get(node.id);
    if (!backdrop) return false;
    if (backdrop.frame.clipsContent) return true;
    const { width, height } = backdrop.frame.size;
    const reach = node.stroke && hasVisibleStroke(node.stroke) ? (node.stroke.align === 'outside' ? node.stroke.weight : node.stroke.align === 'center' ? node.stroke.weight / 2 : 0) : 0;
    return node.effects.every((e) => {
      if (e.type !== 'drop-shadow' || !e.visible) return true;
      // The shadow's extent: the node's box (grown by an outward stroke) offset, spread and blurred (Figma's
      // radius is about where a Gaussian of σ = radius / 2 fades out).
      const grow = reach + Math.max(0, e.spread) + Math.max(0, e.blur);
      const corners = [
        { x: -grow, y: -grow },
        { x: node.size.width + grow, y: -grow },
        { x: node.size.width + grow, y: node.size.height + grow },
        { x: -grow, y: node.size.height + grow },
      ].map((p) => apply(backdrop.toFrame, { x: p.x + e.offset.x, y: p.y + e.offset.y }));
      const tolerance = 0.5;
      return corners.every((p) => p.x >= -tolerance && p.y >= -tolerance && p.x <= width + tolerance && p.y <= height + tolerance);
    });
  }

  page(page: ir.Page): PNode[] {
    return this.children(undefined, page.children, identity());
  }

  private children(parent: Parent, nodes: readonly ir.Node[], parentAbs: ir.Matrix): PNode[] {
    const out: PNode[] = [];
    nodes.forEach((node, index) => {
      try {
        out.push(...this.node(node, parent, index, parentAbs));
      } catch (error) {
        this.ctx.warn('node-conversion-failed', `Node could not be converted and was skipped: ${String(error)}`, node);
      }
    });
    return out;
  }

  private node(node: ir.Node, parent: Parent, index: number, parentAbs: ir.Matrix): PNode[] {
    const abs = multiply(parentAbs, node.transform);
    if (!Object.values(abs).every(Number.isFinite) || !Number.isFinite(node.size.width) || !Number.isFinite(node.size.height)) {
      this.ctx.warn('invalid-geometry', 'Node has a non-finite transform or size and was skipped', node);
      return [];
    }
    if (!inRange(node, abs)) {
      // Penpot's numbers are bounded (`safe-number`); a single larger value makes the whole file unimportable.
      this.ctx.warn('geometry-out-of-range', `Node lies beyond Penpot's coordinate range (±${MAX_COORD}) and was skipped with its content`, node);
      return [];
    }
    switch (node.type) {
      case 'frame':
        return this.frame(node, parent, index, abs);
      case 'group':
        return this.group(node, parent, index, abs);
      case 'rect':
        return this.rect(node, parent, index, abs);
      case 'ellipse':
        return this.ellipse(node, parent, index, abs);
      case 'path':
        return this.path(node, parent, index, abs);
      case 'boolean':
        return this.boolean(node, parent, index, abs);
      case 'text':
        return this.text(node, parent, index, abs);
    }
  }

  // --- containers ------------------------------------------------------------

  private frame(node: ir.FrameNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    const fit = boxGeometry(abs, node.size);
    if (fit.skewed) {
      this.ctx.warn('skewed-board', 'The board is sheared; Penpot keeps the shear in its transform but boards are rarely sheared there', node);
    }
    const scale = this.scale(fit, node);
    const target = this.boxTarget(node, fit);
    // A board Penpot validates by its child list (a component set: a variant container holds variant mains
    // only) gets no synthesized child; it keeps Penpot's own stroke (`frame-strokes.ts`).
    const keeps = this.strokePlacement.keepsChildren(node);
    if (keeps) this.warnKeptStroke(node);
    const sides = !keeps && needsSideStrokes(node.stroke);
    // Figma paints a non-clipping frame's stroke below its children, and dashes per side: both need a
    // separate stroke shape (`frame-strokes.ts`).
    let placement = this.strokePlacement.placement(node);
    // A page-level board has no parent to hold a stroke shape beside it.
    if (placement.kind === 'sibling' && parent === undefined) placement = { kind: 'board' };
    const separate = sides || placement.kind === 'band' || (placement.kind !== 'board' && placement.strokes);
    // Figma's clip, except where a stroke drawn outside the box by a separate shape needs it gone and the clip
    // hides nothing; with `pixelExact`, every clip that hides nothing is dropped (`clip.ts`).
    const hides = this.clip.hidesContent(node);
    const unclippedForStroke = node.clipsContent && !hides && separate && node.stroke?.align !== 'inside';
    const clips = node.clipsContent && !unclippedForStroke && (hides || !this.ctx.options.pixelExact);
    if (unclippedForStroke) {
      this.ctx.warn('frame-clip-disabled-for-stroke', 'The board is written without its clip (nothing overflows it), so that the stroke drawn outside its box by a separate shape shows', node);
    } else if (node.clipsContent && !clips) {
      this.ctx.warn('pixel-exact-unclipped', 'pixelExact: the board is written without its clip, which hides nothing (its anti-aliased edge would thin the content ending there)', node);
    }
    if (placement.kind === 'band') {
      this.ctx.warn('pixel-exact-stroke-inset', "pixelExact: the board's fill and inside stroke are drawn by an inset \"Fill and stroke\" child with a centred stroke (no fill fringe at the stroke's edge)", node);
    }
    const params: BoardParams = {
      ...this.common(node, parent, index),
      ...fit.geometry,
      ...radii(node.cornerRadii, scale),
      fills: placement.kind === 'band' ? [] : convertFills(this.ctx, node.fills, target),
      strokes: separate ? [] : convertStrokes(this.ctx, node.stroke, target, { open: false, scale, turn: boxTurn(node.cornerRadii) }),
      showContent: !clips,
      ...layoutContainer(node),
    };
    const children = this.children(node, node.children, abs);
    let stroke: PNode | undefined;
    if (sides) {
      stroke = this.sideStrokes(node, abs);
      if (stroke && clips && node.stroke?.align !== 'inside') {
        this.ctx.warn('per-side-stroke-clipped', 'The emulated per-side stroke lies partly outside a clipping board and is clipped there', node);
      }
    } else if (placement.kind === 'shape') {
      stroke = placement.band ? this.frameStrokeBand(node, abs, placement.strokes) : this.frameStroke(node, abs, fit, scale, placement.strokes, 'child');
    } else if (placement.kind === 'band') {
      stroke = this.frameBand(node, abs, scale, placement.offset);
    }
    let sibling: PNode | undefined;
    if (placement.kind === 'sibling') {
      // Directly above the board in its parent: what the board shows of it, outside the flow.
      sibling = this.frameStroke(node, abs, fit, scale, placement.strokes, 'sibling');
      const { hidden, opacity: alpha, blendMode, constraintsH, constraintsV } = params;
      Object.assign(sibling.params, { hidden, opacity: alpha, blendMode, constraintsH, constraintsV });
      if (parent?.type === 'frame' && parent.layout) sibling.params.layoutItemAbsolute = true;
      for (const key of ['hidden', 'opacity', 'blendMode', 'constraintsH', 'constraintsV'] as const) if (sibling.params[key] === undefined) delete sibling.params[key];
    }
    if (stroke) {
      // Outside the flow, resizing with the board.
      if (node.layout) stroke.params.layoutItemAbsolute = true;
      stroke.params.constraintsH = 'leftright';
      stroke.params.constraintsV = 'topbottom';
      // Figma: above the content of a clipping frame, below that of a non-clipping one. A band is drawn
      // below the content (it carries the fill; no child reaches the stroke).
      const above = node.clipsContent && placement.kind !== 'band';
      if (above) children.push(stroke);
      else children.unshift(stroke);
      // "First on top" stacking gives the flow children z-indices 0…n−1 (`layoutChild`): the shape goes above or
      // below all of them explicitly, else z 0 would put it among them.
      if (node.layout?.reverseZIndex) stroke.params.layoutItemZIndex = above ? node.children.length : -1;
      if (placement.kind === 'shape' && placement.strokes && shadowsStroke(node)) this.moveShadowToStroke(node, params, stroke);
    }
    // A page-level non-clipping board keeps a centre / outside stroke (`keepsBox` in frame-strokes.ts).
    const rootStroke = !separate && !keeps && this.clip.isRoot(node) && !node.clipsContent && hasVisibleStroke(node.stroke) && node.stroke.align !== 'inside';
    const why = 'a page-level board is exported cropped to its box, which would cut a stroke drawn outside it by a separate shape';
    if (rootStroke && !node.clipsContent && childrenMeetStroke(node)) {
      this.ctx.warn('frame-stroke-order-approximated', `Figma paints this frame's stroke below its children; ${why}, so Penpot paints it above them`, node);
    }
    if (!keeps && !separate && shadowsStroke(node)) {
      this.ctx.warn('frame-shadow-approximated', "Figma shadows this fill-less frame's stroke, Penpot shadows its children instead; the stroke could not be drawn by a separate shape that carries the shadow", node);
    }
    if (!keeps && tooManyBoxDashes(node)) this.warnTooManyDashes(node);
    else if (!separate && !keeps && dashable(node.stroke)) {
      this.ctx.warn(
        'stroke-dash-approximated',
        `Figma restarts the dashes on every side; ${rootStroke ? why : 'the clipping board would clip a stroke drawn outside its box'}, so Penpot's own dashes were used`,
        node,
      );
    }
    const board: BoardNode = { kind: 'board', origin: { irId: node.id, suffix: '' }, node, params, children };
    if (this.ctx.options.components) {
      if (node.componentId !== undefined) board.main = node.componentId;
      if (node.instanceOf !== undefined) board.copy = node.instanceOf;
    }
    return sibling ? [board, sibling] : [board];
  }

  /**
   * Figma shadows a fill-less frame's stroke, Penpot a fill-less board's children (`shadowsStroke` in
   * frame-strokes.ts): the drop shadows go to the separate shape that draws the stroke, which Penpot shadows.
   */
  private moveShadowToStroke(node: ir.FrameNode, params: BoardParams, stroke: PNode): void {
    const shadows = params.shadow ?? [];
    const drop = shadows.filter((sh) => sh.style === 'drop-shadow');
    if (drop.length === 0) return;
    const rest = shadows.filter((sh) => sh.style !== 'drop-shadow');
    if (rest.length > 0) params.shadow = rest;
    else delete params.shadow;
    (stroke.params as ShapeCommon).shadow = drop;
    this.ctx.warn('frame-shadow-on-stroke', "Figma shadows a fill-less frame's stroke, not its children; the drop shadow is drawn by the separate \"Stroke\" shape", node);
  }

  /** What a board that must keep its child list (`keepsChildren`) draws differently with its stroke on the board. */
  private warnKeptStroke(node: ir.FrameNode): void {
    const stroke = node.stroke;
    if (!node.visible || !hasVisibleStroke(stroke)) return;
    const why = 'a shape added to the component set would make Penpot turn its variants into plain components';
    if (needsSideStrokes(stroke)) {
      this.ctx.warn('per-side-stroke-approximated', `Penpot has no per-side stroke widths and ${why}; the largest width is drawn on every side`, node);
    }
    if (dashable(stroke)) this.ctx.warn('stroke-dash-approximated', `Figma restarts the dashes on every side; ${why}, so Penpot's own dashes were used`, node);
    if (!node.clipsContent && childrenMeetStroke(node)) {
      this.ctx.warn('frame-stroke-order-approximated', `Figma paints this frame's stroke below its children; ${why}, so Penpot paints it above them`, node);
    }
  }

  private group(node: ir.GroupNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    const children = this.children(node, node.children, abs);
    if (children.length === 0) {
      this.ctx.warn('empty-group', 'Group has no convertible children and was dropped', node);
      return [];
    }
    const maskNode = node.mask ? node.children[0] : undefined;
    let masked = false;
    let geometry = orientation(boxGeometry(abs, node.size));
    if (node.mask && maskNode) {
      if (!maskNode.visible) {
        // A hidden mask does not mask (Figma); keep a plain group.
      } else if (children[0]?.origin.irId !== maskNode.id) {
        this.ctx.warn('mask-dropped', 'The mask shape could not be converted; the group is not masked', node);
      } else {
        masked = true;
        geometry = orientation(boxGeometry(multiply(abs, maskNode.transform), maskNode.size));
        if (node.mask.type === 'luminance') {
          this.ctx.warn('mask-type-approximated', 'Penpot has no luminance masks; the mask uses the shape instead', node);
        } else if (node.mask.type === 'vector') {
          // A vector mask clips to the silhouette; Penpot masks by alpha, so the mask shape is made opaque.
          if (opaqueSilhouette(children[0]!)) {
            this.ctx.warn('mask-made-opaque', 'Penpot masks by alpha; the vector mask shape is drawn opaque black so that it masks by its silhouette, as Figma does', node);
          }
        }
      }
    }
    const params: GroupParams = { ...this.common(node, parent, index), ...geometry };
    if (masked) params.maskedGroup = true;
    const group: GroupNode = { kind: 'group', origin: { irId: node.id, suffix: '' }, node, params, children };
    return [group];
  }

  private boolean(node: ir.BooleanNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    if (this.ctx.options.booleanMode === 'flatten') {
      if (node.geometry?.fill?.length) {
        return this.pathSet(node, parent, index, abs, [{ paths: node.geometry.fill, fills: node.fills, stroke: node.stroke, suffix: 'part' }]);
      }
      // Figma stores no fill outline for a boolean without fills; a centred stroke's outline is exact on its own.
      if (!node.fills.some((p) => p.visible) && hasVisibleStroke(node.stroke) && node.stroke.align === 'center' && node.geometry?.stroke?.length) {
        return this.pathSet(node, parent, index, abs, [{ paths: node.geometry.stroke, fills: node.stroke.paints, suffix: 'stroke' }]);
      }
      this.ctx.warn('boolean-geometry-missing', 'Boolean has no computed outline to flatten; it stays an editable boolean', node);
    }
    const children = this.children(node, node.children, abs);
    if (children.length === 0) {
      this.ctx.warn('empty-boolean', 'Boolean has no convertible operands and was dropped', node);
      return [];
    }
    // Penpot ignores boards as boolean operands and cannot build a boolean of boards only.
    if (children.every((c) => c.kind === 'board') && node.geometry?.fill?.length) {
      this.ctx.warn('boolean-flattened', 'Penpot cannot combine boards in a boolean; the result outline was used instead', node);
      return this.pathSet(node, parent, index, abs, [{ paths: node.geometry.fill, fills: node.fills, stroke: node.stroke, suffix: 'part' }]);
    }
    // Penpot sizes the boolean to its result, which the source node's box approximates.
    const target: PaintTarget = { node, size: node.size, space: boundsSpace(abs, node.size, pageBounds(abs, node.size)) };
    const fills = convertFills(this.ctx, node.fills, target);
    const outline = node.geometry?.fill?.length ? node.geometry.fill.flatMap((p) => bakeCommands(p.commands, abs)) : undefined;
    const strokes = convertStrokes(this.ctx, node.stroke, target, { open: false, turn: outline ? maxTurn(outline) : undefined });
    // Penpot gives a boolean the fills and strokes of its "head" operand (the first one for
    // difference, the last otherwise, boards excluded); make the head carry the boolean's style.
    const type = BOOL_TYPES[node.operation];
    const eligible = children.filter((c) => c.kind !== 'board');
    const head = type === 'difference' ? eligible[0] : eligible[eligible.length - 1];
    if (head) {
      head.params.fills = fills;
      head.params.strokes = strokes;
      // Penpot gives a boolean whose head is a path (has `svg-attrs`) without fills a default black fill.
      if (head.kind === 'path' && fills.length === 0) delete head.params.svgAttrs;
    }
    const params: GroupParams = { ...this.common(node, parent, index), ...unitBox(), fills, strokes };
    return [{ kind: 'group', bool: type, origin: { irId: node.id, suffix: '' }, node, params, children }];
  }

  // --- leaves ----------------------------------------------------------------

  private rect(node: ir.RectNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    const fit = boxGeometry(abs, node.size);
    if (fit.skewed) return this.shearedOutline(node, parent, index, abs, rectCommands(node.size.width, node.size.height, node.cornerRadii));
    const scale = this.scale(fit, node);
    const target = this.boxTarget(node, fit);
    const fills = convertFills(this.ctx, node.fills, target);
    // Figma ignores a boolean operand's own stroke: no stroke emulation (Penpot would union its shapes too).
    const operand = parent?.type === 'boolean';
    const sides = !operand && needsSideStrokes(node.stroke);
    if (!operand && !sides && !this.strokePlacement.strokeGroup(node) && tooManyBoxDashes(node)) this.warnTooManyDashes(node);
    const dashes = operand || sides ? undefined : this.boxStroke(node, abs);
    if (!sides && !dashes) {
      const band = operand ? undefined : this.centredBand(node, parent);
      if (band !== undefined) {
        // The stroke centred on the box offset to the band's centre line (`centredBand`).
        const moved = boxGeometry(multiply(abs, { a: 1, b: 0, c: 0, d: 1, e: band.offset, f: band.offset }), { width: node.size.width - 2 * band.offset, height: node.size.height - 2 * band.offset });
        const corners = node.cornerRadii?.map((r) => (r > 0 ? Math.max(0, r - band.offset) : 0)) as [number, number, number, number] | undefined;
        return [
          {
            kind: 'rect',
            origin: { irId: node.id, suffix: '' },
            node,
            params: {
              ...this.bandCommon(node, parent, index, band),
              ...moved.geometry,
              ...radii(corners, scale),
              fills,
              strokes: convertStrokes(this.ctx, band.stroke, target, { open: false, scale, turn: boxTurn(node.cornerRadii) }),
            },
          },
        ];
      }
      const strokes = convertStrokes(this.ctx, node.stroke, target, { open: false, scale, turn: boxTurn(node.cornerRadii) });
      return [
        {
          kind: 'rect',
          origin: { irId: node.id, suffix: '' },
          node,
          params: { ...this.common(node, parent, index), ...fit.geometry, ...radii(node.cornerRadii, scale), fills, strokes },
        },
      ];
    }
    const children: PNode[] = [
      {
        kind: 'rect',
        origin: { irId: node.id, suffix: 'shape' },
        node,
        params: { id: shapeId(node.id, 'shape'), name: shapeName(node), ...fit.geometry, ...radii(node.cornerRadii, scale), fills, strokes: [] },
      },
    ];
    const stroke = dashes ?? this.sideStrokes(node, abs);
    if (stroke) children.push(stroke);
    const params: GroupParams = { ...this.common(node, parent, index), ...orientation(fit) };
    return [{ kind: 'group', origin: { irId: node.id, suffix: '' }, node, params, children }];
  }

  private ellipse(node: ir.EllipseNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    const fit = boxGeometry(abs, node.size);
    if (fit.skewed) return this.shearedOutline(node, parent, index, abs, ellipseCommands(node.size.width, node.size.height));
    const scale = this.scale(fit, node);
    const target = this.boxTarget(node, fit);
    const fills = convertFills(this.ctx, node.fills, target);
    if (parent?.type !== 'boolean' && !this.strokePlacement.strokeGroup(node) && tooManyBoxDashes(node)) this.warnTooManyDashes(node);
    const dashes = parent?.type === 'boolean' ? undefined : this.boxStroke(node, abs);
    if (!dashes) {
      const band = parent?.type === 'boolean' || Math.abs(node.size.width - node.size.height) > 1e-3 ? undefined : this.centredBand(node, parent);
      const geometry = band
        ? boxGeometry(multiply(abs, { a: 1, b: 0, c: 0, d: 1, e: band.offset, f: band.offset }), { width: node.size.width - 2 * band.offset, height: node.size.height - 2 * band.offset }).geometry
        : fit.geometry;
      return [
        {
          kind: 'circle',
          origin: { irId: node.id, suffix: '' },
          node,
          params: { ...(band ? this.bandCommon(node, parent, index, band) : this.common(node, parent, index)), ...geometry, fills, strokes: convertStrokes(this.ctx, band?.stroke ?? node.stroke, target, { open: false, scale, turn: 0 }) },
        },
      ];
    }
    const shape: PNode = { kind: 'circle', origin: { irId: node.id, suffix: 'shape' }, node, params: { id: shapeId(node.id, 'shape'), name: shapeName(node), ...fit.geometry, fills, strokes: [] } };
    const params: GroupParams = { ...this.common(node, parent, index), ...orientation(fit) };
    return [{ kind: 'group', origin: { irId: node.id, suffix: '' }, node, params, children: [shape, dashes] }];
  }

  private path(node: ir.PathNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    if (parent?.type === 'boolean') {
      // An operand of an editable boolean: Penpot combines every shape it is drawn with (a stroke outline's
      // mask too), and Figma ignores an operand's stroke anyway. Its fill outline, or the editable paths.
      const outline = !this.pathsExact(node) && node.geometry?.fill?.length ? node.geometry.fill : node.paths;
      return this.pathSet(node, parent, index, abs, [{ paths: outline, fills: node.fills, stroke: node.stroke, suffix: 'part' }]);
    }
    const exact = this.pathsExact(node);
    // A copy drawn like its exact main although its own paths are inexact (e.g. a corner radius override): a
    // closed path's own fill outline is the shape Figma strokes, so it stands in for the network.
    const ownOutline = exact && !drawnExact(node) && !outlinedCaps(node) && isClosed(node.paths) && node.geometry?.fill?.length ? node.geometry.fill : undefined;
    const editable: PathPart[] = this.dashedParts(node) ?? [{ paths: ownOutline ?? node.paths, fills: node.fills, stroke: node.stroke, suffix: 'part' }];
    if (!exact && outlinedCaps(node)) {
      this.ctx.warn('stroke-cap-outlined', `Penpot draws ${capNames(node.stroke!)} caps with its own marker shapes; the stroke is drawn from the source's outline`, node);
    }
    if (exact || !node.geometry) {
      if (!exact) this.ctx.warn('path-approximated', 'The vector paths only approximate the source and no outline was provided', node);
      return this.pathSet(node, parent, index, abs, editable);
    }
    // The editable paths would not look right: draw the source's own fill and stroke outlines.
    const hasFills = node.fills.some((p) => p.visible);
    const hasStroke = hasVisibleStroke(node.stroke);
    const fillGeometry = node.geometry.fill;
    const strokeGeometry = node.geometry.stroke;
    if ((hasFills && !fillGeometry?.length) || (hasStroke && !strokeGeometry?.length) || (!hasFills && !hasStroke)) {
      if (hasFills || hasStroke) this.ctx.warn('path-approximated', 'The vector paths only approximate the source and its outline is incomplete', node);
      return this.pathSet(node, parent, index, abs, editable);
    }
    // An inside/outside stroke's outline is the full 2w band: it is clipped to / cut from the fill shape.
    // Figma strokes open paths centred whatever the alignment, so their outline is used as is.
    const aligned = hasStroke && node.stroke!.align !== 'center' && isClosed(node.paths);
    if (aligned && !fillGeometry?.length) {
      this.ctx.warn('path-approximated', `The vector paths only approximate the source and its ${node.stroke!.align} stroke outline cannot be clipped`, node);
      return this.pathSet(node, parent, index, abs, editable);
    }
    const parts: PathPart[] = [];
    if (hasFills && fillGeometry) parts.push({ paths: fillGeometry, fills: node.fills, suffix: 'fill' });
    if (hasStroke && strokeGeometry) {
      const part: PathPart = { paths: strokeGeometry, fills: node.stroke!.paints, suffix: 'stroke' };
      if (aligned && fillGeometry) part.clip = { paths: fillGeometry, keep: node.stroke!.align === 'inside' ? 'inside' : 'outside' };
      parts.push(part);
    }
    return this.pathSet(node, parent, index, abs, parts);
  }

  private text(node: ir.TextNode, parent: Parent, index: number, abs: ir.Matrix): PNode[] {
    const mode = this.ctx.options.textMode;
    // `auto`: editable only where Penpot is expected to draw what the source drew (text/editability.ts), decided
    // for a main and its copies together (text/classes.ts) so that every copy shape has a counterpart.
    this.textClasses ??= new TextOutlineClasses(this.ctx.doc, this.ctx.options.renderer, this.ctx.options.components, this.ctx.options.pixelExact);
    const decision = mode === 'auto' ? this.textClasses.decide(node) : undefined;
    if (decision && !decision.outline && decision.reason && decision.classReason) {
      this.ctx.warn('text-kept-editable-component', `${decision.reason.message.replace(/; the text was converted to outlines$/, '')}; kept editable like the other texts of its component`, node);
    }
    if (mode === 'outline' || decision?.outline) {
      const outlines = node.layout?.outlines ?? [];
      if (outlines.length > 0) {
        if (decision?.reason) this.ctx.warn(decision.reason.code, decision.reason.message, node);
        else if (decision?.classReason) {
          this.ctx.warn('text-outlined-component', `Converted to outlines like the other texts of its component (${decision.classReason.code})`, node);
        }
        return this.textOutlines(node, parent, index, abs, outlines, decision?.grouping ?? 'runs');
      }
      if (node.characters.trim() !== '') {
        this.ctx.warn('text-outlines-missing', 'No glyph outlines are available; the text stays editable', node);
      }
    }
    const lineBreaks = this.ctx.options.textLineBreaks;
    let attrs: ReturnType<typeof buildTextAttrs>;
    let target: PaintTarget;
    let fit: BoxFit;
    try {
      // The Penpot box may be larger than the IR box (text/box.ts). It is placed in the text's local space, so
      // rotation and mirroring carry over, and paints keep their position relative to the IR box.
      // The SVG renderer rounds baselines in page space: it needs the page y of an unscaled, unrotated text.
      const axisAligned = Math.abs(abs.a - 1) < 1e-9 && Math.abs(abs.d - 1) < 1e-9 && Math.abs(abs.b) < 1e-9 && Math.abs(abs.c) < 1e-9;
      const { box } = penpotTextBox(node, lineBreaks, {
        renderer: this.ctx.options.renderer,
        pageY: axisAligned ? abs.f : undefined,
        textSpacing: this.ctx.options.textSpacing ?? 'line',
        glyphCensus: this.textClasses.census,
      });
      fit = boxGeometry(multiply(abs, { a: 1, b: 0, c: 0, d: 1, e: box.x, f: box.y }), { width: box.width, height: box.height });
      const paintTarget: PaintTarget = { node, size: node.size, space: textPaintSpace(node.size, box, fit) };
      target = paintTarget;
      const deps: TextDeps = {
        reporter: this.ctx.reporter,
        fills: (paints) => convertFills(this.ctx, paints, paintTarget),
        lineBreaks,
        textSpacing: this.ctx.options.textSpacing ?? 'line',
        renderer: this.ctx.options.renderer,
        glyphCensus: this.textClasses.census,
        typographyRef: (styleId) => {
          const id = this.ctx.styles.typographyRef(styleId);
          return id === undefined ? undefined : { id, file: this.ctx.fileId };
        },
      };
      attrs = buildTextAttrs(node, deps);
    } catch (error) {
      const outlines = node.layout?.outlines ?? [];
      this.ctx.warn('text-conversion-failed', `Text could not be converted${outlines.length ? '; drawn as outlines' : ' and was skipped'}: ${String(error)}`, node);
      return outlines.length ? this.textOutlines(node, parent, index, abs, outlines, decision?.grouping ?? 'runs') : [];
    }
    const params: TextParams = {
      ...this.common(node, parent, index),
      ...fit.geometry,
      ...attrs,
      id: shapeId(node.id),
      strokes: convertStrokes(this.ctx, node.stroke, target, { open: false }),
    };
    return [{ kind: 'text', origin: { irId: node.id, suffix: '' }, node, params }];
  }

  private textOutlines(
    node: ir.TextNode,
    parent: Parent,
    index: number,
    abs: ir.Matrix,
    outlines: NonNullable<NonNullable<ir.TextNode['layout']>['outlines']>,
    grouping: OutlineGrouping,
  ): PNode[] {
    // One path per run, or (to match the other members of its component class, text/classes.ts) per fill list / one.
    const groups = grouping === 'runs' ? outlines.map((_, i) => [i]) : grouping === 'fills' ? fillGroups(node) : [outlines.map((_, i) => i)];
    if (grouping === 'single' && new Set(outlines.map((o) => JSON.stringify(node.runs[o.runIndex]?.style.fills ?? []))).size > 1) {
      this.ctx.warn('text-outline-fills-merged', "The outlines are one path like the other texts of its component; the runs' other fills were replaced by the first one's", node);
    }
    const parts = groups.map(
      (group, i): PathPart => ({
        paths: group.map((k) => outlines[k]!.path),
        fills: node.runs[outlines[group[0]!]!.runIndex]?.style.fills ?? [],
        stroke: node.stroke,
        suffix: `glyphs${i}`,
      }),
    );
    return this.pathSet(node, parent, index, abs, parts, { alwaysGroup: true });
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * A dashed path that Figma strokes centred (open sub-paths always): the fill, plus Figma's dashes
   * (`dashes.ts`, one dash layout per edge) as open sub-paths with a solid stroke. Undefined when the path is
   * not dashed that way, or when the dashes leave no gap.
   */
  private dashedParts(node: ir.PathNode): PathPart[] | undefined {
    const stroke = node.stroke;
    if (!stroke || !dashable(stroke) || (stroke.align !== 'center' && isClosed(node.paths))) return undefined;
    const subs = node.paths.flatMap((path) => pathSegments(path.commands));
    if (dashCount(subs.flatMap((sub) => sub.segments), stroke.dashPattern) > MAX_DASHES) {
      this.warnTooManyDashes(node);
      return undefined;
    }
    const commands: ir.PathCommand[] = [];
    let gaps = false;
    for (const sub of subs) {
      const dashes = dashPaths(sub.segments, stroke.dashPattern, sub.closed);
      if (dashes) {
        gaps = true;
        commands.push(...dashes);
      } else {
        // No gap on this sub-path: its whole centre line.
        commands.push(...fullPath(sub.segments, false));
      }
    }
    if (!gaps) return undefined;
    this.warnDashPaths(node);
    const parts: PathPart[] = [];
    if (node.fills.some((p) => p.visible)) parts.push({ paths: node.paths, fills: node.fills, suffix: 'fill' });
    parts.push({ paths: [{ windingRule: 'nonzero', commands }], fills: [], stroke: { ...stroke, dashPattern: [], align: 'center' }, suffix: 'stroke-dashes' });
    return parts;
  }

  /**
   * `pixelExact`, SVG renderer: an opaque inside / outside stroke on a filled rect or circle, as a centred stroke on the box
   * offset by half the width to the band's centre line (`offset` > 0 insets). Penpot draws an aligned stroke
   * clipped to the shape, so where the shape's edge does not fall on a pixel boundary the fill's anti-aliased
   * edge shows through the stroke's (inside: the fill colour bleeds into the outer edge; outside: a light seam
   * at the inner edge); Figma draws neither (live check `test/penpot/live/strokes.test.ts`). The same band is
   * covered, and the fill under the opaque stroke is hidden either way. Not for the WASM renderer, which snaps
   * centred strokes of boxes to whole pixels. In an auto layout flow, inside strokes only: margins of the
   * inset keep the box's place and size there.
   */
  private centredBand(node: ir.RectNode | ir.EllipseNode, parent: Parent): { offset: number; stroke: ir.Stroke; flows: boolean } | undefined {
    const stroke = node.stroke;
    if (!this.ctx.options.pixelExact || this.ctx.options.renderer !== 'svg' || !hasVisibleStroke(stroke) || stroke.align === 'center' || stroke.perSide || stroke.dashPattern.length > 0) return undefined;
    const fills = node.fills.filter((p) => p.visible);
    if (fills.length === 0 || !fills.every((p) => p.type === 'solid')) return undefined;
    const paints = stroke.paints.filter((p) => p.visible);
    const top = paints[paints.length - 1];
    if (!top || top.type !== 'solid' || top.opacity < 1 || top.color.a < 1 || (top.blendMode !== 'normal' && top.blendMode !== 'pass-through')) return undefined;
    if (node.effects.some((e) => e.visible && (e.type === 'inner-shadow' || e.type === 'background-blur'))) return undefined;
    const w = stroke.weight;
    const offset = stroke.align === 'inside' ? w / 2 : -w / 2;
    // In an auto layout flow the inset box keeps its place with margins of the inset (positive margins only).
    const flows = parent?.type === 'frame' && parent.layout !== undefined && node.layoutChild?.positioning !== 'absolute';
    if (flows && offset < 0) return undefined;
    if (node.size.width - 2 * offset <= 0 || node.size.height - 2 * offset <= 0) return undefined;
    // An inside corner radius below w / 2 has no centre line to follow.
    if (node.type === 'rect' && offset > 0 && node.cornerRadii?.some((r) => r > 0 && r < offset)) return undefined;
    this.ctx.warn(
      'pixel-exact-stroke-inset',
      `pixelExact: the ${stroke.align} stroke is drawn centred on the box ${offset > 0 ? 'inset' : 'outset'} by half its width (no fill fringe at the stroke's edge); the shape's box is no longer the design's`,
      node,
    );
    return { offset, stroke: { ...stroke, align: 'center' }, flows };
  }

  /** Layout attributes of a box drawn inset by `offset` (`centredBand`): margins keep its place in the flow. */
  private bandCommon(node: ir.Node, parent: Parent, index: number, band: { offset: number; flows: boolean }): Common {
    const common = this.common(node, parent, index);
    if (!band.flows) return common;
    const d = clean(band.offset);
    common.layoutItemMargin = { m1: d, m2: d, m3: d, m4: d };
    common.layoutItemMarginType = 'multiple';
    for (const key of ['layoutItemMinW', 'layoutItemMaxW', 'layoutItemMinH', 'layoutItemMaxH'] as const) {
      const v = common[key];
      if (v !== undefined) common[key] = clean(Math.max(0, v - 2 * band.offset));
    }
    return common;
  }

  /** A rect/ellipse whose transform shears: drawn as an exact path outline. */
  private shearedOutline(node: ir.RectNode | ir.EllipseNode, parent: Parent, index: number, abs: ir.Matrix, commands: ir.PathCommand[]): PNode[] {
    this.ctx.warn('sheared-shape-to-path', `The ${node.type === 'rect' ? 'rectangle' : 'ellipse'} is sheared, which Penpot cannot express; it was converted to a path`, node);
    if (node.stroke?.perSide) {
      this.ctx.warn('per-side-stroke-approximated', 'Per-side stroke widths on a sheared shape were drawn with the largest width', node);
    }
    return this.pathSet(node, parent, index, abs, [{ paths: [{ windingRule: 'nonzero', commands }], fills: node.fills, stroke: node.stroke, suffix: 'part' }]);
  }

  /**
   * Draws `parts` as Penpot paths. A Penpot path has a single fill rule, so
   * each part is split per winding rule. One resulting path takes the node's
   * place directly; several are wrapped in a group carrying the node's
   * attributes.
   */
  private pathSet(node: ir.Node, parent: Parent, index: number, abs: ir.Matrix, parts: readonly PathPart[], options: { alwaysGroup?: boolean } = {}): PNode[] {
    interface Entry {
      part: PathPart;
      rule: ir.WindingRule;
      commands: AbsCommand[];
      open: boolean;
    }
    const entries: Entry[] = [];
    for (const part of parts) {
      const rules: ir.WindingRule[] = [];
      for (const p of part.paths) if (!rules.includes(p.windingRule)) rules.push(p.windingRule);
      for (const rule of rules) {
        const paths = part.paths.filter((p) => p.windingRule === rule);
        let commands = paths.flatMap((p) => bakeCommands(p.commands, abs));
        if (!hasSegments(commands)) continue;
        // Penpot's SVG renderer clips aligned strokes under the nonzero rule (`windAlternately`).
        if (rule === 'evenodd' && hasVisibleStroke(part.stroke) && part.stroke.align !== 'center') commands = windAlternately(commands);
        entries.push({ part, rule, commands, open: !isClosed(paths) });
      }
    }
    if (entries.length === 0) {
      this.ctx.warn('empty-path', 'Node has no drawable geometry and was dropped', node);
      return [];
    }
    // The geometry is baked into page space; strokes follow the transform's scale like box shapes do.
    const scale = entries.some((e) => hasVisibleStroke(e.part.stroke)) ? this.scale(boxGeometry(abs, node.size), node) : 1;
    const pathAttrs = (entry: Entry): Omit<PathParams, 'id' | 'name'> => {
      const b = bounds(entry.commands)!;
      const target: PaintTarget = { node, size: node.size, space: boundsSpace(abs, node.size, b) };
      return {
        content: serialize(entry.commands),
        svgAttrs: { fillRule: entry.rule },
        fills: convertFills(this.ctx, entry.part.fills, target),
        strokes: convertStrokes(this.ctx, entry.part.stroke, target, { open: entry.open, scale, turn: maxTurn(entry.commands) }),
      };
    };
    const clipped = (part: PathPart): boolean => part.clip !== undefined;
    if (entries.length === 1 && !options.alwaysGroup && !clipped(entries[0]!.part)) {
      const params: PathParams = { ...this.common(node, parent, index), ...pathAttrs(entries[0]!) };
      return [{ kind: 'path', origin: { irId: node.id, suffix: '' }, node, params }];
    }
    const pathNode = (entry: Entry, i: number): PathNode => {
      const suffix = `${entry.part.suffix}-${i}`;
      return {
        kind: 'path',
        origin: { irId: node.id, suffix },
        node,
        params: { id: shapeId(node.id, suffix), name: shapeName(node), ...pathAttrs(entry) },
      };
    };
    const orient = orientation(boxGeometry(abs, node.size));
    // Consecutive entries of one clipped part share a mask group.
    const children: PNode[] = [];
    let i = 0;
    while (i < entries.length) {
      const part = entries[i]!.part;
      if (!part.clip) {
        children.push(pathNode(entries[i]!, i));
        i++;
        continue;
      }
      const members: PathNode[] = [];
      const extent: Bounds[] = [];
      const first = i;
      for (; i < entries.length && entries[i]!.part === part; i++) {
        members.push(pathNode(entries[i]!, i));
        extent.push(bounds(entries[i]!.commands)!);
      }
      const mask = this.clipMask(node, abs, part.clip, extent, `${part.suffix}-${first}-mask`);
      if (!mask) {
        children.push(...members);
        continue;
      }
      const suffix = `${part.suffix}-${first}-clip`;
      children.push({
        kind: 'group',
        origin: { irId: node.id, suffix },
        node,
        params: { id: shapeId(node.id, suffix), name: shapeName(node), ...orient, maskedGroup: true },
        children: [mask, ...members],
      });
    }
    if (children.length === 1 && !options.alwaysGroup && children[0]!.kind === 'group') {
      // A single clipped part: its mask group takes the node's place.
      const only = children[0]!;
      only.origin = { irId: node.id, suffix: '' };
      only.params = { ...only.params, ...this.common(node, parent, index), ...orient };
      return [only];
    }
    const params: GroupParams = { ...this.common(node, parent, index), ...orient };
    return [{ kind: 'group', origin: { irId: node.id, suffix: '' }, node, params, children }];
  }

  /**
   * The mask shape keeping the inside (the clip paths) or the outside (a box around `members` with the
   * clip paths cut out, even-odd) of `clip`. Penpot masks by the mask shape's alpha: it is filled opaque.
   */
  private clipMask(node: ir.Node, abs: ir.Matrix, clip: NonNullable<PathPart['clip']>, extent: readonly Bounds[], suffix: string): PathNode | undefined {
    const commands = clip.paths.flatMap((p) => bakeCommands(p.commands, abs));
    if (!hasSegments(commands)) return undefined;
    let rule: ir.WindingRule = clip.paths[0]?.windingRule ?? 'nonzero';
    let content = commands;
    if (clip.keep === 'outside') {
      const all = [bounds(commands)!, ...extent];
      const x0 = Math.min(...all.map((b) => b.x)) - 1;
      const y0 = Math.min(...all.map((b) => b.y)) - 1;
      const x1 = Math.max(...all.map((b) => b.x + b.width)) + 1;
      const y1 = Math.max(...all.map((b) => b.y + b.height)) + 1;
      content = [...bakeCommands(boxCommands(x0, y0, x1 - x0, y1 - y0), identity()), ...commands];
      rule = 'evenodd';
    }
    return {
      kind: 'path',
      origin: { irId: node.id, suffix },
      node,
      params: {
        id: shapeId(node.id, suffix),
        name: `${shapeName(node)} mask`,
        content: serialize(content),
        svgAttrs: { fillRule: rule },
        fills: [{ fillColor: '#000000', fillOpacity: 1 }],
        strokes: [],
      },
    };
  }

  /** The `band` placement's child: the board's fill and its inside stroke centred on the box inset by `offset`. */
  private frameBand(node: ir.FrameNode, abs: ir.Matrix, scale: number, offset: number): PNode {
    const size = { width: node.size.width - 2 * offset, height: node.size.height - 2 * offset };
    const fit = boxGeometry(multiply(abs, { a: 1, b: 0, c: 0, d: 1, e: offset, f: offset }), size);
    const target = this.boxTarget(node, fit);
    const corners = node.cornerRadii?.map((r) => (r > 0 ? Math.max(0, r - offset) : 0)) as [number, number, number, number] | undefined;
    return {
      kind: 'rect',
      origin: { irId: node.id, suffix: 'band' },
      node,
      params: {
        id: shapeId(node.id, 'band'),
        name: FRAME_BAND_NAME,
        ...fit.geometry,
        ...radii(corners, scale),
        fills: convertFills(this.ctx, node.fills, target),
        strokes: convertStrokes(this.ctx, { ...node.stroke!, align: 'center' }, target, { open: false, scale, turn: boxTurn(corners) }),
      },
    };
  }

  /**
   * The shape drawing a frame's stroke apart from the board (`frame-strokes.ts`): Figma's dashes as a path
   * (`dashes.ts`), else a rect with the board's stroke. `withStrokes` false: the same shape without strokes,
   * which keeps a copy parallel to its main when only one of them needs the shape. `where`: inside the board or
   * directly above it in its parent (for the warning).
   */
  private frameStroke(node: ir.FrameNode, abs: ir.Matrix, fit: BoxFit, scale: number, withStrokes: boolean, where: 'child' | 'sibling'): PNode {
    const stroke = node.stroke;
    if (withStrokes) {
      const why =
        !node.clipsContent && childrenMeetStroke(node)
          ? "Figma paints a non-clipping frame's stroke below its children"
          : boxDashable(node)
            ? "Figma's dash layout cannot be drawn on a board"
            : "Figma shadows this fill-less frame's stroke, Penpot would shadow its children";
      const shape = where === 'sibling' ? 'a separate "Stroke" shape directly above the board' : `a separate "Stroke" shape, the board's ${node.clipsContent ? 'last' : 'first'} child`;
      this.ctx.warn('frame-stroke-separated', `${why}; the stroke is drawn by ${shape}`, node);
    }
    if (stroke && boxDashable(node)) {
      const commands = dashPaths(rectSegments(node.size.width, node.size.height, node.cornerRadii, centerOffset(stroke.align, stroke.weight)), stroke.dashPattern, true);
      if (commands) {
        const path = this.dashPath(node, abs, commands, stroke, 'stroke-dashes', FRAME_STROKE_NAME);
        if (path) {
          if (!withStrokes) path.params.strokes = [];
          else this.warnDashPaths(node);
          return path;
        }
      }
    }
    // Too many dashes (`MAX_DASHES`): Penpot's own dashes, on the separate shape too.
    const solid = stroke && boxDashable(node) ? { ...stroke, dashPattern: [] } : stroke;
    return {
      kind: 'rect',
      origin: { irId: node.id, suffix: 'stroke' },
      node,
      params: {
        id: shapeId(node.id, 'stroke'),
        name: FRAME_STROKE_NAME,
        ...fit.geometry,
        ...radii(node.cornerRadii, scale),
        fills: [],
        strokes: withStrokes ? convertStrokes(this.ctx, solid, this.boxTarget(node, fit), { open: false, scale, turn: boxTurn(node.cornerRadii) }) : [],
      },
    };
  }

  /**
   * The `Stroke` shape of a frame whose drop shadow it carries (`shadowsStroke`): the stroke's band as an even-odd
   * filled path (outer box minus inner box, radii following), which both renderers shadow by its outline (the WASM
   * renderer shadows a stroke-only shape as if it were filled). `withStrokes` false: the same path without fill.
   */
  private frameStrokeBand(node: ir.FrameNode, abs: ir.Matrix, withStrokes: boolean): PNode {
    const stroke = node.stroke!;
    if (withStrokes) {
      this.ctx.warn('frame-stroke-separated', "Figma shadows this fill-less frame's stroke, Penpot would shadow its children; the stroke is drawn by a separate \"Stroke\" shape (its band, filled), the board's first child", node);
    }
    const w = stroke.weight;
    const out = stroke.align === 'outside' ? w : stroke.align === 'center' ? w / 2 : 0;
    const inward = w - out;
    const box = (grow: number): ir.PathCommand[] => {
      const width = node.size.width + 2 * grow;
      const height = node.size.height + 2 * grow;
      if (!(width > 0 && height > 0)) return [];
      const radii = node.cornerRadii?.map((r) => (r > 0 ? Math.max(0, r + grow) : 0)) as [number, number, number, number] | undefined;
      return rectCommands(width, height, radii).map((c) => (c.type === 'Z' ? c : c.type === 'C' ? { ...c, x: c.x - grow, y: c.y - grow, x1: c.x1 - grow, y1: c.y1 - grow, x2: c.x2 - grow, y2: c.y2 - grow } : c.type === 'Q' ? { ...c, x: c.x - grow, y: c.y - grow, x1: c.x1 - grow, y1: c.y1 - grow } : { ...c, x: c.x - grow, y: c.y - grow }));
    };
    const baked = bakeCommands([...box(out), ...box(-inward)], abs);
    const b = bounds(baked)!;
    const target: PaintTarget = { node, size: node.size, space: boundsSpace(abs, node.size, b) };
    return {
      kind: 'path',
      origin: { irId: node.id, suffix: 'stroke' },
      node,
      params: {
        id: shapeId(node.id, 'stroke'),
        name: FRAME_STROKE_NAME,
        content: serialize(baked),
        svgAttrs: { fillRule: 'evenodd' },
        fills: withStrokes ? convertFills(this.ctx, stroke.paints, target) : [],
        strokes: [],
      },
    };
  }

  /**
   * Figma's dashes (`dashes.ts`) of `stroke`: open sub-paths in the node's local space, stroked solid and
   * centred with the stroke's width (they already lie on the stroke's centre line).
   */
  private dashPath(node: ir.Node, abs: ir.Matrix, commands: ir.PathCommand[], stroke: ir.Stroke, suffix: string, name: string, keepPattern = false): PathNode | undefined {
    const baked = bakeCommands(commands, abs);
    const b = bounds(baked);
    if (!b || !hasSegments(baked)) return undefined;
    const scale = this.scale(boxGeometry(abs, node.size), node);
    const target: PaintTarget = { node, size: node.size, space: boundsSpace(abs, node.size, b) };
    const solid: ir.Stroke = { ...stroke, dashPattern: keepPattern ? stroke.dashPattern : [], align: 'center', startCap: 'none', endCap: 'none' };
    return {
      kind: 'path',
      origin: { irId: node.id, suffix },
      node,
      params: {
        id: shapeId(node.id, suffix),
        name,
        content: serialize(baked),
        svgAttrs: { fillRule: 'nonzero' },
        fills: [],
        strokes: convertStrokes(this.ctx, solid, target, { open: true, scale, turn: maxTurn(baked) }),
      },
    };
  }

  /**
   * The stroke path of a rect / ellipse drawn as {shape, stroke path} (`FrameStrokePlacement.strokeGroup`):
   * Figma's dashes, or, for a solid stroke (a shape linked to a dashed one), the closed centre line with a
   * solid centred stroke, which draws the same as the aligned stroke. Undefined: draw the plain shape.
   */
  private boxStroke(node: ir.RectNode | ir.EllipseNode, abs: ir.Matrix): PathNode | undefined {
    if (!this.strokePlacement.strokeGroup(node)) return undefined;
    const stroke = node.stroke;
    const name = `${shapeName(node)} stroke`;
    const weight = stroke && !stroke.perSide ? stroke.weight : 0;
    const offset = stroke ? centerOffset(stroke.align, weight) : 0;
    const segments: DashSegment[] =
      node.type === 'rect' ? rectSegments(node.size.width, node.size.height, node.cornerRadii, offset) : ellipseSegments(node.size.width, node.size.height, offset);
    const dashes = stroke && boxDashable(node) ? dashPaths(segments, stroke.dashPattern, true) : undefined;
    const commands = dashes ?? fullPath(segments, true);
    const { perSide: _sides, ...uniform } = stroke ?? { paints: [], weight: 0, align: 'center' as const, join: 'miter' as const, startCap: 'none' as const, endCap: 'none' as const, dashPattern: [] };
    // Too many dashes (`MAX_DASHES`): the closed centre line with Penpot's own dashes.
    const native = tooManyBoxDashes(node);
    if (native) this.warnTooManyDashes(node);
    const path = this.dashPath(node, abs, commands, uniform, 'stroke-dashes', name, native);
    if (path && !hasVisibleStroke(stroke)) path.params.strokes = [];
    else if (path && dashes) this.warnDashPaths(node);
    return path;
  }

  /** Too many dashes to draw Figma's layout as geometry (`MAX_DASHES`): Penpot's own dashes. */
  private warnTooManyDashes(node: ir.Node): void {
    this.ctx.warn('stroke-dash-approximated', `Figma restarts the dashes on every side / edge; with more than ${MAX_DASHES} dashes that layout is not drawn as geometry, Penpot's own dashes were used`, node);
  }

  /** Figma's dash layout drawn as geometry (`dashes.ts`): the dashes are no longer one editable stroke. */
  private warnDashPaths(node: ir.Node): void {
    this.ctx.warn('stroke-dash-paths', 'Figma restarts the dash pattern on every side / edge, which Penpot cannot; the dashes are drawn as open sub-paths with a solid stroke', node);
  }

  /**
   * Penpot has no per-side stroke widths: the visible sides are drawn as one
   * even-odd filled path (outer box minus inner box), filled with the stroke paints.
   */
  private sideStrokes(node: ir.FrameNode | ir.RectNode, abs: ir.Matrix): PathNode | undefined {
    const stroke = node.stroke;
    if (!stroke?.perSide) return undefined;
    const { top: t, right: r, bottom: b, left: l } = stroke.perSide;
    const { width: w, height: h } = node.size;
    const k = stroke.align === 'inside' ? 0 : stroke.align === 'center' ? 0.5 : 1;
    const outer = { x: -l * k, y: -t * k, width: w + (l + r) * k, height: h + (t + b) * k };
    const inner = { x: l * (1 - k), y: t * (1 - k), width: w - (l + r) * (1 - k), height: h - (t + b) * (1 - k) };
    const commands = [
      ...boxCommands(outer.x, outer.y, outer.width, outer.height),
      ...(inner.width > 0 && inner.height > 0 ? boxCommands(inner.x, inner.y, inner.width, inner.height) : []),
    ];
    this.ctx.warn('per-side-stroke-emulated', 'Penpot has no per-side stroke widths; the stroke was drawn as a filled shape', node);
    if (stroke.dashPattern.length > 0) this.ctx.warn('per-side-stroke-dash-dropped', 'The dashes of the per-side stroke were not reproduced', node);
    if (node.cornerRadii?.some((v) => v > 0)) {
      this.ctx.warn('per-side-stroke-radius-ignored', 'The emulated per-side stroke ignores the corner radii', node);
    }
    const baked = bakeCommands(commands, abs);
    const b0 = bounds(baked);
    if (!b0) return undefined;
    const target: PaintTarget = { node, size: node.size, space: boundsSpace(abs, node.size, b0) };
    return {
      kind: 'path',
      origin: { irId: node.id, suffix: 'stroke-sides' },
      node,
      params: {
        id: shapeId(node.id, 'stroke-sides'),
        name: node.type === 'frame' ? FRAME_STROKE_NAME : `${shapeName(node)} stroke`,
        content: serialize(baked),
        svgAttrs: { fillRule: 'evenodd' },
        fills: convertFills(this.ctx, stroke.paints, target),
        strokes: [],
      },
    };
  }

  /** Attributes of the shape standing for `node` in its parent. */
  private common(node: ir.Node, parent: Parent, index: number): Common {
    const out: Common = {
      id: shapeId(node.id),
      name: shapeName(node),
      ...constraints(node),
      ...layoutChild(node, parent, index),
      ...convertEffects(this.ctx, node, node.id, this.overOpaque(node)),
    };
    if (!node.visible) out.hidden = true;
    if (node.locked) out.blocked = true;
    const alpha = opacity(node.opacity);
    if (alpha !== 1) out.opacity = alpha;
    else if (node.blendMode === 'normal' && (node.type === 'group' || node.type === 'frame') && blendsWithin(node)) {
      // Figma isolates a "normal" container: its children blend only with each other. Penpot isolates a group
      // or board only when its opacity is below 1 (both renderers), so a barely lower opacity stands in.
      out.opacity = ISOLATING_OPACITY;
      this.ctx.warn('blend-isolation-emulated', `The ${node.type} isolates the blend modes of its content; drawn with ${ISOLATING_OPACITY * 100}% opacity, which Penpot isolates`, node);
    }
    const blend = BLEND_MODES[node.blendMode];
    if (node.blendMode === 'linear-burn' || node.blendMode === 'linear-dodge') {
      this.ctx.warn('blend-mode-approximated', `Penpot has no "${node.blendMode}" blend mode; "${blend}" was used`, node);
    }
    if (blend !== 'normal') out.blendMode = blend;
    return out;
  }

  private boxTarget(node: ir.Node, fit: BoxFit): PaintTarget {
    return { node, size: node.size, space: boxSpace(fit.geometry.width, fit.geometry.height) };
  }

  /** Scale baked into width/height; radii and stroke widths follow its geometric mean. */
  private scale(fit: BoxFit, node: ir.Node): number {
    if (Math.abs(fit.scaleX - 1) > 1e-6 || Math.abs(fit.scaleY - 1) > 1e-6) {
      this.ctx.warn('transform-scale-baked', 'The transform scales the node; the scale was baked into its size', node);
      return Math.sqrt(Math.abs(fit.scaleX * fit.scaleY));
    }
    return 1;
  }
}

/** Paint space of a text whose Penpot box is `box` (local space) rather than its IR box. */
function textPaintSpace(size: ir.Size, box: { x: number; y: number; width: number; height: number }, fit: BoxFit): GradientSpace {
  const bw = box.width > 1e-9 ? box.width : 1;
  const bh = box.height > 1e-9 ? box.height : 1;
  return {
    toBox: { a: size.width / bw, b: 0, c: 0, d: size.height / bh, e: -box.x / bw, f: -box.y / bh },
    width: fit.geometry.width,
    height: fit.geometry.height,
  };
}

/** A frame whose fill is opaque everywhere it is (an opaque, normal, solid fill at full opacity). */
function opaqueFrame(frame: ir.FrameNode): boolean {
  return frame.opacity >= 1 && frame.fills.some((p) => p.visible && p.type === 'solid' && p.opacity >= 1 && p.color.a >= 1 && (p.blendMode === 'normal' || p.blendMode === 'pass-through'));
}

/** Whether Figma composes a group's content on its own before blending it with what is under it. */
function isolates(group: ir.GroupNode): boolean {
  return group.opacity < 1 || group.blendMode !== 'pass-through' || group.mask !== undefined;
}

/** Below 1 so Penpot isolates the container, close enough to 1 to change no colour by more than one level. */
const ISOLATING_OPACITY = 0.999;

/** Name of a frame's stroke drawn apart from the board; independent of the frame's name, which copies may change. */
const FRAME_STROKE_NAME = 'Stroke';
const FRAME_BAND_NAME = 'Fill and stroke';

/** Whether a non-normal blend mode inside `node` would reach through it (pass-through descendants included). */
/**
 * Caps that Penpot draws as markers of its own shape and size (both renderers differ from Figma, and from each
 * other): an open stroked path with one of them is drawn from the source's stroke outline. Round, square and
 * butt caps are plain SVG line caps, which match Figma's.
 */
const MARKER_CAPS: ReadonlySet<ir.StrokeCap> = new Set(['line-arrow', 'triangle-arrow', 'diamond', 'circle']);

function outlinedCaps(node: ir.PathNode): boolean {
  const stroke = node.stroke;
  if (!hasVisibleStroke(stroke) || !node.geometry?.stroke?.length) return false;
  return (MARKER_CAPS.has(stroke.startCap) || MARKER_CAPS.has(stroke.endCap)) && !isClosed(node.paths);
}

function capNames(stroke: ir.Stroke): string {
  return [...new Set([stroke.startCap, stroke.endCap].filter((c) => MARKER_CAPS.has(c)))].join(' / ');
}

/** Whether a path is drawn from its editable paths (else from the source's outlines). */
function drawnExact(node: ir.PathNode): boolean {
  return node.pathsAreExact && !outlinedCaps(node);
}

function blendsWithin(node: ir.FrameNode | ir.GroupNode): boolean {
  return node.children.some(
    (c) => (c.blendMode !== 'normal' && c.blendMode !== 'pass-through') || (c.blendMode === 'pass-through' && (c.type === 'group' || c.type === 'frame') && c.opacity >= 1 && blendsWithin(c)),
  );
}

/** Whether every coordinate the node produces stays inside Penpot's number range. */
function inRange(node: ir.Node, abs: ir.Matrix): boolean {
  const ok = (p: ir.Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < MAX_COORD && Math.abs(p.y) < MAX_COORD;
  if (!(Math.abs(node.size.width) < MAX_COORD && Math.abs(node.size.height) < MAX_COORD)) return false;
  const b = pageBounds(abs, node.size);
  if (!ok({ x: b.x, y: b.y }) || !ok({ x: b.x + b.width, y: b.y + b.height })) return false;
  const paths: ir.Path[] = [];
  if (node.type === 'path') paths.push(...node.paths);
  if (node.geometry?.fill) paths.push(...node.geometry.fill);
  if (node.geometry?.stroke) paths.push(...node.geometry.stroke);
  if (node.type === 'text') for (const o of node.layout?.outlines ?? []) paths.push(o.path);
  for (const path of paths) {
    for (const c of path.commands) {
      if (c.type === 'Z') continue;
      if (!ok(apply(abs, c))) return false;
      if ((c.type === 'C' || c.type === 'Q') && !ok(apply(abs, { x: c.x1, y: c.y1 }))) return false;
      if (c.type === 'C' && !ok(apply(abs, { x: c.x2, y: c.y2 }))) return false;
    }
  }
  if (node.type === 'text') {
    for (const line of node.layout?.lines ?? []) if (!ok(apply(abs, line.baseline)) || !(Math.abs(line.width) < MAX_COORD)) return false;
  }
  return true;
}

/**
 * Opaque black fills and strokes, opacity 1, on a (vector) mask shape and its descendants. Returns whether the
 * silhouette's alpha changed (an opacity, or a fill / stroke that was not opaque).
 */
function opaqueSilhouette(shape: PNode): boolean {
  const params = shape.params as ShapeCommon;
  let changed = params.opacity !== undefined && params.opacity < 1;
  delete params.opacity;
  if (params.fills?.length) {
    changed ||= params.fills.some((f) => f.fillColor === undefined || (f.fillOpacity ?? 1) < 1);
    params.fills = [{ fillColor: '#000000', fillOpacity: 1 }];
  }
  if (params.strokes?.length) {
    changed ||= params.strokes.some((st) => st.strokeColor === undefined || (st.strokeOpacity ?? 1) < 1);
    params.strokes = params.strokes.map(({ strokeColorGradient: _g, strokeImage: _i, strokeColorRefId: _r, strokeColorRefFile: _f, ...rest }) => ({
      ...rest,
      strokeColor: '#000000',
      strokeOpacity: 1,
    }));
  }
  if (shape.kind === 'board' || shape.kind === 'group') for (const child of shape.children) changed = opaqueSilhouette(child) || changed;
  return changed;
}

/**
 * U+2215 DIVISION SLASH. The library reads every shape name as a path (`50/50` → `50 / 50`, `a//b` →
 * `a / b`); this look-alike survives it and Penpot. Component mains get real ` / ` paths (`components.ts`).
 */
export const NAME_SLASH = '\u2215';

export function shapeName(node: ir.Node): string {
  const name = node.name.trim();
  return name === '' ? DEFAULT_NAMES[node.type] : node.name.replaceAll('/', NAME_SLASH);
}

/** The turn at a box outline's sharpest corner (`StrokeOptions.turn`): a right angle, or none when every corner is rounded. */
function boxTurn(corners: readonly [number, number, number, number] | undefined): number {
  return !corners || corners.some((r) => !(r > 1e-6)) ? Math.PI / 2 : 0;
}

function radii(corners: readonly [number, number, number, number] | undefined, scale: number): CornerRadii {
  if (!corners) return {};
  const [r1, r2, r3, r4] = corners.map((r) => clean(Math.max(0, Number.isFinite(r) ? r * scale : 0))) as [number, number, number, number];
  return { r1, r2, r3, r4 };
}

