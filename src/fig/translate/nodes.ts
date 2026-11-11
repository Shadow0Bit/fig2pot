import type * as ir from '../../ir.ts';
import type { FigDocument, FigNode } from '../types.ts';
import { apply, multiply, translation } from '../../util/matrix.ts';
import { translateBase } from './base.ts';
import { warnOnce } from './common.ts';
import type { TranslateContext } from './context.ts';
import { autoLayoutOf, detachFromFlow } from './layout.ts';
import { applyCorners, outlinePath, translateEllipse, translateLine, translateRect } from './shapes.ts';
import { translateText } from './text.ts';
import { translateVector } from './vector.ts';

const BOOLEAN_OPS = { UNION: 'union', INTERSECT: 'intersect', SUBTRACT: 'subtract', XOR: 'exclude' } as const;

/** Node types that never render on the canvas (or are handled elsewhere); skipped without a warning. */
const SILENT_SKIP = new Set<string>(['SLICE', 'NONE', 'VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE', 'CODE_LIBRARY', 'CODE_FILE']);

/** Translates one node and its subtree, or returns undefined (skipped, with a warning when unsupported). */
export function translateNode(node: FigNode, ctx: TranslateContext): ir.Node | undefined {
  try {
    return translateNodeUnsafe(node, ctx);
  } catch (error) {
    ctx.warn('node-translation-failed', `could not translate ${node.type}: ${(error as Error).message}`, node);
    return undefined;
  }
}

function translateNodeUnsafe(node: FigNode, ctx: TranslateContext): ir.Node | undefined {
  switch (node.type) {
    case 'FRAME':
      if (node.change.resizeToFit) return translateGroup(node, ctx);
      return translateFrame(node, ctx, node.change.isStateGroup ? 'component-set' : 'frame');
    case 'GROUP':
      return translateGroup(node, ctx);
    case 'SECTION':
      return translateFrame(node, ctx, 'section');
    case 'SYMBOL':
      return translateFrame(node, ctx, 'component');
    case 'INSTANCE':
      return translateFrame(node, ctx, 'instance');
    case 'RECTANGLE':
    case 'ROUNDED_RECTANGLE':
      return translateRect(translateBase(node, ctx), node);
    case 'ELLIPSE':
      return translateEllipse(translateBase(node, ctx), node, ctx);
    case 'VECTOR':
      return translateVector(translateBase(node, ctx), node, ctx);
    case 'LINE':
      return translateLine(translateBase(node, ctx), node, ctx);
    case 'STAR':
    case 'REGULAR_POLYGON':
      return outlinePath(translateBase(node, ctx), node, ctx);
    case 'BOOLEAN_OPERATION': {
      const base = translateBase(node, ctx);
      return { ...base, type: 'boolean', operation: BOOLEAN_OPS[node.change.booleanOperation ?? 'UNION'] ?? 'union', children: translateChildren(node, ctx) };
    }
    case 'TEXT':
      return translateText(node, translateBase(node, ctx), ctx);
    default:
      if (!SILENT_SKIP.has(node.type)) ctx.warn('unsupported-node-type', `${node.type} nodes are not supported; skipped`, node);
      return undefined;
  }
}

function translateFrame(node: FigNode, ctx: TranslateContext, role: ir.FrameNode['role']): ir.FrameNode {
  const c = node.change;
  const frame: ir.FrameNode = {
    ...translateBase(node, ctx),
    type: 'frame',
    children: translateChildren(node, ctx),
    // Frames clip unless clipping was switched off ("Clip content" unchecked).
    clipsContent: c.frameMaskDisabled !== true,
    role,
  };
  applyCorners(frame, c);
  const layout = autoLayoutOf(c);
  if (layout) frame.layout = layout;
  else if (c.stackMode === 'GRID') {
    // Children keep their resolved positions; only the grid flow is lost.
    warnOnce(ctx, 'unsupported-grid-layout', 'grid auto layout is not supported; children keep their computed positions', node);
  }
  if (role === 'component') frame.componentId = node.id;
  if (role === 'instance' && node.symbolId) {
    if (ctx.doc.byId.has(node.symbolId)) frame.instanceOf = node.symbolId;
    else ctx.warn('missing-component', `instance refers to missing component ${node.symbolId}`, node);
  }
  return frame;
}

function translateGroup(node: FigNode, ctx: TranslateContext): ir.GroupNode {
  const base = translateBase(node, ctx);
  // Figma groups have no paint of their own.
  const { stroke: _stroke, ...rest } = base;
  return { ...rest, fills: [], type: 'group', children: translateChildren(node, ctx) };
}

/**
 * Translates `parent`'s children, back → front. A visible node with
 * `mask: true` masks the siblings above it up to the next mask; each such run
 * becomes an IR mask group.
 */
