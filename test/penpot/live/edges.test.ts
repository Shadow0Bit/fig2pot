/**
 * Live checks of the edge emulations: marker caps drawn from Figma's outline, grey multiply shadows, the
 * dashes of clipping boards (child / sibling shape), and, with `pixelExact`, clips that hide nothing and opaque
 * aligned strokes drawn centred on an offset box (SVG renderer). One document per target renderer and option
 * set, imported into the local Penpot and exported with that renderer; the assertions are pixel facts.
 *
 * Runs only with PENPOT_LIVE=1 (see render.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { frame, pathNode, rect, solid, square, stroke, translate } from '../helpers.ts';
import { penpotId } from '../../../src/penpot/ids.ts';
import { LIVE, renderFor, rgb, type Img, type Rendered } from './render.ts';

const white = solid(1, 1, 1);
const black = solid(0, 0, 0);
const green = solid(0, 1, 0);
const blue = solid(0, 0, 1);
const boards: ir.FrameNode[] = [];
let x0 = 0;
function board(id: string, size: ir.Size, children: ir.Node[], options: Partial<ir.FrameNode> = {}): void {
  boards.push(frame(id, children, { transform: translate(x0, 0), size, fills: [white], clipsContent: true, ...options }));
  x0 += size.width + 40;
}

// E1: a line with a line-arrow end cap; Figma's outline: the 3 px line band and a chevron (two 3 px arms at 45°
// meeting at x = 57). Penpot's own marker is a smaller open chevron of its own.
const arm = (sign: 1 | -1): ir.PathCommand[] => [
  // The arm's centre line runs from the tip (56, 0) to (47.5, ∓8.5); ±1.06 is half the width along the normal.
  { type: 'M', x: 57.06, y: -sign * 1.06 },
  { type: 'L', x: 48.56, y: -sign * 9.56 },
  { type: 'L', x: 46.44, y: -sign * 7.44 },
  { type: 'L', x: 54.94, y: sign * 1.06 },
  { type: 'Z' },
];
board('e1', { width: 100, height: 40 }, [
  pathNode('e1-arrow', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 56, y: 0 }] }], {
    transform: translate(20, 20), size: { width: 56, height: 0 }, stroke: stroke({ weight: 3, align: 'center', startCap: 'none', endCap: 'line-arrow', paints: [black] }),
    geometry: { stroke: [{ windingRule: 'nonzero', commands: [...square(0, -1.5, 56, 3).commands, ...arm(1), ...arm(-1)] }] },
  }),
]);

// E2: a grey (#acacac at 50 %) multiply drop shadow over blue: Figma scales the blue by 1 − 0.5 + 0.5·0.675.
board('e2', { width: 100, height: 60 }, [
  rect('e2-under', { transform: translate(10, 10), size: { width: 80, height: 40 }, fills: [blue] }),
  rect('e2-card', {
    transform: translate(20, 10), size: { width: 40, height: 20 }, fills: [white],
    effects: [{ type: 'drop-shadow', visible: true, color: { r: 0.675, g: 0.675, b: 0.675, a: 0.5 }, offset: { x: 0, y: 10 }, blur: 0, spread: 0, blendMode: 'multiply' }],
  }),
]);

// E3: a 1.25 px line whose band starts exactly on a clipping frame's edge at y = 20.25 (auto-layout-playground
// 2495:1898): Figma covers the rows 75 % / 50 %; a clip edge there would thin the first row.
board('e3', { width: 100, height: 60 }, [
  frame('e3-clip', [rect('e3-line', { size: { width: 60, height: 1.25 }, fills: [black] })], { transform: translate(20, 20.25), size: { width: 60, height: 30 }, clipsContent: true, fills: [] }),
]);

// E4: outside dashes (13 px, [10, 5]) of a nested clipping frame: nothing overflows (written without its clip, a
// stroke child draws the dashes), and one whose child overflows (keeps its clip, a sibling draws them).
const dashed = stroke({ weight: 13, align: 'outside', dashPattern: [10, 5], paints: [black] });
board('e4', { width: 300, height: 120 }, [
  frame('e4-fits', [rect('e4-in', { transform: translate(10, 10), size: { width: 20, height: 20 }, fills: [green] })], { transform: translate(30, 30), size: { width: 90, height: 60 }, clipsContent: true, fills: [], stroke: dashed }),
  frame('e4-over', [rect('e4-big', { transform: translate(40, 40), size: { width: 80, height: 80 }, fills: [green] })], { transform: translate(180, 30), size: { width: 90, height: 60 }, clipsContent: true, fills: [], stroke: dashed }),
]);

// E5: opaque 3 px inside / outside strokes on a filled rect whose edges lie at x, y = …33 (not on pixel boundaries),
// and a board with fill and inside stroke at the same offsets.
const banded = (id: string, x: number, align: ir.Stroke['align']): ir.RectNode =>
  rect(id, { transform: translate(x, 10.33), size: { width: 60, height: 40 }, fills: [green], cornerRadii: [8, 8, 8, 8], stroke: stroke({ weight: 3, align, paints: [black] }) });
board('e5', { width: 280, height: 70 }, [
  banded('e5-in', 10.33, 'inside'),
  banded('e5-out', 100.33, 'outside'),
  frame('e5-board', [], { transform: translate(190.33, 10.33), size: { width: 60, height: 40 }, fills: [green], cornerRadii: [8, 8, 8, 8], clipsContent: true, stroke: stroke({ weight: 3, align: 'inside', paints: [black] }) }),
]);

const document: ir.Document = { name: 'live-edges', pages: [{ id: 'edges:page', name: 'p', kind: 'page', children: boards }], components: {}, images: {}, styles: { colors: [], typographies: [] } };

const grey = (img: Img, x: number, y: number): number => rgb(img, x, y)[0];
/** How far a pixel is from grey (a fill colour mixed into a black stroke edge shows as |g − r|). */
const tint = (img: Img, x: number, y: number): number => {
  const [r, g, b] = rgb(img, x, y);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

describe.skipIf(!LIVE)('edge emulations in live Penpot', () => {
  const rendered: Partial<Record<'svg' | 'wasm' | 'svg-px' | 'wasm-px', Rendered>> = {};
  beforeAll(async () => {
    for (const renderer of ['svg', 'wasm'] as const) {
      rendered[renderer] = await renderFor(renderer, 'edges', document, boards.map((b) => b.id));
      rendered[`${renderer}-px`] = await renderFor(renderer, 'edges-px', document, ['e3', 'e5'], { pixelExact: true });
    }
  }, 300_000);

  for (const renderer of ['svg', 'wasm'] as const) {
    describe(`target ${renderer}`, () => {
      const img = (id: string): Img => rendered[renderer]!.boards.get(id)!;
      const exact = (id: string): Img => rendered[`${renderer}-px`]!.boards.get(id)!;

      it("E1: an arrowhead is Figma's chevron (3 px arms 12 px long), not Penpot's marker", () => {
        const i = img('e1');
        // Pixels (by their top-left corner) on the upper and lower arms half way, near the far end, at the tip.
        expect(grey(i, 72, 16)).toBeLessThan(40);
        expect(grey(i, 72, 23)).toBeLessThan(40);
        expect(grey(i, 68, 12)).toBeLessThan(40);
        expect(grey(i, 75, 20)).toBeLessThan(40);
        // Between an arm and the line: white.
        expect(grey(i, 70, 17)).toBeGreaterThan(200);
      });

      it('E2: a grey multiply shadow darkens blue by 1 − a + a·g (≈ 0.84), as Figma', () => {
        // Under the shadow (y 30..40) but not the card: blue × 0.8375 = 214.
        const [, , b] = rgb(img('e2'), 40, 35);
        expect(Math.abs(b - 214)).toBeLessThanOrEqual(4);
      });

      it('E3 (pixelExact): a line on a clipping edge that clips nothing keeps its full coverage (rows 75 % / 50 %)', () => {
        const i = exact('e3');
        expect(Math.abs(grey(i, 50, 20) - 64)).toBeLessThanOrEqual(12);
        expect(Math.abs(grey(i, 50, 21) - 128)).toBeLessThanOrEqual(12);
      });

      it('E4: outside dashes of a nested clipping board are drawn outside its box, with and without overflow', () => {
        const i = img('e4');
        // Top band of e4-fits (y 17..30): its top-left corner dash covers x 17..35 or so, then a gap.
        expect(grey(i, 22, 24)).toBeLessThan(80);
        // e4-over: the same corner dash, drawn by the sibling above the clipping board.
        expect(grey(i, 172, 24)).toBeLessThan(80);
        // e4-over keeps its clip: its green child stops at the box (x = 270).
        const [r, g] = rgb(i, 276, 80);
        expect(g > 200 && r < 60).toBe(false);
      });

      if (renderer === 'svg') {
        it('E5 (svg, pixelExact): no fill colour at the outer edge of an inside stroke, no seam at the inner edge of an outside one', () => {
          const i = exact('e5');
          // Row 10 holds the outer edge of the inside stroke (y = 10.33): grey, not green.
          expect(tint(i, 40, 10)).toBeLessThan(12);
          expect(tint(i, 220, 10)).toBeLessThan(12);
          // Outside stroke: row 10 holds its inner edge; the fill and the stroke cover it fully (no light seam).
          const [r, g] = rgb(i, 130, 10);
          expect(r).toBeLessThan(20);
          expect(g).toBeLessThan(230);
        });
      } else {
        it('E5 (wasm, pixelExact): the native inside stroke is kept (WASM snaps centred box strokes to whole pixels)', () => {
          // The writer keeps Penpot's inner stroke there; the row still shows the fill bleeding (known disagreement).
          const i = exact('e5');
          expect(grey(i, 40, 12)).toBeLessThan(40);
          expect(rgb(i, 40, 30)[1]).toBeGreaterThan(240);
        });
      }

      it('E5 (default): the true box with its native inside / outside stroke and fill', () => {
        const objects = rendered[renderer]!.objects;
        const x0 = objects[penpotId('e5')]!.x;
        expect(objects[penpotId('e5-in')]).toMatchObject({ width: 60, height: 40, strokes: [{ strokeAlignment: 'inner' }] });
        expect(objects[penpotId('e5-in')]!.x - x0).toBeCloseTo(10.33, 3);
        expect(objects[penpotId('e5-out')]).toMatchObject({ width: 60, height: 40, strokes: [{ strokeAlignment: 'outer' }] });
        expect(objects[penpotId('e5-out')]!.x - x0).toBeCloseTo(100.33, 3);
        expect(objects[penpotId('e5-board')]).toMatchObject({ strokes: [{ strokeAlignment: 'inner' }] });
        // The stroke band is drawn: black inside the box, green fill further in.
        const i = img('e5');
        expect(grey(i, 40, 12)).toBeLessThan(40);
        expect(rgb(i, 40, 30)[1]).toBeGreaterThan(240);
      });
    });
  }
});
