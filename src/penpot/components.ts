/**
 * Component mains and copies, linked on the intermediate tree of the whole
 * document (mains may come after their copies, or on another page).
 *
 * What Penpot expects (`app.common.files.validate`, `app.common.types.file`):
 * - a main is a board whose `component-id`/`component-file`/`main-instance`/
 *   `component-root` are set by `addComponent`, and whose name is the
 *   component's `path / name`; mains cannot be nested in other components;
 * - a copy root is a board with `component-id`, `component-file` and a
 *   `shape-ref` to the main root; `component-root` only on copies that are not
 *   inside another component;
 * - every shape inside a copy has a `shape-ref` to the matching shape of the
 *   *near* main: for a nested copy that is the nested copy inside the outer
 *   main (Penpot looks the ref up through all enclosing copy heads), and a
 *   nested copy head must point at a head of the same component unless it is
 *   swapped, which is recorded as a `swap-slot-<id>` touched group;
 * - `touched` lists the sync groups a copy overrides, so that later edits of
 *   the main do not reset them.
 */
import type * as ir from '../ir.ts';
import type { WriterContext } from './context.ts';
import { fillSource } from './fills.ts';
import { penpotId } from './ids.ts';
import type { ComponentParams, PenpotFill, Uuid, VariantProperty } from './library.ts';
import { hasChildren, originKey, walk, type BoardNode, type PNode } from './pnode.ts';
import { splitPath } from './styles.ts';

export interface PageTree {
  pageId: Uuid;
  nodes: PNode[];
}

/** A component to register once its main board exists; `irId` is its id in `Document.components`. */
export interface PendingComponent {
  irId: string;
  params: ComponentParams;
}

type Mode = 'none' | 'main' | 'copy';

/** IR copy node id → IR id of its counterpart in the near main. */
interface CopyResolution {
  counterpart: Map<string, string>;
  /** Nested copy heads whose component differs from the main's: IR id → IR id of the replaced main node. */
  swapped: Map<string, string>;
}

export class ComponentLinker {
  private readonly ctx: WriterContext;
  private readonly pages: readonly PageTree[];
  private readonly byOrigin = new Map<string, PNode>();
  private readonly mains = new Map<string, { node: BoardNode; pageId: Uuid }>();
  private readonly irMains = new Map<string, ir.FrameNode>();
  /** Components Penpot rejected in an earlier attempt: their mains and copies become plain boards. */
  private readonly excluded: ReadonlySet<string>;
  /** IR component id → the component's Penpot name (without its path). */
  private readonly names = new Map<string, string>();

  constructor(ctx: WriterContext, pages: readonly PageTree[], excluded: ReadonlySet<string> = new Set()) {
    this.ctx = ctx;
    this.pages = pages;
    this.excluded = excluded;
    for (const page of pages) for (const node of walk(page.nodes)) this.byOrigin.set(originKey(node.origin), node);
  }

  /** Links everything and returns the components to register once all pages are built. */
  link(): PendingComponent[] {
    for (const page of this.pages) this.collectMains(page.nodes, page.pageId, false);
    // Mains get their final names first: copies are compared against them.
    const components = this.components();
    for (const page of this.pages) for (const node of page.nodes) this.visit(node, 'none', undefined);
    return components;
  }

  private collectMains(nodes: readonly PNode[], pageId: Uuid, insideComponent: boolean): void {
    for (const node of nodes) {
      let inside = insideComponent;
      if (node.kind === 'board' && node.main !== undefined) {
        const id = node.main;
        if (this.excluded.has(id)) {
          delete node.main;
        } else if (insideComponent) {
          this.ctx.warn('nested-main-component', 'Penpot does not allow a main component inside another component; it became a plain board', node.node);
          delete node.main;
        } else if (!Object.hasOwn(this.ctx.doc.components, id)) {
          this.ctx.warn('unknown-component', `Component ${id} is not described in the document; the board stays plain`, node.node);
          delete node.main;
        } else if (this.mains.has(id)) {
          this.ctx.warn('duplicate-main-component', `Component ${id} has several mains; only the first one is kept`, node.node);
          delete node.main;
        } else {
          this.mains.set(id, { node, pageId });
          this.irMains.set(id, node.node as ir.FrameNode);
          inside = true;
        }
      }
      if (node.kind === 'board' && node.copy !== undefined) inside = true;
      if (hasChildren(node)) this.collectMains(node.children, pageId, inside);
    }
  }

