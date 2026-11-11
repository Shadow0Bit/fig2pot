/**
 * Materialises component instances: every INSTANCE node gets a fresh copy of
 * its (effective) SYMBOL's subtree with all overrides merged in, so that the
 * translator can treat it like an ordinary frame.
 *
 * Algorithm (per real INSTANCE node in the tree, i.e. one that is stored in
 * the file, wherever it lives — pages, symbols, the internal canvas):
 *
 * 1. Build an `OverrideIndex` for this expansion: override-key path →
 *    partial NodeChanges. Seeded from the instance's own
 *    `symbolData.symbolOverrides`, component property assignments and
 *    `derivedSymbolData` (level 0).
 * 2. Clone the symbol's children depth-first. Each clone gets
 *    `change = merge(symbolNode.change, index.get(path))`.
 * 3. A cloned node that is itself an INSTANCE opens a new level: its
 *    effective symbol is decided by the merged change (`overriddenSymbolID`
 *    from swap overrides or INSTANCE_SWAP properties), its own overrides /
 *    property assignments / derived data are added to the SAME index under
 *    its path with level+1 (so they lose against every enclosing level), and
 *    its symbol's children are cloned below it.
 *
 * Precedence, lowest to highest, for a node at path `p`: the symbol node's
 * own change → entries of the innermost instance level containing it → …
 * → entries of the real instance; within one level: `symbolOverrides` →
 * component property values → `derivedSymbolData` (Figma's layout result
 * for exactly that configuration, which therefore also fixes geometry of
 * auto-layout instances whose text/visibility was overridden).
 *
 * Instance nodes themselves: Figma stores an INSTANCE (real or nested in a
 * symbol) with a complete copy of its symbol root's properties, already
 * overridden; a field the instance does not store has its default value
 * and must NOT be taken from the symbol (REST shows no strokes for
 * auto-layout-playground.fig instances that lack `strokePaints` while their
 * symbol has them). So the instance's merged change is its own change (plus
 * enclosing-level entries when it is nested), with paints re-read from styles.
 *
 * See `instances-overrides.ts` for the guidPath / id format facts.
 */
import type * as ir from '../ir.ts';
import type { FigDocument, FigNode, NodeChange } from './types.ts';
import type { ComponentPropAssignment, GUID, StyleId, Vector } from './schema.d.ts';
import { applyConstraints, hasAutoLayout, sizesDiffer } from './instances-constraints.ts';
import {
  DERIVED,
  OVERRIDE,
  OverrideIndex,
  PROP,
  type PropRef,
  guidKey,
  isNullGuid,
  mergeEntries,
  overrideKeyOf,
  propValueChange,
  type EntryKind,
  type OverrideEntry,
} from './instances-overrides.ts';

/** Hard cap on instance nesting (Figma itself refuses cycles; this guards malformed files). */
const MAX_DEPTH = 64;

/** Default cap on materialised nodes per `resolveInstances` run (all expansions together). */
export const DEFAULT_MAX_NODES = 5_000_000;

export interface ResolveOptions {
  /**
   * Stop materialising once this many nodes were created (one
   * `instance-budget-exceeded` warning; remaining instances stay partially
   * or entirely empty). Guards against exponential fan-out of nested
   * instances. Default `DEFAULT_MAX_NODES`.
   */
  maxNodes?: number;
}

/** One expansion of a real (stored) instance. */
interface Expansion {
  index: OverrideIndex;
  /** `I<real instance id>` — prefix of every materialised id in this expansion. */
  idPrefix: string;
  /** Symbols currently being expanded (cycle guard). */
  symbolStack: FigNode[];
  /**
   * Real nested-instance nodes that opened each level > 0, with the length of
   * the path string at that point (for `componentRef` fallbacks).
   */
  openers: { node: FigNode; pathLength: number }[];
  /** Paths of nested instances that some derived entry lies inside of. */
  derivedPrefixes: Set<string>;
}

