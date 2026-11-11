/** Builders of ICC profiles and tagged PNGs for the colour-profile tests (unit and live). */
import { PNG } from 'pngjs';
import { crc32, deflateSync } from 'node:zlib';
import { pngChunks, primariesToXyzD50 } from '../../src/penpot/color-profile.ts';

export type CurveSpec = { gamma: number } | { table: number[] } | { para: number; params: number[] };

const s15 = (v: number): number => Math.round(v * 65536);

/** A minimal ICC profile: RGB matrix/TRC (or `space`/tags of choice). */
export function icc(options: { colorants?: number[][]; curves?: CurveSpec[]; space?: string; version?: number; extraTags?: Record<string, Uint8Array> } = {}): Uint8Array {
  const tags: [string, Uint8Array][] = [];
  const xyz = (v: number[]): Uint8Array => {
    const b = Buffer.alloc(20);
    b.write('XYZ ', 0, 'latin1');
    v.forEach((x, i) => b.writeInt32BE(s15(x), 8 + 4 * i));
    return b;
  };
  const curve = (c: CurveSpec): Uint8Array => {
    if ('gamma' in c) {
      const b = Buffer.alloc(14);
      b.write('curv', 0, 'latin1');
      b.writeUInt32BE(1, 8);
      b.writeUInt16BE(Math.round(c.gamma * 256), 12);
      return b;
    }
    if ('table' in c) {
      const b = Buffer.alloc(12 + 2 * c.table.length);
      b.write('curv', 0, 'latin1');
      b.writeUInt32BE(c.table.length, 8);
      c.table.forEach((v, i) => b.writeUInt16BE(Math.round(v * 65535), 12 + 2 * i));
      return b;
    }
    const count = [1, 3, 4, 5, 7][c.para]!;
    const b = Buffer.alloc(12 + 4 * count);
    b.write('para', 0, 'latin1');
    b.writeUInt16BE(c.para, 8);
    c.params.slice(0, count).forEach((v, i) => b.writeInt32BE(s15(v), 12 + 4 * i));
    return b;
  };
  if (options.colorants) ['rXYZ', 'gXYZ', 'bXYZ'].forEach((t, i) => tags.push([t, xyz(options.colorants![i]!)]));
  if (options.curves) ['rTRC', 'gTRC', 'bTRC'].forEach((t, i) => tags.push([t, curve(options.curves![i]!)]));
  for (const [k, v] of Object.entries(options.extraTags ?? {})) tags.push([k, v]);
  const header = Buffer.alloc(132 + 12 * tags.length);
  header.writeUInt8(options.version ?? 4, 8);
  header.write('mntr', 12, 'latin1');
  header.write((options.space ?? 'RGB').padEnd(4), 16, 'latin1');
  header.write('XYZ ', 20, 'latin1');
  header.write('acsp', 36, 'latin1');
  header.writeUInt32BE(tags.length, 128);
  let offset = header.length;
  const bodies: Buffer[] = [];
  tags.forEach(([sig, data], i) => {
    header.write(sig, 132 + 12 * i, 'latin1');
    header.writeUInt32BE(offset, 136 + 12 * i);
    header.writeUInt32BE(data.length, 140 + 12 * i);
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
    Buffer.from(data).copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  const out = Buffer.concat([header, ...bodies]);
  out.writeUInt32BE(out.length, 0);
  return new Uint8Array(out);
}

export const columns = (m: readonly number[]): number[][] => [0, 1, 2].map((c) => [m[c]!, m[3 + c]!, m[6 + c]!]);
export const SRGB_PARA = { para: 4, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] };
export const D65: [number, number] = [0.3127, 0.329];
export const P3_D50 = primariesToXyzD50([0.68, 0.32], [0.265, 0.69], [0.15, 0.06], D65)!;
/** Display P3 as Apple ships it: P3 primaries, D65 white adapted to D50, sRGB tone curve. */
export const DISPLAY_P3 = icc({ colorants: columns(P3_D50), curves: [SRGB_PARA, SRGB_PARA, SRGB_PARA] });

export function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)])) >>> 0, 8 + data.length);
  return out;
}

export const u32 = (...n: number[]): Buffer => {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((x, i) => b.writeUInt32BE(x, i * 4));
  return b;
};

export const iccp = (profile: Uint8Array): Buffer => chunk('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), deflateSync(profile)]));

/** A PNG of `pixels` (straight RGBA) with `extra` chunks inserted after IHDR. */
export function png(pixels: number[][], extra: Buffer[] = [], width = pixels.length): Uint8Array {
  const p = new PNG({ width, height: pixels.length / width });
  pixels.forEach((px, i) => p.data.set(px, i * 4));
  const bytes = new Uint8Array(PNG.sync.write(p));
  const chunks = pngChunks(bytes)!;
  const raw = (c: { data: Uint8Array }): Uint8Array => new Uint8Array(c.data.buffer, c.data.byteOffset - 8, c.data.length + 12);
  return new Uint8Array(Buffer.concat([Buffer.from(bytes.subarray(0, 8)), raw(chunks[0]!), ...extra, ...chunks.slice(1).map(raw)]));
}

