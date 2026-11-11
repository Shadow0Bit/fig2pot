import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { BakeCache, bakePaint, bakeSize, MAX_BAKE_PIXELS, MAX_BAKE_SIDE } from '../../src/penpot/bake.ts';
import { boxSpace } from '../../src/penpot/fills.ts';
import { createRaster, encodePng, fromStraight8, renderGradient, resample, rotateQuarter, type Raster } from '../../src/penpot/raster.ts';
import { doc, ellipse, pathNode, rect, rotateAbout, solid, square, write, type Written } from './helpers.ts';

// --- fixtures -------------------------------------------------------------------------

type RGBA = [number, number, number, number];

/** A PNG image asset from straight RGBA rows. */
function pngAsset(ref: string, rows: RGBA[][]): ir.ImageAsset {
  const height = rows.length;
  const width = rows[0]!.length;
  const png = new PNG({ width, height });
  rows.flat().forEach((px, i) => png.data.set(px, i * 4));
  const bytes = new Uint8Array(PNG.sync.write(png));
  return { ref, bytes, mimeType: 'image/png', width, height };
}

const R: RGBA = [255, 0, 0, 255];
const G: RGBA = [0, 255, 0, 255];
const B: RGBA = [0, 0, 255, 255];
const W: RGBA = [255, 255, 255, 255];
const K: RGBA = [0, 0, 0, 255];
const CLEAR: RGBA = [255, 0, 0, 0];

/** 4×4 checkerboard of 2 px squares, red top-left. */
const CHECKER = pngAsset('checker', [
  [R, R, B, B],
  [R, R, B, B],
  [B, B, R, R],
  [B, B, R, R],
]);
/** 2×1: red left, blue right. */
const PAIR = pngAsset('pair', [[R, B]]);

const tile = (imageRef: string, extra: Partial<ir.ImagePaint> = {}): ir.ImagePaint => ({
  type: 'image',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  imageRef,
  scaleMode: 'tile',
  scalingFactor: 1,
  ...extra,
});

const gradient = (gradientType: ir.GradientPaint['gradientType'], stops: ir.GradientStop[], extra: Partial<ir.GradientPaint> = {}): ir.GradientPaint => ({
  type: 'gradient',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  gradientType,
  handles: [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }],
  stops,
  ...extra,
});

const BLACK_WHITE: ir.GradientStop[] = [
  { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
  { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
];

function decoded(png: Uint8Array): { width: number; height: number; px(x: number, y: number): RGBA } {
  const img = PNG.sync.read(Buffer.from(png));
  return {
    width: img.width,
    height: img.height,
    px: (x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)] as RGBA,
  };
}

/** Bakes a paint over a `width` × `height` box shape at `scale`. */
function bakeBox(paint: ir.ImagePaint | ir.GradientPaint, width: number, height: number, scale = 1, images: Record<string, ir.ImageAsset> = { checker: CHECKER, pair: PAIR }) {
  const out = bakePaint(new BakeCache(images), paint, { node: { id: 'n', name: 'n' }, size: { width, height }, space: boxSpace(width, height) }, { scale, opacity: 1 });
  if (!out.ok) throw new Error(out.reason);
  return { ...out.image, img: decoded(out.image.png) };
}

function px(r: Raster, x: number, y: number): number[] {
  return [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)].map((v) => Math.round(v * 1000) / 1000);
}

/** The baked media of a written shape's first fill. */
function bakedFill(w: Written, irId: string): { fill: Record<string, any>; png: ReturnType<typeof decoded> } {
  const fill = w.shape(irId).fills[0];
  const media = w.media.find((m) => m.id === fill.fillImage.id)!;
  const path = Object.keys(w.files).find((p) => p.startsWith(`objects/${media.mediaId}.`) && !p.endsWith('.json'))!;
  return { fill, png: decoded(w.files[path]!) };
}

// --- rasteriser -------------------------------------------------------------------------

