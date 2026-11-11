/**
 * Live checks of baked paints and clipped stroke outlines: a tiled image, an angular gradient (both baked
 * into image fills) and stroke-only shapes drawn from Figma's 2w stroke band, rendered by both Penpot
 * renderers; the assertions are pixel facts.
 *
 * Runs only with PENPOT_LIVE=1 (see render.ts).
 */
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { frame, pathNode, rect, solid, square, stroke, translate } from '../helpers.ts';
import { LIVE, renderFor, rgb, type Rendered } from './render.ts';

/** 20×20 checkerboard of 10 px squares, red top-left. */
function checker(): ir.ImageAsset {
  const png = new PNG({ width: 20, height: 20 });
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) png.data.set((x < 10) === (y < 10) ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 20 + x) * 4);
  }
  return { ref: 'checker', bytes: new Uint8Array(PNG.sync.write(png)), mimeType: 'image/png', width: 20, height: 20 };
}

const tile = (extra: Partial<ir.ImagePaint> = {}): ir.ImagePaint => ({
  type: 'image',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  imageRef: 'checker',
  scaleMode: 'tile',
  scalingFactor: 1,
  ...extra,
});

const angular: ir.GradientPaint = {
  type: 'gradient',
  gradientType: 'angular',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  handles: [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }],
  stops: [
    { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
  ],
};

/** A 40×40 square at (20, 20) whose paths are inexact: Penpot draws Figma's 4 px stroke band (±4 px). */
const outlined = (id: string, align: 'inside' | 'outside'): ir.PathNode =>
  pathNode(id, [square(0, 0, 40, 40)], {
    transform: translate(20, 20),
    size: { width: 40, height: 40 },
    pathsAreExact: false,
    stroke: stroke({ align, weight: 4 }),
    geometry: {
      fill: [square(0, 0, 40, 40)],
      stroke: [{ windingRule: 'evenodd', commands: [...square(-4, -4, 48, 48).commands, ...square(4, 4, 32, 32).commands] }],
    },
  });

const white = solid(1, 1, 1);
const boards: ir.FrameNode[] = [
  frame('tile', [rect('tile-n', { transform: translate(10, 10), size: { width: 100, height: 60 }, fills: [tile()] })], { size: { width: 120, height: 80 }, fills: [white] }),
  frame('tile-half', [rect('tile-half-n', { transform: translate(10, 10), size: { width: 100, height: 60 }, fills: [tile({ opacity: 0.5 })] })], { size: { width: 120, height: 80 }, fills: [white] }),
  frame('angular', [rect('angular-n', { transform: translate(10, 10), size: { width: 100, height: 100 }, fills: [angular] })], { size: { width: 120, height: 120 }, fills: [white] }),
  frame('outside', [outlined('outside-n', 'outside')], { size: { width: 80, height: 80 }, fills: [white] }),
  frame('inside', [outlined('inside-n', 'inside')], { size: { width: 80, height: 80 }, fills: [white] }),
].map((b, i) => ({ ...b, transform: translate(i * 200, 0) }));

const document: ir.Document = {
  name: 'live-bake',
  pages: [{ id: 'live:page', name: 'p', kind: 'page', children: boards }],
  components: {},
  images: { checker: checker() },
  styles: { colors: [], typographies: [] },
};

describe.skipIf(!LIVE)('baked paints in live Penpot', () => {
  const rendered: Partial<Record<'svg' | 'wasm', Rendered>> = {};
  beforeAll(async () => {
    for (const renderer of ['svg', 'wasm'] as const) rendered[renderer] = await renderFor(renderer, 'bake', document, boards.map((b) => b.id));
  }, 300_000);
  const img = (renderer: 'svg' | 'wasm', id: string) => rendered[renderer]!.boards.get(id)!;
  const near = (actual: number[], expected: number[], tolerance: number): void => {
    actual.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(tolerance));
  };

  for (const renderer of ['svg', 'wasm'] as const) {
    describe(`target ${renderer}`, () => {
      it('draws a tiled image as fine tiles starting at the node top-left', () => {
        const t = img(renderer, 'tile');
        const red = [255, 0, 0];
        const blue = [0, 0, 255];
        // Node (10, 10): squares of 10 px, red first; the 20 px tile repeats five times across.
        near(rgb(t, 15, 15), red, 8);
        near(rgb(t, 25, 15), blue, 8);
        near(rgb(t, 15, 25), blue, 8);
        near(rgb(t, 95, 55), red, 8);
        near(rgb(t, 105, 55), blue, 8);
        near(rgb(t, 105, 65), red, 8);
      });

      it('applies the paint opacity of a baked tile', () => {
        near(rgb(img(renderer, 'tile-half'), 15, 15), [255, 128, 128], 10);
      });

      it('draws an angular gradient sweeping clockwise from the first handle', () => {
        const a = img(renderer, 'angular');
        // Centre (60, 60), radius 50: below = a quarter turn, left = half, above = three quarters.
        expect(Math.abs(rgb(a, 60, 95)[0] - 64)).toBeLessThanOrEqual(10);
        expect(Math.abs(rgb(a, 25, 60)[0] - 128)).toBeLessThanOrEqual(10);
        expect(Math.abs(rgb(a, 60, 25)[0] - 191)).toBeLessThanOrEqual(10);
        expect(rgb(a, 95, 62)[0]).toBeLessThan(20);
      });

      it('draws stroke-only outlines as outlines: outside strokes outside, inside strokes inside', () => {
        const outside = img(renderer, 'outside');
        const inside = img(renderer, 'inside');
        // Square edge at x = 20; band 16..24.
        expect(rgb(outside, 40, 40)).toEqual([255, 255, 255]);
        expect(rgb(outside, 18, 40)[0]).toBeLessThan(40);
        expect(rgb(outside, 22, 40)[0]).toBeGreaterThan(215);
        expect(rgb(inside, 40, 40)).toEqual([255, 255, 255]);
        expect(rgb(inside, 22, 40)[0]).toBeLessThan(40);
        expect(rgb(inside, 18, 40)[0]).toBeGreaterThan(215);
      });
    });
  }
});
