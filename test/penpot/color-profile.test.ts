import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import {
  convertRgba8,
  evalCurve,
  jpegColorEncoding,
  parseIcc,
  pngChunks,
  pngColorEncoding,
  SRGB_TO_XYZ_D50,
  stripJpegProfile,
  type Curve,
  type RgbProfile,
} from '../../src/penpot/color-profile.ts';
import { BakeCache, bakePaint } from '../../src/penpot/bake.ts';
import { boxSpace } from '../../src/penpot/fills.ts';
import { prepareImage } from '../../src/penpot/image-color.ts';
import { doc, rect, write } from './helpers.ts';

import { chunk, columns, DISPLAY_P3, icc, iccp, P3_D50, png, SRGB_PARA, u32, type CurveSpec } from './icc-fixtures.ts';

const pixelsOf = (bytes: Uint8Array): number[][] => {
  const p = PNG.sync.read(Buffer.from(bytes));
  const out: number[][] = [];
  for (let i = 0; i < p.data.length; i += 4) out.push([...p.data.subarray(i, i + 4)]);
  return out;
};

const asset = (ref: string, bytes: Uint8Array, extra: Partial<ir.ImageAsset> = {}, mimeType: ir.ImageAsset['mimeType'] = 'image/png'): ir.ImageAsset => ({ ref, bytes, mimeType, width: 2, height: 1, ...extra });

function convert(profile: RgbProfile, rgb: number[], alpha = 255): number[] {
  const px = new Uint8Array([...rgb, alpha]);
  convertRgba8(px, profile);
  return [...px];
}

function rgbProfile(bytes: Uint8Array): RgbProfile {
  const enc = parseIcc(bytes);
  if (enc.kind !== 'rgb') throw new Error(`expected an RGB profile, got ${JSON.stringify(enc)}`);
  return enc.profile;
}

// --- ICC parsing --------------------------------------------------------------------

