import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { guidToString } from '../tree.ts';
import type { TranslateContext } from './context.ts';
import { translatePaints } from './paints.ts';
import { buildTextStyle, resolveStyleRef } from './text-style.ts';

/** `0xFFFFFFFF:0xFFFFFFFF` marks "explicitly no style" in legacy `inherit*StyleID` fields. */
const NO_STYLE = '4294967295:4294967295';

/**
 * Shared styles are ordinary nodes (usually on the internal canvas) with a
 * `styleType`. Nodes reference them with `styleIdFor*` (by GUID, or by
 * library `assetRef.key`) or, in older files, with `inherit*StyleID` GUIDs.
 * Returns the style node's id, or undefined when unresolvable.
 */
function resolve(ref: fig.StyleId | undefined, legacy: fig.GUID | undefined, ctx: TranslateContext, type: fig.StyleType): string | undefined {
  let id = resolveStyleRef(ref, ctx);
  if (!id && !ref && legacy) {
    const guid = guidToString(legacy);
    if (guid !== NO_STYLE) id = guid;
  }
  if (!id) return undefined;
  const style = ctx.doc.byGuid.get(id);
  return style?.change.styleType === type ? id : undefined;
}

export function fillStyleIdOf(c: fig.NodeChange, ctx: TranslateContext): string | undefined {
  return resolve(c.styleIdForFill, c.inheritFillStyleID, ctx, 'FILL');
}

export function strokeStyleIdOf(c: fig.NodeChange, ctx: TranslateContext): string | undefined {
  return resolve(c.styleIdForStrokeFill, c.inheritFillStyleIDForStroke, ctx, 'FILL');
}

/**
 * The paints a node renders for a style-able paint list: a referenced style's
 * own paints win over the node's inline copy, which Figma does not always
 * re-sync after the style changes (REST reports the style's paints).
 */
export function styledPaints(inline: fig.Paint[] | undefined, styleId: string | undefined, ctx: TranslateContext): fig.Paint[] | undefined {
  const stylePaints = styleId ? ctx.doc.byGuid.get(styleId)?.change.fillPaints : undefined;
  return stylePaints ?? inline;
}

export function withStyleId(paints: ir.Paint[], styleId: string | undefined): ir.Paint[] {
  if (styleId) for (const paint of paints) paint.styleId = styleId;
  return paints;
}

/**
 * Colour and text styles: every live (not soft-deleted) style node plus any
 * style referenced by the translated document, in file order.
 */
export function collectStyles(ctx: TranslateContext, referenced: ReadonlySet<string>): ir.Document['styles'] {
  const colors: ir.ColorStyle[] = [];
  const typographies: ir.TypographyStyle[] = [];
  for (const node of ctx.doc.byGuid.values()) {
    const c = node.change;
    if (!c.styleType) continue;
    if (c.isSoftDeleted && !referenced.has(node.id)) continue;
    const name = c.name ?? '';
    if (c.styleType === 'FILL') {
      colors.push({ id: node.id, name, paints: translatePaints(c.fillPaints, ctx, node) });
    } else if (c.styleType === 'TEXT') {
      typographies.push({ id: node.id, name, style: typographyOf(node, ctx) });
    }
  }
  return { colors, typographies };
}

function typographyOf(node: FigNode, ctx: TranslateContext): ir.TypographyStyle['style'] {
  const { fills: _fills, hyperlink: _hyperlink, styleId: _styleId, ...style } = buildTextStyle(
    { change: node.change, override: {}, baseFills: [] },
    node,
    ctx,
    translatePaints,
  );
  return style;
}
