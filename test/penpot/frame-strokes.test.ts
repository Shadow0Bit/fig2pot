/**
 * Stroke fidelity (F6): frame stroke order (S1), even-odd holes under aligned strokes (S2), Figma's dash
 * layout (S4), boolean operands (S6) and copies following their main's structure (S7).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { dashCount, dashPaths, MAX_DASHES, rectSegments, segmentDashes } from '../../src/penpot/dashes.ts';
import { windAlternately, type AbsCommand } from '../../src/penpot/paths.ts';
import { figToIR } from '../../src/index.ts';
import { CollectingReporter } from '../../src/util/reporter.ts';
import { booleanNode, componentProblems, doc, ellipse, frame, group, pathNode, rect, segments, solid, square, stroke, translate, write, type Json } from './helpers.ts';

const def = (id: string, name: string): ir.ComponentDef => ({ id, name, remote: false });
const red = solid(1, 0, 0);

describe('Figma dash layout (S4)', () => {
  it('stretches the pattern per segment, half a dash at each end (REST strokeGeometry of 2411:13262, 2411:10586)', () => {
    // 72 px side, [10, 5]: 5 periods of 14.4.
    expect(segmentDashes(72, [10, 5])).toEqual([
      [0, 4.8],
      [9.6, 19.2],
      [24, 33.6],
      [38.4, 48],
      [52.8, 62.4],
      [67.2, 72],
    ]);
    // 32 px side, [6, 6]: 2.67 periods round to 3.
    expect(segmentDashes(32, [6, 6])!.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([
      [0, 2.667],
      [8, 13.333],
      [18.667, 24],
      [29.333, 32],
    ]);
    // Halves round up (2411:12640, a 246 px side with period 12 → 21 periods: 22 dashes).
    expect(segmentDashes(246, [6, 6])).toHaveLength(22);
  });

  it('draws a corner arc shorter than one dash solid, else half-gap-half (2411:13262 vs 2411:12640)', () => {
    expect(segmentDashes((Math.PI / 2) * 5, [10, 5])).toEqual([[0, (Math.PI / 2) * 5]]);
    const arc = (Math.PI / 2) * 4;
    expect(segmentDashes(arc, [6, 6])).toEqual([
      [0, arc / 4],
      [(3 * arc) / 4, arc],
    ]);
  });

  it('joins the dashes meeting at a corner into one sub-path on the stroke centre line', () => {
    // 80×80, radius 24, [6, 6]: per quarter 2 + 2 inner dashes and 2 straddling ones (24 in all).
    const commands = dashPaths(rectSegments(80, 80, [24, 24, 24, 24], -1), [6, 6], true)!;
    expect(commands.filter((c) => c.type === 'M')).toHaveLength(24);
    expect(commands.some((c) => c.type === 'Z')).toBe(false);
    // Inside stroke of width 2: the top side's dashes run along y = 1.
    const top = commands.filter((c): c is Extract<ir.PathCommand, { type: 'L' }> => c.type === 'L' && c.x > 25 && c.x < 55 && c.y < 40);
    expect(top.every((c) => Math.abs(c.y - 1) < 1e-9)).toBe(true);
    // A sharp corner: the straddling dash passes through the inset corner.
    const sharp = dashPaths(rectSegments(100, 100, undefined, -2), [10, 10], true)!;
    expect(sharp.some((c) => c.type === 'L' && Math.abs(c.x - 2) < 1e-9 && Math.abs(c.y - 2) < 1e-9)).toBe(true);
  });

  it('draws a dashed rect as its shape plus a solid-stroked dash path; the dash path carries the stroke', async () => {
    const w = await write(doc([rect('r', { size: { width: 80, height: 80 }, cornerRadii: [24, 24, 24, 24], fills: [red], stroke: stroke({ weight: 2, dashPattern: [6, 6] }) })]));
    const group = w.shape('r');
    expect(group.type).toBe('group');
    const [shape, dashes] = w.children(group);
    expect(shape).toMatchObject({ type: 'rect', fills: [{ fillColor: '#ff0000' }], strokes: [] });
    expect(dashes).toMatchObject({ type: 'path', fills: [], strokes: [{ strokeWidth: 2, strokeStyle: 'solid', strokeAlignment: 'center' }] });
    expect(segments(dashes!).filter((s) => s[0] === 'M')).toHaveLength(24);
  });

  it('dashes an ellipse per quarter and an open path per edge', async () => {
    const w = await write(
      doc([
        ellipse('e', { stroke: stroke({ weight: 2, align: 'center', dashPattern: [5, 5] }) }),
        pathNode('l', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 32, y: 0 }] }], { size: { width: 32, height: 0 }, stroke: stroke({ align: 'center', dashPattern: [2, 2] }) }),
      ]),
    );
    expect(w.children(w.shape('e')).map((c) => c.type)).toEqual(['circle', 'path']);
    // 32 px, [2, 2]: half dash, 7 dashes, half dash (REST 2411:10640: dashes at 0–1, 3–5, …).
    const line = w.shape('l');
    expect(line.type).toBe('path');
    const moves = segments(line).filter((s) => s[0] === 'M');
    expect(moves.map((m) => m[1])).toEqual([0, 3, 7, 11, 15, 19, 23, 27, 31]);
  });

  it("keeps Penpot's dashes where Figma's cannot be drawn: round caps, and a clipping board's outside stroke", async () => {
    const w = await write(
      doc([
        rect('caps', { stroke: stroke({ dashPattern: [4, 4], startCap: 'round', endCap: 'round' }) }),
        frame('clip', [rect('over', { transform: translate(60, 60) })], { clipsContent: true, stroke: stroke({ weight: 13, align: 'outside', dashPattern: [10, 5] }) }),
      ]),
    );
    expect(w.shape('caps')).toMatchObject({ type: 'rect', strokes: [{ strokeStyle: 'dashed' }] });
    expect(w.shape('clip').strokes[0]).toMatchObject({ strokeStyle: 'dashed', strokeAlignment: 'outer' });
    expect(w.warnings.find((x) => x.code === 'stroke-dash-approximated')?.nodeId).toBe('clip');
  });

  it("keeps Penpot's dashes beyond MAX_DASHES dashes per shape (a [0.01, 0.01] pattern on a 2000 px box), quickly", async () => {
    // [1, 1] on a 2000 px box: 4000 dashes (Penpot draws it; [0.01, 0.01] is below what Penpot draws, so solid).
    const tiny = stroke({ weight: 1, align: 'center', dashPattern: [1, 1] });
    const started = performance.now();
    const w = await write(
      doc([
        rect('r0', { transform: translate(0, 6000), size: { width: 2000, height: 2000 }, stroke: stroke({ weight: 1, align: 'center', dashPattern: [0.01, 0.01] }) }),
        rect('r', { size: { width: 2000, height: 2000 }, stroke: tiny }),
        ellipse('e', { size: { width: 2000, height: 2000 }, stroke: tiny }),
        frame('f', [rect('in', { size: { width: 10, height: 10 } })], { transform: translate(0, 2100), size: { width: 2000, height: 2000 }, stroke: tiny }),
        // 5000 px at period 2: 2501 dashes.
        pathNode('p', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 5000, y: 0 }] }], { transform: translate(0, 4200), size: { width: 5000, height: 0 }, stroke: tiny }),
        // Under the cap: Figma's layout as before (2000 px at period 2: 1001 dashes).
        pathNode('q', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 2000, y: 0 }] }], { transform: translate(0, 4300), size: { width: 2000, height: 0 }, stroke: tiny }),
      ]),
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(w.shape('r')).toMatchObject({ type: 'rect', strokes: [{ strokeStyle: 'dashed' }] });
    expect(w.shape('e')).toMatchObject({ type: 'circle', strokes: [{ strokeStyle: 'dashed' }] });
    expect(w.shape('f').strokes[0]).toMatchObject({ strokeStyle: 'dashed' });
    expect(w.shape('p')).toMatchObject({ type: 'path', strokes: [{ strokeStyle: 'dashed' }] });
    expect(segments(w.shape('p')).filter((x) => x[0] === 'M')).toHaveLength(1);
    expect(segments(w.shape('q')).filter((x) => x[0] === 'M')).toHaveLength(1001);
    expect(w.shape('r0')).toMatchObject({ type: 'rect' });
    expect(w.warnings.filter((x) => x.code === 'stroke-dash-approximated').map((x) => x.nodeId).sort()).toEqual(['e', 'f', 'p', 'r', 'r0']);
    expect(dashCount(rectSegments(2000, 2000, undefined, 0), [0.01, 0.01])).toBeGreaterThan(MAX_DASHES);
  });

  it('keeps the {shape, stroke path} structure of a rect linked to a dashed one when its own dashes are too many', async () => {
    const w = await write(
      doc(
        [
          frame('main', [rect('mr', { stroke: stroke({ dashPattern: [4, 4] }) })], { componentId: 'C', role: 'component', size: { width: 100, height: 100 } }),
          frame('copy', [rect('cr', { componentRef: 'mr', size: { width: 2000, height: 2000 }, stroke: stroke({ dashPattern: [1, 1] }) })], { instanceOf: 'C', role: 'instance', transform: translate(200, 0), size: { width: 100, height: 100 } }),
        ],
        { components: { C: def('C', 'C') } },
      ),
    );
    const copy = w.shape('cr');
    expect(copy.type).toBe('group');
    expect(w.children(copy).map((c) => c.type)).toEqual(['rect', 'path']);
    expect(w.children(copy)[1]).toMatchObject({ strokes: [{ strokeStyle: 'dashed', strokeAlignment: 'center' }] });
    expect(segments(w.children(copy)[1]!).filter((x) => x[0] === 'M')).toHaveLength(1);
    expect(componentProblems(w)).toEqual([]);
  });

  it('draws the dashes of a clipping board that must keep its clip by a shape directly above it', async () => {
    const dashed = stroke({ weight: 13, align: 'outside', dashPattern: [10, 5] });
    const w = await write(
      doc([
        frame(
          'parent',
          [
            frame('clip', [rect('over', { transform: translate(60, 60) })], { transform: translate(10, 10), clipsContent: true, stroke: dashed }),
            frame('set', [rect('in', { size: { width: 10, height: 10 } })], { transform: translate(200, 10), clipsContent: true, role: 'component-set', stroke: dashed }),
          ],
          { size: { width: 400, height: 200 }, layout: { direction: 'horizontal', wrap: false, itemSpacing: 0, counterSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'start', counterAlign: 'start', counterAlignContent: 'auto', reverseZIndex: false, strokesIncludedInLayout: false } },
        ),
      ]),
    );
    const kids = w.children(w.shape('parent'));
    expect(kids.map((k) => k.id)).toEqual([w.shape('clip').id, w.shape('clip', 'stroke-dashes').id, w.shape('set').id]);
    expect(w.shape('clip')).toMatchObject({ showContent: false, strokes: [] });
    expect(w.shape('clip', 'stroke-dashes')).toMatchObject({ layoutItemAbsolute: true, strokes: [{ strokeStyle: 'solid', strokeAlignment: 'center', strokeWidth: 13 }] });
    expect(w.warnings.filter((x) => x.code === 'frame-stroke-separated').map((x) => x.nodeId)).toEqual(['clip']);
    // A component set never gets a synthesized child (Penpot's variant container holds variant mains only): it
    // keeps its clip and Penpot's own dashes, even though nothing overflows it.
    expect(w.shape('set')).toMatchObject({ showContent: false, strokes: [{ strokeStyle: 'dashed', strokeAlignment: 'outer', strokeWidth: 13 }] });
    expect(w.children(w.shape('set')).map((k) => k.id)).toEqual([w.shape('in').id]);
    expect(w.warnings.filter((x) => x.code === 'stroke-dash-approximated').map((x) => x.nodeId)).toEqual(['set']);
  });

  it('adds no synthesized child to a component set, nor a sibling to a variant main in it', async () => {
    const dashed = stroke({ weight: 2, align: 'inside', dashPattern: [10, 5] });
    const sides = stroke({ weight: 1, align: 'inside', perSide: { top: 0, right: 0, bottom: 2, left: 0 } });
    const variant = (id: string, value: string, extra: Partial<ir.FrameNode> = {}): ir.FrameNode =>
      frame(id, [rect(`${id}c`, { transform: translate(0, 0), size: { width: 40, height: 40 }, fills: [red] })], { componentId: `C${id}`, role: 'component', name: `State=${value}`, size: { width: 30, height: 30 }, ...extra });
    // v1: a clipping variant whose child overflows, with outside dashes (elsewhere: a sibling above it).
    const v1 = variant('v1', 'a', { clipsContent: true, stroke: stroke({ weight: 4, align: 'outside', dashPattern: [6, 3] }) });
    const v2 = variant('v2', 'b', { transform: translate(50, 0) });
    const set = (id: string, s: ir.Stroke, extra: Partial<ir.FrameNode> = {}): ir.FrameNode =>
      frame(id, [v1, v2], { role: 'component-set', name: 'Button', size: { width: 100, height: 50 }, clipsContent: false, stroke: s, ...extra });
    const components = {
      Cv1: { id: 'Cv1', name: 'State=a', remote: false, set: { id: 'S', name: 'Button' }, variantProperties: { State: 'a' } },
      Cv2: { id: 'Cv2', name: 'State=b', remote: false, set: { id: 'S', name: 'Button' }, variantProperties: { State: 'b' } },
    } as ir.Document['components'];
    for (const [s, code] of [
      [dashed, 'stroke-dash-approximated'],
      [sides, 'per-side-stroke-approximated'],
      [stroke({ weight: 2, align: 'inside' }), 'frame-stroke-order-approximated'],
    ] as const) {
      const w = await write(doc([set('set', s)], { components }), { pixelExact: true });
      const container = w.shape('set');
      expect(container.isVariantContainer).toBe(true);
      expect(w.children(container).map((k) => k.id)).toEqual([w.shape('v1').id, w.shape('v2').id]);
      expect(container.strokes).toHaveLength(1);
      for (const id of ['v1', 'v2']) expect(w.shape(id).variantId).toBe(container.id);
      // v1 keeps its clip and Penpot's dashes instead of a sibling inside the set.
      expect(w.shape('v1')).toMatchObject({ showContent: false, strokes: [{ strokeStyle: 'dashed' }] });
      expect(w.codes()).toContain(code);
      expect(w.codes()).not.toContain('variants-as-components');
      expect(componentProblems(w)).toEqual([]);
    }
  });

  it("draws a clipping board's outside dashes Figma's way when nothing overflows it: the board is written without its clip", async () => {
    const w = await write(
      doc([
        frame('page', [frame('clip', [rect('in', { transform: translate(10, 10), size: { width: 20, height: 20 } })], { transform: translate(20, 20), clipsContent: true, stroke: stroke({ weight: 13, align: 'outside', dashPattern: [10, 5] }) })], {
          size: { width: 200, height: 200 },
        }),
      ]),
    );
    const board = w.shape('clip');
    expect(board).toMatchObject({ showContent: true, strokes: [] });
    // Figma paints a clipping frame's stroke above its content: the stroke shape is the last child.
    const kids = w.children(board);
    expect(kids[0]!.id).toBe(w.shape('in').id);
    expect(kids[1]).toMatchObject({ name: 'Stroke', strokes: [{ strokeStyle: 'solid', strokeAlignment: 'center' }] });
    expect(w.codes()).toContain('frame-clip-disabled-for-stroke');
    expect(w.codes()).not.toContain('stroke-dash-approximated');
  });
});

describe('frame stroke order (S1)', () => {
  const covering = (id: string): ir.RectNode => rect(id, { size: { width: 80, height: 80 }, fills: [red] });

  it('draws the stroke of a non-clipping frame below a child that covers it', async () => {
    const w = await write(doc([frame('f', [covering('c')], { size: { width: 80, height: 80 }, clipsContent: false, cornerRadii: [8, 8, 8, 8], stroke: stroke({ weight: 4 }) })]));
    const f = w.shape('f');
    expect(f.strokes).toEqual([]);
    const [first, child] = w.children(f);
    expect(first).toMatchObject({ type: 'rect', name: 'Stroke', fills: [], strokes: [{ strokeWidth: 4, strokeAlignment: 'inner' }], r1: 8, constraintsH: 'leftright', constraintsV: 'topbottom' });
    expect(first!.selrect).toMatchObject({ x: 0, y: 0, width: 80, height: 80 });
    expect(child!.id).toBe(w.shape('c').id);
  });

  it('keeps the board stroke when the frame clips, or when no child reaches the stroke', async () => {
    const w = await write(
      doc([
        frame('clip', [covering('c1')], { size: { width: 80, height: 80 }, clipsContent: true, stroke: stroke({ weight: 4 }) }),
        frame('free', [rect('c2', { transform: translate(10, 10), size: { width: 60, height: 60 } })], { size: { width: 80, height: 80 }, clipsContent: false, stroke: stroke({ weight: 4 }) }),
      ]),
    );
    expect(w.shape('clip').strokes).toHaveLength(1);
    expect(w.shape('free').strokes).toHaveLength(1);
    expect(w.has('clip', 'stroke') || w.has('free', 'stroke')).toBe(false);
  });

  it('takes the stroke shape out of the flex flow', async () => {
    const layout: ir.AutoLayout = {
      direction: 'horizontal', wrap: false, itemSpacing: 0, counterSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 },
      primaryAlign: 'start', counterAlign: 'start', counterAlignContent: 'auto', reverseZIndex: false, strokesIncludedInLayout: false,
    };
    const w = await write(doc([frame('f', [covering('c')], { size: { width: 80, height: 80 }, clipsContent: false, layout, stroke: stroke({ weight: 4 }) })]));
    expect(w.shape('f', 'stroke')).toMatchObject({ layoutItemAbsolute: true });
  });

  it('draws a dashed frame stroke as a dash path: below the children without clipping, above them with', async () => {
    const dashed = stroke({ weight: 2, dashPattern: [6, 6] });
    const w = await write(
      doc([
        frame('a', [covering('ca')], { size: { width: 80, height: 80 }, clipsContent: false, stroke: dashed }),
        frame('b', [covering('cb')], { size: { width: 80, height: 80 }, clipsContent: true, stroke: dashed }),
      ]),
    );
    expect(w.children(w.shape('a'))[0]!.id).toBe(w.shape('a', 'stroke-dashes').id);
    const kids = w.children(w.shape('b'));
    expect(kids[kids.length - 1]!.id).toBe(w.shape('b', 'stroke-dashes').id);
    expect(w.shape('a').strokes).toEqual([]);
    expect(w.shape('b').strokes).toEqual([]);
  });

  it('keeps mains and copies parallel: a copy refers to its main stroke shape, also when only one of them needs it', async () => {
    const main = frame('10:1', [covering('10:2')], { componentId: 'C1', role: 'component', name: 'Tile', size: { width: 80, height: 80 }, clipsContent: false, stroke: stroke({ weight: 4 }) });
    // The copy hides the covering child: alone it would keep its board stroke.
    const copy = frame('I1', [{ ...covering('I1;10:2'), componentRef: '10:2', name: '10:2', visible: false }], {
      instanceOf: 'C1', role: 'instance', name: 'Tile copy', size: { width: 80, height: 80 }, clipsContent: false, stroke: stroke({ weight: 4 }), transform: translate(200, 0),
    });
    const w = await write(doc([main, copy], { components: { C1: def('C1', 'Tile') } }));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('I1', 'stroke').shapeRef).toBe(w.shape('10:1', 'stroke').id);
    // Named independently of the head (copies rename heads): no spurious name touch.
    expect(w.shape('I1', 'stroke').touched ?? []).not.toContain('name-group');
  });
});

describe('dashed copies of solid mains (S4, components)', () => {
  it('gives a solid main the same {shape, stroke path} structure as its dashed copy', async () => {
    const main = frame('10:1', [rect('10:2', { stroke: stroke({ weight: 3 }) })], { componentId: 'C1', role: 'component', name: 'Outline' });
    const copy = frame('I1', [rect('I1;10:2', { componentRef: '10:2', name: '10:2', stroke: stroke({ weight: 3, dashPattern: [6, 6] }) })], {
      instanceOf: 'C1', role: 'instance', name: 'Outline', transform: translate(200, 0),
    });
    const w = await write(doc([main, copy], { components: { C1: def('C1', 'Outline') } }));
    expect(componentProblems(w)).toEqual([]);
    // The main draws its solid inside stroke as a closed centre line (1.5 px in), stroked solid and centred.
    const solidPath = w.shape('10:2', 'stroke-dashes');
    expect(solidPath).toMatchObject({ type: 'path', strokes: [{ strokeWidth: 3, strokeStyle: 'solid', strokeAlignment: 'center' }] });
    expect(solidPath.selrect).toMatchObject({ x: 1.5, y: 1.5, width: 97, height: 97 });
    expect(w.shape('I1;10:2', 'stroke-dashes').shapeRef).toBe(solidPath.id);
    expect(w.shape('I1;10:2', 'shape').shapeRef).toBe(w.shape('10:2', 'shape').id);
  });
});

describe('even-odd holes under aligned strokes (S2)', () => {
  const ring = (): ir.Path => ({ windingRule: 'evenodd', commands: [...square(0, 0, 100, 100).commands, ...square(30, 30, 40, 40).commands] });

  it('winds a hole against its outline (Penpot SVG clips inner strokes under the nonzero rule)', async () => {
    const w = await write(doc([pathNode('p', [ring()], { fills: [red], stroke: stroke({ weight: 3, align: 'inside' }) })]));
    const p = w.shape('p');
    expect(p.svgAttrs).toMatchObject({ fillRule: 'evenodd' });
    const s = segments(p);
    const area = (pts: (string | number)[][]): number => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const [, x1, y1] = pts[i]! as [string, number, number];
        const [, x2, y2] = pts[(i + 1) % pts.length]! as [string, number, number];
        a += x1 * y2 - x2 * y1;
      }
      return a;
    };
    const outer = s.slice(0, 4);
    const hole = s.slice(5, 9);
    expect(Math.sign(area(outer))).toBe(-Math.sign(area(hole)));
  });

  it('leaves centred strokes and single outlines alone', () => {
    const one: AbsCommand[] = [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 0 }, { type: 'L', x: 1, y: 1 }, { type: 'Z' }];
    expect(windAlternately(one)).toEqual(one);
    const nested: AbsCommand[] = [...one.map((c) => (c.type === 'Z' ? c : { ...c, x: c.x * 10, y: c.y * 10 })), ...one.map((c) => (c.type === 'Z' ? c : { ...c, x: c.x + 6, y: c.y + 2 }))];
    const out = windAlternately(nested);
    // The inner triangle is reversed from the same start point.
    expect(out.slice(4)).toEqual([{ type: 'M', x: 6, y: 2 }, { type: 'L', x: 7, y: 3 }, { type: 'L', x: 7, y: 2 }, { type: 'L', x: 6, y: 2 }, { type: 'Z' }]);
  });
});

describe('boolean operands (S6)', () => {
  it('draws an inexact operand of an editable boolean from its fill outline, without a mask group', async () => {
    const operand = pathNode('op', [square(0, 0, 10, 10)], {
      size: { width: 10, height: 10 },
      pathsAreExact: false,
      fills: [red],
      stroke: stroke({ align: 'inside', weight: 2 }),
      geometry: { fill: [square(0, 0, 10, 10)], stroke: [{ windingRule: 'evenodd', commands: [...square(-2, -2, 14, 14).commands, ...square(2, 2, 6, 6).commands] }] },
    });
    const w = await write(doc([booleanNode('b', 'union', [operand, rect('r2', { fills: [red] })])]), { booleanMode: 'editable' });
    expect(w.shape('op').type).toBe('path');
    expect(w.shape('op').maskedGroup).toBeFalsy();
    expect(w.shape('op').selrect).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(w.has('op', 'stroke-1-mask')).toBe(false);
  });

  it('does not group the dashes or per-side strokes of an operand', async () => {
    const w = await write(
      doc([booleanNode('b', 'union', [rect('d', { fills: [red], stroke: stroke({ dashPattern: [4, 4] }) }), rect('s', { fills: [red], stroke: stroke({ perSide: { top: 1, right: 0, bottom: 0, left: 0 } }) })])]),
      { booleanMode: 'editable' },
    );
    expect(w.shape('d').type).toBe('rect');
    expect(w.shape('s').type).toBe('rect');
  });
});

describe('copies follow their main (S7)', () => {
  it("draws a copy from its editable paths when only the copy's outline is inexact", async () => {
    const tri: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'L', x: 0, y: 10 }, { type: 'Z' }] };
    const geometry = { fill: [tri], stroke: [square(-2, -2, 14, 14)] };
    const main = frame('10:1', [pathNode('10:2', [tri], { size: { width: 10, height: 10 }, fills: [red], stroke: stroke({ align: 'outside' }), geometry })], { componentId: 'C1', role: 'component', name: 'Icon' });
    const copy = frame('I1', [pathNode('I1;10:2', [tri], { componentRef: '10:2', name: '10:2', size: { width: 10, height: 10 }, fills: [red], stroke: stroke({ align: 'outside' }), geometry, pathsAreExact: false })], {
      instanceOf: 'C1', role: 'instance', name: 'Icon', transform: translate(100, 0),
    });
    const w = await write(doc([main, copy], { components: { C1: def('C1', 'Icon') } }));
    expect(w.shape('I1;10:2')).toMatchObject({ type: 'path', shapeRef: w.shape('10:2').id });
    expect(w.codes()).toContain('copy-geometry-approximated');
    expect(componentProblems(w)).toEqual([]);
  });

  it("strokes such a copy's own fill outline (e.g. its corner radius override), keeping the main's single path", async () => {
    const tri: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'L', x: 0, y: 10 }, { type: 'Z' }] };
    const rounded: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 1, y: 0 }, { type: 'L', x: 9, y: 0 }, { type: 'Q', x1: 10, y1: 0, x: 9, y: 1 }, { type: 'L', x: 1, y: 9 }, { type: 'Q', x1: 0, y1: 10, x: 0, y: 9 }, { type: 'L', x: 0, y: 1 }, { type: 'Q', x1: 0, y1: 0, x: 1, y: 0 }, { type: 'Z' }] };
    const main = frame('10:1', [pathNode('10:2', [tri], { size: { width: 10, height: 10 }, fills: [red], stroke: stroke({ align: 'outside' }), geometry: { fill: [tri] } })], { componentId: 'C1', role: 'component', name: 'Icon' });
    const copy = frame('I1', [pathNode('I1;10:2', [tri], { componentRef: '10:2', name: '10:2', size: { width: 10, height: 10 }, fills: [red], stroke: stroke({ align: 'outside' }), geometry: { fill: [rounded], stroke: [square(-2, -2, 14, 14)] }, pathsAreExact: false })], {
      instanceOf: 'C1', role: 'instance', name: 'Icon', transform: translate(100, 0),
    });
    const w = await write(doc([main, copy], { components: { C1: def('C1', 'Icon') } }));
    const shape = w.shape('I1;10:2');
    expect(shape).toMatchObject({ type: 'path', shapeRef: w.shape('10:2').id, strokes: [{ strokeAlignment: 'outer' }] });
    expect(shape.content[0]).toMatchObject({ command: 'move-to', params: { x: 101, y: 0 } });
    expect(componentProblems(w)).toEqual([]);
  });
});

describe('component integrity on real files', () => {
  for (const fixture of ['grida-components', 'radix-icons']) {
    it(`${fixture}: every copy shape refers to a shape of its main, synthesized stroke shapes included`, async () => {
      const ir = figToIR(new Uint8Array(readFileSync(new URL(`../fixtures/${fixture}.fig`, import.meta.url))), new CollectingReporter());
      const w = await write(ir);
      expect(componentProblems(w)).toEqual([]);
      // Synthesized shapes inside copies have a ref (Penpot needs one for every copy shape).
      const inCopy = (s: Json): boolean => {
        for (let cur = s; cur.parentId && cur.parentId !== cur.id; cur = w.shapes[cur.parentId]!) {
          const parent = w.shapes[cur.parentId];
          if (!parent) return false;
          if (parent.componentId !== undefined && !parent.mainInstance) return true;
        }
        return false;
      };
      const missing = Object.values(w.shapes).filter((s) => / stroke$|^Stroke$/.test(s.name) && inCopy(s) && !s.shapeRef);
      expect(missing.map((s) => s.name)).toEqual([]);
    }, 120_000);
  }
});

describe('stroke shapes where they would land wrong (review K)', () => {
  const outside = stroke({ weight: 4, align: 'outside', dashPattern: [6, 3] });
  const flex = (extra: Partial<ir.AutoLayout> = {}): ir.AutoLayout => ({
    direction: 'horizontal',
    wrap: false,
    itemSpacing: 0,
    counterSpacing: 0,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    primaryAlign: 'start',
    counterAlign: 'start',
    counterAlignContent: 'auto',
    reverseZIndex: false,
    strokesIncludedInLayout: false,
    ...extra,
  });

  it('K1: a page-level non-clipping board separates only an inside stroke (its export is cropped to its box)', async () => {
    const w = await write(
      doc([
        frame('root', [rect('over', { transform: translate(-2, 10) })], { clipsContent: false, stroke: outside }),
        frame('rootIn', [rect('over2', { transform: translate(-2, 10) })], { transform: translate(200, 0), clipsContent: false, stroke: stroke({ dashPattern: [6, 3] }) }),
        frame('parent', [frame('nested', [rect('over3', { transform: translate(-2, 10) })], { transform: translate(10, 10), clipsContent: false, stroke: outside })], { transform: translate(400, 0), size: { width: 200, height: 200 } }),
      ]),
    );
    // Page level, outside: Penpot's own dashes on the board, painted above the child.
    expect(w.shape('root').strokes[0]).toMatchObject({ strokeStyle: 'dashed', strokeAlignment: 'outer' });
    expect(w.has('root', 'stroke-dashes')).toBe(false);
    expect(w.warnings.filter((x) => x.nodeId === 'root').map((x) => x.code).sort()).toEqual(['frame-stroke-order-approximated', 'stroke-dash-approximated']);
    expect(w.warnings.find((x) => x.nodeId === 'root' && x.code === 'stroke-dash-approximated')?.message).toMatch(/page-level board is exported cropped/);
    // Page level, inside: separated as before.
    expect(w.has('rootIn', 'stroke-dashes')).toBe(true);
    // Below page level: separated as before.
    expect(w.has('nested', 'stroke-dashes')).toBe(true);
  });

  it('K2: never puts a stroke sibling into a mask group or a boolean (it would become masked content / an operand)', async () => {
    const clipping = (id: string, x: number): ir.FrameNode => frame(id, [rect(`${id}-over`, { transform: translate(60, 60) })], { transform: translate(x, 0), clipsContent: true, stroke: outside });
    const w = await write(
      doc([
        frame('host', [
          group('masked', [clipping('mask', 0), rect('content', { size: { width: 200, height: 200 }, fills: [solid(0, 0, 1)] })], { mask: { type: 'alpha' }, size: { width: 200, height: 200 } }),
          booleanNode('bool', 'union', [clipping('operand', 300), rect('op2', { transform: translate(300, 0) })], { size: { width: 100, height: 100 } }),
          clipping('free', 600),
        ], { size: { width: 800, height: 300 } }),
      ]),
      { booleanMode: 'editable' },
    );
    expect(w.children(w.shape('masked')).map((k) => k.id)).toEqual([w.shape('mask').id, w.shape('content').id]);
    expect(w.has('mask', 'stroke-dashes')).toBe(false);
    expect(w.shape('mask').strokes[0]).toMatchObject({ strokeStyle: 'dashed' });
    expect(w.has('operand', 'stroke-dashes')).toBe(false);
    expect(w.has('free', 'stroke-dashes')).toBe(true);
    expect(w.warnings.filter((x) => x.code === 'stroke-dash-approximated').map((x) => x.nodeId).sort()).toEqual(['mask', 'operand']);
  });

  it('K3: in a "first on top" flex board the stroke shape is stacked above (clipping) or below (not clipping) every child', async () => {
    const flow: Partial<ir.RectNode> = { size: { width: 10, height: 10 }, layoutChild: { positioning: 'auto' } };
    const kids = [rect('a', flow), rect('b', { ...flow, transform: translate(10, 0) }), rect('c', { ...flow, transform: translate(20, 0) })];
    const w = await write(
      doc([
        frame('host', [
          frame('clip', kids, { size: { width: 30, height: 10 }, clipsContent: true, layout: flex({ reverseZIndex: true }), stroke: stroke({ dashPattern: [2, 2] }) }),
          frame('open', kids.map((k) => ({ ...k, id: `o-${k.id}` })), { transform: translate(0, 40), size: { width: 30, height: 10 }, clipsContent: false, layout: flex({ reverseZIndex: true }), stroke: stroke({ dashPattern: [2, 2] }) }),
        ], { size: { width: 100, height: 100 } }),
      ]),
    );
    expect(w.children(w.shape('clip')).map((k) => k.layoutItemZIndex)).toEqual([2, 1, 0, 3]);
    expect(w.children(w.shape('open')).map((k) => k.layoutItemZIndex)).toEqual([-1, 2, 1, 0]);
  });

  it("K7: moves a fill-less frame's drop shadow onto the separate stroke shape (Figma shadows the stroke, Penpot the children)", async () => {
    const shadow: ir.Effect = { type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 2, y: 2 }, blur: 0, spread: 0, blendMode: 'normal', showBehindNode: false };
    const inner: ir.Effect = { type: 'inner-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 1, y: 1 }, blur: 0, spread: 0, blendMode: 'normal' };
    const w = await write(
      doc([
        frame('host', [
          frame('tip', [rect('text', { transform: translate(16, 16), fills: [solid(0, 0, 0)] })], { transform: translate(10, 10), size: { width: 200, height: 80 }, clipsContent: false, stroke: stroke({ weight: 3, align: 'outside' }), effects: [shadow, inner] }),
          // Neither fill nor stroke: Figma shadows its children too; nothing to move.
          frame('tooltip', [rect('box', { fills: [solid(0.1, 0.1, 0.1)] })], { transform: translate(10, 120), clipsContent: false, effects: [shadow] }),
          // A fill: the shadow follows it in both.
          frame('card', [rect('t2', { transform: translate(16, 16), size: { width: 20, height: 20 } })], { transform: translate(250, 10), clipsContent: false, fills: [solid(1, 1, 1)], stroke: stroke({ weight: 3, align: 'outside' }), effects: [shadow] }),
        ], { size: { width: 600, height: 300 } }),
      ]),
    );
    const tip = w.shape('tip');
    expect(tip.strokes).toEqual([]);
    expect(tip.shadow.map((s: Json) => s.style)).toEqual(['inner-shadow']);
    const strokeShape = w.shape('tip', 'stroke');
    expect(w.children(tip)[0]!.id).toBe(strokeShape.id);
    // The band, filled (the WASM renderer shadows a stroke-only shape as if it were filled): 3 px outside the box.
    expect(strokeShape).toMatchObject({ type: 'path', strokes: [], fills: [{ fillColor: '#000000' }], shadow: [{ style: 'drop-shadow', offsetX: 2, offsetY: 2 }] });
    const xs = segments(strokeShape).filter((x) => x[0] !== 'Z').map((x) => x[x.length - 2] as number);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([7, 213]);
    expect(w.warnings.filter((x) => x.code === 'frame-shadow-on-stroke').map((x) => x.nodeId)).toEqual(['tip']);
    expect(w.shape('tooltip').shadow).toHaveLength(1);
    expect(w.has('tooltip', 'stroke')).toBe(false);
    expect(w.shape('card').shadow).toHaveLength(1);
    expect(w.has('card', 'stroke')).toBe(false);
  });
});
