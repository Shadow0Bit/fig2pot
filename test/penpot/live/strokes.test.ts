/**
 * Live checks of stroke fidelity (F6: S1–S4, S6): one document per target renderer, imported into the local
 * Penpot and exported with that renderer; the assertions are pixel facts.
 *
 * Runs only with PENPOT_LIVE=1 (see render.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { booleanNode, frame, pathNode, rect, solid, square, stroke, translate } from '../helpers.ts';
import { LIVE, renderFor, rgb, type Img, type Rendered } from './render.ts';

const white = solid(1, 1, 1);
const red = solid(1, 0, 0);
const black = solid(0, 0, 0);
const boards: ir.FrameNode[] = [];
let x0 = 0;
function board(id: string, size: ir.Size, children: ir.Node[], options: Partial<ir.FrameNode> = {}): void {
  boards.push(frame(id, children, { transform: translate(x0, 0), size, fills: [white], clipsContent: true, ...options }));
  x0 += size.width + 40;
}

// S1: a non-clipping frame whose child covers its 10 px inside stroke (Figma: the child on top), and a clipping one
// (Figma: the stroke on top).
for (const clip of [false, true]) {
  board(`s1-${clip ? 'clip' : 'free'}`, { width: 100, height: 100 }, [
    frame(`s1-${clip}-f`, [rect(`s1-${clip}-c`, { size: { width: 80, height: 80 }, fills: [red] })], {
      transform: translate(10, 10), size: { width: 80, height: 80 }, clipsContent: clip, stroke: stroke({ weight: 10, align: 'inside', paints: [black] }),
    }),
  ]);
}

// S2: a square with an even-odd hole wound like its outline, 6 px inside stroke: the hole edge gets 6 px on the
// filled side only.
board('s2', { width: 140, height: 140 }, [
  pathNode('s2-p', [{ windingRule: 'evenodd', commands: [...square(0, 0, 100, 100).commands, ...square(30, 30, 40, 40).commands] }], {
    transform: translate(20, 20), size: { width: 100, height: 100 }, fills: [solid(0.5, 0.5, 1)], stroke: stroke({ weight: 6, align: 'inside', paints: [black] }),
  }),
]);

// S3: a per-side stroke (outside, bottom only, 8 px) on a rect.
board('s3', { width: 120, height: 120 }, [
  rect('s3-r', { transform: translate(20, 20), size: { width: 80, height: 60 }, fills: [red], stroke: stroke({ weight: 8, align: 'outside', perSide: { top: 0, right: 0, bottom: 8, left: 0 }, paints: [black] }) }),
]);

// S4: a 200 px inside dashed side, [10, 10], 4 px: Figma starts each side with half a dash (5 px), so the top side
// shows ink on x ∈ [0, 5) + 15 … and a gap at [5, 15).
board('s4-rect', { width: 240, height: 240 }, [
  rect('s4-r', { transform: translate(20, 20), size: { width: 200, height: 200 }, stroke: stroke({ weight: 4, align: 'inside', dashPattern: [10, 10], paints: [black] }) }),
]);
board('s4-frame', { width: 240, height: 240 }, [
  frame('s4-f', [], { transform: translate(20, 20), size: { width: 200, height: 200 }, clipsContent: false, stroke: stroke({ weight: 4, align: 'outside', dashPattern: [10, 10], paints: [black] }) }),
]);

// S6: an inexact path operand with an inside stroke in an editable boolean: the union is the two squares, not a blob.
const operand = pathNode('s6-op', [square(0, 0, 40, 40)], {
  transform: translate(20, 20), size: { width: 40, height: 40 }, pathsAreExact: false, fills: [black], stroke: stroke({ weight: 4, align: 'inside' }),
  geometry: { fill: [square(0, 0, 40, 40)], stroke: [{ windingRule: 'evenodd', commands: [...square(-4, -4, 48, 48).commands, ...square(4, 4, 32, 32).commands] }] },
});
board('s6', { width: 160, height: 80 }, [booleanNode('s6-b', 'union', [operand, rect('s6-r', { transform: translate(100, 20), size: { width: 40, height: 40 }, fills: [black] })], { fills: [black] })]);

const document: ir.Document = { name: 'live-strokes', pages: [{ id: 'strokes:page', name: 'p', kind: 'page', children: boards }], components: {}, images: {}, styles: { colors: [], typographies: [] } };

const dark = (img: Img, x: number, y: number): boolean => rgb(img, x, y)[0] < 80 && rgb(img, x, y)[1] < 80;
const isRed = (img: Img, x: number, y: number): boolean => {
  const [r, g] = rgb(img, x, y);
  return r > 200 && g < 60;
};

describe.skipIf(!LIVE)('stroke fidelity in live Penpot', () => {
  const rendered: Partial<Record<'svg' | 'wasm', Rendered>> = {};
  beforeAll(async () => {
    for (const renderer of ['svg', 'wasm'] as const) {
      // Editable booleans: S6 is about operands that stay operands (the other boards have no boolean).
      rendered[renderer] = await renderFor(renderer, 'strokes', document, boards.map((b) => b.id), { booleanMode: 'editable' });
    }
  }, 180_000);

  for (const renderer of ['svg', 'wasm'] as const) {
    describe(`target ${renderer}`, () => {
      const img = (id: string): Img => rendered[renderer]!.boards.get(id)!;

      it('S1: a non-clipping frame’s child covers its stroke; a clipping frame’s stroke covers the child', () => {
        // Inside the 10 px band (board px 10..20), away from the corners.
        expect(isRed(img('s1-free'), 15, 50)).toBe(true);
        expect(dark(img('s1-clip'), 15, 50)).toBe(true);
        expect(isRed(img('s1-clip'), 50, 50)).toBe(true);
      });

      it('S2: an even-odd hole gets the inside stroke on the filled side only', () => {
        // Hole edge at x = 50 (20 + 30): stroke on 44..50, the hole (white) from 50.
        const i = img('s2');
        expect(dark(i, 46.5, 70)).toBe(true);
        expect(dark(i, 53.5, 70)).toBe(false);
        expect(rgb(i, 53.5, 70)[0]).toBeGreaterThan(240);
      });

      it('S3: a bottom-only outside stroke lies below the box, nothing above it', () => {
        const i = img('s3');
        expect(dark(i, 60, 84)).toBe(true);
        expect(dark(i, 60, 17)).toBe(false);
        expect(isRed(i, 60, 22)).toBe(true);
      });

      it('S4: dashed rect and frame sides start with half a dash (Figma), not a full one', () => {
        const r = img('s4-rect');
        // Inside band y ∈ [20, 24): ink at x = 20..25, gap 25..35, ink 35..45.
        expect(dark(r, 22.5, 22)).toBe(true);
        expect(dark(r, 30, 22)).toBe(false);
        expect(dark(r, 40, 22)).toBe(true);
        // Outside band of the frame y ∈ [16, 20): the corner dash runs to x = 25 then a gap to 35.
        const f = img('s4-frame');
        expect(dark(f, 22.5, 18)).toBe(true);
        expect(dark(f, 30, 18)).toBe(false);
        expect(dark(f, 40, 18)).toBe(true);
      });

      it('S6: an inexact operand of an editable boolean keeps its shape', () => {
        const i = img('s6');
        expect(dark(i, 40, 40)).toBe(true);
        expect(dark(i, 120, 40)).toBe(true);
        // Between the squares: white (a mask silhouette in the union would fill the bounding box).
        expect(dark(i, 80, 40)).toBe(false);
      });
    });
  }
});
