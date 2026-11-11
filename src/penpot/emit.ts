/**
 * Sends the intermediate tree to the library.
 *
 * Boards and groups are validated by the library (it throws a BuilderError
 * before touching its state, so the open-container stack stays balanced); on
 * rejection we retry with the bare shape, and failing that emit the children
 * in place of the container. Leaf shapes are not validated by the library.
 */
import type { WriterContext } from './context.ts';
import { describeBuilderError, type BoardParams, type GroupParams, type Uuid } from './library.ts';
import type { BoardNode, GroupNode, PNode } from './pnode.ts';

export class Emitter {
  private readonly ctx: WriterContext;
  /** Ids of the shapes that made it into the file. */
  readonly emitted = new Set<Uuid>();

  constructor(ctx: WriterContext) {
    this.ctx = ctx;
  }

  emitAll(nodes: readonly PNode[]): void {
    for (const node of nodes) this.emit(node);
  }

  private emit(node: PNode): void {
    const b = this.ctx.builder;
    switch (node.kind) {
      case 'board':
        return this.container(node, (p) => b.addBoard(p), () => b.closeBoard(), bareBoard);
      case 'group':
        return this.container(node, (p) => b.addGroup(p), () => b.closeGroup(), bareGroup);
      case 'rect':
        return this.leaf(node, () => b.addRect(node.params));
      case 'circle':
        return this.leaf(node, () => b.addCircle(node.params));
      case 'path':
        return this.leaf(node, () => b.addPath(node.params));
      case 'text':
        return this.leaf(node, () => b.addText(node.params));
    }
  }

  private container<N extends BoardNode | GroupNode>(
    node: N,
    open: (params: N['params']) => void,
    close: () => void,
    bare: (params: N['params']) => N['params'],
  ): void {
    if (!this.tryOpen(node, open, bare)) {
      this.emitAll(node.children);
      return;
    }
    this.emitted.add(node.params.id);
    this.emitAll(node.children);
    close();
    if (node.kind === 'group' && node.bool) {
      try {
        this.ctx.builder.addBool({ groupId: node.params.id, type: node.bool });
      } catch (error) {
        this.ctx.warn('boolean-unsupported', `Penpot could not build the boolean, it stays a group: ${describeBuilderError(error)}`, node.node);
      }
    }
  }

  private tryOpen<N extends BoardNode | GroupNode>(node: N, open: (params: N['params']) => void, bare: (params: N['params']) => N['params']): boolean {
    try {
      open(node.params);
      return true;
    } catch (error) {
      this.ctx.warn('invalid-shape', `Penpot rejected the ${node.kind}; retrying without styling: ${describeBuilderError(error)}`, node.node);
    }
    try {
      open(bare(node.params));
      return true;
    } catch (error) {
      this.ctx.warn('invalid-shape', `Penpot rejected the ${node.kind} entirely; its children were kept: ${describeBuilderError(error)}`, node.node);
      return false;
    }
  }

  private leaf(node: PNode, add: () => void): void {
    try {
      add();
      this.emitted.add(node.params.id);
    } catch (error) {
      this.ctx.warn('invalid-shape', `Penpot rejected the ${node.kind} and it was skipped: ${describeBuilderError(error)}`, node.node);
    }
  }
}

/** Geometry, identity and component links only. */
function bareBoard(p: BoardParams): BoardParams {
  const out: BoardParams = {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    transform: p.transform,
    transformInverse: p.transformInverse,
    fills: [],
    strokes: [],
  };
  copyDefined(p, out, ['flipX', 'hidden', 'showContent', 'shapeRef', 'componentId', 'componentFile', 'componentRoot', 'isVariantContainer', 'variantId', 'variantName']);
  return out;
}

function bareGroup(p: GroupParams): GroupParams {
  const out: GroupParams = {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    transform: p.transform,
    transformInverse: p.transformInverse,
  };
  copyDefined(p, out, ['hidden', 'maskedGroup', 'shapeRef']);
  return out;
}

function copyDefined<T extends object>(from: T, to: T, keys: (keyof T)[]): void {
  for (const key of keys) if (from[key] !== undefined) to[key] = from[key];
}
