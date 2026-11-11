/**
 * Regression tests for reviewed `resolveInstances` defects (stale derived
 * text layout, null-GUID swaps, componentRef cost, node budget, depth cap)
 * and for branches the main suite does not reach.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { resolveInstancesWithStats, type ResolveOptions } from '../../src/fig/instances.ts';
import { buildTree } from '../../src/fig/tree.ts';
import { decodeFig } from '../../src/fig/decode.ts';
import type { FigDocument, FigNode, Message, NodeChange } from '../../src/fig/types.ts';

const G = (guid: string) => {
  const [s, l] = guid.split(':').map(Number);
  return { sessionID: s!, localID: l! };
};
const NULL_GUID = { sessionID: 0xffffffff, localID: 0xffffffff };

let position = 0;
function n(guid: string, type: string, parent: string | undefined, extra: Record<string, unknown> = {}): NodeChange {
  position++;
  return {
    guid: G(guid),
    type,
    name: `${type.toLowerCase()} ${guid}`,
    ...(parent ? { parentIndex: { guid: G(parent), position: String(position).padStart(8, '0') } } : {}),
    size: { x: 10, y: 10 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    ...extra,
  } as NodeChange;
}
const path = (...guids: string[]) => ({ guids: guids.map(G) });
const inst = (symbol: string, symbolOverrides: object[] = [], derivedSymbolData: object[] = []) => ({
  symbolData: { symbolID: G(symbol), symbolOverrides },
  derivedSymbolData,
});
const page = (): NodeChange[] => {
  position = 0;
  return [n('0:0', 'DOCUMENT', undefined), n('0:1', 'CANVAS', '0:0')];
};

function run(changes: NodeChange[], options?: ResolveOptions) {
  const doc = buildTree({ prelude: 'fig-kiwi', version: 0, message: { nodeChanges: changes } as Message, blobs: [], images: new Map() });
  const warnings: ir.Warning[] = [];
  const started = performance.now();
  const stats = resolveInstancesWithStats(doc, { warn: (w) => warnings.push(w) }, options);
  return { doc, warnings, stats, ms: performance.now() - started };
}

const get = (doc: FigDocument, id: string): FigNode => {
  const node = doc.byId.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};
const baselineEnd = (node: FigNode) => node.change.derivedTextData?.baselines?.at(-1)?.endCharacter;
const derived = (end: number) => ({ baselines: [{ firstCharacter: 0, endCharacter: end }] });

/** Symbol 1:1 holds text 1:2 ("Inner"); symbol 2:1 holds instance 2:2 of 1:1 with its own derived layout. */
function nestedText(outerOverrides: object[], outerDerived: object[] = []): NodeChange[] {
  return [
    ...page(),
    n('1:1', 'SYMBOL', '0:1'),
    n('1:2', 'TEXT', '1:1', { textData: { characters: 'Inner' }, derivedTextData: derived(5) }),
    n('2:1', 'SYMBOL', '0:1'),
    n('2:2', 'INSTANCE', '2:1', inst('1:1', [], [{ guidPath: path('1:2'), derivedTextData: derived(5) }])),
    n('3:1', 'INSTANCE', '0:1', inst('2:1', outerOverrides, outerDerived)),
  ];
}

/** Symbol k (100+k:1) holds one rect and `fan` instances of symbol k-1; one real instance of the top symbol. */
function chain(depth: number, fan: number): NodeChange[] {
  const c = page();
  for (let k = 0; k < depth; k++) {
    const s = `${100 + k}:1`;
    c.push(n(s, 'SYMBOL', '0:1'), n(`${100 + k}:10`, 'RECTANGLE', s));
    if (k > 0) for (let f = 0; f < fan; f++) c.push(n(`${100 + k}:${100 + f}`, 'INSTANCE', s, inst(`${100 + k - 1}:1`)));
  }
  c.push(n('9:1', 'INSTANCE', '0:1', inst(`${100 + depth - 1}:1`)));
  return c;
}

