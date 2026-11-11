/**
 * Live checks of the stroke placement edge cases and image paths fixed after reviews K and L, in both Penpot
 * renderers:
 * - K1: a page-level non-clipping board keeps its outside dashed stroke on itself; exported on its own, the
 *   stroke shows (a separate stroke child was cut in half by SVG, dropped by WASM);
 * - K3: in a clipping "first on top" flex board the dash shape is stacked above the children;
 * - K5: a grey multiply shadow on a red opaque frame is drawn black (multiply over opaque content); inside an
 *   isolating group (opacity 1, blend normal) it stays grey, as Figma composes it there;
 * - K7: a fill-less frame with an outside stroke and a hard drop shadow: the stroke is shadowed, the content is
 *   not (both renderers; before, SVG shadowed the content and not the stroke, WASM drew a black box);
 * - L8: a rotated, mirrored rect with a reduced image copy (`fill`, `crop`) and a tiled (baked) image: every
 *   quadrant of the picture lands where Figma draws it.
 *
 * Runs only with PENPOT_LIVE=1 (see render.ts).
 */
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { apply } from '../../../src/util/matrix.ts';
import { frame, group, rect, solid, stroke, translate } from '../helpers.ts';
import { LIVE, renderFor, rgb, type Img, type Rendered } from './render.ts';

const white = solid(1, 1, 1);
const black = solid(0, 0, 0);
const red = solid(1, 0, 0);
const boards: ir.FrameNode[] = [];
let x0 = 0;
function board(id: string, size: ir.Size, children: ir.Node[], options: Partial<ir.FrameNode> = {}): void {
  boards.push(frame(id, children, { transform: translate(x0, 0), size, fills: [white], clipsContent: true, ...options }));
  x0 += size.width + 60;
}

// K1: page level, not clipping, outside dashes 8 px [12, 8] around a 100 × 80 box, a child reaching the stroke band.
board('k1', { width: 100, height: 80 }, [rect('k1-c', { size: { width: 40, height: 30 }, transform: translate(-4, 20), fills: [red] })], {
  clipsContent: false,
  fills: [solid(0.85, 0.85, 0.85)],
  stroke: stroke({ weight: 8, align: 'outside', dashPattern: [12, 8], paints: [black] }),
});

// K3: a clipping flex board, "first on top", 10 px inside dashes [10, 10], two children covering the stroke band.
const flow = (id: string, x: number, paint: ir.Paint): ir.RectNode =>
  rect(id, { size: { width: 60, height: 80 }, transform: translate(x, 0), fills: [paint], layoutChild: { positioning: 'auto' } });
board('k3', { width: 140, height: 120 }, [
  frame('k3-f', [flow('k3-a', 0, red), flow('k3-b', 40, solid(0, 0, 1))], {
    transform: translate(10, 10), size: { width: 120, height: 100 }, clipsContent: true, fills: [solid(0.9, 0.9, 0.9)],
    layout: {
      direction: 'horizontal', wrap: false, itemSpacing: -20, counterSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 },
      primaryAlign: 'start', counterAlign: 'start', counterAlignContent: 'auto', reverseZIndex: true, strokesIncludedInLayout: false,
    },
    stroke: stroke({ weight: 10, align: 'inside', dashPattern: [10, 10], paints: [black] }),
  }),
]);

// K5: grey multiply shadows (#acacac at 50 %, 8 px down, hard) of white squares on a red frame.
const multiply: ir.Effect[] = [{ type: 'drop-shadow', visible: true, color: { r: 0.675, g: 0.675, b: 0.675, a: 0.5 }, offset: { x: 0, y: 8 }, blur: 0, spread: 0, blendMode: 'multiply' }];
board('k5', { width: 160, height: 80 }, [
  frame('k5-red', [
    rect('k5-direct', { size: { width: 30, height: 30 }, transform: translate(20, 20), fills: [white], effects: multiply }),
    group('k5-iso', [rect('k5-grouped', { size: { width: 30, height: 30 }, transform: translate(100, 20), fills: [white], effects: multiply })], { size: { width: 30, height: 30 }, blendMode: 'normal' }),
  ], { size: { width: 160, height: 80 }, fills: [red], clipsContent: true }),
]);

