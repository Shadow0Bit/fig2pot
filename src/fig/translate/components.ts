import type * as ir from '../../ir.ts';
import type { FigDocument, FigNode } from '../types.ts';
import { guidToString } from '../tree.ts';
import { apply } from '../../util/matrix.ts';
import type { TranslateContext } from './context.ts';
import { detachFromFlow } from './layout.ts';
import { translateNode } from './nodes.ts';

/** Registry entry for a SYMBOL node. */
export function componentDef(symbol: FigNode, remote: boolean): ir.ComponentDef {
  const c = symbol.change;
  const def: ir.ComponentDef = { id: symbol.id, name: c.name ?? '', remote };
  const description = c.symbolDescription || c.description;
  if (description) def.description = description;
  const parent = symbol.parent;
  if (parent?.change.isStateGroup) {
    def.set = { id: parent.id, name: parent.change.name ?? '' };
    const props = variantProperties(symbol, parent);
    if (props) def.variantProperties = props;
  }
  return def;
}

/**
 * Variant values come from `variantPropSpecs` (property id → value, names in
 * the set's `componentPropDefs`); older files only encode them in the name
 * (`Size=Large, State=Hover`).
 */
function variantProperties(symbol: FigNode, set: FigNode): Record<string, string> | undefined {
  const defs = new Map<string, string>();
  for (const def of set.change.componentPropDefs ?? []) {
    if (def.id && def.name) defs.set(guidToString(def.id), def.name);
  }
  const props: Record<string, string> = {};
  for (const spec of symbol.change.variantPropSpecs ?? []) {
    const name = spec.propDefId ? defs.get(guidToString(spec.propDefId)) : undefined;
    if (name && spec.value !== undefined) props[name] = spec.value;
  }
  if (Object.keys(props).length > 0) return props;
  return parseVariantName(symbol.change.name ?? '');
}

export function parseVariantName(name: string): Record<string, string> | undefined {
  const props: Record<string, string> = {};
  for (const part of name.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    props[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return Object.keys(props).length > 0 ? props : undefined;
}

/**
 * SYMBOLs on the internal-only canvas that the visible pages instantiate,
 * directly or through other such symbols, in discovery order.
 */
export function remoteSymbols(doc: FigDocument): FigNode[] {
  const internal = doc.internalCanvas;
  if (!internal) return [];
  const isInternal = (node: FigNode): boolean => {
    for (let n: FigNode | undefined = node; n; n = n.parent) if (n === internal) return true;
    return false;
  };
  const found: FigNode[] = [];
  const seen = new Set<string>();
  const stack: FigNode[] = [...doc.pages].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'INSTANCE' && node.symbolId && !seen.has(node.symbolId)) {
      seen.add(node.symbolId);
      const symbol = doc.byId.get(node.symbolId);
      if (symbol && symbol.type === 'SYMBOL' && isInternal(symbol)) {
        found.push(symbol);
        stack.push(symbol);
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return found;
}

const GRID_GAP = 100;
const GRID_ROW_WIDTH = 4000;

/** The synthetic page holding the remote symbols, laid out left → right in rows that do not overlap. */
export function translateRemotePage(symbols: FigNode[], ctx: TranslateContext): ir.Page {
  const children: ir.Node[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const symbol of symbols) {
    const node = translateNode(symbol, ctx);
    if (!node) continue;
    // Detached from its original parent: no parent layout to take part in.
    detachFromFlow(node);
    const box = bounds(node);
    if (x > 0 && x + box.width > GRID_ROW_WIDTH) {
      x = 0;
      y += rowHeight + GRID_GAP;
      rowHeight = 0;
    }
    node.transform = { ...node.transform, e: node.transform.e - box.x + x, f: node.transform.f - box.y + y };
    x += box.width + GRID_GAP;
    rowHeight = Math.max(rowHeight, box.height);
    children.push(node);
  }
  return { id: 'remote-components', name: 'Remote components', kind: 'remote-components', children };
}

/** Axis-aligned bounds of a node's box in its parent's space. */
function bounds(node: ir.Node): { x: number; y: number; width: number; height: number } {
  const { width, height } = node.size;
  const pts = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((p) => apply(node.transform, p));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}
