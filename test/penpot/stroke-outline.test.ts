/**
 * Stroke outlines drawn from the source's geometry (inexact vector paths, flattened booleans): Figma's
 * outline of an inside / outside stroke is the full 2w band, which it clips to / cuts from the fill shape.
 */
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { booleanNode, doc, pathNode, rect, solid, square, stroke, write } from './helpers.ts';

/** A 10×10 square path whose vector network Figma cannot reproduce, with its geometry. */
function inexactSquare(id: string, align: ir.Stroke['align'], extra: Partial<ir.PathNode> = {}, paths: ir.Path[] = [square(0, 0, 10, 10)]): ir.PathNode {
  return pathNode(id, paths, {
    size: { width: 10, height: 10 },
    pathsAreExact: false,
    stroke: stroke({ align, weight: 2 }),
    geometry: {
      fill: [square(0, 0, 10, 10)],
      // The 2w band around the outline (outer square, inner square reversed).
      stroke: [{ windingRule: 'evenodd', commands: [...square(-2, -2, 14, 14).commands, ...square(2, 2, 6, 6).commands] }],
    },
    ...extra,
  });
}

describe('stroke outlines of inexact paths', () => {
  it('clips an inside stroke outline to the fill shape with a mask group', async () => {
    const w = await write(doc([inexactSquare('p', 'inside')]));
    const group = w.shape('p');
    expect(group).toMatchObject({ type: 'group', maskedGroup: true });
    const [mask, band] = w.children(group);
    expect(mask).toMatchObject({ type: 'path', fills: [{ fillColor: '#000000', fillOpacity: 1 }] });
    expect(mask!.selrect).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(band).toMatchObject({ type: 'path', fills: [{ fillColor: '#000000' }], strokes: [] });
    expect(band!.selrect).toMatchObject({ x: -2, y: -2, width: 14, height: 14 });
  });

  it('cuts the fill shape out of an outside stroke outline (even-odd mask around it)', async () => {
    const w = await write(doc([inexactSquare('p', 'outside')]));
    const [mask] = w.children(w.shape('p'));
    expect(mask!.svgAttrs).toMatchObject({ fillRule: 'evenodd' });
    // A box around the band, with the fill shape as a hole.
    expect(mask!.selrect).toMatchObject({ x: -3, y: -3, width: 16, height: 16 });
    expect(JSON.stringify(mask!.content).match(/move-to/g)).toHaveLength(2);
  });

  it('draws a centred stroke outline (and open paths, which Figma strokes centred) as is', async () => {
    const centred = await write(doc([inexactSquare('p', 'center')]));
    expect(centred.shape('p')).toMatchObject({ type: 'path', fills: [{ fillColor: '#000000' }] });
    const open: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 10 }] };
    const w = await write(doc([inexactSquare('o', 'inside', {}, [open])]));
    expect(w.shape('o').type).toBe('path');
  });

  it('keeps the fill under the clipped stroke', async () => {
    const w = await write(doc([inexactSquare('p', 'outside', { fills: [solid(1, 0, 0)] })]));
    const group = w.shape('p');
    expect(group.maskedGroup).toBeFalsy();
    const [fill, clip] = w.children(group);
    expect(fill).toMatchObject({ type: 'path', fills: [{ fillColor: '#ff0000' }] });
    expect(clip).toMatchObject({ type: 'group', maskedGroup: true });
  });

  it('falls back to the editable paths when there is no fill outline to clip to', async () => {
    const node = inexactSquare('p', 'inside');
    node.geometry = { stroke: node.geometry!.stroke! };
    const w = await write(doc([node]));
    expect(w.shape('p')).toMatchObject({ type: 'path', fills: [], strokes: [{ strokeAlignment: 'inner', strokeWidth: 2 }] });
    expect(w.codes()).toContain('path-approximated');
  });
});

describe('stroke-only booleans', () => {
  const operands = (): ir.Node[] => [
    rect('a', { size: { width: 10, height: 10 }, fills: [solid(0, 0, 0)] }),
    pathNode('b', [square(5, 5, 10, 10)], { size: { width: 15, height: 15 }, fills: [solid(0.5, 0.5, 0.5)] }),
  ];
  const band: ir.Path = { windingRule: 'nonzero', commands: square(-1, -1, 17, 17).commands };

  it('flattens a boolean without fills from its (centred) stroke outline', async () => {
    const node = booleanNode('u', 'union', operands(), { size: { width: 15, height: 15 }, stroke: stroke({ align: 'center', weight: 2 }), geometry: { stroke: [band] } });
    const w = await write(doc([node]));
    expect(w.shape('u')).toMatchObject({ type: 'path', fills: [{ fillColor: '#000000' }], strokes: [] });
    expect(w.codes()).not.toContain('boolean-geometry-missing');
  });

  it('keeps an editable stroke-only boolean unfilled (Penpot fills a path head without fills black)', async () => {
    const node = booleanNode('u', 'union', operands(), { size: { width: 15, height: 15 }, stroke: stroke({ align: 'inside', weight: 2 }), geometry: { stroke: [band] } });
    const w = await write(doc([node]));
    const bool = w.shape('u');
    expect(bool.type).toBe('bool');
    expect(bool.fills).toEqual([]);
    expect(bool.strokes).toMatchObject([{ strokeAlignment: 'inner' }]);
  });
});

describe('marker caps (arrowheads)', () => {
  const line: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 56, y: 0 }] };
  // Figma's outline: the line band plus a chevron (simplified).
  const outline: ir.Path = { windingRule: 'nonzero', commands: [...square(0, -1.5, 56, 3).commands, ...square(45, -10, 12, 20).commands] };
  const arrow = (id: string, startCap: ir.StrokeCap, endCap: ir.StrokeCap, extra: Partial<ir.PathNode> = {}): ir.PathNode =>
    pathNode(id, [line], { size: { width: 56, height: 0 }, stroke: stroke({ align: 'center', weight: 3, startCap, endCap }), geometry: { stroke: [outline] }, ...extra });

  it("draws an open path with an arrow / marker cap from Figma's stroke outline", async () => {
    for (const cap of ['line-arrow', 'triangle-arrow', 'diamond', 'circle'] as const) {
      const w = await write(doc([arrow('a', 'round', cap)]));
      expect(w.shape('a')).toMatchObject({ type: 'path', fills: [{ fillColor: '#000000' }], strokes: [] });
      expect(w.codes()).toContain('stroke-cap-outlined');
    }
  });

  it('keeps round, square and butt caps editable, and an arrow without an outline', async () => {
    const w = await write(doc([arrow('r', 'round', 'square'), arrow('n', 'line-arrow', 'none', { geometry: {} })]));
    expect(w.shape('r')).toMatchObject({ type: 'path', fills: [], strokes: [{ strokeWidth: 3, strokeCapStart: 'round', strokeCapEnd: 'square' }] });
    expect(w.shape('n').strokes[0]).toMatchObject({ strokeCapStart: 'line-arrow' });
    expect(w.codes()).not.toContain('stroke-cap-outlined');
  });
});
