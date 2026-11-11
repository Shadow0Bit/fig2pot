import { crc32 } from 'node:zlib';
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { sniffImage } from '../../src/fig/translate/images.ts';
import type * as ir from '../../src/ir.ts';
import { downsamplePng, MAX_VARIANTS, variantSize } from '../../src/penpot/downsample.ts';
import { decodeImage, fromStraight8, orient } from '../../src/penpot/raster.ts';
import { exifOrientation } from '../../src/util/exif.ts';
import { componentProblems, doc, frame, rect, translate, write } from './helpers.ts';

/** A `width` × `height` PNG of 1 px vertical black / white lines (black at even columns). */
function grating(ref: string, width = 64, height = 64): ir.ImageAsset {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) png.data.set(x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * width + x) * 4);
  return { ref, bytes: new Uint8Array(PNG.sync.write(png)), mimeType: 'image/png', width, height };
}

const image = (ref: string, extra: Partial<ir.ImagePaint> = {}): ir.ImagePaint => ({ type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: ref, scaleMode: 'fill', ...extra });

const decoded = (bytes: Uint8Array): { width: number; height: number; data: Uint8Array } => PNG.sync.read(Buffer.from(bytes));

type Written = Awaited<ReturnType<typeof write>>;
const stored = (w: Written, mediaName: string): Uint8Array => {
  const media = w.media.find((m) => m.name === mediaName)!;
  const path = Object.keys(w.files).find((p) => p.startsWith(`objects/${media.mediaId}.`) && !p.endsWith('.json'))!;
  return w.files[path]!;
};

