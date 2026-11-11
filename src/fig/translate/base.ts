import type * as ir from '../../ir.ts';
import type { FigNode } from '../types.ts';
import { blendModeFromKiwi, clamp01, finite, matrixFromKiwi } from './common.ts';
import type { TranslateContext } from './context.ts';
import { translateEffects } from './effects.ts';
import { geometryOf } from './geometry.ts';
import { constraintsOf, layoutChildOf, sizingOf } from './layout.ts';
import { translatePaints } from './paints.ts';
import { translateStroke } from './stroke.ts';
import { fillStyleIdOf, styledPaints, withStyleId } from './styles.ts';

/** All BaseNode fields for a node (id, name, visible, locked, opacity, blendMode, transform, size, fills, stroke, effects, constraints, sizing, layoutChild, componentRef, geometry). */
export function translateBase(node: FigNode, ctx: TranslateContext): ir.BaseNode {
  const c = node.change;
  const fillStyleId = fillStyleIdOf(c, ctx);
  const base: ir.BaseNode = {
    id: node.id,
    name: c.name ?? '',
    visible: c.visible ?? true,
    locked: c.locked ?? false,
    opacity: clamp01(c.opacity ?? 1),
    blendMode: blendModeFromKiwi(c.blendMode, 'pass-through'),
    transform: matrixFromKiwi(c.transform),
    size: { width: Math.max(0, finite(c.size?.x, 0)), height: Math.max(0, finite(c.size?.y, 0)) },
    fills: withStyleId(translatePaints(styledPaints(c.fillPaints, fillStyleId, ctx), ctx, node), fillStyleId),
    effects: translateEffects(c.effects, ctx, node),
    constraints: constraintsOf(c),
  };
  const stroke = translateStroke(node, ctx);
  if (stroke) base.stroke = stroke;
  const sizing = sizingOf(node);
  if (sizing) base.sizing = sizing;
  const layoutChild = layoutChildOf(node);
  if (layoutChild) base.layoutChild = layoutChild;
  if (node.componentRef) base.componentRef = node.componentRef;
  const geometry = geometryOf(node, ctx);
  if (geometry) base.geometry = geometry;
  return base;
}