/** Counters for diagnostics and tests. */
export interface ResolveStats {
  /** Stored INSTANCE nodes that were expanded. */
  instances: number;
  /** Materialised nodes created (all levels). */
  nodes: number;
  /** Instance levels re-laid out by the constraint fallback. */
  constraintFallbacks: number;
  /** Nodes moved/resized by the constraint fallback. */
  constraintNodes: number;
  /** Resized auto-layout instance levels without derived data (left at the symbol's layout). */
  autoLayoutWithoutDerived: number;
  /** Override / derived entries whose guidPath matched no materialised node (stale data). */
  unmatchedOverrides: number;
  unmatchedDerived: number;
}

export function resolveInstances(doc: FigDocument, reporter: ir.Reporter, options?: ResolveOptions): void {
  resolveInstancesWithStats(doc, reporter, options);
}

/** `resolveInstances`, returning counters about what was done. */
export function resolveInstancesWithStats(doc: FigDocument, reporter: ir.Reporter, options: ResolveOptions = {}): ResolveStats {
  const resolver = new InstanceResolver(doc, reporter, options.maxNodes ?? DEFAULT_MAX_NODES);
  resolver.run();
  return resolver.stats;
}

class InstanceResolver {
  readonly stats: ResolveStats = {
    instances: 0,
    nodes: 0,
    constraintFallbacks: 0,
    constraintNodes: 0,
    autoLayoutWithoutDerived: 0,
    unmatchedOverrides: 0,
    unmatchedDerived: 0,
  };
  private readonly symbolsByKey = new Map<string, FigNode>();
  private readonly stylesByKey = new Map<string, NodeChange>();
  private readonly refsBySymbol = new Map<FigNode, PropRef[]>();
  /**
   * Expansion state of every stored INSTANCE in the tree. Expansions run on
   * demand (`ensureExpanded`) so that a nested instance's own expansion
   * exists when an enclosing expansion needs it for `componentRef`.
   */
  private readonly state = new Map<FigNode, 'pending' | 'running' | 'done'>();
  private readonly warned = new Set<string>();
  private readonly doc: FigDocument;
  private readonly reporter: ir.Reporter;
  private readonly maxNodes: number;

  constructor(doc: FigDocument, reporter: ir.Reporter, maxNodes: number) {
    this.doc = doc;
    this.reporter = reporter;
    this.maxNodes = maxNodes;
    for (const node of doc.byGuid.values()) {
      if (node.change.styleType && node.change.key) this.stylesByKey.set(node.change.key, node.change);
      if (node.type !== 'SYMBOL') continue;
      const key = guidKey(node.change.overrideKey);
      if (key && !doc.byGuid.has(key)) this.symbolsByKey.set(key, node);
    }
  }

  /** Shared styles are referenced by local GUID or, for library styles, by asset key. */
  private readonly styleLookup = (id: StyleId): NodeChange | undefined => {
    const local = guidKey(id.guid);
    const node = local ? this.doc.byGuid.get(local) : undefined;
    if (node?.change.styleType) return node.change;
    return id.assetRef?.key ? this.stylesByKey.get(id.assetRef.key) : undefined;
  };

  run(): void {
    // Collect real instances first (the tree is mutated while expanding).
    const instances: FigNode[] = [];
    const walk = (node: FigNode): void => {
      if (node.type === 'INSTANCE') instances.push(node);
      else for (const child of node.children) walk(child);
    };
    walk(this.doc.root);

    for (const instance of instances) {
      for (const old of instance.children) this.unindex(old);
      instance.children = [];
      this.state.set(instance, 'pending');
    }
    for (const instance of instances) this.ensureExpanded(instance);
  }

  /** Expands a stored instance once; false while it is being expanded (malformed cycle) or not in the tree. */
  private ensureExpanded(instance: FigNode): boolean {
    const state = this.state.get(instance);
    if (state !== 'pending') return state === 'done';
    this.state.set(instance, 'running');
    this.expandRealInstance(instance);
    for (const child of instance.children) this.index(child);
    this.state.set(instance, 'done');
    return true;
  }

  // -------------------------------------------------------------------------
  // Expansion
  // -------------------------------------------------------------------------