describe('raster', () => {
  it('turns rasters clockwise by quarter turns', () => {
    const src = fromStraight8(2, 1, [...R, ...B]);
    const cw = rotateQuarter(src, 90);
    expect([cw.width, cw.height]).toEqual([1, 2]);
    expect([px(cw, 0, 0), px(cw, 0, 1)]).toEqual([[1, 0, 0, 1], [0, 0, 1, 1]]);
    const ccw = rotateQuarter(src, 270);
    expect([px(ccw, 0, 0), px(ccw, 0, 1)]).toEqual([[0, 0, 1, 1], [1, 0, 0, 1]]);
    const half = rotateQuarter(src, 180);
    expect([px(half, 0, 0), px(half, 1, 0)]).toEqual([[0, 0, 1, 1], [1, 0, 0, 1]]);
  });

  it('area-averages when downscaling, in premultiplied alpha (no colour bleeds from transparent pixels)', () => {
    const src = fromStraight8(2, 1, [...CLEAR, ...B]);
    const out = resample(src, 1, 1, { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 }, 'transparent');
    // Premultiplied: half-covered blue; straight it stays pure blue.
    expect(px(out, 0, 0)).toEqual([0, 0, 0.5, 0.5]);
    const straight = decoded(encodePng(out));
    expect(straight.px(0, 0)).toEqual([0, 0, 255, 128]);
  });

  it('weights partial source pixels by their coverage', () => {
    const src = fromStraight8(3, 1, [...K, ...W, ...K]);
    // Output pixel covers source [0, 1.5): 1 × black + 0.5 × white.
    const out = resample(src, 2, 1, { a: 1.5, b: 0, c: 0, d: 1, e: 0, f: 0 }, 'transparent');
    expect(px(out, 0, 0)[0]).toBeCloseTo(1 / 3, 3);
    expect(px(out, 1, 0)[0]).toBeCloseTo(1 / 3, 3);
  });

  it('interpolates bilinearly when upscaling', () => {
    const src = fromStraight8(2, 1, [...K, ...W]);
    const out = resample(src, 8, 1, { a: 0.25, b: 0, c: 0, d: 1, e: 0, f: 0 }, 'wrap');
    const reds = Array.from({ length: 8 }, (_, i) => px(out, i, 0)[0]!);
    // Centres of output pixels 2..5 lie between the two source centres (0.5 and 1.5): a rising ramp.
    expect(reds[2]).toBeCloseTo(0.125, 3);
    expect(reds[5]).toBeCloseTo(0.875, 3);
    for (let i = 2; i < 5; i++) expect(reds[i + 1]!).toBeGreaterThan(reds[i]!);
  });

  it('supersamples rotated maps', () => {
    const src = fromStraight8(1, 1, [...G]);
    const out = resample(src, 3, 3, { a: 0.7, b: 0.7, c: -0.7, d: 0.7, e: 0, f: 0 }, 'wrap');
    expect(px(out, 1, 1)).toEqual([0, 1, 0, 1]);
  });

  it('encodes identical rasters to identical bytes', () => {
    const r = createRaster(5, 3);
    r.data.fill(0.5);
    expect(Buffer.compare(Buffer.from(encodePng(r)), Buffer.from(encodePng(r)))).toBe(0);
  });
});

