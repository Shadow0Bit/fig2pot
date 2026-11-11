import type { FigDocument, FigFile, FigNode, GuidString, NodeChange } from './types.ts';
import { FigDecodeError } from './decode.ts';

export function guidToString(guid: { sessionID: number; localID: number }): GuidString {
  return `${guid.sessionID}:${guid.localID}`;
}

function comparePosition(a: FigNode, b: FigNode): number {
  const pa = a.change.parentIndex?.position ?? '';
  const pb = b.change.parentIndex?.position ?? '';
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * Rebuilds the scene tree from the flat `nodeChanges` list. Instances are NOT
 * expanded here (see `resolveInstances`).
 */
export function buildTree(file: FigFile): FigDocument {
  const byGuid = new Map<GuidString, FigNode>();
  const changes: NodeChange[] = file.message.nodeChanges ?? [];

  for (const change of changes) {
    if (!change.guid || !change.type) continue;
    if (change.phase === 'REMOVED') continue;
    const guid = guidToString(change.guid);
    byGuid.set(guid, { id: guid, guid, type: change.type, change, children: [] });
  }

  let root: FigNode | undefined;
  for (const node of byGuid.values()) {
    const parentGuid = node.change.parentIndex?.guid;
    if (!parentGuid) {
      if (node.type === 'DOCUMENT') root = node;
      continue;
    }
    const parent = byGuid.get(guidToString(parentGuid));
    if (!parent) continue; // orphan: referenced by GUID only (or dangling)
    node.parent = parent;
    parent.children.push(node);
  }
  if (!root) throw new FigDecodeError('.fig file has no DOCUMENT node');

  for (const node of byGuid.values()) node.children.sort(comparePosition);

  const canvases = root.children.filter((child) => child.type === 'CANVAS');
  const pages = canvases.filter((canvas) => !canvas.change.internalOnly);
  const internalCanvas = canvases.find((canvas) => canvas.change.internalOnly);

  const byId = new Map<string, FigNode>();
  const index = (node: FigNode): void => {
    byId.set(node.id, node);
    for (const child of node.children) index(child);
  };
  index(root);

  return { file, root, pages, internalCanvas, byId, byGuid };
}
