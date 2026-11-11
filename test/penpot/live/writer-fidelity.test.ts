/**
 * Live checks of the writer's renderer-dependent numbers (review E: E1, E1b, E2, E3, E4, E5, E6) and of
 * names surviving the import (F6): one small document per target renderer, imported into the local
 * Penpot and exported with that renderer; the assertions are pixel facts.
 *
 * Runs only with PENPOT_LIVE=1 (see render.ts).
 */
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { penpotId } from '../../../src/penpot/ids.ts';
import { multiply } from '../../../src/util/matrix.ts';
import { frame, group, pathNode, rect, rotateAbout, solid, square, stroke, translate } from '../helpers.ts';
import { darkRuns, edgeSigma, gradientError, LIVE, renderFor, rgb, type Rendered } from './render.ts';

const V = (x: number, y: number): ir.Vec2 => ({ x, y });
const bw: ir.GradientStop[] = [
  { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
  { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
];
const gradient = (gradientType: 'linear' | 'radial', handles: [ir.Vec2, ir.Vec2, ir.Vec2], stops = bw): ir.GradientPaint => ({
  type: 'gradient',
  gradientType,
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  handles,
  stops,
});

// --- the document ------------------------------------------------------------------------------------------

interface GradientCase {
  id: string;
  board: ir.Size;
  node: ir.Node;
  paint: ir.GradientPaint;
  /** Node-local → board pixels. */
  m: ir.Matrix;
  inside?: (p: ir.Vec2) => boolean;
}

const gradientCases: GradientCase[] = [];
function addGradient(id: string, board: ir.Size, kind: 'rect' | 'path', size: ir.Size, m: ir.Matrix, paint: ir.GradientPaint, region?: [number, number, number, number]): void {
  const node =
    kind === 'rect'
      ? rect(`${id}-n`, { transform: m, size, fills: [paint] })
      : pathNode(`${id}-n`, [square(...region!)], { transform: m, size, fills: [paint] });
  const inside = region ? (p: ir.Vec2): boolean => p.x > region[0] + 3 && p.x < region[0] + region[2] - 3 && p.y > region[1] + 3 && p.y < region[1] + region[3] - 3 : undefined;
  gradientCases.push({ id, board, node, paint, m, ...(inside ? { inside } : {}) });
}
{
  const inscribed = gradient('radial', [V(0.5, 0.5), V(1, 0.5), V(0.5, 1)]);
  addGradient('rad-square', { width: 220, height: 220 }, 'rect', { width: 200, height: 200 }, translate(10, 10), gradient('radial', [V(0.5, 0.5), V(1, 0.5), V(0.5, 0.75)]));
  addGradient('rad-wide', { width: 320, height: 120 }, 'rect', { width: 300, height: 100 }, translate(10, 10), inscribed);
  addGradient('rad-tall', { width: 120, height: 320 }, 'rect', { width: 100, height: 300 }, translate(10, 10), inscribed);
  // Rotated ellipse handles: pixel ellipse rx 120, ry 40 at 30° in a 300×200 box.
  const a = (30 * Math.PI) / 180;
  const n = (x: number, y: number): ir.Vec2 => V(x / 300, y / 200);
  const rotated = gradient('radial', [n(150, 100), n(150 + 120 * Math.cos(a), 100 + 120 * Math.sin(a)), n(150 - 40 * Math.sin(a), 100 + 40 * Math.cos(a))]);
  addGradient('rad-rotated-handles', { width: 320, height: 220 }, 'rect', { width: 300, height: 200 }, translate(10, 10), rotated);
  addGradient('rad-rotated-rect', { width: 400, height: 300 }, 'rect', { width: 300, height: 100 }, rotateAbout(30, 60, 20), inscribed);
  addGradient('rad-path', { width: 220, height: 220 }, 'path', { width: 200, height: 200 }, translate(10, 10), inscribed, [40, 20, 120, 160]);
  addGradient('lin-wide-skew', { width: 320, height: 120 }, 'rect', { width: 300, height: 100 }, translate(10, 10), gradient('linear', [V(0, 0), V(1, 1), V(-1, 1)]));
  addGradient('lin-tall-skew', { width: 120, height: 320 }, 'rect', { width: 100, height: 300 }, translate(10, 10), gradient('linear', [V(0, 0), V(1, 0.5), V(0.3, 1)]));
  addGradient('lin-rotated-rect', { width: 400, height: 300 }, 'rect', { width: 300, height: 100 }, rotateAbout(30, 60, 20), gradient('linear', [V(0, 0), V(1, 1), V(-1, 1)]));
  addGradient('lin-path', { width: 220, height: 220 }, 'path', { width: 200, height: 200 }, translate(10, 10), gradient('linear', [V(0, 0.2), V(1, 0.8), V(0, 1.2)]), [20, 50, 160, 100]);
}

const boards: ir.FrameNode[] = [];
let x0 = 0;
function board(id: string, size: ir.Size, children: ir.Node[], fill = solid(1, 1, 1)): void {
  boards.push(frame(id, children, { transform: translate(x0, 0), size, fills: [fill], clipsContent: true }));
  x0 += size.width + 40;
}
for (const c of gradientCases) board(c.id, c.board, [c.node], solid(1, 0, 0));

// E2: blurs (Figma σ = radius / 2 = 10).
const black = solid(0, 0, 0);
board('blur-layer', { width: 400, height: 400 }, [rect('bl', { transform: translate(100, 100), size: { width: 200, height: 200 }, fills: [black], effects: [{ type: 'layer-blur', visible: true, radius: 20 }] })]);
board('blur-shadow', { width: 400, height: 400 }, [
  rect('bs', {
    transform: translate(50, 100),
    size: { width: 100, height: 200 },
    fills: [black],
    effects: [{ type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 200, y: 0 }, blur: 20, spread: 0, blendMode: 'normal' }],
  }),
]);
board('blur-background', { width: 400, height: 400 }, [
  rect('bbl', { size: { width: 200, height: 400 }, fills: [black] }),
  rect('bbr', { transform: translate(200, 0), size: { width: 200, height: 400 }, fills: [solid(1, 1, 1)] }),
  rect('bbg', { transform: translate(50, 100), size: { width: 300, height: 200 }, fills: [solid(1, 1, 1, 0.01)], effects: [{ type: 'background-blur', visible: true, radius: 20 }] }),
]);

// E3: a crop whose box aspect (3:1) differs from the visible image region (1:1).
const quadrants = (() => {
  const png = new PNG({ width: 80, height: 40 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 80; x++) {
      const c = y < 20 ? (x < 40 ? [255, 0, 0] : [0, 255, 0]) : x < 40 ? [0, 0, 255] : [255, 255, 0];
      png.data.set([...c, 255], (y * 80 + x) * 4);
    }
  }
  return new Uint8Array(PNG.sync.write(png));
})();
const images: Record<string, ir.ImageAsset> = { quad: { ref: 'quad', bytes: quadrants, mimeType: 'image/png', width: 80, height: 40 } };
const image = (scaleMode: ir.ImageScaleMode, extra: Partial<ir.ImagePaint> = {}): ir.ImagePaint => ({
  type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: 'quad', scaleMode, ...extra,
});
board('crop', { width: 400, height: 200 }, [rect('crop-n', { transform: translate(50, 50), size: { width: 300, height: 100 }, fills: [image('crop', { imageTransform: { a: 0.5, b: 0, c: 0, d: 1, e: 0.5, f: 0 } })] })], black);
board('fit', { width: 400, height: 300 }, [rect('fit-n', { transform: translate(50, 50), size: { width: 300, height: 200 }, fills: [image('fit')] })], black);

// E4: round dots, period 3 × weight.
const line = (length: number): ir.Path => ({ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: length, y: 0 }] });
for (const weight of [4, 10, 20]) {
  board(`dots-${weight}`, { width: 600, height: 100 }, [
    pathNode(`dots-${weight}-n`, [line(500)], {
      transform: translate(50, 50),
      size: { width: 500, height: 0 },
      stroke: stroke({ weight, align: 'center', startCap: 'round', endCap: 'round', dashPattern: [0, weight * 3] }),
    }),
  ]);
}