  private expandRealInstance(instance: FigNode): void {
    const change = instance.change;
    const symbol = this.findSymbol(effectiveSymbolRef(change, change), instance, instance);
    if (!symbol) return;
    const expansion: Expansion = {
      index: new OverrideIndex(),
      idPrefix: `I${instance.id}`,
      symbolStack: [symbol],
      openers: [],
      derivedPrefixes: new Set(),
    };
    this.addInstanceLayers(expansion, change, '', 0);
    this.ignoreRootEntries(expansion, '', symbol);
    this.addPropLayer(expansion, symbol, '', assignmentsWithLevel(change.componentPropAssignments, 0));
    instance.change = mergeEntries(change, NO_ENTRIES, this.styleLookup);
    instance.symbolId = symbol.id;
    instance.children = this.cloneChildren(expansion, symbol, '', 0, instance, { mirror: symbol, index: 0 });
    this.stats.instances++;
    this.countUnmatched(expansion);
    // Derived data, when present, is the layout for the instance's actual size.
    if (!change.derivedSymbolData?.length) this.relayout(instance, symbol.change.size, instance.change);
  }

  /**
   * Entries left over once an expansion is complete point at nodes that are
   * not in the effective symbol: on simple-design-system.fig they all target
   * nodes deleted since, or nodes of the symbol a nested instance showed
   * before it was swapped / its variant changed (Figma keeps such entries).
   */
  private countUnmatched(expansion: Expansion): void {
    for (const [, entry] of expansion.index.unmatched()) {
      if (entry.kind === DERIVED) this.stats.unmatchedDerived++;
      else if (entry.kind === OVERRIDE) this.stats.unmatchedOverrides++;
    }
  }

  /** Entries addressed to a level's symbol root describe the instance node itself, which already stores them. */
  private ignoreRootEntries(expansion: Expansion, prefix: string, symbol: FigNode): void {
    for (const key of new Set([symbol.guid, overrideKeyOf(symbol.change, symbol.guid)])) {
      expansion.index.ignore(prefix ? `${prefix};${key}` : key);
    }
  }

  /**
   * Constraint fallback for a level whose content was laid out for size
   * `reference` but whose instance node has another size, without derived
   * data describing the result (see `instances-constraints.ts`).
   */
  private relayout(node: FigNode, reference: Vector | undefined, change: NodeChange): void {
    if (!reference || !change.size || !sizesDiffer(reference, change.size)) return;
    if (hasAutoLayout(change)) {
      this.stats.autoLayoutWithoutDerived++;
      return;
    }
    const changed = applyConstraints(node, reference, change.size);
    if (changed > 0) {
      this.stats.constraintFallbacks++;
      this.stats.constraintNodes += changed;
    }
  }

  /**
   * Clones `source` (a real node of a symbol) at instance level `level`.
   * `prefix` is the override-key path of the instance that opened this level
   * ('' at level 0): a guidPath has one element per instance level, so the
   * node's own path is `prefix;key` whatever its depth inside the symbol.
   * Returns undefined once the node budget is exhausted.
   */
  private clone(
    expansion: Expansion,
    source: FigNode,
    prefix: string,
    level: number,
    parent: FigNode,
    position: number,
    parentRef: MirrorRef,
  ): FigNode | undefined {
    if (this.stats.nodes >= this.maxNodes) {
      this.warnOnce('budget', {
        code: 'instance-budget-exceeded',
        message: `more than ${this.maxNodes} nodes materialised from instances; remaining instance content left out`,
        nodeId: parent.id,
        nodeName: parent.change.name,
      });
      return undefined;
    }
    const key = overrideKeyOf(source.change, source.guid);
    const path = prefix ? `${prefix};${key}` : key;
    const node: FigNode = {
      id: `${expansion.idPrefix};${path}`,
      guid: source.guid,
      type: source.type,
      change: source.change,
      parent,
      children: [],
    };
    const ref = this.mirrorOf(expansion, source, path, position, parentRef);
    node.componentRef = ref.mirror.id;
    this.stats.nodes++;

    const entries = expansion.index.get(path);
    if (source.type === 'INSTANCE') {
      this.expandNested(expansion, node, source, path, level, entries, ref);
    } else {
      node.change = mergeEntries(source.change, entries, this.styleLookup);
      node.children = this.cloneChildren(expansion, source, prefix, level, node, ref);
    }
    return node;
  }

