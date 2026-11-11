/**
 * Live checks of image colours and reduced copies, in both Penpot renderers:
 * - a flat Display P3-tagged PNG: Penpot 2.19's SVG renderer (Chromium) applies the profile, the WASM
 *   renderer ignores it (bytes as stored, which the backend keeps unchanged); the writer's plain-sRGB
 *   output shows the same colour in both, whether the source ignores the profile (Figma files without a
 *   colour profile) or applies it;
 * - a 1 px line grating shown at 0.25×: with the area-averaged copy both renderers show Figma's flat grey;
 * - EXIF orientation 6 on a 40 × 20 PNG (`eXIf`) and JPEG (APP1): the SVG renderer honours both, the WASM
 *   renderer only the JPEG's; with the PNG stored re-encoded with turned pixels both draw both turned.
 *
 * Runs only with PENPOT_LIVE=1 (see render.ts).
 */
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { frame, rect, solid, translate } from '../helpers.ts';
import { chunk, DISPLAY_P3, iccp, png, u32 } from '../icc-fixtures.ts';
import { LIVE, renderFor, rgb, type Img, type Rendered } from './render.ts';

const BLUE = [69, 151, 247, 255];
const flat = (extra: Buffer[]): Uint8Array => png(Array.from({ length: 40 * 40 }, () => BLUE), extra, 40);
const asset = (ref: string, bytes: Uint8Array, extra: Partial<ir.ImageAsset> = {}): ir.ImageAsset => ({ ref, bytes, mimeType: 'image/png', width: 40, height: 40, ...extra });

function grating(): ir.ImageAsset {
  const p = new PNG({ width: 128, height: 128 });
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) p.data.set(x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * 128 + x) * 4);
  return { ref: 'grating', bytes: new Uint8Array(PNG.sync.write(p)), mimeType: 'image/png', width: 128, height: 128 };
}

/** 40 × 20 px, left half red, right half blue, with EXIF orientation 6 (turned clockwise: red on top). */
const TIFF_ORIENTATION_6 = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
const halves = Array.from({ length: 40 * 20 }, (_, i) => (i % 40 < 20 ? [230, 20, 20, 255] : [20, 20, 230, 255]));
function orientedJpeg(): Uint8Array {
  const data = new Uint8Array(40 * 20 * 4);
  halves.forEach((px, i) => data.set(px, i * 4));
  const encoded = Buffer.from(encodeJpeg({ data, width: 40, height: 20 }, 95).data);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), TIFF_ORIENTATION_6]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return new Uint8Array(Buffer.concat([encoded.subarray(0, 2), app1, encoded.subarray(2)]));
}

const images: Record<string, ir.ImageAsset> = {
  // Sizes as `sniffImage` reports them: the displayed (turned) one.
  'exif-png': asset('exif-png', png(halves, [chunk('eXIf', TIFF_ORIENTATION_6)], 40), { width: 20, height: 40 }),
  'exif-jpeg': asset('exif-jpeg', orientedJpeg(), { mimeType: 'image/jpeg', width: 20, height: 40 }),
  ignored: asset('ignored', flat([iccp(DISPLAY_P3)]), { ignoresEmbeddedProfile: true }),
  applied: asset('applied', flat([iccp(DISPLAY_P3)])),
  gamma: asset('gamma', flat([chunk('gAMA', u32(55556))])),
  'gamma-ignored': asset('gamma-ignored', flat([chunk('gAMA', u32(55556))]), { ignoresEmbeddedProfile: true }),
  grating: grating(),
};

const fill = (ref: string): ir.ImagePaint => ({ type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: ref, scaleMode: 'fill' });
const boards: ir.FrameNode[] = ['ignored', 'applied', 'gamma', 'gamma-ignored', 'grating'].map((ref, i) =>
  frame(`img-${ref}`, [rect(`img-${ref}-n`, { transform: translate(10, 10), size: { width: 32, height: 32 }, fills: [fill(ref)] })], {
    size: { width: 52, height: 52 },
    transform: translate(i * 80, 0),
    fills: [solid(1, 1, 1)],
  }),
);
for (const [i, ref] of ['exif-png', 'exif-jpeg'].entries()) {
  boards.push(
    frame(`img-${ref}`, [rect(`img-${ref}-n`, { transform: translate(10, 10), size: { width: 20, height: 40 }, fills: [fill(ref)] })], {
      size: { width: 52, height: 52 },
      transform: translate((boards.length + i) * 80, 0),
      fills: [solid(1, 1, 1)],
    }),
  );
}
const document: ir.Document = { name: 'live-images', pages: [{ id: 'live-images:page', name: 'p', kind: 'page', children: boards }], components: {}, images, styles: { colors: [], typographies: [] } };

