/**
 * Regression tests for reviewed translator defects: corner clamping, masks
 * in auto layout, mask-group componentRef, stretch vs hug, silent data loss
 * warnings, hidden instantiated symbols, remote symbols' layout fields.
 */
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { clampRadii } from '../../../src/fig/translate/shapes.ts';
import { translateDocument } from '../../../src/fig/translate/index.ts';
import type { TranslateOptions } from '../../../src/fig/translate/context.ts';
import type { FigDocument, FigNode, NodeChange } from '../../../src/fig/types.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { allNodes } from './helpers.ts';

let counter = 0;
function mk(type: string, change: Record<string, unknown> = {}, children: FigNode[] = [], id?: string): FigNode {
  counter++;
  const nodeId = id ?? `1:${counter}`;
  const [s, l] = nodeId.split(':').map(Number);
  const node: FigNode = {
    id: nodeId,
    guid: nodeId,
    type: type as FigNode['type'],
    change: {
      type,
      name: `${type.toLowerCase()} ${nodeId}`,
      guid: { sessionID: s!, localID: l! },
      size: { x: 100, y: 100 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      ...change,
    } as NodeChange,
    children,
  };
  for (const child of children) child.parent = node;
  return node;
}
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

function run(pageChildren: FigNode[], options?: TranslateOptions & { internal?: FigNode[] }) {
  const page = mk('CANVAS', {}, pageChildren);
  const canvases = [page];
  const internal = options?.internal ? mk('CANVAS', { internalOnly: true }, options.internal) : undefined;
  if (internal) canvases.push(internal);
  const root = mk('DOCUMENT', {}, canvases);
  const byId = new Map<string, FigNode>();
  const index = (n: FigNode): void => {
    byId.set(n.id, n);
    n.children.forEach(index);
  };
  index(root);
  const doc: FigDocument = {
    file: { prelude: 'fig-kiwi', version: 1, message: {} as FigDocument['file']['message'], blobs: [], images: new Map() },
    root,
    pages: [page],
    internalCanvas: internal,
    byId,
    byGuid: new Map(byId),
  };
  const reporter = new CollectingReporter();
  const out = translateDocument(doc, reporter, options);
  const nodes = out.pages.flatMap((p) => allNodes(p.children));
  const get = (id: string): ir.Node => {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`no IR node ${id}`);
    return node;
  };
  return { ir: out, reporter, get, codes: reporter.warnings.map((w) => w.code) };
}

describe('corner radii are clamped to the box (B1)', () => {
  it('scales all four radii by the CSS factor', () => {
    // A 302 px high pill stored with radius 200 renders with 151.
    expect(clampRadii([200, 200, 200, 200], { width: 600, height: 302 })).toEqual([151, 151, 151, 151]);
    // tl+tr = 150 on a 100 wide box → factor 2/3 for every corner.
    expect(clampRadii([100, 50, 0, 0], { width: 100, height: 400 })).toEqual([100 * (2 / 3), 50 * (2 / 3), 0, 0]);
    expect(clampRadii([4, 8, 16, 12], { width: 100, height: 100 })).toEqual([4, 8, 16, 12]);
  });

  it('stores the clamped radii on rects and frames', () => {
    const { get } = run([
      mk('ROUNDED_RECTANGLE', { size: { x: 600, y: 302 }, cornerRadius: 200 }, [], '2:1'),
      mk('FRAME', { size: { x: 40, y: 40 }, cornerRadius: 999 }, [], '2:2'),
      mk('ROUNDED_RECTANGLE', { size: { x: 0, y: 0 }, cornerRadius: 5 }, [], '2:3'),
    ]);
    expect((get('2:1') as ir.RectNode).cornerRadii).toEqual([151, 151, 151, 151]);
    expect((get('2:2') as ir.FrameNode).cornerRadii).toEqual([20, 20, 20, 20]);
    expect((get('2:3') as ir.RectNode).cornerRadii).toBeUndefined();
  });
});