// E5: a vector mask with a fading fill clips without fading; an alpha mask fades.
const fading = gradient('linear', [V(0, 0.5), V(1, 0.5), V(0, 1)], [
  { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
  { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
]);
for (const type of ['vector', 'alpha'] as const) {
  board(`mask-${type}`, { width: 200, height: 200 }, [
    group(`mask-${type}-g`, [rect(`mask-${type}-m`, { transform: translate(20, 20), size: { width: 160, height: 160 }, fills: [fading], opacity: 0.8 }), rect(`mask-${type}-c`, { size: { width: 200, height: 200 }, fills: [solid(1, 0, 0)] })], {
      size: { width: 200, height: 200 },
      mask: { type },
    }),
  ]);
}

// E6: strokes and dashes under a 2× scaled parent.
board('scaled', { width: 300, height: 200 }, [
  frame(
    'scaled-f',
    [
      pathNode('scaled-solid', [line(100)], { transform: translate(10, 20), size: { width: 100, height: 0 }, stroke: stroke({ weight: 4, align: 'center' }) }),
      pathNode('scaled-dashed', [line(100)], { transform: translate(10, 60), size: { width: 100, height: 0 }, stroke: stroke({ weight: 2, align: 'center', dashPattern: [4, 4] }) }),
    ],
    { transform: multiply(translate(20, 0), { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), size: { width: 130, height: 90 }, clipsContent: false },
  ),
]);

// F6: names with slashes.
board('names', { width: 100, height: 100 }, [rect('name-5050', { name: '50/50', fills: [black] })]);

const document: ir.Document = {
  name: 'live-writer',
  pages: [{ id: 'live:page', name: 'p', kind: 'page', children: boards }],
  components: {},
  images,
  styles: { colors: [], typographies: [] },
};

// --- assertions -------------------------------------------------------------------------------------------

describe.skipIf(!LIVE)('writer fidelity in live Penpot', () => {
  const rendered: Partial<Record<'svg' | 'wasm', Rendered>> = {};
  beforeAll(async () => {
    for (const renderer of ['svg', 'wasm'] as const) rendered[renderer] = await renderFor(renderer, 'writer', document, boards.map((b) => b.id));
  }, 600_000);
  const img = (renderer: 'svg' | 'wasm', id: string) => rendered[renderer]!.boards.get(id)!;

  for (const renderer of ['svg', 'wasm'] as const) {
    describe(`target ${renderer}`, () => {
      it.each(gradientCases.map((c) => [c.id, c] as const))('E1/E1b: %s gradient matches Figma within one level on average', (_, c) => {
        const size = c.node.size;
        expect(gradientError(img(renderer, c.id), c.paint, c.m, size, c.inside)).toBeLessThanOrEqual(1);
      });

      it('E2: layer blur and shadow have σ = radius / 2', () => {
        const layer = img(renderer, 'blur-layer');
        expect(edgeSigma((x) => 1 - rgb(layer, x, 200)[0] / 255, 40, 200)).toBeCloseTo(10, 0);
        const shadow = img(renderer, 'blur-shadow');
        expect(edgeSigma((x) => 1 - rgb(shadow, x, 200)[0] / 255, 300, 400)).toBeCloseTo(10, 0);
      });

      it('E3: a crop shows the requested region; fit letterboxes', () => {
        const crop = img(renderer, 'crop');
        expect([rgb(crop, 60, 60), rgb(crop, 340, 60), rgb(crop, 60, 140), rgb(crop, 340, 140)]).toEqual([
          [0, 255, 0],
          [0, 255, 0],
          [255, 255, 0],
          [255, 255, 0],
        ]);
        const fit = img(renderer, 'fit');
        expect([rgb(fit, 60, 70), rgb(fit, 60, 80), rgb(fit, 340, 220), rgb(fit, 340, 230)]).toEqual([
          [0, 0, 0],
          [255, 0, 0],
          [255, 255, 0],
          [0, 0, 0],
        ]);
      });

      it.each([4, 10, 20])('E4: round dots of weight %i repeat every 3 × weight', (weight) => {
        const runs = darkRuns(img(renderer, `dots-${weight}`), 50).filter(([a, b]) => a > 55 && b < 545);
        const periods = runs.slice(1).map((r, i) => r[0] - runs[i]![0]);
        expect(periods.length).toBeGreaterThan(5);
        expect(periods.reduce((s, p) => s + p, 0) / periods.length).toBeCloseTo(weight * 3, 0);
      });

      it('E5: a vector mask clips to the silhouette, an alpha mask fades', () => {
        const vector = img(renderer, 'mask-vector');
        for (const x of [40, 100, 170]) expect(rgb(vector, x, 100)).toEqual([255, 0, 0]);
        expect(rgb(vector, 10, 100)).toEqual([255, 255, 255]);
        const alpha = img(renderer, 'mask-alpha');
        expect(rgb(alpha, 170, 100)[1]).toBeGreaterThan(150);
      });

      it('E6: strokes and dashes follow the parent’s 2× scale', () => {
        const scaled = img(renderer, 'scaled');
        // Solid line at board y = 40, weight 4 × 2 (the dashed one is below y = 80).
        const column = Array.from({ length: 80 }, (_, y) => rgb(scaled, 120, y)[0] < 128);
        expect(column.filter(Boolean).length).toBeGreaterThanOrEqual(7);
        expect(column.filter(Boolean).length).toBeLessThanOrEqual(9);
        // Dashed line at board y = 120: dash 4 + gap 4 on a 100 px edge, × 2. Figma stretches the pattern to a
        // whole number of periods per edge (dashes.ts): n = max(1, round(L / period)), period' = L / n.
        const length = 100;
        const period = 4 + 4;
        const n = Math.max(1, Math.floor(length / period + 0.5));
        const runs = darkRuns(scaled, 120).filter(([a, b]) => a > 45 && b < 215);
        const periods = runs.slice(1).map((r, i) => r[0] - runs[i]![0]);
        expect(periods.reduce((s, p) => s + p, 0) / periods.length).toBeCloseTo((2 * length) / n, 0);
      });

      it('F6: a slash in a shape name survives the library and the import', () => {
        expect(rendered[renderer]!.objects[penpotId('name-5050')]?.name).toBe('50∕50');
      });
    });
  }

  it('E2: the WASM renderer blurs the background with σ = radius / 2', () => {
    const bg = img('wasm', 'blur-background');
    expect(edgeSigma((x) => rgb(bg, x, 200)[0] / 255, 120, 280)).toBeCloseTo(10, 0);
  });
});