describe('gradient rasteriser', () => {
  const identityToNorm = (size: number): ir.Matrix => ({ a: 1 / size, b: 0, c: 0, d: 1 / size, e: 0, f: 0 });

  it('angular: starts along h0→h1 and sweeps towards h2 (clockwise on screen)', () => {
    const size = 40;
    // Centre at (20.5, 20.5) px: the start ray runs through the middle of pixel row 20.
    const c = 20.5 / size;
    const r = renderGradient('angular', [{ x: c, y: c }, { x: 1, y: c }, { x: c, y: 1 }], BLACK_WHITE, size, size, identityToNorm(size))!;
    const grey = (x: number, y: number): number => px(r, x, y)[0]!;
    expect(grey(30, 22)).toBeLessThan(0.05); // just below the start ray (position ≈ 0)
    expect(grey(20, 35)).toBeCloseTo(0.25, 1); // below the centre: a quarter turn clockwise
    expect(grey(5, 20)).toBeCloseTo(0.5, 1); // left
    expect(grey(20, 5)).toBeCloseTo(0.75, 1); // above
    expect(grey(30, 19)).toBeGreaterThan(0.95); // just above: the end of the sweep
    // Pixels on the seam (where the end meets the start) are antialiased, not a jagged edge.
    expect(grey(35, 20)).toBeCloseTo(0.5, 1);
  });

  it('angular: follows the handles (a mirrored frame sweeps the other way)', () => {
    const size = 40;
    const r = renderGradient('angular', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0 }], BLACK_WHITE, size, size, identityToNorm(size))!;
    expect(px(r, 20, 5)[0]).toBeCloseTo(0.25, 1);
    expect(px(r, 20, 35)[0]).toBeCloseTo(0.75, 1);
  });

  it('diamond: position is |s| + |t| in the handle frame', () => {
    const size = 40;
    // Centre on pixel (20, 20)'s centre; main axis 20 px to the right, second axis 10 px down.
    const n = (v: number): number => v / size;
    const r = renderGradient('diamond', [{ x: n(20.5), y: n(20.5) }, { x: n(40.5), y: n(20.5) }, { x: n(20.5), y: n(30.5) }], BLACK_WHITE, size, size, identityToNorm(size))!;
    const at = (x: number, y: number): number => px(r, x, y)[0]!;
    expect(at(20, 20)).toBe(0);
    expect(at(30, 20)).toBeCloseTo(0.5, 3); // s = 0.5
    expect(at(20, 25)).toBeCloseTo(0.5, 3); // t = 0.5
    expect(at(24, 23)).toBeCloseTo(0.5, 3); // s = 0.2, t = 0.3
    expect(at(16, 17)).toBeCloseTo(0.5, 3); // s = -0.2, t = -0.3
    expect(at(40 - 1, 39)).toBe(1); // beyond the last stop
  });

  it('interpolates stops in straight alpha', () => {
    const stops: ir.GradientStop[] = [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 0 } },
    ];
    const size = 40;
    const r = renderGradient('diamond', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }], stops, size, size, identityToNorm(size))!;
    // Halfway: straight (0.5, 0, 0.5) at alpha 0.5 → premultiplied (0.25, 0, 0.25, 0.5).
    const [pr, , pb, pa] = px(r, 29, 19);
    expect(pa).toBeCloseTo(0.5, 1);
    expect(pr! / pa!).toBeCloseTo(0.5, 1);
    expect(pb! / pa!).toBeCloseTo(0.5, 1);
  });
});

// --- baking ----------------------------------------------------------------------------