describe('masks inside auto layout (B2, B3)', () => {
  const stack = (children: FigNode[]) =>
    mk('FRAME', { stackMode: 'HORIZONTAL', stackPrimarySizing: 'FIXED', size: { x: 300, y: 100 } }, children, '3:1');

  it('detaches members from the flow and positions the group absolutely, with a warning', () => {
    const { get, reporter } = run([
      stack([
        mk('ELLIPSE', { mask: true, size: { x: 50, y: 50 }, transform: at(0, 0) }, [], '3:2'),
        mk('ROUNDED_RECTANGLE', { size: { x: 50, y: 50 }, transform: at(60, 0), stackChildAlignSelf: 'STRETCH' }, [], '3:3'),
      ]),
    ]);
    const group = get('3:2#mask') as ir.GroupNode;
    expect(group.layoutChild).toEqual({ positioning: 'absolute' });
    expect(group.sizing).toEqual({ horizontal: 'fixed', vertical: 'fixed' });
    for (const member of group.children) {
      expect(member.layoutChild, member.id).toBeUndefined();
      expect(member.sizing, member.id).toBeUndefined();
    }
    expect(reporter.warnings.filter((w) => w.code === 'mask-in-auto-layout')).toEqual([
      expect.objectContaining({ nodeId: '3:2' }),
    ]);
    // Members stay where Figma put them.
    const parent = get('3:1') as ir.FrameNode;
    expect(parent.children.map((c) => c.id)).toEqual(['3:2#mask']);
    expect(group.transform).toMatchObject({ e: 0, f: 0 });
    expect(group.children[1]!.transform).toMatchObject({ e: 60, f: 0 });
  });

  it('lets the group take the place of its single in-flow member when the boxes coincide', () => {
    const { get, codes } = run([
      stack([
        mk('ELLIPSE', { mask: true, size: { x: 50, y: 50 }, transform: at(10, 0) }, [], '3:2'),
        mk('ROUNDED_RECTANGLE', { size: { x: 20, y: 20 }, transform: at(20, 10), stackPositioning: 'ABSOLUTE' }, [], '3:3'),
      ]),
    ]);
    expect((get('3:2#mask') as ir.GroupNode).layoutChild).toEqual({ positioning: 'auto' });
    expect(codes).not.toContain('mask-in-auto-layout');
  });

  it('keeps masks outside auto layout free of layout fields', () => {
    const { get } = run([
      mk('ELLIPSE', { mask: true, size: { x: 50, y: 50 } }, [], '3:2'),
      mk('ROUNDED_RECTANGLE', { size: { x: 50, y: 50 } }, [], '3:3'),
    ]);
    const group = get('3:2#mask') as ir.GroupNode;
    expect(group.layoutChild).toBeUndefined();
    expect(group.sizing).toBeUndefined();
    expect(group.componentRef).toBeUndefined();
  });

  it('mirrors the main component\'s mask group inside instances', () => {
    const mask = mk('ELLIPSE', { mask: true, size: { x: 50, y: 50 } }, [], 'I4:1;3:2');
    mask.componentRef = '3:2';
    const masked = mk('ROUNDED_RECTANGLE', {}, [], 'I4:1;3:3');
    masked.componentRef = '3:3';
    const { get } = run([mk('INSTANCE', {}, [mask, masked], '4:1')]);
    expect(get('I4:1;3:2#mask').componentRef).toBe('3:2#mask');
  });
});

describe('stretch vs own hug sizing (B4)', () => {
  it('reports HUG and no stretch for a hugging auto layout child stretched along its own primary axis', () => {
    const { get } = run([
      mk('FRAME', { stackMode: 'VERTICAL', stackPrimarySizing: 'FIXED' }, [
        mk('FRAME', { stackMode: 'HORIZONTAL', stackChildAlignSelf: 'STRETCH' }, [], '5:2'),
        mk('FRAME', { stackMode: 'HORIZONTAL', stackPrimarySizing: 'FIXED', stackChildAlignSelf: 'STRETCH' }, [], '5:3'),
        mk('FRAME', { stackMode: 'VERTICAL', stackChildAlignSelf: 'STRETCH' }, [], '5:4'),
        mk('ROUNDED_RECTANGLE', { stackChildAlignSelf: 'STRETCH' }, [], '5:5'),
      ]),
    ]);
    expect(get('5:2').sizing?.horizontal).toBe('hug');
    expect(get('5:2').layoutChild?.alignSelf).toBeUndefined();
    for (const id of ['5:3', '5:4', '5:5']) {
      expect(get(id).sizing?.horizontal, id).toBe('fill');
      expect(get(id).layoutChild?.alignSelf, id).toBe('stretch');
    }
  });
});