export function translateChildren(parent: FigNode, ctx: TranslateContext): ir.Node[] {
  const children = ctx.options.includeHidden ? parent.children : parent.children.filter((c) => c.change.visible !== false || holdsInstantiatedSymbol(ctx.doc, c));
  const out: ir.Node[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (!isMask(child)) {
      const translated = translateNode(child, ctx);
      if (translated) out.push(translated);
      continue;
    }
    const run: FigNode[] = [child];
    while (i + 1 < children.length && !isMask(children[i + 1]!)) run.push(children[++i]!);
    out.push(...maskGroup(run, ctx));
  }
  return out;
}

const symbolHolders = new WeakMap<FigDocument, Set<FigNode>>();

/**
 * True for an instantiated SYMBOL and its ancestors. With `includeHidden:
 * false` these are still emitted (with `visible: false`) when hidden, so
 * that every `instanceOf` resolves.
 */
function holdsInstantiatedSymbol(doc: FigDocument, node: FigNode): boolean {
  let holders = symbolHolders.get(doc);
  if (!holders) {
    holders = new Set();
    for (const candidate of doc.byId.values()) {
      const symbol = candidate.type === 'INSTANCE' && candidate.symbolId ? doc.byId.get(candidate.symbolId) : undefined;
      for (let n = symbol; n && !holders.has(n); n = n.parent) holders.add(n);
    }
    symbolHolders.set(doc, holders);
  }
  return holders.has(node);
}

function isMask(node: FigNode): boolean {
  return node.change.mask === true && node.change.visible !== false;
}

/**
 * `[mask group]`, or the run's nodes unmasked when the mask itself could not
 * be translated.
 *
 * Inside an auto layout parent every member was laid out as its own flow
 * item (no fixture has such a mask, so this follows the IR contract rather
 * than observed data): members of a group cannot take part in their
 * grandparent's flow, so they lose `layoutChild`, and the group keeps them
 * where Figma put them. It takes the single in-flow member's place when that
 * member's box is the group's box; otherwise it is positioned absolutely
 * (the geometry is final) with a `mask-in-auto-layout` warning, because a
 * target that re-runs the layout no longer reserves the members' space.
 */
function maskGroup(run: FigNode[], ctx: TranslateContext): ir.Node[] {
  const maskNode = run[0]!;
  const nodes = run.map((n) => translateNode(n, ctx)).filter((n): n is ir.Node => !!n);
  const mask = nodes[0];
  if (!mask || mask.id !== maskNode.id) return nodes;

  const c = maskNode.change;
  const type: NonNullable<ir.GroupNode['mask']>['type'] =
    c.maskType === 'LUMINANCE' ? 'luminance' : c.maskType === 'OUTLINE' || c.maskIsOutline ? 'vector' : 'alpha';

  // The group's box is the mask's axis-aligned bounds in the parent's space.
  const box = aabb(mask);
  const inFlow = nodes.filter((n) => n.layoutChild && n.layoutChild.positioning !== 'absolute');
  const inLayout = nodes.some((n) => n.layoutChild);
  const toGroup = translation(-box.minX, -box.minY);
  for (const n of nodes) n.transform = multiply(toGroup, n.transform);

  const group: ir.GroupNode = {
    id: `${maskNode.id}#mask`,
    name: mask.name,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'pass-through',
    transform: translation(box.minX, box.minY),
    size: { width: box.maxX - box.minX, height: box.maxY - box.minY },
    fills: [],
    effects: [],
    type: 'group',
    children: nodes,
    mask: { type },
  };
  if (mask.constraints) group.constraints = mask.constraints;
  if (mask.componentRef) group.componentRef = `${mask.componentRef}#mask`;
  if (inLayout) {
    const flowing = inFlow.length === 1 ? inFlow[0]! : undefined;
    if (inFlow.length === 0) {
      group.layoutChild = { positioning: 'absolute' };
    } else if (flowing && sameBox(aabb(flowing), { minX: 0, minY: 0, maxX: group.size.width, maxY: group.size.height })) {
      group.layoutChild = { ...flowing.layoutChild!, positioning: 'auto' };
      // A stretch would resize the group instead of the member.
      if (group.layoutChild.alignSelf === 'stretch') delete group.layoutChild.alignSelf;
    } else {
      group.layoutChild = { positioning: 'absolute' };
      ctx.warn(
        'mask-in-auto-layout',
        `mask "${mask.name}" and ${nodes.length - 1} masked layer(s) take part in auto layout; grouped and positioned absolutely at their computed place`,
        maskNode,
      );
    }
    group.sizing = { horizontal: 'fixed', vertical: 'fixed' };
  }
  for (const n of nodes) detachFromFlow(n);
  return [group];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Axis-aligned bounds of `node`'s box in its parent's space. */
function aabb(node: ir.Node): Box {
  const m = node.transform;
  const corners = [
    { x: 0, y: 0 },
    { x: node.size.width, y: 0 },
    { x: node.size.width, y: node.size.height },
    { x: 0, y: node.size.height },
  ].map((p) => apply(m, p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function sameBox(a: Box, b: Box, eps = 0.01): boolean {
  return Math.abs(a.minX - b.minX) <= eps && Math.abs(a.minY - b.minY) <= eps && Math.abs(a.maxX - b.maxX) <= eps && Math.abs(a.maxY - b.maxY) <= eps;
}