// K7: "Tip" of auto-layout-playground 1620:1472: fill-less, not clipping, 3 px outside stroke, hard shadow (2, 2).
board('k7', { width: 200, height: 100 }, [
  frame('k7-f', [rect('k7-bar', { size: { width: 4, height: 40 }, transform: translate(40, 10), fills: [black] })], {
    transform: translate(20, 20), size: { width: 140, height: 60 }, clipsContent: false,
    stroke: stroke({ weight: 3, align: 'outside', paints: [black] }),
    effects: [{ type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 2, y: 2 }, blur: 0, spread: 0, blendMode: 'normal', showBehindNode: false }],
  }),
]);

// L8: a 256 px image of four quadrants (red, green / blue, yellow) on a 48 px rect turned 30° and mirrored.
function quadrants(): ir.ImageAsset {
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) png.data.set(QUADRANT[(y < 128 ? 0 : 2) + (x < 128 ? 0 : 1)]!, (y * 256 + x) * 4);
  return { ref: 'quadrants', bytes: new Uint8Array(PNG.sync.write(png)), mimeType: 'image/png', width: 256, height: 256 };
}
const QUADRANT = [[255, 0, 0, 255], [0, 200, 0, 255], [0, 0, 255, 255], [255, 220, 0, 255]];
const turned = (cx: number, cy: number): ir.Matrix => {
  // Rotation by 30° of a mirrored (x → −x) box, its centre at (cx, cy).
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const m = { a: -c, b: -s, c: -s, d: c, e: 0, f: 0 };
  const centre = apply(m, { x: 24, y: 24 });
  return { ...m, e: cx - centre.x, f: cy - centre.y };
};
const picture = (extra: Partial<ir.ImagePaint>): ir.ImagePaint => ({ type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: 'quadrants', scaleMode: 'fill', ...extra });
const L8: Record<string, ir.ImagePaint> = {
  fill: picture({}),
  // The top-left 3 / 4 of the image: the quadrant boundary at node-local 32 px.
  crop: picture({ scaleMode: 'crop', imageTransform: { a: 0.75, b: 0, c: 0, d: 0.75, e: 0, f: 0 } }),
  // 32 px tiles (256 × 0.125): baked.
  tile: picture({ scaleMode: 'tile', scalingFactor: 0.125 }),
};
for (const [mode, paint] of Object.entries(L8)) board(`l8-${mode}`, { width: 100, height: 100 }, [rect(`l8-${mode}-r`, { size: { width: 48, height: 48 }, transform: turned(50, 50), fills: [paint] })]);
/** Node-local sample points → expected quadrant, per mode. */
const L8_POINTS: Record<string, [number, number, number][]> = {
  fill: [[12, 12, 0], [36, 12, 1], [12, 36, 2], [36, 36, 3]],
  crop: [[12, 12, 0], [42, 12, 1], [12, 42, 2], [42, 42, 3]],
  tile: [[8, 8, 0], [24, 8, 1], [8, 24, 2], [24, 24, 3], [40, 8, 0], [40, 40, 0], [40, 24, 2]],
};

const document: ir.Document = {
  name: 'live-review-fixes',
  pages: [{ id: 'live-review:page', name: 'p', kind: 'page', children: boards }],
  components: {},
  images: { quadrants: quadrants() },
  styles: { colors: [], typographies: [] },
};

const dark = (p: [number, number, number]): boolean => p[0] < 90 && p[1] < 90 && p[2] < 90;