describe('resolveInstances: derived text layout provenance (A1)', () => {
  it('drops an inner level layout when an outer level overrides the text', () => {
    const { doc } = run(nestedText([{ guidPath: path('2:2', '1:2'), textData: { characters: 'Hi' } }]));
    const text = get(doc, 'I3:1;2:2;1:2');
    expect(text.change.textData?.characters).toBe('Hi');
    expect(text.change.derivedTextData).toBeUndefined();
    // The symbol's own nested instance keeps its matching layout.
    expect(baselineEnd(get(doc, 'I2:2;1:2'))).toBe(5);
  });

  it('keeps a layout from the same (or an outer) level as the text override', () => {
    const { doc } = run(
      nestedText([{ guidPath: path('2:2', '1:2'), textData: { characters: 'Hi' } }], [{ guidPath: path('2:2', '1:2'), derivedTextData: derived(2) }]),
    );
    expect(baselineEnd(get(doc, 'I3:1;2:2;1:2'))).toBe(2);
  });

  it('keeps an inner layout when the outer override leaves the characters unchanged', () => {
    const { doc } = run(nestedText([{ guidPath: path('2:2', '1:2'), textData: { characters: 'Inner' } }]));
    expect(baselineEnd(get(doc, 'I3:1;2:2;1:2'))).toBe(5);
  });

  it('drops a layout whose last baseline disagrees with the final length (safety net)', () => {
    const { doc } = run(
      nestedText([{ guidPath: path('2:2', '1:2'), textData: { characters: 'Hi' } }], [{ guidPath: path('2:2', '1:2'), derivedTextData: derived(7) }]),
    );
    expect(get(doc, 'I3:1;2:2;1:2').change.derivedTextData).toBeUndefined();
  });

  /**
   * Like the "Sign in" button of simple-design-system.fig: the base text is
   * "Button", the nested instance sets "Sign in" through a component property
   * and stores the layout of that text; the outer level re-assigns the same
   * property (an exposed nested property), so the final characters come from
   * the outer level while the layout comes from the inner one.
   */
  function innerLayoutOfFinalText(innerDerived: object, innerValue = 'Sign in', outerValue = 'Sign in'): NodeChange[] {
    const assign = (characters: string) => [{ defID: G('9:1'), value: { textValue: { characters } } }];
    return [
      ...page(),
      n('1:1', 'SYMBOL', '0:1', { componentPropDefs: [{ id: G('9:1'), name: 'Label', type: 'TEXT', initialValue: { textValue: { characters: 'Button' } } }] }),
      n('1:2', 'TEXT', '1:1', {
        textData: { characters: 'Button' },
        derivedTextData: derived(6),
        componentPropRefs: [{ defID: G('9:1'), componentPropNodeField: 'TEXT_DATA' }],
      }),
      n('2:1', 'SYMBOL', '0:1'),
      n('2:2', 'INSTANCE', '2:1', { ...inst('1:1', [], [{ guidPath: path('1:2'), derivedTextData: innerDerived }]), componentPropAssignments: assign(innerValue) }),
      n('3:1', 'INSTANCE', '0:1', inst('2:1', [{ guidPath: path('2:2'), componentPropAssignments: assign(outerValue) }])),
    ];
  }
  const glyphs = (...first: number[]) => first.map((firstCharacter) => ({ firstCharacter }));

  it('keeps an inner level layout that already fits the final text', () => {
    const { doc } = run(innerLayoutOfFinalText({ ...derived(7), glyphs: glyphs(0, 1, 2, 3, 4, 5, 6) }));
    const text = get(doc, 'I3:1;2:2;1:2');
    expect(text.change.textData?.characters).toBe('Sign in');
    expect(baselineEnd(text)).toBe(7);
    expect(text.change.derivedTextData?.glyphs).toHaveLength(7);
  });

  it('drops a layout with a glyph outside the final text', () => {
    const { doc } = run(innerLayoutOfFinalText({ ...derived(7), glyphs: glyphs(0, 1, 2, 3, 4, 5, 6, 8) }));
    expect(get(doc, 'I3:1;2:2;1:2').change.derivedTextData).toBeUndefined();
  });

  it('drops an inner level layout it cannot check (no baselines) when the text changed', () => {
    const { doc } = run(innerLayoutOfFinalText({ glyphs: glyphs(0, 1, 2) }, 'Sig'));
    expect(get(doc, 'I3:1;2:2;1:2').change.derivedTextData).toBeUndefined();
  });

  it('drops an inner level layout of another text of the same length ("Inner" shown as "Outer")', () => {
    // Length is not identity: the layout fits "Outer" but its glyphs draw "Inner".
    const inner = { ...derived(5), glyphs: [0, 1, 2, 3, 4].map((i) => ({ firstCharacter: i, advance: 0.5, fontSize: 10, commandsBlob: [1, 2, 2, 3, 4][i] })) };
    const viaOverride = run(nestedText([{ guidPath: path('2:2', '1:2'), textData: { characters: 'Outer' } }], []));
    expect(get(viaOverride.doc, 'I3:1;2:2;1:2').change.textData?.characters).toBe('Outer');
    expect(get(viaOverride.doc, 'I3:1;2:2;1:2').change.derivedTextData).toBeUndefined();
    const viaProperty = run(innerLayoutOfFinalText(inner, 'Inner', 'Outer'));
    expect(get(viaProperty.doc, 'I3:1;2:2;1:2').change.textData?.characters).toBe('Outer');
    expect(get(viaProperty.doc, 'I3:1;2:2;1:2').change.derivedTextData).toBeUndefined();
    // The same layout stays where its level's text is the final one.
    expect(get(run(innerLayoutOfFinalText(inner, 'Inner', 'Inner')).doc, 'I3:1;2:2;1:2').change.derivedTextData?.glyphs).toHaveLength(5);
  });

  it('drops an inner layout whose glyph pattern contradicts the final text, even with matching provenance', () => {
    // Glyphs 1 and 2 are the same glyph, but "Sign in" has "i" and "g" there.
    const wrong = { ...derived(7), glyphs: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ firstCharacter: i, advance: 0.5, fontSize: 10, commandsBlob: [1, 2, 2, 3, 4, 5, 6][i] })) };
    expect(get(run(innerLayoutOfFinalText(wrong)).doc, 'I3:1;2:2;1:2').change.derivedTextData).toBeUndefined();
  });

  const large = fileURLToPath(new URL('../fixtures-large/simple-design-system.fig', import.meta.url));
  it.skipIf(!existsSync(large))('keeps the valid inner level layout of simple-design-system "Sign in", and every kept layout fits its text', () => {
    const doc = buildTree(decodeFig(readFileSync(large)));
    resolveInstancesWithStats(doc, { warn() {} });
    const signIn = get(doc, 'I18:9895;18:9047;34:12129');
    expect(signIn.change.textData?.characters).toBe('Sign in');
    expect(baselineEnd(signIn)).toBe(7);
    expect(signIn.change.derivedTextData?.glyphs).toHaveLength(7);
    const misfits: string[] = [];
    for (const node of doc.byId.values()) {
      const characters = node.change.textData?.characters;
      const end = baselineEnd(node);
      if (characters === undefined || end === undefined) continue;
      const units = [characters.length, [...characters].length];
      const glyphOutside = (node.change.derivedTextData?.glyphs ?? []).some((g) => (g.firstCharacter ?? 0) >= end);
      if (!units.includes(end) || glyphOutside) misfits.push(`${node.id} ${JSON.stringify(characters)} ends at ${end}`);
    }
    expect(misfits).toEqual([]);
  });

  it('accepts both index units for astral characters', () => {
    // '👍a' is 2 code points, 3 UTF-16 units.
    for (const end of [2, 3]) {
      const { doc } = run(
        nestedText([{ guidPath: path('2:2', '1:2'), textData: { characters: '👍a' } }], [{ guidPath: path('2:2', '1:2'), derivedTextData: derived(end) }]),
      );
      expect(baselineEnd(get(doc, 'I3:1;2:2;1:2'))).toBe(end);
    }
  });
});