  private visit(node: PNode, mode: Mode, resolution: CopyResolution | undefined): void {
    if (node.kind === 'board' && node.copy !== undefined) {
      const main = this.mains.get(node.copy);
      if (!main || main.node === node) {
        if (!main && !this.excluded.has(node.copy)) {
          this.ctx.warn('missing-main-component', `The main of component ${node.copy} is not in the document; the copy became a plain board`, node.node);
        }
        delete node.copy;
      } else {
        this.linkHead(node, main.node, mode, resolution);
        return;
      }
    }
    if (mode === 'copy' && resolution) this.linkChild(node, resolution);
    const childMode: Mode = node.kind === 'board' && node.main !== undefined ? 'main' : mode;
    if (hasChildren(node)) for (const child of node.children) this.visit(child, childMode, resolution);
  }

  private linkHead(head: BoardNode, main: BoardNode, mode: Mode, outer: CopyResolution | undefined): void {
    const componentId = head.copy!;
    head.params.componentId = penpotId(componentId, 'component');
    head.params.componentFile = this.ctx.fileId;
    if (mode === 'none') head.params.componentRoot = true;

    let resolution: CopyResolution;
    const nested = mode === 'copy' && outer !== undefined && outer.counterpart.has(head.node.id);
    if (nested) {
      // Resolved along with the enclosing copy: refs point into the enclosing main.
      resolution = outer;
      const refIr = outer.counterpart.get(head.node.id)!;
      const ref = this.byOrigin.get(originKey({ irId: refIr, suffix: '' }));
      if (ref) {
        head.params.shapeRef = ref.params.id;
        this.touch(head, ref, this.names.get(componentId));
      }
      const slot = outer.swapped.get(head.node.id);
      if (slot !== undefined) {
        const slotShape = this.byOrigin.get(originKey({ irId: slot, suffix: '' }));
        if (slotShape) (head.params.touched ??= []).push(`swap-slot-${slotShape.params.id}`);
      }
    } else {
      resolution = this.resolve(head.node as ir.FrameNode, main.node as ir.FrameNode);
      head.params.shapeRef = main.params.id;
      this.touch(head, main, this.names.get(componentId));
    }
    for (const child of head.children) this.visit(child, 'copy', resolution);
  }

  private linkChild(node: PNode, resolution: CopyResolution): void {
    const refIr = resolution.counterpart.get(node.origin.irId);
    if (refIr === undefined) return;
    const ref = this.byOrigin.get(originKey({ irId: refIr, suffix: node.origin.suffix }));
    if (!ref || ref.kind !== node.kind) return;
    // Penpot requires a non-head copy shape to reference a non-head shape.
    if (ref.kind === 'board' && (ref.copy !== undefined || ref.main !== undefined)) return;
    node.params.shapeRef = ref.params.id;
    this.touch(node, ref);
  }

