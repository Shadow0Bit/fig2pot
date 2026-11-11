import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { decodeFig } from '../../src/fig/decode.ts';
import { resolveInstances, resolveInstancesWithStats } from '../../src/fig/instances.ts';
import { buildTree } from '../../src/fig/tree.ts';
import type { FigDocument, FigNode, Message, NodeChange } from '../../src/fig/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function loadFixture(name: string): FigDocument {
  return buildTree(decodeFig(new Uint8Array(readFileSync(fixture(name)))));
}

function collect(): ir.Reporter & { warnings: ir.Warning[] } {
  const warnings: ir.Warning[] = [];
  return { warnings, warn: (w) => warnings.push(w) };
}

const G = (guid: string) => {
  const [s, l] = guid.split(':').map(Number);
  return { sessionID: s!, localID: l! };
};

let positionCounter = 0;
function n(guid: string, type: NonNullable<NodeChange['type']>, parent: string | undefined, extra: Record<string, unknown> = {}): NodeChange {
  positionCounter++;
  return {
    guid: G(guid),
    type,
    name: `${type.toLowerCase()} ${guid}`,
    ...(parent ? { parentIndex: { guid: G(parent), position: String.fromCharCode(33 + positionCounter) } } : {}),
    size: { x: 10, y: 10 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    ...extra,
  } as NodeChange;
}

const path = (...guids: string[]) => ({ guids: guids.map(G) });
const solid = (r: number, g: number, b: number) => [{ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true }];
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const instanceOf = (symbol: string, symbolOverrides: object[] = [], derivedSymbolData: object[] = []) => ({
  symbolData: { symbolID: G(symbol), symbolOverrides },
  derivedSymbolData,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * A hand-built file exercising every override source. Symbols:
 *   1:10 Icon   → 1:11 vector (red)
 *   1:20 Icon2  → 1:21 vector (green)
 *   2:1  Button → 2:2 text (TEXT prop 9:1), 2:3 instance of Icon (BOOL prop 9:2,
 *                 INSTANCE_SWAP prop 9:3; own override: vector blue, own derived size 8×8)
 *   4:1  Lib    (overrideKey 7:1) → 4:2 rect (overrideKey 7:2)   [internal canvas]
 *   5:1  Loop   → 5:2 instance of Loop
 *   6:1  Pinned (100×100) → 6:2 rect MAX/MAX, 6:3 rect STRETCH/SCALE
 *   8:1  fill style (purple)
 */
function syntheticChanges(): NodeChange[] {
  positionCounter = 0;
  return [
    n('0:0', 'DOCUMENT', undefined),
    n('0:1', 'CANVAS', '0:0'),
    n('0:2', 'CANVAS', '0:0', { internalOnly: true }),
    // Symbols
    n('1:10', 'SYMBOL', '0:1'),
    n('1:11', 'VECTOR', '1:10', { fillPaints: solid(1, 0, 0) }),
    n('1:20', 'SYMBOL', '0:1'),
    n('1:21', 'VECTOR', '1:20', { fillPaints: solid(0, 1, 0) }),
    n('2:1', 'SYMBOL', '0:1', {
      size: { x: 100, y: 40 },
      fillPaints: solid(1, 1, 1),
      componentPropDefs: [
        { id: G('9:1'), name: 'Label', type: 'TEXT', initialValue: { textValue: { characters: 'Label' } } },
        { id: G('9:2'), name: 'Show icon', type: 'BOOL', initialValue: { boolValue: true } },
        { id: G('9:3'), name: 'Icon', type: 'INSTANCE_SWAP', initialValue: { guidValue: G('1:10') } },
      ],
    }),
    n('2:2', 'TEXT', '2:1', {
      textData: { characters: 'Label' },
      derivedTextData: { baselines: [{ firstCharacter: 0, endCharacter: 5 }] },
      componentPropRefs: [{ defID: G('9:1'), componentPropNodeField: 'TEXT_DATA' }],
    }),
    n('2:3', 'INSTANCE', '2:1', {
      ...instanceOf(
        '1:10',
        [{ guidPath: path('1:11'), fillPaints: solid(0, 0, 1) }],
        [{ guidPath: path('1:11'), size: { x: 8, y: 8 } }],
      ),
      componentPropRefs: [
        { defID: G('9:2'), componentPropNodeField: 'VISIBLE' },
        { defID: G('9:3'), componentPropNodeField: 'OVERRIDDEN_SYMBOL_ID' },
      ],
    }),
    n('4:1', 'SYMBOL', '0:2', { overrideKey: G('7:1') }),
    n('4:2', 'ROUNDED_RECTANGLE', '4:1', { overrideKey: G('7:2'), fillPaints: solid(0, 0, 0) }),
    n('5:1', 'SYMBOL', '0:1'),
    n('5:2', 'INSTANCE', '5:1', instanceOf('5:1')),
    n('6:1', 'SYMBOL', '0:1', { size: { x: 100, y: 100 } }),
    n('6:2', 'ROUNDED_RECTANGLE', '6:1', {
      size: { x: 20, y: 20 },
      transform: at(80, 80),
      horizontalConstraint: 'MAX',
      verticalConstraint: 'MAX',
      fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0 }],
    }),
    n('6:3', 'ROUNDED_RECTANGLE', '6:1', {
      size: { x: 80, y: 20 },
      transform: at(10, 40),
      horizontalConstraint: 'STRETCH',
      verticalConstraint: 'SCALE',
    }),
    n('8:1', 'ROUNDED_RECTANGLE', '0:2', { styleType: 'FILL', fillPaints: solid(0.5, 0, 0.5) }),
    // Instances on the page
    n('3:1', 'INSTANCE', '0:1', {
      ...instanceOf(
        '2:1',
        [
          { guidPath: path('2:3', '1:11'), fillPaints: solid(1, 1, 0) },
          { guidPath: path('2:2'), textData: { characters: 'Override' } },
          { guidPath: path('2:1'), fillPaints: solid(0, 0, 0) }, // root-addressed: ignored
        ],
        [
          { guidPath: path('2:2'), derivedTextData: { baselines: [{ firstCharacter: 0, endCharacter: 4 }] } },
          { guidPath: path('2:3', '1:11'), size: { x: 6, y: 6 }, transform: at(2, 2) },
        ],
      ),
      size: { x: 100, y: 40 },
      fillPaints: solid(0.9, 0.9, 0.9),
      componentPropAssignments: [{ defID: G('9:1'), value: { textValue: { characters: 'Prop' } } }],
    }),
    n('3:2', 'INSTANCE', '0:1', {
      ...instanceOf('2:1'),
      componentPropAssignments: [
        { defID: G('9:2'), value: { boolValue: false } },
        { defID: G('9:3'), varValue: { value: { symbolIdValue: { guid: G('1:20') } } } },
      ],
    }),
    n('3:3', 'INSTANCE', '0:1', {
      ...instanceOf('2:1', [{ guidPath: path('2:3'), overriddenSymbolID: G('1:20') }]),
    }),
    n('3:4', 'INSTANCE', '0:1', {
      ...instanceOf('4:1', [{ guidPath: path('7:2'), fillPaints: solid(0, 1, 1) }]),
    }),
    n('3:5', 'INSTANCE', '0:1', instanceOf('99:99')),
    n('3:6', 'INSTANCE', '0:1', instanceOf('5:1')),
    n('3:7', 'INSTANCE', '0:1', {
      ...instanceOf('1:10', [{ fillPaints: solid(1, 1, 1) }]),
    }),
    n('3:8', 'INSTANCE', '0:1', { ...instanceOf('6:1'), size: { x: 200, y: 50 } }),
    n('3:9', 'INSTANCE', '0:1', {
      ...instanceOf('1:10', [{ guidPath: path('1:11'), styleIdForFill: { guid: G('8:1') } }]),
    }),
  ];
}

function synthetic(): { doc: FigDocument; reporter: ReturnType<typeof collect> } {
  const changes = syntheticChanges();
  const doc = buildTree({ prelude: 'fig-kiwi', version: 0, message: { nodeChanges: changes } as Message, blobs: [], images: new Map() });
  deepFreeze(changes); // resolveInstances must never mutate decoded data
  const reporter = collect();
  resolveInstances(doc, reporter);
  return { doc, reporter };
}

const get = (doc: FigDocument, id: string): FigNode => {
  const node = doc.byId.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};
const colour = (node: FigNode) => node.change.fillPaints?.[0]?.color;

/** Checks tree ↔ byId consistency, unique ids and resolvable references. */
function checkInvariants(doc: FigDocument): void {
  const reachable = new Set<string>();
  const walk = (node: FigNode): void => {
    expect(reachable.has(node.id), `duplicate id ${node.id}`).toBe(false);
    reachable.add(node.id);
    expect(doc.byId.get(node.id)).toBe(node);
    for (const child of node.children) {
      expect(child.parent).toBe(node);
      walk(child);
    }
    if (node.id.startsWith('I')) {
      const ref = doc.byId.get(node.componentRef ?? '');
      expect(ref?.guid, `componentRef of ${node.id}`).toBe(node.guid);
    }
    if (node.type === 'INSTANCE' && node.symbolId) expect(doc.byId.get(node.symbolId)?.type).toBe('SYMBOL');
  };
  walk(doc.root);
  expect(doc.byId.size).toBe(reachable.size);
}

// ---------------------------------------------------------------------------
// Synthetic file
// ---------------------------------------------------------------------------

describe('resolveInstances (synthetic)', () => {
  it('materialises with REST-style path ids and componentRefs', () => {
    const { doc } = synthetic();
    const button = get(doc, '3:1');
    expect(button.symbolId).toBe('2:1');
    expect(button.children.map((c) => c.id)).toEqual(['I3:1;2:2', 'I3:1;2:3']);
    const nested = get(doc, 'I3:1;2:3');
    expect(nested.symbolId).toBe('1:10');
    expect(nested.children.map((c) => c.id)).toEqual(['I3:1;2:3;1:11']);
    expect(get(doc, 'I3:1;2:2').componentRef).toBe('2:2');
    // The nested node mirrors the node in Button's own materialised nested instance.
    expect(get(doc, 'I3:1;2:3;1:11').componentRef).toBe('I2:3;1:11');
    // Instances inside symbols are materialised too.
    expect(get(doc, '2:3').children.map((c) => c.id)).toEqual(['I2:3;1:11']);
    checkInvariants(doc);
  });

  it('applies overrides in Figma precedence order', () => {
    const { doc } = synthetic();
    // inner instance's own override (blue) loses against the outer one (yellow)
    expect(colour(get(doc, 'I2:3;1:11'))).toMatchObject({ r: 0, g: 0, b: 1 });
    expect(colour(get(doc, 'I3:1;2:3;1:11'))).toMatchObject({ r: 1, g: 1, b: 0 });
    // outer derived data beats the inner instance's own derived size
    expect(get(doc, 'I2:3;1:11').change.size).toEqual({ x: 8, y: 8 });
    expect(get(doc, 'I3:1;2:3;1:11').change.size).toEqual({ x: 6, y: 6 });
    expect(get(doc, 'I3:1;2:3;1:11').change.transform).toMatchObject({ m02: 2, m12: 2 });
    // TEXT property beats the plain textData override; derived text layout is kept
    const text = get(doc, 'I3:1;2:2');
    expect(text.change.textData?.characters).toBe('Prop');
    expect(text.change.derivedTextData?.baselines?.[0]?.endCharacter).toBe(4);
    // root-addressed entries are ignored: the instance node's own fill wins
    expect(colour(get(doc, '3:1'))).toMatchObject({ r: 0.9, g: 0.9, b: 0.9 });
  });

  it('applies BOOL and INSTANCE_SWAP properties and swap overrides', () => {
    const { doc } = synthetic();
    const swappedByProp = get(doc, 'I3:2;2:3');
    expect(swappedByProp.change.visible).toBe(false);
    expect(swappedByProp.symbolId).toBe('1:20');
    expect(swappedByProp.children.map((c) => c.id)).toEqual(['I3:2;2:3;1:21']);
    // Button's own 2:3 shows Icon, so the swapped content mirrors Icon2's real node.
    expect(swappedByProp.children[0]!.componentRef).toBe('1:21');
    // The inner instance's own overrides target Icon's nodes and do not leak into Icon2.
    expect(colour(swappedByProp.children[0]!)).toMatchObject({ r: 0, g: 1, b: 0 });

    const swappedByOverride = get(doc, 'I3:3;2:3');
    expect(swappedByOverride.symbolId).toBe('1:20');
    expect(swappedByOverride.change.visible).toBeUndefined();
    // No TEXT assignment: the symbol's own text stays, with its own layout.
    expect(get(doc, 'I3:3;2:2').change.textData?.characters).toBe('Label');
    expect(get(doc, 'I3:3;2:2').change.derivedTextData?.baselines?.[0]?.endCharacter).toBe(5);
  });

  it('addresses library nodes by overrideKey', () => {
    const { doc } = synthetic();
    const lib = get(doc, '3:4');
    expect(lib.symbolId).toBe('4:1');
    expect(lib.children.map((c) => c.id)).toEqual(['I3:4;7:2']);
    expect(lib.children[0]!.guid).toBe('4:2');
    expect(lib.children[0]!.componentRef).toBe('4:2');
    expect(colour(lib.children[0]!)).toMatchObject({ r: 0, g: 1, b: 1 });
  });

  it('re-reads paints from a referenced style', () => {
    const { doc } = synthetic();
    expect(colour(get(doc, 'I3:9;1:11'))).toMatchObject({ r: 0.5, g: 0, b: 0.5 });
  });

  it('falls back to constraints when an instance is resized without derived data', () => {
    const changes = syntheticChanges();
    const doc = buildTree({ prelude: 'fig-kiwi', version: 0, message: { nodeChanges: changes } as Message, blobs: [], images: new Map() });
    const stats = resolveInstancesWithStats(doc, collect());
    expect(stats.constraintFallbacks).toBe(1);
    const pinned = get(doc, 'I3:8;6:2');
    expect(pinned.change.transform).toMatchObject({ m02: 180, m12: 30 });
    expect(pinned.change.size).toEqual({ x: 20, y: 20 });
    const stretched = get(doc, 'I3:8;6:3');
    expect(stretched.change.transform).toMatchObject({ m02: 10, m12: 20 });
    expect(stretched.change.size).toEqual({ x: 180, y: 10 });
    expect(get(doc, '6:3').change.size).toEqual({ x: 80, y: 20 });
  });

  it('reports missing symbols, cycles and malformed overrides without throwing', () => {
    const { doc, reporter } = synthetic();
    const codes = reporter.warnings.map((w) => `${w.code} ${w.nodeId}`).sort();
    expect(codes).toContain('missing-symbol 3:5');
    expect(codes.some((c) => c.startsWith('instance-cycle'))).toBe(true);
    expect(codes).toContain('bad-override 3:7');
    expect(get(doc, '3:5').children).toEqual([]);
    expect(get(doc, '3:5').symbolId).toBeUndefined();
    // The cycle is cut at the recursive nested instance.
    expect(get(doc, '3:6').children.map((c) => c.id)).toEqual(['I3:6;5:2']);
    expect(get(doc, 'I3:6;5:2').children).toEqual([]);
    // The malformed override is skipped, the rest still applies.
    expect(get(doc, '3:7').children.map((c) => c.id)).toEqual(['I3:7;1:11']);
  });

  it('never shares NodeChange objects with the symbol it clones', () => {
    const { doc } = synthetic();
    for (const node of doc.byId.values()) {
      if (!node.id.startsWith('I')) continue;
      const source = doc.byGuid.get(node.guid)!;
      expect(node.change).not.toBe(source.change);
    }
  });

  it('is deterministic and idempotent', () => {
    const snapshot = (doc: FigDocument) =>
      JSON.stringify([...doc.byId.values()].map((x) => [x.id, x.guid, x.componentRef, x.symbolId, x.children.map((c) => c.id)]));
    const a = synthetic().doc;
    const b = synthetic().doc;
    expect(snapshot(a)).toBe(snapshot(b));
    resolveInstances(a, collect()); // re-running replaces, never duplicates or leaves stale ids
    expect(snapshot(a)).toBe(snapshot(b));
    checkInvariants(a);
  });
});

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

describe('resolveInstances (fixtures)', () => {
  it('grida-components: root-level overrides are already stored on the instance', () => {
    const doc = loadFixture('grida-components.fig');
    const before = doc.byGuid.get('11:5')!.change;
    const reporter = collect();
    resolveInstances(doc, reporter);
    expect(reporter.warnings).toEqual([]);
    const instance = get(doc, '11:5');
    expect(instance.symbolId).toBe('1:11');
    expect(instance.change).not.toBe(before);
    expect(instance.change.fillPaints?.[0]?.opacity).toBeCloseTo(0.5);
    const instances = [...doc.byId.values()].filter((x) => x.type === 'INSTANCE');
    expect(instances).toHaveLength(8);
    for (const x of instances) expect(x.symbolId).toBeDefined();
    checkInvariants(doc);
  });

  it('f2s-structure: text overrides with derived layout', () => {
    const doc = loadFixture('f2s-structure.fig');
    resolveInstances(doc, collect());
    expect(get(doc, 'I1:38;1:42').change.textData?.characters).toBe('XYZ');
    expect(get(doc, 'I1:45;1:42').change.textData?.characters).toBe('ABC');
    expect(get(doc, 'I1:38;1:42').componentRef).toBe('1:42');
    checkInvariants(doc);
  });

  it.each(['f2s-prototyping-swaps-and-instances.fig', 'f2s-sections.fig', 'radix-icons.fig'])('%s: invariants hold', (name) => {
    const doc = loadFixture(name);
    const reporter = collect();
    resolveInstances(doc, reporter);
    expect(reporter.warnings).toEqual([]);
    for (const node of doc.byId.values()) if (node.type === 'INSTANCE') expect(node.symbolId).toBeDefined();
    checkInvariants(doc);
  });
});

describe('resolveInstances (large fixtures)', () => {
  const sds = fileURLToPath(new URL('../fixtures-large/simple-design-system.fig', import.meta.url));
  it.skipIf(!existsSync(sds))('simple-design-system: props, swaps and deep nesting', () => {
    const doc = buildTree(decodeFig(new Uint8Array(readFileSync(sds))));
    const reporter = collect();
    const started = performance.now();
    const stats = resolveInstancesWithStats(doc, reporter);
    const elapsed = performance.now() - started;
    expect(reporter.warnings).toEqual([]);
    expect(stats.instances).toBe(1685);
    expect(stats.nodes).toBe(13105);
    // Stale entries Figma keeps for deleted nodes / pre-swap symbols (see
    // `countUnmatched`). Pinned so that addressing regressions show up.
    expect(stats.unmatchedOverrides).toBe(687);
    expect(stats.unmatchedDerived).toBe(846);
    expect(stats.autoLayoutWithoutDerived).toBe(32);
    expect(elapsed).toBeLessThan(5000);
    checkInvariants(doc);
    // Every materialised text with Figma's derived layout must agree with its
    // final characters — a cheap consistency oracle for TEXT props and
    // swaps, which the REST dumps do not cover.
    let texts = 0;
    for (const node of doc.byId.values()) {
      if (node.type !== 'TEXT' || !node.id.startsWith('I')) continue;
      const baselines = node.change.derivedTextData?.baselines;
      if (!baselines?.length) continue;
      texts++;
      const end = Math.max(...baselines.map((b) => b.endCharacter ?? 0));
      expect(end, node.id).toBe([...(node.change.textData?.characters ?? '')].length);
    }
    expect(texts).toBeGreaterThan(3000);
  });
});
