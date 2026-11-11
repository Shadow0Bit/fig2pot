import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { booleanNode, doc, ellipse, frame, group, pathNode, rect, segments, solid, square, stroke, text, textStyle, translate, write } from './helpers.ts';

describe('groups and masks', () => {
  it('writes a group around its children (box recomputed by Penpot)', async () => {
    const w = await write(
      doc([group('g', [rect('a', { transform: translate(10, 10), size: { width: 10, height: 10 } }), rect('b', { transform: translate(30, 30), size: { width: 10, height: 10 } })], { opacity: 0.5 })]),
    );
    const g = w.shape('g');
    expect(g).toMatchObject({ type: 'group', opacity: 0.5, x: 10, y: 10, width: 30, height: 30 });
    expect(w.children(g).map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('writes a masked group whose first child is the mask', async () => {
    const mask = ellipse('m', { transform: translate(5, 5), size: { width: 20, height: 20 } });
    const w = await write(doc([group('g', [mask, rect('a', { size: { width: 100, height: 100 } })], { mask: { type: 'alpha' } })]));
    const g = w.shape('g');
    expect(g.maskedGroup).toBe(true);
    expect(g.shapes[0]).toBe(w.shape('m').id);
    expect(g).toMatchObject({ x: 5, y: 5, width: 20, height: 20 });
  });

  it('does not mask with a hidden mask, and warns about luminance masks', async () => {
    const w = await write(
      doc([
        group('hidden', [rect('m1', { visible: false }), rect('a1')], { mask: { type: 'vector' } }),
        group('lum', [rect('m2'), rect('a2')], { mask: { type: 'luminance' } }),
      ]),
    );
    expect(w.shape('hidden').maskedGroup).toBeUndefined();
    expect(w.shape('lum').maskedGroup).toBe(true);
    expect(w.codes()).toContain('mask-type-approximated');
  });

  it('drops empty groups with a warning', async () => {
    const w = await write(doc([group('g', []), rect('r')]));
    expect(w.has('g')).toBe(false);
    expect(w.roots().map((s) => s.name)).toEqual(['r']);
    expect(w.codes()).toContain('empty-group');
  });
});

describe('paths', () => {
  it('bakes the absolute transform into the content and converts quadratics to cubics', async () => {
    const p: ir.Path = {
      windingRule: 'evenodd',
      commands: [
        { type: 'M', x: 0, y: 0 },
        { type: 'Q', x1: 30, y1: 0, x: 30, y: 30 },
        { type: 'C', x1: 30, y1: 40, x2: 10, y2: 40, x: 0, y: 30 },
        { type: 'Z' },
      ],
    };
    const w = await write(doc([group('g', [pathNode('p', [p], { transform: translate(5, 0), fills: [solid(0, 0, 0)] })], { transform: translate(0, 100) })]));
    const s = w.shape('p');
    expect(s.type).toBe('path');
    expect(s.svgAttrs).toEqual({ fillRule: 'evenodd' });
    expect(segments(s)).toEqual([
      ['M', 5, 100],
      ['C', 25, 100, 35, 110, 35, 130],
      ['C', 35, 140, 15, 140, 5, 130],
      ['Z'],
    ]);
    // Paths have no default stroke.
    expect(s.strokes).toEqual([]);
  });

  it('splits paths with different winding rules into a group of paths', async () => {
    const w = await write(doc([pathNode('p', [square(0, 0, 10, 10, 'nonzero'), square(20, 0, 10, 10, 'evenodd')], { fills: [solid(1, 0, 0)], opacity: 0.5 })]));
    const g = w.shape('p');
    expect(g).toMatchObject({ type: 'group', name: 'p', opacity: 0.5 });
    const kids = w.children(g);
    expect(kids.map((k) => k.svgAttrs.fillRule)).toEqual(['nonzero', 'evenodd']);
    expect(kids.every((k) => k.fills[0].fillColor === '#ff0000' && k.opacity === undefined)).toBe(true);
  });

  it('draws the source outlines when the editable paths are not exact', async () => {
    const node = pathNode('p', [square(0, 0, 10, 10)], {
      pathsAreExact: false,
      fills: [solid(1, 0, 0)],
      stroke: stroke({ paints: [solid(0, 0, 1)], weight: 2, align: 'center' }),
      geometry: { fill: [square(1, 1, 8, 8)], stroke: [{ windingRule: 'evenodd', commands: [...square(-1, -1, 12, 12).commands, ...square(1, 1, 8, 8).commands] }] },
    });
    const w = await write(doc([node]));
    const [fill, outline] = w.children(w.shape('p'));
    expect(fill).toMatchObject({ fills: [{ fillColor: '#ff0000' }], strokes: [], svgAttrs: { fillRule: 'nonzero' } });
    expect(segments(fill!)[0]).toEqual(['M', 1, 1]);
    expect(outline).toMatchObject({ fills: [{ fillColor: '#0000ff' }], strokes: [], svgAttrs: { fillRule: 'evenodd' } });
  });

  it('falls back to the editable paths (with a warning) when no outline is provided', async () => {
    const w = await write(doc([pathNode('p', [square(0, 0, 10, 10)], { pathsAreExact: false, fills: [solid(1, 0, 0)] })]));
    expect(w.shape('p').type).toBe('path');
    expect(w.codes()).toContain('path-approximated');
  });

  it('drops paths without segments', async () => {
    const w = await write(doc([pathNode('p', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }] }])]));
    expect(w.has('p')).toBe(false);
    expect(w.codes()).toContain('empty-path');
  });
});

