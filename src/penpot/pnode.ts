/**
 * The writer's intermediate tree: Penpot shape params, nested like Penpot's
 * containers, built from the IR before anything is sent to the library. Having
 * the whole document as Penpot shapes first lets component copies be linked to
 * their mains wherever (and in whatever order) those appear.
 */
import type * as ir from '../ir.ts';
import { penpotId } from './ids.ts';
import type {
  BoardParams,
  CircleParams,
  GroupParams,
  PathParams,
  PenpotBoolType,
  RectParams,
  TextParams,
  Uuid,
} from './library.ts';

/** Which IR node a shape comes from; `suffix` tells apart the extra shapes one node may produce ('' = its main shape). */
export interface Origin {
  irId: string;
  suffix: string;
}

interface Base {
  origin: Origin;
  /** The IR node this shape represents (for diagnostics and component matching). */
  node: ir.Node;
}

export interface BoardNode extends Base {
  kind: 'board';
  params: BoardParams;
  children: PNode[];
  /** IR component id, when this board is a main component. */
  main?: string;
  /** IR component id, when this board is a component copy root. */
  copy?: string;
}

export interface GroupNode extends Base {
  kind: 'group';
  params: GroupParams;
  children: PNode[];
  bool?: PenpotBoolType;
}

export interface RectNode extends Base {
  kind: 'rect';
  params: RectParams;
}

export interface CircleNode extends Base {
  kind: 'circle';
  params: CircleParams;
}

export interface PathNode extends Base {
  kind: 'path';
  params: PathParams;
}

export interface TextNode extends Base {
  kind: 'text';
  params: TextParams;
}

export type PNode = BoardNode | GroupNode | RectNode | CircleNode | PathNode | TextNode;

export function shapeId(irId: string, suffix = ''): Uuid {
  return penpotId(suffix === '' ? irId : `${irId}/${suffix}`);
}

export function originKey(origin: Origin): string {
  return `${origin.irId}\u0000${origin.suffix}`;
}

export function hasChildren(node: PNode): node is BoardNode | GroupNode {
  return node.kind === 'board' || node.kind === 'group';
}

export function* walk(nodes: readonly PNode[]): Generator<PNode> {
  for (const node of nodes) {
    yield node;
    if (hasChildren(node)) yield* walk(node.children);
  }
}