describe('tile baking', () => {
  it('starts the first tile at the node top-left, one tile = natural size × scalingFactor', () => {
    const { img, width, height } = bakeBox(tile('checker'), 10, 6);
    expect([width, height]).toEqual([10, 6]);
    const colour = (x: number, y: number): string => (img.px(x, y)[0] > 200 ? 'R' : 'B');
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => colour(x, 0)).join('')).toBe('RRBBRRBBRR');
    expect([0, 1, 2, 3, 4, 5].map((y) => colour(0, y)).join('')).toBe('RRBBRR');
    const half = bakeBox(tile('checker', { scalingFactor: 0.5 }), 8, 2).img;
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((x) => (half.px(x, 0)[0] > 200 ? 'R' : 'B')).join('')).toBe('RBRBRBRB');
  });

  it('bakes at the requested device-pixel ratio', () => {
    const { img, width, height, scale } = bakeBox(tile('checker'), 10, 6, 2);
    expect([width, height, scale]).toEqual([20, 12, 2]);
    // Upscaled bilinearly (wrapping across tile edges): each 2 px square spans 4 px.
    expect([1, 2, 5, 6, 9].map((x) => (img.px(x, 1)[0] > img.px(x, 1)[2] ? 'R' : 'B')).join('')).toBe('RRBBR');
    expect(img.px(2, 2)).toEqual([255, 0, 0, 255]);
  });

  it('rotates each tile clockwise', () => {
    const { img } = bakeBox(tile('pair', { rotation: 90 }), 2, 4);
    // 2×1 [red, blue] turned clockwise is 1×2: red on top. Tiles repeat every 2 px down.
    const col = [0, 1, 2, 3].map((y) => (img.px(0, y)[0] > 200 ? 'R' : 'B')).join('');
    expect(col).toBe('RBRB');
  });

  it('averages a tile smaller than a pixel', () => {
    const { img } = bakeBox(tile('checker', { scalingFactor: 0.25 }), 4, 4);
    const [r, g, b, a] = img.px(1, 1);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(135);
    expect(b).toBeGreaterThan(120);
    expect(g).toBe(0);
  });

  it('fails (for the caller to approximate) when the image cannot be decoded', () => {
    const gif: ir.ImageAsset = { ref: 'gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]), mimeType: 'image/gif', width: 1, height: 1 };
    const out = bakePaint(new BakeCache({ gif }), tile('gif'), { node: { id: 'n', name: 'n' }, size: { width: 4, height: 4 }, space: boxSpace(4, 4) }, { scale: 1, opacity: 1 });
    expect(out).toMatchObject({ ok: false });
  });
});

describe('pixel budget', () => {
  it('reduces the scale so that no bitmap exceeds the side or area limit', () => {
    expect(bakeSize(100, 50, 2)).toEqual({ width: 200, height: 100, scale: 2, downscaled: false });
    const long = bakeSize(10_000, 100, 2);
    expect(long.width).toBeLessThanOrEqual(MAX_BAKE_SIDE);
    expect(long.downscaled).toBe(true);
    const big = bakeSize(5000, 5000, 2);
    expect(big.width * big.height).toBeLessThanOrEqual(MAX_BAKE_PIXELS + 2 * 4096);
    expect(big.downscaled).toBe(true);
    expect(bakeSize(0.2, 0.2, 2)).toMatchObject({ width: 1, height: 1 });
  });

  it('warns bake-downscaled', async () => {
    const w = await write(doc([rect('big', { size: { width: 6000, height: 100 }, fills: [tile('checker')] })], { images: { checker: CHECKER } }));
    expect(w.codes()).toContain('bake-downscaled');
    expect(w.shape('big').fills[0].fillImage.width).toBeLessThanOrEqual(MAX_BAKE_SIDE);
  });
});