  private cloneChildren(
    expansion: Expansion,
    source: FigNode,
    prefix: string,
    level: number,
    parent: FigNode,
    parentRef: MirrorRef,
  ): FigNode[] {
    const out: FigNode[] = [];
    source.children.forEach((child, i) => {
      const clone = this.clone(expansion, child, prefix, level, parent, i, parentRef);
      if (clone) out.push(clone);
    });
    return out;
  }

  /** `source` is a (real) INSTANCE node inside the symbol being cloned. */
  private expandNested(
    expansion: Expansion,
    node: FigNode,
    source: FigNode,
    path: string,
    level: number,
    entries: readonly OverrideEntry[],
    ref: MirrorRef,
  ): void {
    const merged = mergeEntries(source.change, entries, this.styleLookup);
    const symbol = this.findSymbol(effectiveSymbolRef(merged, source.change), node, source);
    if (!symbol) {
      node.change = merged;
      return;
    }
    if (expansion.symbolStack.includes(symbol)) {
      this.warnOnce(`cycle:${source.guid}`, {
        code: 'instance-cycle',
        message: `instance "${source.change.name ?? ''}" (re)enters symbol ${symbol.id} recursively; left empty`,
        nodeId: node.id,
        nodeName: source.change.name,
      });
      node.change = merged;
      return;
    }
    if (expansion.symbolStack.length >= MAX_DEPTH) {
      this.warnOnce(`deep:${source.guid}`, {
        code: 'instance-too-deep',
        message: `instance "${source.change.name ?? ''}" is nested more than ${MAX_DEPTH} instance levels deep; left empty`,
        nodeId: node.id,
        nodeName: source.change.name,
      });
      node.change = merged;
      return;
    }

    const inner = level + 1;
    // Must be read before this level's own layers are added: only derived
    // data from ENCLOSING levels describes the nested instance as resized here.
    const outerDerived = expansion.derivedPrefixes.has(path);
    this.addInstanceLayers(expansion, source.change, path, inner);
    this.ignoreRootEntries(expansion, path, symbol);
    // After a swap the nested instance's own root entries still name the
    // symbol it was created from.
    const original = this.lookupSymbol(source.change.symbolData?.symbolID);
    if (original && original !== symbol) this.ignoreRootEntries(expansion, path, original);
    this.addPropLayer(expansion, symbol, path, this.effectiveAssignments(source.change, entries, inner));

    node.change = merged;
    node.symbolId = symbol.id;
    // `source` becomes opener `expansion.openers.length`; when `ref` falls
    // back to it, its content mirrors `source`'s own expansion, which must
    // exist by now (a placeholder without children while it cannot).
    const ready = this.ensureExpanded(source);
    const childRef: MirrorRef = ref.mirror === source && !ready ? { mirror: NO_MIRROR, index: ref.index } : ref;
    expansion.symbolStack.push(symbol);
    expansion.openers.push({ node: source, pathLength: path.length });
    node.children = this.cloneChildren(expansion, symbol, path, inner, node, childRef);
    expansion.openers.pop();
    expansion.symbolStack.pop();

    if (!outerDerived) {
      // Content is laid out for the nested instance's own stored size if it
      // has derived data of its own, else for the symbol's size.
      const reference = source.change.derivedSymbolData?.length ? source.change.size : symbol.change.size;
      this.relayout(node, reference, merged);
    }
  }

  /** Adds an instance's own `symbolOverrides` and `derivedSymbolData` under `prefix`. */
  private addInstanceLayers(expansion: Expansion, change: NodeChange, prefix: string, level: number): void {
    this.addEntries(expansion, change.symbolData?.symbolOverrides, prefix, level, OVERRIDE, change);
    this.addEntries(expansion, change.derivedSymbolData, prefix, level, DERIVED, change);
  }