  /**
   * Pairs every node of an IR copy with its counterpart in the main. The trees
   * are parallel (copies are materialised clones): plain nodes match through
   * `componentRef`, which names the node in the *nearest* main and so is shared
   * by the main's own nested copy; nested copy heads match by their position
   * among the instance children.
   */
  private resolve(copy: ir.FrameNode, main: ir.FrameNode): CopyResolution {
    // The root itself: shapes the writer adds to the head (e.g. an emulated per-side stroke) match the main's.
    const counterpart = new Map<string, string>([[copy.id, main.id]]);
    const swapped = new Map<string, string>();
    const descend = (c: ir.Node, m: ir.Node): void => {
      if (!('children' in c) || !('children' in m)) return;
      const used = new Set<string>();
      const mainHeads = m.children.filter(isCopyHead);
      let headIndex = 0;
      for (const child of c.children) {
        if (isCopyHead(child)) {
          const position = headIndex++;
          let match: ir.Node | undefined;
          if (child.componentRef !== undefined) match = m.children.find((x) => !used.has(x.id) && (x.id === child.componentRef || x.componentRef === child.componentRef));
          match ??= mainHeads[position];
          if (match && !used.has(match.id) && isCopyHead(match) && match.instanceOf === child.instanceOf) {
            used.add(match.id);
            counterpart.set(child.id, match.id);
            descend(child, match);
            continue;
          }
          // Swapped (or unmatched) nested copy: its refs point into its own component's main.
          const own = this.irMains.get(child.instanceOf);
          if (!own) continue;
          counterpart.set(child.id, own.id);
          if (match && !used.has(match.id)) {
            used.add(match.id);
            swapped.set(child.id, match.id);
          }
          descend(child, own);
          continue;
        }
        const ref = child.componentRef;
        if (ref === undefined) continue;
        const match =
          m.children.find((x) => !used.has(x.id) && (x.id === ref || x.componentRef === ref)) ?? findDeep(m, (x) => x.id === ref || x.componentRef === ref);
        if (!match) continue;
        used.add(match.id);
        counterpart.set(child.id, match.id);
        descend(child, match);
      }
    };
    descend(copy, main);
    return { counterpart, swapped };
  }

  /**
   * Records the sync groups in which a copy shape differs from its main shape. A copy head named like
   * its component (Penpot's own naming of new copies) does not override the name either.
   */
  private touch(copy: PNode, main: PNode, componentName?: string): void {
    const groups = touchedGroups(copy, main).filter((g) => g !== 'name-group' || copy.params.name !== componentName);
    if (groups.length === 0) return;
    const touched = (copy.params.touched ??= []);
    for (const g of groups) if (!touched.includes(g)) touched.push(g);
  }

  private components(): PendingComponent[] {
    const out: PendingComponent[] = [];
    const variants = this.variantSets();
    for (const [id, { node, pageId }] of this.mains) {
      const def = this.ctx.doc.components[id]!;
      const params: ComponentParams = {
        componentId: penpotId(id, 'component'),
        fileId: this.ctx.fileId,
        pageId,
        frameId: node.params.id,
      };
      const variant = variants.get(id);
      if (variant) {
        const { path, name } = splitPath(variant.setName);
        params.name = name;
        params.path = path;
        params.variantId = variant.variantId;
        params.variantProperties = variant.properties;
        node.params.variantId = variant.variantId;
        node.params.variantName = variant.properties.map((p) => p.value).filter((v) => v !== '').join(', ');
        node.params.name = path ? `${path} / ${name}` : name;
        variant.container.params.name = node.params.name;
      } else {
        const full = def.set ? `${def.set.name} / ${def.name}` : def.name;
        const { path, name } = splitPath(full);
        params.name = name;
        params.path = path;
        // Penpot checks that a main's name is its component's `path / name`.
        node.params.name = path ? `${path} / ${name}` : name;
      }
      this.names.set(id, params.name!);
      out.push({ irId: id, params });
    }
    return out;
  }