describe('resolveInstances: swaps and lookups', () => {
  it('treats a null-GUID overriddenSymbolID as "no swap" on real and nested instances (A2)', () => {
    const { doc, warnings } = run([
      ...page(),
      n('1:1', 'SYMBOL', '0:1'),
      n('1:2', 'RECTANGLE', '1:1'),
      n('2:1', 'SYMBOL', '0:1'),
      n('2:2', 'INSTANCE', '2:1', inst('1:1')),
      n('3:1', 'INSTANCE', '0:1', { ...inst('1:1'), overriddenSymbolID: NULL_GUID }),
      n('3:2', 'INSTANCE', '0:1', inst('2:1', [{ guidPath: path('2:2'), overriddenSymbolID: NULL_GUID }])),
    ]);
    expect(warnings).toEqual([]);
    expect(get(doc, '3:1').symbolId).toBe('1:1');
    expect(get(doc, '3:1').children.map((c) => c.id)).toEqual(['I3:1;1:2']);
    expect(get(doc, 'I3:2;2:2').symbolId).toBe('1:1');
    expect(get(doc, 'I3:2;2:2').children.map((c) => c.id)).toEqual(['I3:2;2:2;1:2']);
  });

  it('resolves library symbols by their overrideKey (symbolsByKey)', () => {
    const { doc, warnings } = run([
      ...page(),
      n('0:2', 'CANVAS', '0:0', { internalOnly: true }),
      n('4:1', 'SYMBOL', '0:2', { overrideKey: G('7:1') }),
      n('4:2', 'RECTANGLE', '4:1', { overrideKey: G('7:2') }),
      n('3:1', 'INSTANCE', '0:1', inst('7:1')),
    ]);
    expect(warnings).toEqual([]);
    expect(get(doc, '3:1').symbolId).toBe('4:1');
    expect(get(doc, '3:1').children.map((c) => c.id)).toEqual(['I3:1;7:2']);
    expect(get(doc, 'I3:1;7:2').componentRef).toBe('4:2');
  });

  it('reports a derived entry without a valid guidPath as bad-override', () => {
    const { doc, warnings } = run([
      ...page(),
      n('1:1', 'SYMBOL', '0:1'),
      n('1:2', 'RECTANGLE', '1:1'),
      n('3:1', 'INSTANCE', '0:1', inst('1:1', [], [{ size: { x: 1, y: 1 } }, { guidPath: path('1:2'), size: { x: 4, y: 4 } }])),
    ]);
    expect(warnings.map((w) => `${w.code} ${w.nodeId}`)).toEqual(['bad-override 3:1']);
    expect(get(doc, 'I3:1;1:2').change.size).toEqual({ x: 4, y: 4 });
  });

  it('points componentRef at an inner opener when the outer one shows another symbol', () => {
    // 1:1 S0 ⊃ o1 (2:2, instance of S1)
    // 2:1 S1 ⊃ o2 (3:2, stored swap to S3), but o1 swaps o2 back to S2
    // the real instance swaps o1;o2 to S3 again → its content mirrors o2's own expansion.
    const { doc } = run([
      ...page(),
      n('5:1', 'SYMBOL', '0:1'),
      n('5:2', 'RECTANGLE', '5:1'),
      n('6:1', 'SYMBOL', '0:1'),
      n('6:2', 'ELLIPSE', '6:1'),
      n('2:1', 'SYMBOL', '0:1'),
      n('3:2', 'INSTANCE', '2:1', { ...inst('5:1'), overriddenSymbolID: G('6:1') }),
      n('1:1', 'SYMBOL', '0:1'),
      n('2:2', 'INSTANCE', '1:1', inst('2:1', [{ guidPath: path('3:2'), overriddenSymbolID: G('5:1') }])),
      n('9:1', 'INSTANCE', '0:1', inst('1:1', [{ guidPath: path('2:2', '3:2'), overriddenSymbolID: G('6:1') }])),
    ]);
    expect(get(doc, 'I2:2;3:2').symbolId).toBe('5:1');
    expect(get(doc, 'I9:1;2:2;3:2').symbolId).toBe('6:1');
    expect(get(doc, 'I9:1;2:2;3:2;6:2').componentRef).toBe('I3:2;6:2');
    expect(get(doc, 'I9:1;2:2;3:2').componentRef).toBe('I2:2;3:2');
  });
});