/** Mean and spread (max − min) of the red channel over the interior of the 32 px picture. */
function interior(img: Img): { mean: number; spread: number } {
  let sum = 0;
  let n = 0;
  let min = 255;
  let max = 0;
  for (let y = 14; y < 38; y++) {
    for (let x = 14; x < 38; x++) {
      const r = rgb(img, x, y)[0];
      sum += r;
      n++;
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
  }
  return { mean: sum / n, spread: max - min };
}

describe.skipIf(!LIVE)('image colours and reduced copies in live Penpot', () => {
  const rendered: Partial<Record<'svg' | 'wasm' | 'svg-raw' | 'wasm-raw', Rendered>> = {};
  beforeAll(async () => {
    const ids = boards.map((b) => b.id);
    for (const renderer of ['svg', 'wasm'] as const) {
      rendered[renderer] = await renderFor(renderer, 'images', document, ids);
      rendered[`${renderer}-raw`] = await renderFor(renderer, 'images-raw', document, ids, { convertImageProfiles: false, downsampleImages: false });
    }
  }, 300_000);
  const img = (key: keyof typeof rendered, id: string): Img => rendered[key]!.boards.get(`img-${id}`)!;
  const near = (actual: number[], expected: number[], tolerance = 1): void => {
    actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
  };

  it('stores profiles as they are: Chromium applies them, WASM does not (why the writer converts)', () => {
    near(rgb(img('svg-raw', 'applied'), 26, 26), [11, 153, 255]);
    near(rgb(img('wasm-raw', 'applied'), 26, 26), [69, 151, 247]);
    near(rgb(img('svg-raw', 'gamma'), 26, 26), [87, 168, 249]);
    near(rgb(img('wasm-raw', 'gamma'), 26, 26), [69, 151, 247]);
  });

  /** 'R' or 'B': which of red and blue dominates at (x, y). */
  const hue = (image: Img, x: number, y: number): string => {
    const [r, , b] = rgb(image, x, y);
    return r > b ? 'R' : 'B';
  };
  /**
   * Top-left, top-right, bottom-left, bottom-right quarter of the 20 × 40 picture at (10, 10): 'RRBB' when turned
   * clockwise, 'RBRB' when the stored 40 × 20 pixels are drawn unturned (squeezed into the box).
   */
  const quarters = (image: Img): string => [hue(image, 15, 20), hue(image, 25, 20), hue(image, 15, 40), hue(image, 25, 40)].join('');

  for (const renderer of ['svg', 'wasm'] as const) {
    describe(`renderer ${renderer}`, () => {
      it('draws an EXIF-oriented PNG and JPEG turned, as browsers do, with or without colour conversion', () => {
        // The PNG is stored with turned pixels (the WASM renderer ignores eXIf); the JPEG keeps its EXIF.
        for (const key of [renderer, `${renderer}-raw`] as const) {
          expect(quarters(img(key, 'exif-png')), key).toBe('RRBB');
          expect(quarters(img(key, 'exif-jpeg')), key).toBe('RRBB');
        }
      });

      it('shows the stored values of an image whose profile (or gAMA) the source ignores', () => {
        near(rgb(img(renderer, 'ignored'), 26, 26), [69, 151, 247]);
        near(rgb(img(renderer, 'gamma-ignored'), 26, 26), [69, 151, 247]);
      });

      it('shows the converted colours of an image whose profile the source applies', () => {
        near(rgb(img(renderer, 'applied'), 26, 26), [11, 153, 255]);
        near(rgb(img(renderer, 'gamma'), 26, 26), [87, 168, 249]);
      });

      it('draws a 1 px grating shown at 0.25× as flat grey (area average), as Figma does', () => {
        const g = interior(img(renderer, 'grating'));
        expect(Math.abs(g.mean - 128)).toBeLessThanOrEqual(4);
        expect(g.spread).toBeLessThanOrEqual(6);
      });
    });
  }
});
