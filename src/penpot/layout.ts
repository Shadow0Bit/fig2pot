/**
 * Auto layout, layout-child and constraint attributes.
 *
 * Every position in the IR is already resolved, and Penpot does not re-run
 * layouts when it opens a file, so these attributes only make the result
 * editable. They follow the Figma exporter plugin:
 *
 * - Directions are `row-reverse` / `column-reverse`. Penpot flows the children
 *   of a non-reversed flex board from the END of its `shapes` vector (see
 *   `layout_data.cljc`: `(cond->> children (not reverse?) reverse)`), while
 *   the IR lists them in flow order; a reversed direction keeps both the flow
 *   and the z-order (last child on top) identical to the source.
 * - "First on top" stacking is reproduced with `layoutItemZIndex`.
 */
import type * as ir from '../ir.ts';
import { clean } from './geometry.ts';
import type { ConstraintH, ConstraintV, LayoutChildAttrs, LayoutContainerAttrs, PenpotLayoutSizing } from './library.ts';

const JUSTIFY = { start: 'start', center: 'center', end: 'end', 'space-between': 'space-between' } as const;
const ALIGN_ITEMS = { start: 'start', center: 'center', end: 'end', baseline: 'start', stretch: 'stretch' } as const;

export function layoutContainer(frame: ir.FrameNode): LayoutContainerAttrs {
  const layout = frame.layout;
  if (!layout) return {};
  const horizontal = layout.direction === 'horizontal';
  const primaryGap = layout.primaryAlign === 'space-between' ? 0 : Math.max(0, layout.itemSpacing);
  const counterGap =
    layout.wrap && layout.counterAlignContent !== 'space-between' ? Math.max(0, layout.counterSpacing) : 0;
  const attrs: LayoutContainerAttrs = {
    layout: 'flex',
    layoutFlexDir: horizontal ? 'row-reverse' : 'column-reverse',
    layoutGap: horizontal
      ? { rowGap: clean(counterGap), columnGap: clean(primaryGap) }
      : { rowGap: clean(primaryGap), columnGap: clean(counterGap) },
    layoutGapType: 'multiple',
    layoutWrapType: layout.wrap ? 'wrap' : 'nowrap',
    layoutPadding: padding(frame),
    layoutPaddingType:
      layout.padding.top === layout.padding.bottom && layout.padding.left === layout.padding.right ? 'simple' : 'multiple',
    layoutJustifyContent: JUSTIFY[layout.primaryAlign],
    layoutAlignItems: ALIGN_ITEMS[layout.counterAlign],
    layoutAlignContent: layout.counterAlignContent === 'space-between' ? 'space-between' : ALIGN_ITEMS[layout.counterAlign],
  };
  return attrs;
}

/**
 * Penpot misbehaves when the paddings add up to exactly the board size
 * (exporter plugin `translateLayoutPadding`); nudging them keeps it stable.
 */
function padding(frame: ir.FrameNode): { p1: number; p2: number; p3: number; p4: number } {
  const p = frame.layout!.padding;
  let { top, right, bottom, left } = p;
  top = Math.max(0, top);
  right = Math.max(0, right);
  bottom = Math.max(0, bottom);
  left = Math.max(0, left);
  if (frame.size.height > 0 && top + bottom === frame.size.height && top + bottom > 0) {
    top = Math.max(0, top - 0.0001);
    bottom = Math.max(0, bottom - 0.0001);
  }
  if (frame.size.width > 0 && left + right === frame.size.width && left + right > 0) {
    left = Math.max(0, left - 0.0001);
    right = Math.max(0, right - 0.0001);
  }
  return { p1: clean(top), p2: clean(right), p3: clean(bottom), p4: clean(left) };
}

function sizing(value: ir.Sizing, node: ir.Node, parentHasLayout: boolean): PenpotLayoutSizing {
  // Penpot's "fill" on boards/texts and "hug" on texts behave unlike Figma's; the plugin keeps them fixed.
  switch (value) {
    case 'fixed':
      return 'fix';
    case 'hug':
      return node.type === 'text' ? 'fix' : node.type === 'frame' && node.layout ? 'auto' : 'fix';
    case 'fill':
      return parentHasLayout && node.type !== 'frame' && node.type !== 'text' ? 'fill' : 'fix';
  }
}

/**
 * @param parent the IR parent, when it is a container
 * @param index the node's index among `parent.children`
 */
export function layoutChild(node: ir.Node, parent: ir.ContainerNode | undefined, index: number): LayoutChildAttrs {
  const parentLayout = parent?.type === 'frame' ? parent.layout : undefined;
  const attrs: LayoutChildAttrs = {};
  const isLayoutBoard = node.type === 'frame' && node.layout !== undefined;
  if (node.sizing && (parentLayout || isLayoutBoard)) {
    attrs['layoutItemH-Sizing'] = sizing(node.sizing.horizontal, node, parentLayout !== undefined);
    attrs['layoutItemV-Sizing'] = sizing(node.sizing.vertical, node, parentLayout !== undefined);
  }
  const child = node.layoutChild;
  if (!parentLayout || !child) return attrs;
  if (child.positioning === 'absolute') attrs.layoutItemAbsolute = true;
  if (child.alignSelf && child.alignSelf !== 'baseline') attrs.layoutItemAlignSelf = child.alignSelf;
  if (child.minWidth !== undefined && child.minWidth >= 0) attrs.layoutItemMinW = clean(child.minWidth);
  if (child.maxWidth !== undefined && child.maxWidth >= 0) attrs.layoutItemMaxW = clean(child.maxWidth);
  if (child.minHeight !== undefined && child.minHeight >= 0) attrs.layoutItemMinH = clean(child.minHeight);
  if (child.maxHeight !== undefined && child.maxHeight >= 0) attrs.layoutItemMaxH = clean(child.maxHeight);
  if (parentLayout.reverseZIndex && child.positioning !== 'absolute' && parent) {
    attrs.layoutItemZIndex = parent.children.length - 1 - index;
  }
  return attrs;
}

const CONSTRAINT_H: Record<ir.ConstraintH, ConstraintH> = {
  left: 'left',
  right: 'right',
  'left-right': 'leftright',
  center: 'center',
  scale: 'scale',
};

const CONSTRAINT_V: Record<ir.ConstraintV, ConstraintV> = {
  top: 'top',
  bottom: 'bottom',
  'top-bottom': 'topbottom',
  center: 'center',
  scale: 'scale',
};

export function constraints(node: ir.BaseNode): { constraintsH?: ConstraintH; constraintsV?: ConstraintV } {
  if (!node.constraints) return {};
  return { constraintsH: CONSTRAINT_H[node.constraints.horizontal], constraintsV: CONSTRAINT_V[node.constraints.vertical] };
}