describe('silent data loss is reported (B5)', () => {
  it('warns about grid auto layout once per node and keeps child positions', () => {
    const { get, reporter } = run([
      mk('FRAME', { stackMode: 'GRID' }, [mk('ROUNDED_RECTANGLE', { transform: at(30, 40) }, [], '6:2')], '6:1'),
    ]);
    expect(reporter.warnings.filter((w) => w.code === 'unsupported-grid-layout').map((w) => w.nodeId)).toEqual(['6:1']);
    expect((get('6:1') as ir.FrameNode).layout).toBeUndefined();
    expect(get('6:2').transform).toMatchObject({ e: 30, f: 40 });
    expect(get('6:2').layoutChild).toBeUndefined();
  });

  it('warns about layout grids and guides once per document', () => {
    const grid = { type: 'STRETCH', axis: 'X', visible: true, numSections: 5 };
    const { reporter } = run([
      mk('FRAME', { layoutGrids: [grid, grid] }),
      mk('FRAME', { layoutGrids: [grid], guides: [{ axis: 'Y', offset: 10 }] }),
    ]);
    const warnings = reporter.warnings.filter((w) => w.code === 'layout-grids-dropped');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/3 layout grid\(s\) and 1 guide/);
  });

  it('warns about unmapped image filters and non-sRGB gradient interpolation, once per node', () => {
    const image = (filter: object) => ({ type: 'IMAGE', image: { hash: new Uint8Array([1, 2]) }, imageScaleMode: 'FILL', paintFilter: filter });
    const gradient = (space: string) => ({
      type: 'GRADIENT_LINEAR',
      interpolationColorSpace: space,
      stops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    });
    const { reporter } = run([
      mk('ROUNDED_RECTANGLE', { fillPaints: [image({ vignette: 0.3, exposure: 0.2 }), image({ brightness: 0.1 })] }, [], '7:1'),
      mk('ROUNDED_RECTANGLE', { fillPaints: [image({ exposure: 0.2 })] }, [], '7:2'),
      mk('ROUNDED_RECTANGLE', { fillPaints: [gradient('OKLAB')], strokePaints: [gradient('OKLCH')] }, [], '7:3'),
      mk('ROUNDED_RECTANGLE', { fillPaints: [gradient('DEFAULT')] }, [], '7:4'),
    ]);
    const of = (code: string) => reporter.warnings.filter((w) => w.code === code).map((w) => w.nodeId);
    expect(of('unsupported-image-filter')).toEqual(['7:1']);
    expect(of('unsupported-gradient-color-space')).toEqual(['7:3']);
  });
});

describe('hidden instantiated symbols (B6)', () => {
  it('keeps hidden symbols (and their hidden ancestors) that are instantiated, with includeHidden: false', () => {
    const symbol = mk('SYMBOL', { visible: false }, [mk('ROUNDED_RECTANGLE')], '8:1');
    const nested = mk('SYMBOL', {}, [], '8:3');
    const hiddenSet = mk('FRAME', { visible: false, isStateGroup: true }, [nested], '8:2');
    const unused = mk('SYMBOL', { visible: false }, [], '8:4');
    const a = mk('INSTANCE', {}, [], '8:5');
    a.symbolId = '8:1';
    const b = mk('INSTANCE', {}, [], '8:6');
    b.symbolId = '8:3';
    const { get, ir: doc } = run([symbol, hiddenSet, unused, a, b], { includeHidden: false });
    expect(get('8:1').visible).toBe(false);
    expect(get('8:2').visible).toBe(false);
    expect(get('8:3').visible).toBe(true);
    expect(() => get('8:4')).toThrow();
    expect((get('8:5') as ir.FrameNode).instanceOf).toBe('8:1');
    expect((get('8:6') as ir.FrameNode).instanceOf).toBe('8:3');
    expect(Object.keys(doc.components).sort()).toEqual(['8:1', '8:3']);
  });
});

describe('remote symbols detached from an auto layout parent (B2)', () => {
  it('drops layoutChild and parent-derived sizing', () => {
    const plain = mk('SYMBOL', { stackChildPrimaryGrow: 1 }, [], '9:2');
    const auto = mk('SYMBOL', { stackMode: 'VERTICAL', stackChildAlignSelf: 'STRETCH' }, [], '9:3');
    const libraryStack = mk('FRAME', { stackMode: 'HORIZONTAL' }, [plain, auto], '9:1');
    const i1 = mk('INSTANCE', {}, [], '9:4');
    i1.symbolId = '9:2';
    const i2 = mk('INSTANCE', {}, [], '9:5');
    i2.symbolId = '9:3';
    const { ir: doc } = run([i1, i2], { internal: [libraryStack] });
    const remote = doc.pages.find((p) => p.kind === 'remote-components')!;
    const byId = new Map(remote.children.map((n) => [n.id, n]));
    expect(byId.get('9:2')!.layoutChild).toBeUndefined();
    expect(byId.get('9:2')!.sizing).toBeUndefined();
    expect(byId.get('9:3')!.layoutChild).toBeUndefined();
    // Its own auto layout sizing stays; the parent's stretch does not.
    expect(byId.get('9:3')!.sizing).toEqual({ horizontal: 'fixed', vertical: 'hug' });
  });
});
