import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { finite } from './common.ts';

export function isAutoLayout(c: fig.NodeChange | undefined): boolean {
  return c?.stackMode === 'HORIZONTAL' || c?.stackMode === 'VERTICAL';
}

/** True when `node` takes part in its parent's auto layout flow. */
function inParentFlow(node: FigNode): boolean {
  return isAutoLayout(node.parent?.change) && node.change.stackPositioning !== 'ABSOLUTE';
}

const H: Record<fig.ConstraintType, ir.ConstraintH> = {
  MIN: 'left',
  CENTER: 'center',
  MAX: 'right',
  STRETCH: 'left-right',
  SCALE: 'scale',
  FIXED_MIN: 'left',
  FIXED_MAX: 'right',
};
const V: Record<fig.ConstraintType, ir.ConstraintV> = {
  MIN: 'top',
  CENTER: 'center',
  MAX: 'bottom',
  STRETCH: 'top-bottom',
  SCALE: 'scale',
  FIXED_MIN: 'top',
  FIXED_MAX: 'bottom',
};

/** Absent fields mean MIN (REST reports LEFT/TOP for them). */
export function constraintsOf(c: fig.NodeChange): NonNullable<ir.BaseNode['constraints']> {
  return { horizontal: H[c.horizontalConstraint ?? 'MIN'] ?? 'left', vertical: V[c.verticalConstraint ?? 'MIN'] ?? 'top' };
}

const PRIMARY: Partial<Record<fig.StackJustify, ir.AutoLayout['primaryAlign']>> = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  // Figma's UI "Auto" spacing is stored as SPACE_EVENLY; REST reports it as SPACE_BETWEEN.
  SPACE_EVENLY: 'space-between',
  SPACE_BETWEEN: 'space-between',
};

const COUNTER: Partial<Record<fig.StackAlign | fig.StackCounterAlign, ir.AutoLayout['counterAlign']>> = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  BASELINE: 'baseline',
  STRETCH: 'stretch',
};

export function autoLayoutOf(c: fig.NodeChange): ir.AutoLayout | undefined {
  if (!isAutoLayout(c)) return undefined;
  const itemSpacing = finite(c.stackSpacing, 0);
  let padding = {
    top: finite(c.stackVerticalPadding, 0),
    right: finite(c.stackPaddingRight, 0),
    bottom: finite(c.stackPaddingBottom, 0),
    left: finite(c.stackHorizontalPadding, 0),
  };
  const perSideSet = [c.stackVerticalPadding, c.stackPaddingRight, c.stackPaddingBottom, c.stackHorizontalPadding].some((v) => v !== undefined);
  if (!perSideSet && c.stackPadding !== undefined) {
    // Very old files: one uniform padding.
    const p = finite(c.stackPadding, 0);
    padding = { top: p, right: p, bottom: p, left: p };
  }
  const counterAlignKey = c.stackCounterAlignItems ?? c.stackCounterAlign ?? c.stackAlign;
  return {
    direction: c.stackMode === 'VERTICAL' ? 'vertical' : 'horizontal',
    wrap: c.stackWrap === 'WRAP',
    itemSpacing,
    // NaN means "same as the item spacing" (REST reports `counterAxisSpacing` = itemSpacing then).
    counterSpacing: finite(c.stackCounterSpacing, itemSpacing),
    padding,
    primaryAlign: PRIMARY[c.stackPrimaryAlignItems ?? c.stackJustify ?? 'MIN'] ?? 'start',
    counterAlign: (counterAlignKey && COUNTER[counterAlignKey]) || 'start',
    counterAlignContent: c.stackCounterAlignContent === 'SPACE_BETWEEN' ? 'space-between' : 'auto',
    reverseZIndex: c.stackReverseZIndex ?? false,
    strokesIncludedInLayout: c.bordersTakeSpace ?? false,
  };
}

const isHug = (size: fig.StackSize | undefined): boolean => size === 'RESIZE_TO_FIT' || size === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';

/**
 * Resolved sizing per axis, like Figma's `layoutSizingHorizontal/Vertical`.
 * Only for auto layout frames and the children of auto layout frames.
 */