  private addEntries(
    expansion: Expansion,
    list: NodeChange[] | undefined,
    prefix: string,
    level: number,
    kind: EntryKind,
    owner: NodeChange,
  ): void {
    if (!list) return;
    for (const entry of list) {
      const keys = entry.guidPath?.guids;
      if (!keys || keys.length === 0 || keys.some((guid) => !guidKey(guid))) {
        this.warnOnce(`bad:${owner.guid ? guidKey(owner.guid) : ''}`, {
          code: 'bad-override',
          message: `instance "${owner.name ?? ''}" has an override without a valid guidPath; ignored`,
          nodeId: owner.guid ? guidKey(owner.guid) : undefined,
          nodeName: owner.name,
        });
        continue;
      }
      const rel = keys.map((guid) => guidKey(guid)!);
      const path = prefix ? `${prefix};${rel.join(';')}` : rel.join(';');
      expansion.index.add(path, { level, kind, change: entry });
      if (kind === DERIVED) {
        // Record every instance path this entry lies inside of.
        let at = prefix;
        for (let i = 0; i < rel.length - 1; i++) {
          at = at ? `${at};${rel[i]}` : rel[i]!;
          expansion.derivedPrefixes.add(at);
        }
      }
    }
  }

  /**
   * Turns component property assignments into PROP entries on the nodes of
   * `symbol` that reference the property (`componentPropRefs`).
   */
  private addPropLayer(
    expansion: Expansion,
    symbol: FigNode,
    prefix: string,
    assignments: Map<string, LeveledAssignment>,
  ): void {
    if (assignments.size === 0) return;
    for (const ref of this.refsOf(symbol)) {
      const assigned = assignments.get(ref.defID);
      if (!assigned) continue;
      const target = prefix ? `${prefix};${ref.key}` : ref.key;
      const change = propValueChange(assigned.assignment, ref.field);
      if (change) expansion.index.add(target, { level: assigned.level, kind: PROP, change });
      // What an inner level assigned before an outer one re-assigned it: provenance of that level's derived text layout.
      const shadowed = assigned.shadowed && propValueChange(assigned.shadowed.assignment, ref.field);
      if (shadowed) expansion.index.add(target, { level: assigned.shadowed!.level, kind: PROP, change: shadowed, shadowed: true });
    }
  }

  /**
   * Assignments in force for a nested instance: its own (stored on the node,
   * level `inner`) overlaid by `componentPropAssignments` overrides from the
   * enclosing levels (each keeping its level so precedence stays right).
   * That is also how values of *exposed* nested props (`propsAreBubbled`)
   * are stored: the outer instance carries a `{guidPath: [nested],
   * componentPropAssignments}` override (264× on simple-design-system.fig),
   * whose defIDs are the nested symbol's own property definitions.
   */
  private effectiveAssignments(
    change: NodeChange,
    entries: readonly OverrideEntry[],
    inner: number,
  ): Map<string, LeveledAssignment> {
    const out = assignmentsWithLevel(change.componentPropAssignments, inner);
    for (const entry of entries) {
      for (const assignment of entry.change.componentPropAssignments ?? []) {
        const def = guidKey(assignment.defID);
        if (!def) continue;
        const own = out.get(def);
        out.set(def, { assignment, level: entry.level, ...(own?.level === inner ? { shadowed: own } : own?.shadowed ? { shadowed: own.shadowed } : {}) });
      }
    }
    return out;
  }

  private refsOf(symbol: FigNode): PropRef[] {
    let refs = this.refsBySymbol.get(symbol);
    if (refs) return refs;
    refs = [];
    const walk = (node: FigNode): void => {
      for (const ref of node.change.componentPropRefs ?? []) {
        const defID = guidKey(ref.defID);
        if (!defID || ref.isDeleted || !ref.componentPropNodeField) continue;
        refs!.push({ defID, field: ref.componentPropNodeField, key: overrideKeyOf(node.change, node.guid) });
      }
      // Instances' children are materialised content, never the symbol's own.
      if (node.type !== 'INSTANCE') for (const child of node.children) walk(child);
    };
    for (const child of symbol.children) walk(child);
    this.refsBySymbol.set(symbol, refs);
    return refs;
  }

  // -------------------------------------------------------------------------
  // Lookup, ids, bookkeeping
  // -------------------------------------------------------------------------