  /**
   * Component sets whose every child is a main with the same, valid variant
   * property names become Penpot variant containers; otherwise their
   * components are plain ones named `Set / variant`.
   */
  private variantSets(): Map<string, { variantId: Uuid; setName: string; properties: VariantProperty[]; container: BoardNode }> {
    const out = new Map<string, { variantId: Uuid; setName: string; properties: VariantProperty[]; container: BoardNode }>();
    for (const page of this.pages) {
      for (const node of walk(page.nodes)) {
        if (node.kind !== 'board' || node.node.type !== 'frame' || node.node.role !== 'component-set') continue;
        if (node.main !== undefined || node.copy !== undefined || node.params.componentId !== undefined) continue;
        const members = node.children;
        if (members.length === 0) continue;
        const props: { id: string; properties: VariantProperty[] }[] = [];
        let names: string | undefined;
        let ok = true;
        for (const member of members) {
          const id = member.kind === 'board' ? member.main : undefined;
          const def = id === undefined ? undefined : this.ctx.doc.components[id];
          const entries = def?.variantProperties ? Object.entries(def.variantProperties) : [];
          if (id === undefined || entries.length === 0 || !entries.every(([k, v]) => validProperty(k, true) && validProperty(v, false))) {
            ok = false;
            break;
          }
          const properties = entries.map(([name, value]) => ({ name: name.trim(), value: value.trim() })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const key = properties.map((p) => p.name).join('\u0000');
          if (names !== undefined && names !== key) {
            ok = false;
            break;
          }
          names = key;
          props.push({ id, properties });
        }
        if (!ok) {
          this.ctx.warn('variants-as-components', 'The component set could not become a Penpot variant set; its variants are plain components', node.node);
          continue;
        }
        node.params.isVariantContainer = true;
        // The source name: `/` in it are path separators (the shape name has them replaced).
        const setName = node.node.name.trim() === '' ? node.params.name : node.node.name;
        for (const { id, properties } of props) out.set(id, { variantId: node.params.id, setName, properties, container: node });
      }
    }
    return out;
  }
}

function isCopyHead(node: ir.Node): node is ir.FrameNode & { instanceOf: string } {
  return node.type === 'frame' && node.instanceOf !== undefined;
}

function findDeep(root: ir.Node, predicate: (node: ir.Node) => boolean): ir.Node | undefined {
  if (!('children' in root)) return undefined;
  for (const child of root.children) {
    if (predicate(child)) return child;
    const found = findDeep(child, predicate);
    if (found) return found;
  }
  return undefined;
}

/** Penpot variant property names/values: no `,` or `=`, at most 60 characters, names not blank. */
function validProperty(text: string, isName: boolean): boolean {
  const t = text.trim();
  if (/[,=]/.test(t) || t.length > 60) return false;
  return !isName || t !== '';
}

const TOUCH_ATTRS: [string, string[]][] = [
  ['fill-group', ['fills']],
  ['stroke-group', ['strokes']],
  ['visibility-group', ['hidden']],
  ['modifiable-group', ['blocked']],
  ['layer-effects-group', ['opacity', 'blendMode']],
  ['radius-group', ['r1', 'r2', 'r3', 'r4']],
  ['show-content', ['showContent']],
  ['mask-group', ['maskedGroup']],
  ['constraints-group', ['constraintsH', 'constraintsV']],
];

const LAYOUT_ATTRS: [string, string][] = [
  ['layout-container', 'layout'],
  ['layout-flex-dir', 'layoutFlexDir'],
  ['layout-gap', 'layoutGap'],
  ['layout-padding', 'layoutPadding'],
  ['layout-wrap-type', 'layoutWrapType'],
  ['layout-justify-content', 'layoutJustifyContent'],
  ['layout-align-items', 'layoutAlignItems'],
  ['layout-align-content', 'layoutAlignContent'],
  ['layout-item-h-sizing', 'layoutItemH-Sizing'],
  ['layout-item-v-sizing', 'layoutItemV-Sizing'],
  ['layout-item-align-self', 'layoutItemAlignSelf'],
  ['layout-item-absolute', 'layoutItemAbsolute'],
  ['layout-item-z-index', 'layoutItemZIndex'],
  ['layout-item-min-w', 'layoutItemMinW'],
  ['layout-item-max-w', 'layoutItemMaxW'],
  ['layout-item-min-h', 'layoutItemMinH'],
  ['layout-item-max-h', 'layoutItemMaxH'],
  ['layout-item-margin', 'layoutItemMargin'],
  ['layout-item-margin-type', 'layoutItemMarginType'],
];

function touchedGroups(copy: PNode, main: PNode): string[] {
  const a = copy.params as unknown as Record<string, unknown>;
  const b = main.params as unknown as Record<string, unknown>;
  const same = (keys: string[]): boolean => keys.every((k) => (k === 'fills' ? sameFills(copy.params.fills, main.params.fills) : stable(a[k]) === stable(b[k])));
  const groups: string[] = [];
  for (const [group, keys] of TOUCH_ATTRS) if (!same(keys)) groups.push(group);
  if (stable(withoutIds(a['shadow'])) !== stable(withoutIds(b['shadow']))) groups.push('shadow-group');
  if (stable(withoutIds(a['blur'])) !== stable(withoutIds(b['blur'])) || stable(withoutIds(a['backgroundBlur'])) !== stable(withoutIds(b['backgroundBlur']))) {
    groups.push('blur-group');
  }
  for (const [group, key] of LAYOUT_ATTRS) if (stable(a[key]) !== stable(b[key])) groups.push(group);
  if (copy.params.name !== main.params.name) groups.push('name-group');
  if (copy.kind === 'path' && main.kind === 'path') {
    // Path content belongs to Penpot's geometry group.
    if (!sameSize(pathExtent(copy.params.content), pathExtent(main.params.content))) groups.push('geometry-group');
  } else if (copy.kind === 'text' && main.kind === 'text') {
    // A text's Penpot box grows around what the source drew and shifts for baseline placement (text/box.ts,
    // text/baseline.ts), by sub-pixel amounts that differ between copies of the same text. Compare the source boxes.
    if (!sameSize(copy.node.size, main.node.size)) groups.push('geometry-group');
  } else if ('width' in a && 'width' in b) {
    if (Math.abs(Number(a['width']) - Number(b['width'])) > 0.01 || Math.abs(Number(a['height']) - Number(b['height'])) > 0.01) {
      groups.push('geometry-group');
    }
  }
  if (copy.kind === 'text' && main.kind === 'text' && stable(copy.params.content) !== stable(main.params.content)) {
    groups.push('content-group', textOf(copy.params.content) !== textOf(main.params.content) ? 'text-content-text' : 'text-content-attribute');
  }
  return groups;
}

function stable(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value);
}