export function sizingOf(node: FigNode): ir.BaseNode['sizing'] {
  if (!isAutoLayout(node.change) && !isAutoLayout(node.parent?.change)) return undefined;
  return { horizontal: axisSizing(node, true), vertical: axisSizing(node, false) };
}

function axisSizing(node: FigNode, horizontal: boolean): ir.Sizing {
  const c = node.change;
  if (inParentFlow(node)) {
    const parentPrimaryIsHorizontal = node.parent!.change.stackMode === 'HORIZONTAL';
    if (parentPrimaryIsHorizontal === horizontal) {
      if (finite(c.stackChildPrimaryGrow, 0) > 0) return 'fill';
    } else if (c.stackChildAlignSelf === 'STRETCH' && !hugsOwnPrimary(c, horizontal)) {
      return 'fill';
    }
  }
  if (isAutoLayout(c)) {
    const primaryIsHorizontal = c.stackMode === 'HORIZONTAL';
    // An absent primary sizing means "hug", an absent counter sizing means "fixed" (checked against REST).
    if (primaryIsHorizontal === horizontal) return c.stackPrimarySizing === 'FIXED' ? 'fixed' : 'hug';
    return isHug(c.stackCounterSizing) ? 'hug' : 'fixed';
  }
  // Like REST, text only reports "hug" while it takes part in the flow.
  if (node.type === 'TEXT' && inParentFlow(node) && c.visible !== false) {
    if (c.textAutoResize === 'WIDTH_AND_HEIGHT') return 'hug';
    if (c.textAutoResize === 'HEIGHT' && !horizontal) return 'hug';
  }
  return 'fixed';
}

/**
 * An auto layout node whose own primary axis is `horizontal` and not FIXED
 * hugs its content along it, even when its parent asks it to stretch along
 * that axis: REST reports HUG (and Figma draws it hugging) for
 * auto-layout-playground.fig 1620:3020…3024, horizontal "list item"
 * instances with `stackChildAlignSelf: STRETCH` in a vertical stack.
 */
function hugsOwnPrimary(c: fig.NodeChange, horizontal: boolean): boolean {
  return isAutoLayout(c) && (c.stackMode === 'HORIZONTAL') === horizontal && c.stackPrimarySizing !== 'FIXED';
}

const ALIGN_SELF: Partial<Record<fig.StackCounterAlign, NonNullable<ir.LayoutChild['alignSelf']>>> = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  STRETCH: 'stretch',
  BASELINE: 'baseline',
};

export function layoutChildOf(node: FigNode): ir.LayoutChild | undefined {
  if (!isAutoLayout(node.parent?.change)) return undefined;
  const c = node.change;
  const child: ir.LayoutChild = { positioning: c.stackPositioning === 'ABSOLUTE' ? 'absolute' : 'auto' };
  const alignSelf = c.stackChildAlignSelf && ALIGN_SELF[c.stackChildAlignSelf];
  // A stretch the node's own hug sizing overrides (see `hugsOwnPrimary`) has no effect.
  const counterIsHorizontal = node.parent!.change.stackMode === 'VERTICAL';
  if (alignSelf && !(alignSelf === 'stretch' && hugsOwnPrimary(c, counterIsHorizontal))) child.alignSelf = alignSelf;
  const min = c.minSize?.value;
  const max = c.maxSize?.value;
  const set = (key: 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight', value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value)) child[key] = value;
  };
  set('minWidth', min?.x);
  set('minHeight', min?.y);
  set('maxWidth', max?.x);
  set('maxHeight', max?.y);
  return child;
}

/**
 * Makes a translated node independent of the auto layout parent it was
 * computed for (it now lives in a group, or on the remote-components page):
 * drops `layoutChild`, and keeps `sizing` only on auto layout frames, whose
 * own hug/fixed behaviour stays meaningful (`fill` becomes `fixed`).
 */
export function detachFromFlow(node: ir.Node): void {
  delete node.layoutChild;
  if (!node.sizing) return;
  if (node.type !== 'frame' || !node.layout) {
    delete node.sizing;
    return;
  }
  const fixed = (s: ir.Sizing): ir.Sizing => (s === 'fill' ? 'fixed' : s);
  node.sizing = { horizontal: fixed(node.sizing.horizontal), vertical: fixed(node.sizing.vertical) };
}