describe('booleans', () => {
  const operands = (): ir.Node[] => [
    rect('a', { size: { width: 20, height: 20 }, fills: [solid(0, 1, 0)] }),
    rect('b', { transform: translate(10, 10), size: { width: 20, height: 20 }, fills: [solid(0, 0, 1)] }),
  ];

  it('builds an editable Penpot boolean whose style is the boolean node\'s', async () => {
    const w = await write(doc([booleanNode('u', 'subtract', operands(), { fills: [solid(1, 0, 0)], size: { width: 30, height: 30 } })]), { booleanMode: 'editable' });
    const b = w.shape('u');
    expect(b.type).toBe('bool');
    expect(b.boolType).toBe('difference');
    expect(b.fills).toEqual([{ fillColor: '#ff0000', fillOpacity: 1 }]);
    expect(w.children(b).map((s) => s.name)).toEqual(['a', 'b']);
    expect(b.content.length).toBeGreaterThan(0);
  });

  it('maps every operation', async () => {
    const ops: ir.BooleanNode['operation'][] = ['union', 'subtract', 'intersect', 'exclude'];
    const w = await write(doc(ops.map((op) => booleanNode(op, op, operands().map((n) => ({ ...n, id: `${op}-${n.id}` }))))), { booleanMode: 'editable' });
    expect(ops.map((op) => w.shape(op).boolType)).toEqual(['union', 'difference', 'intersection', 'exclude']);
  });

  it('flattens to the computed outline in flatten mode', async () => {
    const node = booleanNode('u', 'union', operands(), { fills: [solid(1, 0, 0)], geometry: { fill: [square(0, 0, 30, 30)] } });
    const w = await write(doc([node]), { booleanMode: 'flatten' });
    const s = w.shape('u');
    expect(s.type).toBe('path');
    expect(s.fills).toEqual([{ fillColor: '#ff0000', fillOpacity: 1 }]);
    expect(w.has('a')).toBe(false);
  });

  it('uses the computed outline when every operand is a board (Penpot ignores boards in booleans)', async () => {
    const node = booleanNode('u', 'union', [frame('f1', [rect('inner')])], { fills: [solid(1, 0, 0)], geometry: { fill: [square(0, 0, 30, 30)] } });
    const w = await write(doc([node]), { booleanMode: 'editable' });
    expect(w.shape('u').type).toBe('path');
    expect(w.codes()).toContain('boolean-flattened');
  });

  it('stays editable in flatten mode when no outline is available', async () => {
    const w = await write(doc([booleanNode('u', 'union', operands())]), { booleanMode: 'flatten' });
    expect(w.shape('u').type).toBe('bool');
    expect(w.codes()).toContain('boolean-geometry-missing');
  });
});

describe('text', () => {
  const outlined = (extra: Partial<ir.TextNode> = {}): ir.TextNode =>
    text('t', 'Hi', {
      runs: [
        { start: 0, end: 1, style: textStyle({ fills: [solid(1, 0, 0)] }) },
        { start: 1, end: 2, style: textStyle({ fills: [solid(0, 0, 1)] }) },
      ],
      layout: {
        outlines: [
          { path: square(0, 0, 5, 10), runIndex: 0 },
          { path: square(6, 0, 5, 10), runIndex: 1 },
        ],
      },
      ...extra,
    });

  it('keeps text editable when the fonts are available', async () => {
    const w = await write(doc([outlined()]));
    const s = w.shape('t');
    expect(s.type).toBe('text');
    expect(s.growType).toBe('fixed');
    expect(JSON.stringify(s.content)).toContain('"text":"H"');
  });

  it('draws glyph outlines with each run\'s fills in outline mode', async () => {
    const w = await write(doc([outlined({ transform: translate(100, 0) })]), { textMode: 'outline' });
    const g = w.shape('t');
    expect(g.type).toBe('group');
    const kids = w.children(g);
    expect(kids.map((k) => k.fills[0].fillColor)).toEqual(['#ff0000', '#0000ff']);
    expect(segments(kids[1]!)[0]).toEqual(['M', 106, 0]);
  });

  it('outlines text whose font Penpot does not have, in auto mode', async () => {
    const node = outlined();
    node.runs = node.runs.map((r) => ({ ...r, style: { ...r.style, fontFamily: 'Totally Unknown Sans' } }));
    const w = await write(doc([node]));
    expect(w.shape('t').type).toBe('group');
    expect(w.codes()).toContain('font-unavailable');
  });

  it('keeps text editable (with a warning) in outline mode when outlines are missing', async () => {
    const w = await write(doc([text('t', 'Hello')]), { textMode: 'outline' });
    expect(w.shape('t').type).toBe('text');
    expect(w.codes()).toContain('text-outlines-missing');
  });
});
