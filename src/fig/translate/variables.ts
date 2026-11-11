/**
 * Resolution of variable-bound colours (`Paint.colorVar`).
 *
 * VARIABLE nodes hold one value per mode of their VARIABLE_SET; a node picks
 * the mode per set through `variableModeBySetMap` on itself or its nearest
 * ancestor that sets one (instances commonly switch modes), otherwise the set's
 * first mode. The inline `Paint.color` is only Figma's cached value for the
 * default context and goes stale under explicit modes, so a resolvable
 * variable wins.
 */
import type * as fig from '../schema.d.ts';
import type { FigDocument, FigNode } from '../types.ts';
import { guidToString } from '../tree.ts';

interface VariableIndex {
  byKey: Map<string, FigNode>;
}

const indexCache = new WeakMap<FigDocument, VariableIndex>();

function indexOf(doc: FigDocument): VariableIndex {
  let index = indexCache.get(doc);
  if (!index) {
    index = { byKey: new Map() };
    for (const node of doc.byGuid.values()) {
      if ((node.type === 'VARIABLE' || node.type === 'VARIABLE_SET') && node.change.key && !index.byKey.has(`${node.type}:${node.change.key}`)) {
        index.byKey.set(`${node.type}:${node.change.key}`, node);
      }
    }
    indexCache.set(doc, index);
  }
  return index;
}

type Ref = { guid?: fig.GUID; assetRef?: fig.AssetRef } | undefined;

function lookup(doc: FigDocument, ref: Ref, type: 'VARIABLE' | 'VARIABLE_SET'): FigNode | undefined {
  if (ref?.guid) {
    const node = doc.byGuid.get(guidToString(ref.guid));
    if (node?.type === type) return node;
  }
  const key = ref?.assetRef?.key;
  return key ? indexOf(doc).byKey.get(`${type}:${key}`) : undefined;
}

function sameSet(ref: Ref, set: FigNode): boolean {
  if (ref?.guid && guidToString(ref.guid) === set.guid) return true;
  return !!ref?.assetRef?.key && ref.assetRef.key === set.change.key;
}

function modeFor(set: FigNode, node: FigNode | undefined): string | undefined {
  for (let n = node; n; n = n.parent) {
    const entry = n.change.variableModeBySetMap?.entries?.find((e) => sameSet(e.variableSetID, set));
    if (entry?.variableModeID) return guidToString(entry.variableModeID);
  }
  const first = set.change.variableSetModes?.[0]?.id;
  return first ? guidToString(first) : undefined;
}

/** The colour a `colorVar` resolves to in `node`'s context, or undefined when unresolvable. */
export function resolveColorVariable(doc: FigDocument, data: fig.VariableData | undefined, node: FigNode | undefined): fig.Color | undefined {
  let value = data?.value;
  for (let depth = 0; depth < 16 && value; depth++) {
    if (value.colorValue) return value.colorValue;
    const variable = lookup(doc, value.alias, 'VARIABLE');
    if (!variable) return undefined;
    const entries = variable.change.variableDataValues?.entries ?? [];
    const set = lookup(doc, variable.change.variableSetID, 'VARIABLE_SET');
    const mode = set ? modeFor(set, node) : undefined;
    const entry = entries.find((e) => e.modeID && guidToString(e.modeID) === mode) ?? entries[0];
    value = entry?.variableData?.value;
  }
  return undefined;
}