describe('resolveInstances: limits', () => {
  it('reports the nesting cap as instance-too-deep, not as a cycle (A4)', () => {
    const { warnings, doc } = run(chain(70, 1));
    const codes = new Set(warnings.map((w) => w.code));
    expect([...codes]).toEqual(['instance-too-deep']);
    expect(warnings[0]!.message).toMatch(/more than 64 instance levels/);
    // The real instance's chain is cut at depth 64.
    let node = get(doc, '9:1');
    let depth = 0;
    for (;;) {
      const next = node.children.find((c) => c.type === 'INSTANCE');
      if (!next) break;
      node = next;
      depth++;
    }
    expect(depth).toBe(64);
    expect(node.children).toEqual([]);
  });

  it('scales linearly with exponential fan-out (A3)', () => {
    const { stats, ms, warnings } = run(chain(14, 2));
    expect(warnings).toEqual([]);
    expect(stats.nodes).toBeGreaterThan(90_000);
    // ~0.15 s on a laptop; the old per-node candidate lists took ~2 s here and minutes at depth 18.
    expect(ms).toBeLessThan(2_000);
  });

  it('stops at the node budget with a single warning (A3)', () => {
    const { stats, warnings, doc } = run(chain(12, 2), { maxNodes: 1000 });
    expect(stats.nodes).toBe(1000);
    expect(warnings.map((w) => w.code)).toEqual(['instance-budget-exceeded']);
    // Everything that was created is consistent and indexed.
    for (const node of doc.byId.values()) {
      for (const child of node.children) expect(doc.byId.get(child.id)).toBe(child);
    }
  });
});