describe('reduced image copies', () => {
  it('reduces only pictures shown below 1 / scale of their size, never enlarging', () => {
    expect(variantSize({ width: 200, height: 100 }, { width: 40, height: 20 }, 2)).toEqual({ width: 80, height: 40 });
    expect(variantSize({ width: 200, height: 100 }, { width: 100, height: 50 }, 2)).toBeUndefined();
    // A stretched crop that enlarges one axis keeps the original.
    expect(variantSize({ width: 200, height: 100 }, { width: 40, height: 60 }, 2)).toBeUndefined();
    expect(variantSize({ width: 200, height: 100 }, { width: 40, height: 20 }, 1)).toEqual({ width: 40, height: 20 });
    // Whole displayed pixels × an integer scale (the renderer's halved mip level is the displayed size)…
    expect(variantSize({ width: 200, height: 100 }, { width: 40.4, height: 20.6 }, 2)).toEqual({ width: 80, height: 42 });
    // …else plain rounding.
    expect(variantSize({ width: 200, height: 100 }, { width: 40.4, height: 20.6 }, 1.5)).toEqual({ width: 61, height: 31 });
  });

  it('area-averages (box filter, premultiplied)', () => {
    // 4×1: opaque red, transparent, white, black → 2×1.
    const src = fromStraight8(4, 1, [255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255]);
    const out = decoded(downsamplePng(src, 2, 1));
    expect([...out.data]).toEqual([255, 0, 0, 128, 128, 128, 128, 255]);
  });

  it('stores a copy at bakeScale × the displayed size, placed by an explicit box, without the unused original', async () => {
    const d = doc([rect('r', { size: { width: 8, height: 8 }, fills: [image('g')] })], { images: { g: grating('g') } });
    const w = await write(d);
    const fill = w.shape('r').fills[0].fillImage;
    expect(fill).toMatchObject({ width: 16, height: 16, keepAspectRatio: false, transform: { x: 0, y: 0, width: 1, height: 1 }, name: 'g@16x16' });
    expect(w.media.map((m) => m.name)).toEqual(['g@16x16']);
    // Every copy pixel averages 4 grating columns: mid grey.
    const px = decoded(stored(w, 'g@16x16'));
    expect(px.width).toBe(16);
    expect(new Set([...px.data].filter((_, i) => i % 4 === 0))).toEqual(new Set([128]));
    const again = await write(d);
    expect(again.bytes).toEqual(w.bytes);
  });

  it('keeps the original when disabled or when shown at ≥ 1 / bakeScale', async () => {
    const off = await write(doc([rect('r', { size: { width: 8, height: 8 }, fills: [image('g')] })], { images: { g: grating('g') } }), { downsampleImages: false });
    expect(off.shape('r').fills[0].fillImage).toMatchObject({ width: 64, height: 64, keepAspectRatio: true });
    const big = await write(doc([rect('r', { size: { width: 40, height: 40 }, fills: [image('g')] })], { images: { g: grating('g') } }));
    expect(big.shape('r').fills[0].fillImage).toMatchObject({ width: 64, height: 64, keepAspectRatio: true });
  });

  it('reduces crops per axis and keeps their picture box', async () => {
    // The left half of the image fills an 8×8 rect: the picture is 16 × 8 px for 64 × 64 source px.
    const crop = image('g', { scaleMode: 'crop', imageTransform: { a: 0.5, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    const w = await write(doc([rect('c', { size: { width: 8, height: 8 }, fills: [crop] })], { images: { g: grating('g') } }));
    expect(w.shape('c').fills[0].fillImage).toMatchObject({ width: 32, height: 16, keepAspectRatio: false, transform: { x: 0, y: 0, width: 2, height: 1 } });
  });

  it('shares one copy per size and bounds the number of copies per image', async () => {
    const sizes = Array.from({ length: MAX_VARIANTS + 2 }, (_, i) => 4 + i);
    const nodes = [
      rect('a', { size: { width: 8, height: 8 }, fills: [image('g')] }),
      rect('b', { size: { width: 8, height: 8 }, transform: translate(20, 0), fills: [image('g')] }),
      ...sizes.map((s, i) => rect(`s${i}`, { size: { width: s, height: s }, transform: translate(0, 20 + 20 * i), fills: [image('g')] })),
    ];
    const w = await write(doc(nodes, { images: { g: grating('g') } }));
    expect(w.shape('a').fills[0].fillImage.id).toBe(w.shape('b').fills[0].fillImage.id);
    // 4…13 px → copies of 8…26 px (rects a and b share the 16 px one); the sizes beyond the cap use the original.
    expect(w.media.filter((m) => m.name.startsWith('g@'))).toHaveLength(MAX_VARIANTS);
    expect(w.media.some((m) => m.name === 'g')).toBe(true);
  });
});

describe('reduced copies in components, styles and the warnings', () => {
  const def = (id: string, name: string): ir.ComponentDef => ({ id, name, remote: false });
  const main = (): ir.FrameNode => frame('10:1', [rect('10:2', { size: { width: 8, height: 8 }, fills: [image('g')] })], { componentId: 'C1', role: 'component', size: { width: 8, height: 8 } });
  const copy = (id: string, size: number, x: number, paint = image('g')): ir.FrameNode =>
    frame(id, [rect(`${id};10:2`, { componentRef: '10:2', size: { width: size, height: size }, fills: [paint] })], { instanceOf: 'C1', role: 'instance', transform: translate(x, 0), size: { width: size, height: size } });

  it("does not mark a copy shown at another size as a fill override: the source paint is compared, not the stored copy", async () => {
    const w = await write(
      doc([main(), copy('I1', 4, 20), copy('I2', 24, 40), copy('I3', 8, 80, image('g', { opacity: 0.5 }))], { images: { g: grating('g') }, components: { C1: def('C1', 'Avatar') } }),
    );
    expect(componentProblems(w)).toEqual([]);
    // Smaller: its own 8 px copy, untouched (a sync would give it the main's sharper 16 px copy).
    expect(w.shape('I1;10:2').fills[0].fillImage).toMatchObject({ name: 'g@8x8' });
    expect(w.shape('I1;10:2').touched ?? []).not.toContain('fill-group');
    // Larger than the main: a sync would replace its 48 px copy with the main's 16 px one, so it keeps it (touched).
    expect(w.shape('I2;10:2').fills[0].fillImage).toMatchObject({ name: 'g@48x48' });
    expect(w.shape('I2;10:2').touched).toContain('fill-group');
    // A real override (another paint) still is one.
    expect(w.shape('I3;10:2').touched).toContain('fill-group');
  });

  it('keeps the full-size original for a paint linked to a library colour, the image the colour holds', async () => {
    const style: ir.ColorStyle = { id: 'S:img', name: 'Pictures/Grating', paints: [image('g')] };
    const w = await write(doc([rect('r', { size: { width: 8, height: 8 }, fills: [image('g', { styleId: 'S:img' })] }), rect('plain', { transform: translate(20, 0), size: { width: 8, height: 8 }, fills: [image('g')] })], { images: { g: grating('g') }, styles: { colors: [style], typographies: [] } }));
    const linked = w.shape('r').fills[0];
    expect(linked.fillColorRefId).toBe(w.colors[0]!.id);
    expect(linked.fillImage.id).toBe(w.colors[0]!.image.id);
    expect(linked.fillImage).toMatchObject({ width: 64, height: 64 });
    // An unlinked use of the same image is still reduced.
    expect(w.shape('plain').fills[0].fillImage).toMatchObject({ name: 'g@16x16' });
  });

  it('says once per document that images were reduced (how many, the bytes saved, how to turn it off), and when the copies per image are capped', async () => {
    const sizes = Array.from({ length: MAX_VARIANTS + 2 }, (_, i) => 4 + i);
    const nodes = [rect('h', { size: { width: 4, height: 4 }, transform: translate(0, -20), fills: [image('h')] }), ...sizes.map((s, i) => rect(`s${i}`, { size: { width: s, height: s }, transform: translate(0, 20 * i), fills: [image('g')] }))];
    const w = await write(doc(nodes, { images: { g: grating('g'), h: grating('h', 256, 256) } }));
    const summary = w.warnings.filter((x) => x.code === 'images-downsampled');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.message).toMatch(/^2 images are shown much smaller .* \(for 1 of them the full-size original is not stored: nothing shows it\); the file is [\d.]+ MB (smaller|larger)\. .*--no-downsample/);
    expect(summary[0]!.nodeId).toBeUndefined();
    expect(w.warnings.filter((x) => x.code === 'image-variants-capped').map((x) => x.message)).toEqual([expect.stringMatching(/^Image g is shown at more than 8 sizes/)]);
    const off = await write(doc(nodes, { images: { g: grating('g'), h: grating('h', 256, 256) } }), { downsampleImages: false });
    expect(off.codes()).not.toContain('images-downsampled');
  });
});

describe('EXIF orientation', () => {
  /** A 3 × 1 PNG (red, green, blue) carrying an eXIf chunk with `orientation`. */
  function oriented(orientation: number): Uint8Array {
    const p = new PNG({ width: 3, height: 1 });
    p.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const plain = new Uint8Array(PNG.sync.write(p));
    const tiff = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    const chunk = Buffer.alloc(12 + tiff.length);
    chunk.writeUInt32BE(tiff.length, 0);
    chunk.write('eXIf', 4, 'latin1');
    chunk.set(tiff, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + tiff.length)), 8 + tiff.length);
    // After IHDR (8 + 25 bytes).
    return new Uint8Array(Buffer.concat([plain.subarray(0, 33), chunk, plain.subarray(33)]));
  }

  it('reads the orientation of PNG and JPEG files and reports the displayed size', () => {
    expect(exifOrientation(oriented(6), 'image/png')).toBe(6);
    expect(exifOrientation(oriented(1), 'image/png')).toBe(1);
    expect(exifOrientation(new Uint8Array([1, 2, 3]), 'image/png')).toBe(1);
    expect(sniffImage(oriented(6))).toEqual({ mimeType: 'image/png', width: 1, height: 3 });
    expect(sniffImage(oriented(3))).toEqual({ mimeType: 'image/png', width: 3, height: 1 });
    const jpeg = encodeJpeg({ width: 3, height: 1, data: new Uint8Array(12).fill(255) }, 90).data;
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0];
    const app1 = [0xff, 0xe1, 0, 2 + 6 + tiff.length, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const withExif = new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
    expect(exifOrientation(withExif, 'image/jpeg')).toBe(8);
    expect(sniffImage(withExif)).toMatchObject({ mimeType: 'image/jpeg', width: 1, height: 3 });
  });

  it('reads the orientation stored as a single BYTE or LONG, not only as a SHORT', () => {
    const png = (tiff: number[]): Uint8Array => {
      const p = new PNG({ width: 3, height: 1 });
      const plain = new Uint8Array(PNG.sync.write(p));
      const chunk = Buffer.alloc(12 + tiff.length);
      chunk.writeUInt32BE(tiff.length, 0);
      chunk.write('eXIf', 4, 'latin1');
      chunk.set(tiff, 8);
      chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + tiff.length)), 8 + tiff.length);
      return new Uint8Array(Buffer.concat([plain.subarray(0, 33), chunk, plain.subarray(33)]));
    };
    // Big-endian IFD0 with one entry: tag 0x0112, `type`, `count`, value field.
    const entry = (type: number, count: number, value: number[]): number[] => [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, type, 0, 0, 0, count, ...value, 0, 0, 0, 0];
    expect(exifOrientation(png(entry(4, 1, [0, 0, 0, 6])), 'image/png')).toBe(6);
    expect(exifOrientation(png(entry(1, 1, [8, 0, 0, 0])), 'image/png')).toBe(8);
    expect(exifOrientation(png(entry(3, 1, [0, 5, 0, 0])), 'image/png')).toBe(5);
    // Little-endian LONG.
    expect(exifOrientation(png([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 4, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]), 'image/png')).toBe(3);
    // Two values, another type (RATIONAL), or an out-of-range value: no orientation.
    expect(exifOrientation(png(entry(3, 2, [0, 6, 0, 6])), 'image/png')).toBe(1);
    expect(exifOrientation(png(entry(5, 1, [0, 0, 0, 6])), 'image/png')).toBe(1);
    expect(exifOrientation(png(entry(4, 1, [0, 1, 0, 6])), 'image/png')).toBe(1);
  });

  it('stores an oriented PNG with turned pixels and no eXIf chunk, a JPEG with its EXIF', async () => {
    const bytes = oriented(6);
    const asset: ir.ImageAsset = { ref: 'p', bytes, ...sniffImage(bytes) };
    const jpeg = encodeJpeg({ width: 3, height: 1, data: new Uint8Array(12).fill(255) }, 90).data;
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0];
    const app1 = [0xff, 0xe1, 0, 2 + 6 + tiff.length, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const jpegBytes = new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
    const jpegAsset: ir.ImageAsset = { ref: 'j', bytes: jpegBytes, ...sniffImage(jpegBytes) };
    for (const options of [{}, { convertImageProfiles: false, downsampleImages: false }]) {
      const w = await write(
        doc([rect('r', { size: { width: 1, height: 3 }, fills: [image('p')] }), rect('s', { size: { width: 1, height: 3 }, fills: [image('j')] })], { images: { p: asset, j: jpegAsset } }),
        options,
      );
      const out = stored(w, 'p');
      expect(exifOrientation(out, 'image/png')).toBe(1);
      expect(Buffer.from(out).includes(Buffer.from('eXIf', 'latin1'))).toBe(false);
      const png = decoded(out);
      expect([png.width, png.height]).toEqual([1, 3]);
      // Red on top, blue at the bottom: orientation 6 turns the strip clockwise.
      expect([...png.data.subarray(0, 4), ...png.data.subarray(8, 12)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
      expect(exifOrientation(stored(w, 'j'), 'image/jpeg')).toBe(8);
    }
  });

  it('applies it when decoding for reduced copies and baked bitmaps, like the renderers drawing the original', () => {
    // Orientation 6: turned clockwise, so the 3 × 1 strip stands red (top), green, blue (bottom).
    const turned = decodeImage(oriented(6), 'image/png', undefined, 6)!;
    expect([turned.width, turned.height]).toEqual([1, 3]);
    expect([...turned.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const mirrored = orient({ width: 3, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) }, 2);
    expect([...mirrored.rgba]).toEqual([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    const ccw = orient({ width: 3, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) }, 8);
    expect([...ccw.rgba]).toEqual([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
  });

  it('draws an oriented image the same in a reduced copy as the original would show', async () => {
    // An 8 × 128 strip, left half black, right half white, orientation 6: displayed 128 wide, 8 tall, black on top.
    const p = new PNG({ width: 8, height: 128 });
    for (let y = 0; y < 128; y++) for (let x = 0; x < 8; x++) p.data.set(x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * 8 + x) * 4);
    const plain = new Uint8Array(PNG.sync.write(p));
    const tiff = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    const chunk = Buffer.alloc(12 + tiff.length);
    chunk.writeUInt32BE(tiff.length, 0);
    chunk.write('eXIf', 4, 'latin1');
    chunk.set(tiff, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + tiff.length)), 8 + tiff.length);
    const bytes = new Uint8Array(Buffer.concat([plain.subarray(0, 33), chunk, plain.subarray(33)]));
    const asset: ir.ImageAsset = { ref: 'o', bytes, ...sniffImage(bytes) };
    expect([asset.width, asset.height]).toEqual([128, 8]);
    const w = await write(doc([rect('r', { size: { width: 32, height: 2 }, fills: [image('o')] })], { images: { o: asset } }));
    const copy = decoded(stored(w, 'o@64x4'));
    expect([copy.width, copy.height]).toEqual([64, 4]);
    expect([...copy.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...copy.data.subarray(64 * 4 * 3, 64 * 4 * 3 + 4)]).toEqual([255, 255, 255, 255]);
  });
});