  private lookupSymbol(ref: GUID | undefined): FigNode | undefined {
    const key = guidKey(ref);
    const found = key ? (this.doc.byGuid.get(key) ?? this.symbolsByKey.get(key)) : undefined;
    return found?.type === 'SYMBOL' ? found : undefined;
  }

  private findSymbol(ref: GUID | undefined, node: FigNode, source: FigNode): FigNode | undefined {
    const found = this.lookupSymbol(ref);
    if (found) return found;
    const key = guidKey(ref);
    this.warnOnce(`missing:${source.guid}:${key}`, {
      code: 'missing-symbol',
      message: `instance "${source.change.name ?? ''}" refers to symbol ${key ?? '(none)'} which is not in the file; left empty`,
      nodeId: node.id,
      nodeName: source.change.name,
    });
    return undefined;
  }

  /**
   * `componentRef` = id of the mirrored node in the OWNING symbol's tree.
   * Level-0 nodes mirror a real node of the instance's symbol. Deeper nodes
   * mirror the node inside the materialised nested instance of the outermost
   * symbol whose own expansion contains it (it may not, when this expansion
   * swapped the nested instance); the innermost real node is the fallback.
   *
   * Candidate `i` (opener `i`'s own expansion) can only contain the node if
   * it contains the node's parent, so the search starts at the parent's
   * choice and normally ends at the parent mirror's child at the same
   * position — O(1) per node, nothing kept per node.
   */
  private mirrorOf(expansion: Expansion, source: FigNode, path: string, position: number, parentRef: MirrorRef): MirrorRef {
    const openers = expansion.openers;
    if (parentRef.index >= openers.length) return { mirror: source, index: openers.length };
    const siblings = parentRef.mirror.children;
    const hit = siblings[position]?.guid === source.guid ? siblings[position] : siblings.find((c) => c.guid === source.guid);
    if (hit) return { mirror: hit, index: parentRef.index };
    for (let i = parentRef.index + 1; i < openers.length; i++) {
      const { node: opener, pathLength } = openers[i]!;
      const found = this.doc.byId.get(`I${opener.id}${path.slice(pathLength)}`);
      if (found?.guid === source.guid) return { mirror: found, index: i };
    }
    return { mirror: source, index: openers.length };
  }

  private index(node: FigNode): void {
    this.doc.byId.set(node.id, node);
    for (const child of node.children) this.index(child);
  }

  private unindex(node: FigNode): void {
    if (this.doc.byId.get(node.id) === node) this.doc.byId.delete(node.id);
    for (const child of node.children) this.unindex(child);
  }

  private warnOnce(key: string, warning: ir.Warning): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.reporter.warn(warning);
  }
}

const NO_ENTRIES: readonly OverrideEntry[] = Object.freeze([]);

/**
 * Where a materialised node's `componentRef` points: `mirror` is the node
 * it mirrors; `index` is the opener (`Expansion.openers`) whose own
 * expansion holds it, or `openers.length` when it is the real symbol node.
 */
interface MirrorRef {
  mirror: FigNode;
  index: number;
}

/** Mirror placeholder for an expansion that is not available (malformed cycles, nodes outside the tree). */
const NO_MIRROR: FigNode = Object.freeze({ id: '', guid: '', type: 'NONE', change: {}, children: [] }) as FigNode;

/** The symbol an instance shows: its swap target unless that is absent or the null-GUID sentinel. */
function effectiveSymbolRef(change: NodeChange, stored: NodeChange): GUID | undefined {
  return isNullGuid(change.overriddenSymbolID) ? stored.symbolData?.symbolID : change.overriddenSymbolID;
}

/** A property assignment with the instance level it was made on. */
interface LeveledAssignment {
  assignment: ComponentPropAssignment;
  level: number;
  /** The nested instance's own assignment this one replaced (provenance only). */
  shadowed?: LeveledAssignment;
}

function assignmentsWithLevel(list: ComponentPropAssignment[] | undefined, level: number): Map<string, LeveledAssignment> {
  const out = new Map<string, LeveledAssignment>();
  for (const assignment of list ?? []) {
    const def = guidKey(assignment.defID);
    if (def) out.set(def, { assignment, level });
  }
  return out;
}