describe('ICC profiles', () => {
  it('evaluates curv (identity, gamma, table) and para curves', () => {
    const curves = (spec: CurveSpec): Curve => rgbProfile(icc({ colorants: columns(P3_D50), curves: [spec, spec, spec] })).curves[0];
    expect(evalCurve(rgbProfile(icc({ colorants: columns(P3_D50), curves: [{ table: [] }, { table: [] }, { table: [] }] })).curves[0], 0.3)).toBeCloseTo(0.3, 6);
    expect(evalCurve(curves({ gamma: 1.8 }), 0.5)).toBeCloseTo(0.5 ** (461 / 256), 6);
    // A 3-entry table is interpolated linearly.
    expect(evalCurve(curves({ table: [0, 0.25, 1] }), 0.75)).toBeCloseTo(0.625, 4);
    expect(evalCurve(curves({ para: 0, params: [2.2] }), 0.5)).toBeCloseTo(0.5 ** 2.2, 4);
    // Type 1: (a·x + b)^g above −b/a, 0 below.
    expect(evalCurve(curves({ para: 1, params: [2, 1, -0.2] }), 0.1)).toBe(0);
    expect(evalCurve(curves({ para: 1, params: [2, 1, -0.2] }), 0.6)).toBeCloseTo(0.16, 4);
    // Type 2 adds c.
    expect(evalCurve(curves({ para: 2, params: [2, 1, -0.2, 0.1] }), 0.1)).toBeCloseTo(0.1, 4);
    expect(evalCurve(curves({ para: 2, params: [2, 1, -0.2, 0.1] }), 0.6)).toBeCloseTo(0.26, 4);
    // Type 3 is sRGB's shape.
    const srgb3 = curves({ para: 3, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] });
    expect(evalCurve(srgb3, 0.02)).toBeCloseTo(0.02 / 12.92, 5);
    expect(evalCurve(srgb3, 0.5)).toBeCloseTo(0.214, 3);
    // Type 4 adds e above and f below d.
    const t4 = curves({ para: 4, params: [1, 1, 0, 0.5, 0.5, 0.1, 0.05] });
    expect(evalCurve(t4, 0.2)).toBeCloseTo(0.15, 4);
    expect(evalCurve(t4, 0.8)).toBeCloseTo(0.9, 4);
  });

  it('reads the colorant matrix as stored (already adapted to D50, chad or not)', () => {
    const chad = Buffer.alloc(44);
    chad.write('sf32', 0, 'latin1');
    const p = rgbProfile(icc({ colorants: columns(P3_D50), curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA], extraTags: { chad } }));
    p.toXyzD50.forEach((v, i) => expect(v).toBeCloseTo(P3_D50[i]!, 4));
    // The colorants of a valid profile sum to the D50 white.
    expect(p.toXyzD50[0]! + p.toXyzD50[1]! + p.toXyzD50[2]!).toBeCloseTo(0.9642, 3);
  });

  it('converts Display P3 to sRGB like ColorSync and Chromium (relative colorimetric, clipped)', () => {
    const p3 = rgbProfile(DISPLAY_P3);
    // Expected values: macOS ColorSync (`sips -m "sRGB Profile.icc"`) from /System/…/Display P3.icc; the
    // (69,151,247) row is also what Chromium (Penpot's SVG renderer) drew for that pixel.
    const cases: [number[], number[]][] = [
      [[234, 51, 35], [255, 0, 0]],
      [[69, 151, 247], [11, 153, 255]],
      [[200, 100, 50], [215, 93, 31]],
      [[30, 30, 200], [30, 30, 208]],
      [[10, 200, 30], [0, 204, 0]],
      [[128, 128, 128], [128, 128, 128]],
      [[255, 255, 255], [255, 255, 255]],
      [[0, 0, 0], [0, 0, 0]],
    ];
    for (const [input, expected] of cases) {
      const out = convert(p3, input).slice(0, 3);
      out.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${input} → ${out}, expected ${expected}`).toBeLessThanOrEqual(1));
    }
  });

  it('recognises sRGB by its primaries and curves, whatever the name or curve encoding', () => {
    const table = Array.from({ length: 1024 }, (_, i) => {
      const v = i / 1023;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    expect(parseIcc(icc({ colorants: columns(SRGB_TO_XYZ_D50), curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] })).kind).toBe('srgb');
    expect(parseIcc(icc({ colorants: columns(SRGB_TO_XYZ_D50), curves: [{ table }, { table }, { table }], version: 2 })).kind).toBe('srgb');
    // Same primaries, gamma 2.2: not sRGB (up to 4 levels apart in the shadows).
    expect(parseIcc(icc({ colorants: columns(SRGB_TO_XYZ_D50), curves: [{ gamma: 2.2 }, { gamma: 2.2 }, { gamma: 2.2 }] })).kind).toBe('rgb');
    expect(parseIcc(DISPLAY_P3).kind).toBe('rgb');
  });

  it('reports what it cannot convert', () => {
    expect(parseIcc(icc({ space: 'GRAY' }))).toMatchObject({ kind: 'unsupported', reason: 'GRAY colour space' });
    expect(parseIcc(icc({ space: 'CMYK' }))).toMatchObject({ kind: 'unsupported', reason: 'CMYK colour space' });
    expect(parseIcc(icc({ extraTags: { A2B0: Buffer.from('mft2xxxx') } }))).toMatchObject({ kind: 'unsupported', reason: 'LUT-based profile' });
    expect(parseIcc(new Uint8Array(40))).toMatchObject({ kind: 'unsupported', reason: 'truncated profile' });
  });

  it('converts colour channels only, in straight alpha', () => {
    const p3 = rgbProfile(DISPLAY_P3);
    expect(convert(p3, [69, 151, 247], 128)).toEqual([11, 153, 255, 128]);
    expect(convert(p3, [69, 151, 247], 0)[3]).toBe(0);
  });
});

// --- PNG / JPEG tags ----------------------------------------------------------------

describe('PNG colour chunks', () => {
  const px = [[69, 151, 247, 255]];
  const rgbOf = (bytes: Uint8Array): number[] => {
    const enc = pngColorEncoding(bytes);
    if (enc.kind !== 'rgb') throw new Error(enc.kind);
    return convert(enc.profile, px[0]!.slice(0, 3)).slice(0, 3);
  };

  it('reads gAMA and cHRM (values Chromium drew for the same files)', () => {
    expect(rgbOf(png(px, [chunk('gAMA', u32(55556))]))).toEqual([87, 168, 249]);
    expect(rgbOf(png(px, [chunk('gAMA', u32(55556)), chunk('cHRM', u32(31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000))]))).toEqual([87, 168, 249]);
    expect(rgbOf(png(px, [chunk('gAMA', u32(45455)), chunk('cHRM', u32(31270, 32900, 68000, 32000, 26500, 69000, 15000, 6000))]))).toEqual([0, 155, 255]);
  });

  it('follows the PNG precedence: cICP, iCCP, sRGB, gAMA/cHRM', () => {
    expect(pngColorEncoding(png(px)).kind).toBe('untagged');
    expect(pngColorEncoding(png(px, [chunk('sRGB', new Uint8Array([0])), chunk('gAMA', u32(45455))]))).toEqual({ kind: 'srgb', source: 'PNG sRGB' });
    expect(pngColorEncoding(png(px, [iccp(DISPLAY_P3), chunk('sRGB', new Uint8Array([0]))])).kind).toBe('rgb');
    // cICP Display P3 + sRGB transfer = the Display P3 profile.
    expect(rgbOf(png(px, [chunk('cICP', new Uint8Array([12, 13, 0, 1])), iccp(icc({ colorants: columns(SRGB_TO_XYZ_D50), curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] }))]))).toEqual([11, 153, 255]);
    expect(pngColorEncoding(png(px, [chunk('cICP', new Uint8Array([1, 13, 0, 1]))])).kind).toBe('srgb');
    expect(pngColorEncoding(png(px, [chunk('cICP', new Uint8Array([9, 16, 0, 1]))]))).toMatchObject({ kind: 'unsupported', reason: 'transfer characteristics 16' });
  });
});

describe('JPEG ICC profiles', () => {
  const jpeg = new Uint8Array(encodeJpeg({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 128) }, 90).data);
  /** The JPEG with `profile` split over APP2 segments, inserted after SOI in the order given. */
  const withProfile = (profile: Uint8Array, parts: number, order: number[]): Uint8Array => {
    const size = Math.ceil(profile.length / parts);
    const segments = order.map((k) => {
      const data = profile.subarray(k * size, (k + 1) * size);
      const seg = Buffer.alloc(18 + data.length);
      seg[0] = 0xff;
      seg[1] = 0xe2;
      seg.writeUInt16BE(16 + data.length, 2);
      seg.write('ICC_PROFILE\0', 4, 'latin1');
      seg[16] = k + 1;
      seg[17] = parts;
      Buffer.from(data).copy(seg, 18);
      return seg;
    });
    return new Uint8Array(Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), ...segments, Buffer.from(jpeg.subarray(2))]));
  };

  it('reassembles a profile split over several APP2 segments, in sequence order', () => {
    const bytes = withProfile(DISPLAY_P3, 3, [2, 0, 1]);
    const enc = jpegColorEncoding(bytes);
    expect(enc.kind).toBe('rgb');
    expect(jpegColorEncoding(jpeg).kind).toBe('untagged');
    const stripped = stripJpegProfile(bytes);
    expect(stripped).toEqual(jpeg);
    expect(jpegColorEncoding(stripped).kind).toBe('untagged');
  });

  it('converts a profiled JPEG and keeps its EXIF segment', () => {
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 10]), Buffer.from('Exif\0\0abcd', 'latin1').subarray(0, 8)]);
    const tagged = withProfile(DISPLAY_P3, 1, [0]);
    const bytes = new Uint8Array(Buffer.concat([Buffer.from(tagged.subarray(0, 2)), exif, Buffer.from(tagged.subarray(2))]));
    const out = prepareImage(asset('j', bytes, { width: 8, height: 8 }, 'image/jpeg'));
    expect(out.action).toBe('converted');
    expect(jpegColorEncoding(out.bytes).kind).toBe('untagged');
    expect(Buffer.from(out.bytes).includes(exif)).toBe(true);
    // 128 grey stays grey (white point preserved), within JPEG noise.
    const d = decodeJpeg(out.bytes, { useTArray: true });
    expect(Math.abs(d.data[0]! - 128)).toBeLessThanOrEqual(2);
  });
});

// --- writer -------------------------------------------------------------------------

describe('image colours in the writer', () => {
  const px = [[69, 151, 247, 255], [10, 20, 30, 100]];
  const exif = chunk('eXIf', Buffer.from('MM\0*\0\0\0\x08\0\0', 'latin1'));
  const idot = chunk('iDOT', u32(2, 0, 1, 40));
  const tagged = png(px, [iccp(DISPLAY_P3), exif, idot]);

  it('drops an ignored profile losslessly', () => {
    const out = prepareImage(asset('a', tagged, { ignoresEmbeddedProfile: true }));
    expect(out.action).toBe('stripped');
    const types = pngChunks(out.bytes)!.map((c) => c.type);
    expect(types).not.toContain('iCCP');
    expect(types).not.toContain('iDOT');
    expect(types).toContain('eXIf');
    expect(pixelsOf(out.bytes)).toEqual(px);
  });

  it('converts an applied profile and keeps alpha', () => {
    const out = prepareImage(asset('a', tagged));
    expect(out.action).toBe('converted');
    expect(pngColorEncoding(out.bytes).kind).toBe('untagged');
    expect(pngChunks(out.bytes)!.map((c) => c.type)).toContain('eXIf');
    const [first, second] = pixelsOf(out.bytes);
    expect(first).toEqual([11, 153, 255, 255]);
    expect(second![3]).toBe(100);
  });

  it('converts 16-bit PNGs at 8 bits and keeps them 16-bit when only stripping', () => {
    const p = new PNG({ width: 2, height: 1, bitDepth: 16, colorType: 6, inputColorType: 6, inputHasAlpha: true });
    p.data = Buffer.from(new Uint16Array([69 * 257, 151 * 257, 247 * 257, 65535, 1000, 2000, 3000, 32768]).buffer);
    const plain = new Uint8Array(PNG.sync.write(p, { bitDepth: 16, colorType: 6, inputColorType: 6 }));
    const chunks = pngChunks(plain)!;
    const raw = (c: { data: Uint8Array }): Uint8Array => new Uint8Array(c.data.buffer, c.data.byteOffset - 8, c.data.length + 12);
    const tagged16 = new Uint8Array(Buffer.concat([Buffer.from(plain.subarray(0, 8)), raw(chunks[0]!), iccp(DISPLAY_P3), ...chunks.slice(1).map(raw)]));
    const converted = prepareImage(asset('a', tagged16));
    expect(converted.action).toBe('converted');
    expect(pixelsOf(converted.bytes)).toEqual([[11, 153, 255, 255], expect.arrayContaining([128])]);
    expect(pixelsOf(converted.bytes)[1]![3]).toBe(128);
    const stripped = prepareImage(asset('a', tagged16, { ignoresEmbeddedProfile: true }));
    expect(stripped.action).toBe('stripped');
    expect(stripped.bytes[24]).toBe(16);
  });

  it('ignores gAMA / cHRM like ICC profiles when the source does (Figma files without a colour profile), applies them otherwise', () => {
    const chrm = chunk('cHRM', u32(31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000));
    const gamma = png(px, [chunk('gAMA', u32(55556)), chrm]);
    const ignored = prepareImage(asset('a', gamma, { ignoresEmbeddedProfile: true }));
    expect(ignored.action).toBe('stripped');
    expect(pngChunks(ignored.bytes)!.map((c) => c.type)).not.toContain('gAMA');
    expect(pngChunks(ignored.bytes)!.map((c) => c.type)).not.toContain('cHRM');
    expect(pixelsOf(ignored.bytes)).toEqual(px);
    const applied = prepareImage(asset('a', png(px, [chunk('gAMA', u32(55556))])));
    expect(applied.action).toBe('converted');
    expect(pixelsOf(applied.bytes)[0]).toEqual([87, 168, 249, 255]);
  });

  it('leaves untagged and sRGB images alone, and strips sRGB-equivalent profiles', () => {
    const plain = png(px);
    expect(prepareImage(asset('a', plain)).bytes).toBe(plain);
    const srgbChunk = png(px, [chunk('sRGB', new Uint8Array([0]))]);
    expect(prepareImage(asset('a', srgbChunk)).bytes).toBe(srgbChunk);
    const srgbIcc = png(px, [iccp(icc({ colorants: columns(SRGB_TO_XYZ_D50), curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] }))]);
    const out = prepareImage(asset('a', srgbIcc));
    expect(out.action).toBe('stripped');
    expect(pixelsOf(out.bytes)).toEqual(px);
  });

  const image = (ref: string): ir.ImagePaint => ({ type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: ref, scaleMode: 'fill' });
  const stored = (w: Awaited<ReturnType<typeof write>>, ref: string): Uint8Array => {
    const media = w.media.find((m) => m.name === ref)!;
    const path = Object.keys(w.files).find((p) => p.startsWith(`objects/${media.mediaId}.`) && !p.endsWith('.json'))!;
    return w.files[path]!;
  };

  it('stores converted bytes, deterministically, and the source bytes with convertImageProfiles: false', async () => {
    const d = doc([rect('r', { size: { width: 2, height: 1 }, fills: [image('p3')] })], { images: { p3: asset('p3', tagged) } });
    const a = await write(d);
    const b = await write(d);
    expect(a.bytes).toEqual(b.bytes);
    expect(pixelsOf(stored(a, 'p3'))[0]).toEqual([11, 153, 255, 255]);
    const off = await write(d, { convertImageProfiles: false });
    expect(stored(off, 'p3')).toEqual(tagged);
  });

  it('warns about a profile it cannot convert and keeps the bytes', async () => {
    const cmyk = png(px, [iccp(icc({ space: 'CMYK' }))]);
    const d = doc([rect('r', { size: { width: 2, height: 1 }, fills: [image('c')] })], { images: { c: asset('c', cmyk) } });
    const w = await write(d);
    expect(w.codes()).toContain('image-profile-unsupported');
    expect(stored(w, 'c')).toEqual(cmyk);
    expect(strFromU8(unzipSync(w.bytes)['manifest.json']!)).toBeTruthy();
  });

  it('bakes the converted colours', () => {
    const images = { p3: asset('p3', png([[69, 151, 247, 255]], [iccp(DISPLAY_P3)]), { width: 1, height: 1 }) };
    const paint: ir.ImagePaint = { ...image('p3'), scaleMode: 'tile', scalingFactor: 1 };
    const target = { node: { id: 'n', name: 'n' }, size: { width: 2, height: 2 }, space: boxSpace(2, 2) };
    const baked = (convertProfiles: boolean): number[] => {
      const out = bakePaint(new BakeCache(images, { convertProfiles }), paint, target, { scale: 1, opacity: 1 });
      if (!out.ok) throw new Error(out.reason);
      return pixelsOf(out.image.png)[0]!;
    };
    expect(baked(true)).toEqual([11, 153, 255, 255]);
    expect(baked(false)).toEqual([69, 151, 247, 255]);
  });
});