describe.skipIf(!LIVE)('review K / L fixes in live Penpot', () => {
  const rendered: Partial<Record<'svg' | 'wasm', Rendered>> = {};
  beforeAll(async () => {
    for (const renderer of ['svg', 'wasm'] as const) rendered[renderer] = await renderFor(renderer, 'review-fixes', document, boards.map((b) => b.id));
    if (process.env.LIVE_DUMP) {
      const { writeFileSync } = await import('node:fs');
      for (const [r, out] of Object.entries(rendered)) for (const [id, im] of out!.boards) { const p = new PNG({ width: im.width, height: im.height }); p.data = Buffer.from(im.data); writeFileSync(`${process.env.LIVE_DUMP}/${r}-${id}.png`, PNG.sync.write(p)); }
    }
  }, 300_000);

  for (const renderer of ['svg', 'wasm'] as const) {
    describe(`renderer ${renderer}`, () => {
      const img = (id: string): Img => rendered[renderer]!.boards.get(id)!;

      it('K1: the page-level board exported on its own shows its outside dashes on every side', () => {
        const k1 = img('k1');
        // The export covers the box and the 8 px outside band (SVG adds 4 px of margin).
        const m = renderer === 'svg' ? 4 : 0;
        expect([k1.width, k1.height]).toEqual([116 + 2 * m, 96 + 2 * m]);
        // Dashes along the middle of the band on each side: ink and gaps (Penpot's own dashes).
        // Outside the box the export is transparent between dashes.
        const ink = (x: number, y: number): boolean => k1.data[(y * k1.width + x) * 4 + 3]! > 128 && dark(rgb(k1, x, y));
        const side = (points: [number, number][]): number => points.filter(([x, y]) => ink(x + m, y + m)).length / points.length;
        const along = (n: number, f: (i: number) => [number, number]): [number, number][] => Array.from({ length: n }, (_, i) => f(i));
        for (const fraction of [
          side(along(100, (i) => [8 + i, 4])),
          side(along(100, (i) => [8 + i, 92])),
          side(along(80, (i) => [4, 8 + i])),
          side(along(80, (i) => [112, 8 + i])),
        ]) {
          expect(fraction).toBeGreaterThan(0.3);
          expect(fraction).toBeLessThan(0.9);
        }
      });

      it('K3: the dashes of a clipping "first on top" flex board stay above its children', () => {
        const k3 = img('k3');
        // The 10 px top band (y 10–20): a dash at x 25–35 over the red child, one at 85–95 over the blue one.
        expect(dark(rgb(k3, 30, 15))).toBe(true);
        expect(dark(rgb(k3, 90, 15))).toBe(true);
        expect(rgb(k3, 20, 25)).toEqual([255, 0, 0]);
      });

      it('K5: a grey multiply shadow on a red frame is black, inside an isolating group it stays grey', () => {
        const k5 = img('k5');
        // Below the squares (y 50–58): multiply over red keeps green at 0; the isolated one shows the grey.
        const direct = rgb(k5, 35, 54);
        const grouped = rgb(k5, 115, 54);
        expect(Math.abs(direct[0] - 214)).toBeLessThanOrEqual(3);
        expect(direct[1]).toBeLessThanOrEqual(3);
        expect(Math.abs(grouped[0] - 214)).toBeLessThanOrEqual(3);
        expect(Math.abs(grouped[1] - 86)).toBeLessThanOrEqual(3);
      });

      it("K7: the fill-less frame's stroke is shadowed and its content is not", () => {
        const k7 = img('k7');
        const row = (y: number, from: number, to: number): string => Array.from({ length: to - from }, (_, i) => (dark(rgb(k7, from + i, y)) ? '#' : '.')).join('');
        // Left edge: 3 px of stroke (x 17–19) and its shadow 2 px further (to 21; Figma hides that part inside the
        // box, `showShadowBehindNode: false`, which Penpot cannot); right edge: stroke (160–162) + shadow (to 164).
        expect(row(50, 14, 24)).toBe('...#####..');
        expect(row(50, 156, 168)).toBe('....#####...');
        // The bar inside (x 60–63) casts no shadow at 64–65.
        expect(row(50, 58, 68)).toBe('..####....');
      });

      for (const [mode, points] of Object.entries(L8_POINTS)) {
        it(`L8: a rotated, mirrored ${mode} picture lands where Figma draws it`, () => {
          const shot = img(`l8-${mode}`);
          const m = turned(50, 50);
          for (const [x, y, q] of points) {
            const p = apply(m, { x, y });
            const actual = rgb(shot, p.x - 0.5, p.y - 0.5);
            const expected = QUADRANT[q]!;
            actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${mode} (${x}, ${y}) → ${actual} vs ${expected}`).toBeLessThanOrEqual(40));
          }
        });
      }
    });
  }

  it('wrote reduced copies for the fill and crop pictures and baked the tile', () => {
    const codes = rendered.svg!.warnings.map((w) => w.code);
    expect(codes).toContain('images-downsampled');
    expect(codes).toContain('paint-baked');
    expect(rendered.svg!.warnings.filter((w) => w.code === 'frame-shadow-on-stroke').map((w) => w.nodeId)).toEqual(['k7-f']);
  });
});
