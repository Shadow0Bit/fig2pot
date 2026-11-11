import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { finite } from './common.ts';
import type { TranslateContext } from './context.ts';
import { translatePaints } from './paints.ts';
import { strokeStyleIdOf, styledPaints, withStyleId } from './styles.ts';

const JOINS: Record<fig.StrokeJoin, ir.Stroke['join']> = { MITER: 'miter', BEVEL: 'bevel', ROUND: 'round' };

const CAPS: Partial<Record<fig.StrokeCap, ir.StrokeCap>> = {
  NONE: 'none',
  ROUND: 'round',
  SQUARE: 'square',
  ARROW_LINES: 'line-arrow',
  ARROW_EQUILATERAL: 'triangle-arrow',
  // A filled triangle without the arrow's notch; the closest IR marker.
  TRIANGLE_FILLED: 'triangle-arrow',
  DIAMOND_FILLED: 'diamond',
  CIRCLE_FILLED: 'circle',
};

export function strokeCapFromKiwi(cap: fig.StrokeCap | undefined, ctx: TranslateContext, node?: FigNode): ir.StrokeCap {
  if (!cap) return 'none';
  const mapped = CAPS[cap];
  if (mapped) return mapped;
  ctx.warn('unsupported-stroke-cap', `stroke cap ${cap} is not supported; using none`, node);
  return 'none';
}

/** The node's stroke, or undefined when it has no stroke paints. */
export function translateStroke(node: FigNode, ctx: TranslateContext): ir.Stroke | undefined {
  const c = node.change;
  const styleId = strokeStyleIdOf(c, ctx);
  const kiwiPaints = styledPaints(c.strokePaints, styleId, ctx);
  if (!kiwiPaints || kiwiPaints.length === 0) return undefined;
  const paints = withStyleId(translatePaints(kiwiPaints, ctx, node), styleId);

  let weight = Math.max(0, finite(c.strokeWeight, 1));
  let perSide: ir.Stroke['perSide'];
  if (c.borderStrokeWeightsIndependent) {
    // With independent weights an absent side weight is 0 (REST `individualStrokeWeights`).
    const side = (w: number | undefined, hidden: boolean | undefined): number => (hidden ? 0 : Math.max(0, finite(w, 0)));
    const sides = {
      top: side(c.borderTopWeight, c.borderTopHidden),
      right: side(c.borderRightWeight, c.borderRightHidden),
      bottom: side(c.borderBottomWeight, c.borderBottomHidden),
      left: side(c.borderLeftWeight, c.borderLeftHidden),
    };
    const values = [sides.top, sides.right, sides.bottom, sides.left];
    if (values.every((v) => v === values[0])) weight = values[0]!;
    else {
      perSide = sides;
      weight = Math.max(...values);
    }
  }

  let align: ir.Stroke['align'] = 'center';
  if (c.strokeAlign === 'INSIDE') align = 'inside';
  else if (c.strokeAlign === 'OUTSIDE') align = 'outside';
  else if (c.strokeAlign === 'OFFSET') ctx.warn('unsupported-stroke-align', 'offset stroke alignment is not supported; using center', node);

  if (c.variableWidthPoints && c.variableWidthPoints.length > 0) {
    ctx.warn('variable-stroke-width', 'variable-width strokes are approximated with a constant width', node);
  }
  if (c.strokeBrushGuid || c.brushType) {
    ctx.warn('unsupported-brush-stroke', 'brush strokes are approximated with a plain stroke', node);
  }

  const cap = strokeCapFromKiwi(c.strokeCap, ctx, node);
  const stroke: ir.Stroke = {
    paints,
    weight,
    align,
    join: JOINS[c.strokeJoin ?? 'MITER'] ?? 'miter',
    startCap: cap,
    endCap: cap,
    dashPattern: (c.dashPattern ?? []).filter((v) => Number.isFinite(v) && v >= 0),
  };
  if (perSide) stroke.perSide = perSide;
  if (c.miterLimit !== undefined && Number.isFinite(c.miterLimit)) stroke.miterLimit = c.miterLimit;
  return stroke;
}