/**
 * Whether a copy's fills are its main's. An image fill is compared by its source paint (`fillSource`), not by
 * the stored bitmap: a copy shown at another size stores another reduced copy of the same image (or another
 * baked bitmap), which is no override. Unless the copy's bitmap has more pixels than the main's: a sync would
 * then replace it with the main's smaller one, so the copy keeps its own (touched).
 */
function sameFills(copy: readonly PenpotFill[] | undefined, main: readonly PenpotFill[] | undefined): boolean {
  if (stable(copy) === stable(main)) return true;
  if (!copy || !main || copy.length !== main.length) return false;
  return copy.every((fill, i) => {
    const other = main[i]!;
    const a = fillSource(fill);
    const b = fillSource(other);
    if (!a || !b) return stable(fill) === stable(other);
    const { fillImage: _a, ...restA } = fill;
    const { fillImage: _b, ...restB } = other;
    return a.paint === b.paint && a.pixels <= b.pixels && stable(restA) === stable(restB);
  });
}

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === 'object') {
    const { id: _id, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}

function textOf(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const node = content as { text?: unknown; children?: unknown };
  const own = typeof node.text === 'string' ? node.text : '';
  const kids = Array.isArray(node.children) ? node.children.map(textOf).join('') : '';
  return own + kids;
}

function pathExtent(content: string): { width: number; height: number } {
  const numbers = content.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi)?.map(Number) ?? [];
  const xs = numbers.filter((_, i) => i % 2 === 0);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  if (xs.length === 0) return { width: 0, height: 0 };
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function sameSize(p: { width: number; height: number }, q: { width: number; height: number }): boolean {
  return Math.abs(p.width - q.width) < 0.01 && Math.abs(p.height - q.height) < 0.01;
}