describe('baked paints in the written file', () => {
  const images = { checker: CHECKER, pair: PAIR };

  it('writes a tiled image as a stretched image fill covering the box, with paint-baked', async () => {
    const w = await write(doc([rect('t', { size: { width: 10, height: 6 }, fills: [tile('checker', { opacity: 0.6 })] })], { images }));
    const { fill, png } = bakedFill(w, 't');
    expect(fill.fillOpacity).toBe(0.6);
    expect(fill.fillImage).toMatchObject({ width: 20, height: 12, mtype: 'image/png', keepAspectRatio: false });
    expect(fill.fillImage.transform).toBeUndefined();
    // The opacity stays a fill attribute: the pixels are opaque.
    expect(png.px(1, 1)).toEqual([255, 0, 0, 255]);
    expect(w.warnings.filter((x) => x.code === 'paint-baked').map((x) => x.nodeId)).toEqual(['t']);
    expect(w.codes()).not.toContain('image-scale-mode-approximated');
  });

  it('bakes the opacity into the pixels for the WASM renderer, which ignores image fill opacity', async () => {
    const w = await write(doc([rect('t', { size: { width: 10, height: 6 }, fills: [tile('checker', { opacity: 0.6 })] })], { images }), { renderer: 'wasm' });
    const { fill, png } = bakedFill(w, 't');
    expect(fill.fillOpacity).toBe(1);
    expect(png.px(1, 1)).toEqual([255, 0, 0, 153]);
  });

  it('writes one media object per distinct bitmap', async () => {
    const w = await write(
      doc([
        rect('a', { size: { width: 10, height: 6 }, fills: [tile('checker')] }),
        rect('b', { size: { width: 10, height: 6 }, fills: [tile('checker')] }),
        ellipse('c', { size: { width: 10, height: 6 }, fills: [tile('checker')] }),
        rect('d', { size: { width: 12, height: 6 }, fills: [tile('checker')] }),
      ], { images }),
    );
    const ids = ['a', 'b', 'c', 'd'].map((id) => w.shape(id).fills[0].fillImage.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[3]).not.toBe(ids[0]);
    expect(w.media).toHaveLength(2);
  });

  it('bakes in the local space of box shapes, so rotation and mirroring still apply', async () => {
    const w = await write(doc([rect('r', { transform: rotateAbout(30, 50, 0), size: { width: 10, height: 6 }, fills: [tile('checker')] })], { images }));
    const { fill } = bakedFill(w, 'r');
    expect([fill.fillImage.width, fill.fillImage.height]).toEqual([20, 12]);
    expect(w.shape('r').rotation).toBeCloseTo(30, 6);
  });

  it('bakes a path image fill over the path bounds (Penpot paints path images in their bounds)', async () => {
    // A 10×6 vector rotated 90°: Penpot's box is 6 wide, 12 tall… at scale 2 → 12 × 20.
    const w = await write(doc([pathNode('p', [square(0, 0, 10, 6)], { transform: rotateAbout(90, 20, 0), size: { width: 10, height: 6 }, fills: [tile('checker')] })], { images }));
    const { fill, png } = bakedFill(w, 'p');
    expect([fill.fillImage.width, fill.fillImage.height]).toEqual([12, 20]);
    // Node-local (0, 0) is the box's top-right corner after a 90° turn: the first tile's red square sits there.
    expect(png.px(10, 1)).toEqual([255, 0, 0, 255]);
    expect(png.px(10, 5)).toEqual([0, 0, 255, 255]);
  });

  it('bakes angular and diamond gradients, keeping the opacity a fill attribute', async () => {
    const w = await write(doc([
      rect('a', { size: { width: 20, height: 20 }, fills: [gradient('angular', BLACK_WHITE, { opacity: 0.5 })] }),
      rect('d', { size: { width: 20, height: 20 }, fills: [gradient('diamond', BLACK_WHITE)] }),
    ]));
    const a = bakedFill(w, 'a');
    expect(a.fill.fillOpacity).toBe(0.5);
    expect(a.png.px(20, 30)[0]).toBeGreaterThan(50); // below the centre, a quarter turn
    expect(a.png.px(20, 30)[0]).toBeLessThan(80);
    expect(bakedFill(w, 'd').png.px(0, 0)).toEqual([255, 255, 255, 255]);
    expect(w.warnings.filter((x) => x.code === 'paint-baked').map((x) => x.nodeId)).toEqual(['a', 'd']);
    expect(w.codes()).not.toContain('gradient-approximated');
  });

  it('bakes rotated images and rotated crops; leaves plain fill/fit/crop to Penpot', async () => {
    const w = await write(doc([
      rect('rot', { size: { width: 2, height: 4 }, fills: [{ ...tile('pair'), scaleMode: 'fill', rotation: 90 }] }),
      rect('crop', { size: { width: 4, height: 4 }, fills: [{ ...tile('pair'), scaleMode: 'crop', imageTransform: { a: 0, b: 1, c: 1, d: 0, e: 0, f: 0 } }] }),
      rect('plain', { size: { width: 4, height: 4 }, fills: [{ ...tile('pair'), scaleMode: 'fit' }] }),
    ], { images }));
    const rot = bakedFill(w, 'rot').png;
    expect([rot.width, rot.height]).toEqual([4, 8]);
    expect(rot.px(1, 1)).toEqual([255, 0, 0, 255]);
    expect(rot.px(1, 6)).toEqual([0, 0, 255, 255]);
    // The transposing crop shows the image's top-left at the node's top-left, the right half at the bottom.
    const crop = bakedFill(w, 'crop').png;
    expect(crop.px(1, 1)[0]).toBe(255);
    expect(crop.px(1, 6)[2]).toBe(255);
    expect(w.shape('plain').fills[0].fillImage.id).toBe(w.media.find((m) => m.name === 'pair')!.id);
    expect(w.warnings.filter((x) => x.code === 'paint-baked').map((x) => x.nodeId)).toEqual(['rot', 'crop']);
  });

  it('does not bake stroke paints (Penpot places stroke images differently per renderer)', async () => {
    const w = await write(doc([rect('s', { stroke: { paints: [tile('checker')], weight: 4, align: 'inside', join: 'miter', startCap: 'none', endCap: 'none', dashPattern: [] } })], { images }));
    expect(w.shape('s').strokes[0].strokeImage.id).toBe(w.media.find((m) => m.name === 'checker')!.id);
    expect(w.codes()).toContain('image-scale-mode-approximated');
    expect(w.codes()).not.toContain('paint-baked');
  });

  it('keeps the old approximations with bakeUnsupportedPaints: false', async () => {
    const w = await write(doc([rect('t', { fills: [tile('checker')] }), rect('a', { fills: [gradient('angular', BLACK_WHITE)] })], { images }), { bakeUnsupportedPaints: false });
    expect(w.shape('t').fills[0].fillImage.id).toBe(w.media.find((m) => m.name === 'checker')!.id);
    expect(w.shape('a').fills[0].fillColorGradient.type).toBe('linear');
    expect(w.codes()).toEqual(expect.arrayContaining(['image-scale-mode-approximated', 'gradient-approximated']));
    expect(w.codes()).not.toContain('paint-baked');
  });

  it('falls back to the approximation when the image cannot be decoded', async () => {
    const gif: ir.ImageAsset = { ref: 'gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]), mimeType: 'image/gif', width: 1, height: 1 };
    const w = await write(doc([rect('t', { fills: [tile('gif')] })], { images: { gif } }));
    expect(w.shape('t').fills[0].fillImage.mtype).toBe('image/gif');
    expect(w.codes()).toEqual(expect.arrayContaining(['paint-bake-failed', 'image-scale-mode-approximated']));
  });

  it('honours bakeScale', async () => {
    const w = await write(doc([rect('t', { size: { width: 10, height: 6 }, fills: [tile('checker')] })], { images }), { bakeScale: 3 });
    expect([w.shape('t').fills[0].fillImage.width, w.shape('t').fills[0].fillImage.height]).toEqual([30, 18]);
  });

  it('is deterministic: the same document gives identical bytes', async () => {
    const document = doc([
      rect('t', { size: { width: 30, height: 20 }, fills: [tile('checker', { scalingFactor: 0.7, rotation: 270 })] }),
      rect('a', { size: { width: 30, height: 20 }, fills: [gradient('angular', BLACK_WHITE)] }),
      pathNode('p', [square(0, 0, 10, 6)], { transform: rotateAbout(30, 20, 0), size: { width: 10, height: 6 }, fills: [gradient('diamond', BLACK_WHITE), solid(0, 0, 0, 0.2)] }),
    ], { images });
    const a = await write(document);
    const b = await write(document);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    for (const [path, data] of Object.entries(a.files)) {
      if (/\/media\/[^/]+\.json$/.test(path)) expect(JSON.parse(strFromU8(data)).createdAt).toBe('1970-01-01T00:00:00+00:00');
    }
    expect(Object.keys(unzipSync(a.bytes)).filter((p) => p.startsWith('objects/') && p.endsWith('.png'))).toHaveLength(3);
  });
});
