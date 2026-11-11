import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { gradientHandles } from '../../../src/fig/translate/paints.ts';
import { sniffImage } from '../../../src/fig/translate/images.ts';
import { parseVariantName } from '../../../src/fig/translate/components.ts';
import { byId, byName, fixture, nodesOf } from './helpers.ts';

function as<T extends ir.Node['type']>(node: ir.Node, type: T): Extract<ir.Node, { type: T }> {
  expect(node.type).toBe(type);
  return node as Extract<ir.Node, { type: T }>;
}

describe('document', () => {
  it('uses meta.json for the name and canvas background colours for pages', () => {
    const t = fixture('grida-frame.fig');
    expect(t.ir.name).toBe(t.doc.file.meta?.['file_name']);
    expect(t.ir.pages.map((p) => p.name)).toEqual(['page-with-frame', 'page-with-frame-with-clip', 'page-with-group']);
    expect(t.ir.pages[0]!.background).toEqual({ r: expect.closeTo(0.96, 2), g: expect.closeTo(0.96, 2), b: expect.closeTo(0.96, 2), a: 1 });
    expect(t.ir.pages.every((p) => p.kind === 'page')).toBe(true);
  });

  it('translates an empty file', () => {
    const t = fixture('grida-blank.fig');
    expect(t.ir.pages).toHaveLength(1);
    expect(t.ir.pages[0]!.children).toEqual([]);
    expect(t.reporter.warnings).toEqual([]);
  });

  it('is deterministic', () => {
    const a = fixture('f2s-structure.fig').ir;
    const b = fixture('f2s-structure.fig').ir;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('frames, groups, clipping', () => {
  it('maps frameMaskDisabled to clipsContent and resizeToFit frames to groups', () => {
    const t = fixture('grida-frame.fig');
    expect(as(t.ir.pages[0]!.children[0]!, 'frame').clipsContent).toBe(false);
    expect(as(t.ir.pages[1]!.children[0]!, 'frame').clipsContent).toBe(true);
    const group = as(t.ir.pages[2]!.children[0]!, 'group');
    expect(group.children.map((c) => c.name)).toEqual(['red', 'green', 'blue']);
    expect(group.fills).toEqual([]);
    expect(group.size).toEqual({ width: 320, height: 100 });
  });

  it('keeps rotated nested groups with their own transform and effects', () => {
    const t = fixture('f2s-structure.fig');
    const outer = as(byName(t, 'Group 2'), 'group');
    expect(outer.effects).toEqual([
      { type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, blur: 4, spread: 0, blendMode: 'normal', showBehindNode: false },
    ]);
    const inner = as(byName(t, 'Group 1'), 'group');
    expect(inner.transform.a).toBeCloseTo(Math.SQRT1_2, 5);
    expect(inner.transform.b).toBeCloseTo(Math.SQRT1_2, 5);
    expect(inner.transform.c).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(inner.transform.e).toBeCloseTo(186.42, 2);
  });

  it('translates sections, component sets and corner radii', () => {
    const t = fixture('f2s-sections.fig');
    const section = as(byName(t, 'Section'), 'frame');
    expect(section.role).toBe('section');
    const set = as(section.children[0]!, 'frame');
    expect(set.role).toBe('component-set');
    expect(set.cornerRadii).toEqual([5, 5, 5, 5]);
    expect(set.stroke).toMatchObject({ weight: 1, align: 'inside', dashPattern: [10, 5] });
    expect(set.children.map((c) => (c as ir.FrameNode).role)).toEqual(['component', 'component']);
  });

  it('reads independent corner radii (TL, TR, BR, BL) and smoothing', () => {
    const t = fixture('f2s-corners.fig');
    // kiwi: TL 4, TR 8, BL 12, BR 16 (the layer name lists them in field order).
    expect(as(byId(t, '2051:14'), 'frame').cornerRadii).toEqual([4, 8, 16, 12]);
    expect(as(byId(t, '2051:13'), 'frame').cornerRadii).toEqual([0, 12, 0, 0]);
    const smooth = as(byId(t, '2051:3'), 'rect');
    expect(smooth.cornerRadii).toEqual([12, 12, 12, 12]);
    expect(smooth.cornerSmoothing).toBeCloseTo(0.6, 5);
    expect(as(byId(t, '2051:2'), 'rect').cornerSmoothing).toBeUndefined();
  });
});

describe('auto layout', () => {
  it('translates direction, wrap, spacing, padding and alignment', () => {
    const t = fixture('f2s-stacks-wrap.fig');
    const wrap = as(byName(t, 'Horizontal wrap bottom right'), 'frame');
    expect(wrap.layout).toEqual({
      direction: 'horizontal',
      wrap: true,
      itemSpacing: 4,
      counterSpacing: 8,
      padding: { top: 20, right: 20, bottom: 20, left: 20 },
      primaryAlign: 'end',
      counterAlign: 'end',
      counterAlignContent: 'auto',
      reverseZIndex: false,
      strokesIncludedInLayout: false,
    });
    expect(as(byName(t, 'Vertical middle center'), 'frame').layout).toMatchObject({ direction: 'vertical', wrap: false, primaryAlign: 'center', counterAlign: 'center' });
    const child = wrap.children[0]!;
    expect(child.layoutChild).toEqual({ positioning: 'auto' });
    expect(child.sizing).toEqual({ horizontal: 'fixed', vertical: 'fixed' });
  });

  it('leaves layout fields off nodes outside auto layout', () => {
    const t = fixture('grida-frame.fig');
    for (const node of nodesOf(t)) {
      expect(node.layoutChild).toBeUndefined();
      expect(node.sizing).toBeUndefined();
    }
  });
});

describe('strokes', () => {
  it('translates alignment and weight', () => {
    const t = fixture('grida-stroke.fig');
    expect(byName(t, 'inside-rect-vector-with-strokes').stroke).toMatchObject({ weight: 10, align: 'inside', join: 'miter', startCap: 'none', endCap: 'none', dashPattern: [] });
    expect(byName(t, 'center-rect-vector-with-strokes').stroke?.align).toBe('center');
    expect(byName(t, 'outside-rect-vector-with-strokes').stroke?.align).toBe('outside');
  });

  it('keeps open curves as open paths with the stroke outline in geometry', () => {
    const t = fixture('grida-vector.fig');
    const path = as(byName(t, 'vector-3-scurve'), 'path');
    expect(path.pathsAreExact).toBe(true);
    expect(path.paths[0]!.commands.map((c) => c.type)).toEqual(['M', 'C', 'C']);
    expect(path.geometry?.stroke?.length).toBe(1);
    expect(path.geometry?.fill).toBeUndefined();
  });
});

describe('vectors', () => {
  it('builds exact paths from simple networks', () => {
    const t = fixture('f2s-structure.fig');
    const v = as(byId(t, '1:32'), 'path');
    expect(v.pathsAreExact).toBe(true);
    expect(v.paths[0]!.commands.filter((c) => c.type === 'M')).toHaveLength(2);
  });

  it('splits per-region fills into a group of exact fill paths, and flags corner radii as inexact', () => {
    const complex = as(byName(fixture('f2s-vector.fig'), 'Complex'), 'group');
    expect(complex.id).toBe('0:5');
    expect(complex.children.map((c) => c.id)).toEqual(['0:5#fill0', '0:5#fill1', '0:5#fill2', '0:5#fill3', '0:5#fill4', '0:5#fill5', '0:5#stroke']);
    for (const child of complex.children) expect(as(child, 'path').pathsAreExact).toBe(true);
    const rounded = as(byId(fixture('f2s-corners.fig'), '2051:6'), 'path');
    expect(rounded.pathsAreExact).toBe(false);
    expect(rounded.geometry?.fill?.[0]!.commands.some((c) => c.type === 'C')).toBe(true);
  });
});

describe('components and instances', () => {
  it('registers components with sets and variant properties', () => {
    const t = fixture('grida-components.fig');
    expect(t.ir.components['1:3']).toEqual({ id: '1:3', name: 'color=red', remote: false, set: { id: '1:2', name: 'components-set' }, variantProperties: { color: 'red' } });
    expect(t.ir.components['1:11']).toEqual({ id: '1:11', name: 'red', remote: false });
    const instance = as(byId(t, '1:17'), 'frame');
    expect(instance.role).toBe('instance');
    expect(instance.instanceOf).toBe('1:3');
  });

  it('copies componentRef onto materialised instance children', () => {
    const t = fixture('f2s-structure.fig');
    const instance = as(byName(t, 'Component 2'), 'frame');
    expect(instance.instanceOf).toBe('1:37');
    expect(instance.children.map((c) => [c.id, c.componentRef])).toEqual([
      ['I1:38;1:35', '1:35'],
      ['I1:38;1:42', '1:42'],
    ]);
    expect(byId(t, '1:37').componentRef).toBeUndefined();
  });

  it('puts instantiated internal-canvas symbols on a remote-components page', () => {
    const t = fixture('radix-icons.fig');
    const remote = t.ir.pages.find((p) => p.kind === 'remote-components');
    expect(remote).toBeDefined();
    const ids = new Set(remote!.children.map((c) => c.id));
    for (const node of remote!.children) {
      expect(as(node, 'frame').componentId).toBe(node.id);
      expect(t.ir.components[node.id]?.remote).toBe(true);
    }
    // Every instance resolves to a translated component.
    for (const node of nodesOf(t)) {
      if (node.type === 'frame' && node.instanceOf) expect(t.ir.components[node.instanceOf]).toBeDefined();
    }
    // Laid out without overlaps.
    const boxes = remote!.children.map((c) => ({ x: c.transform.e, y: c.transform.f, w: c.size.width, h: c.size.height }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
    }
    expect(ids.size).toBe(remote!.children.length);
  });

  it('parses variant names', () => {
    expect(parseVariantName('Size=Large, State=Hover')).toEqual({ Size: 'Large', State: 'Hover' });
    expect(parseVariantName('Plain name')).toBeUndefined();
  });
});

describe('masks', () => {
  it('wraps a mask and the siblings above it in a mask group', () => {
    const t = fixture('radix-icons.fig');
    const group = as(byId(t, '2001:5701#mask'), 'group');
    expect(group.mask).toEqual({ type: 'alpha' });
    // The mask first, then every following sibling (no further mask in that parent).
    expect(group.children.map((c) => c.id).slice(0, 3)).toEqual(['2001:5701', '2001:5702', '2001:5703']);
    const parent = t.doc.byId.get('2001:5701')!.parent!;
    expect(group.children).toHaveLength(parent.children.length - parent.children.findIndex((c) => c.id === '2001:5701'));
    // The mask sits at the group origin; the group carries the mask's offset.
    expect(group.children[0]!.transform.e).toBeCloseTo(0, 6);
    expect(group.transform.e).toBeCloseTo(1.35, 2);
    expect(group.size.width).toBeCloseTo(group.children[0]!.size.width, 6);
  });
});

describe('paints and images', () => {
  it('embeds referenced images with sniffed type and size, and reports missing ones', () => {
    const t = fixture('f2s-structure.fig');
    expect(Object.values(t.ir.images).map(({ ref, mimeType, width, height }) => ({ ref, mimeType, width, height }))).toEqual([
      { ref: '93e8eeb27e934c4b9ae9e7929c7df9e96a6ec90c', mimeType: 'image/jpeg', width: 1024, height: 512 },
      { ref: '9e5c0093c792b765075c6886d474cefd1c2d8809', mimeType: 'image/png', width: 64, height: 64 },
    ]);
    const fill = byName(t, 'sketch 1').fills[0]!;
    expect(fill).toMatchObject({ type: 'image', imageRef: '9e5c0093c792b765075c6886d474cefd1c2d8809', scaleMode: 'fill' });

    const broken = fixture('f2s-broken-images.fig');
    expect(broken.reporter.warnings).toContainEqual(expect.objectContaining({ code: 'missing-image', nodeId: '1:3' }));
    // A present but undecodable image keeps its bytes, without a mime type.
    const images = Object.values(broken.ir.images);
    expect(images.map((i) => i.ref)).toEqual(['ebf82e54d840d6415a9c0aee2d04b472c30d15e9']);
    expect(images[0]!.mimeType).toBeUndefined();
    expect(images[0]!.bytes.length).toBeGreaterThan(0);
  });

  it('maps gradient transforms to REST handle positions', () => {
    // Identity: the canonical linear axis (0,.5) → (1,.5).
    expect(gradientHandles(undefined, 'linear')).toEqual([{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }]);
    // A vertical top → bottom gradient: node (x,y) ↦ gradient (y, 1-x)... inverse maps (0,.5) to (.5,0).
    const handles = gradientHandles({ m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 }, 'linear');
    expect(handles[0]).toEqual({ x: expect.closeTo(0.5, 9), y: expect.closeTo(0, 9) });
    expect(handles[1]).toEqual({ x: expect.closeTo(0.5, 9), y: expect.closeTo(1, 9) });
    expect(gradientHandles(undefined, 'radial')[0]).toEqual({ x: 0.5, y: 0.5 });
  });

  it('sniffs image headers', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 2]);
    expect(sniffImage(png)).toEqual({ mimeType: 'image/png', width: 256, height: 2 });
    const gif = new TextEncoder().encode('GIF89a\x05\x00\x07\x00');
    expect(sniffImage(gif)).toEqual({ mimeType: 'image/gif', width: 5, height: 7 });
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ mimeType: 'image/svg+xml' });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toEqual({});
  });
});

describe('effects', () => {
  it('reports unsupported effects and does not smear progressive blurs over the whole node', () => {
    const t = fixture('f2s-noise-and-grain.fig');
    const codes = t.reporter.warnings.map((w) => w.code);
    expect(codes).toContain('unsupported-effect');
    // Both texts carry a progressive blur ramping up from radius 0: Figma shows them mostly sharp.
    expect(codes).toContain('progressive-blur');
    const effects = nodesOf(t).flatMap((n) => n.effects);
    expect(effects.some((e) => e.type === 'layer-blur' || e.type === 'background-blur')).toBe(false);
  });
});
