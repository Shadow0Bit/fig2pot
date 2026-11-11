/**
 * Colour information embedded in PNG / JPEG files, and its conversion to
 * sRGB, so that image fills look the same in both Penpot renderers (the SVG
 * renderer — Chromium — applies an embedded profile, the WASM renderer
 * ignores it; measured on 2.19, `test/penpot/live/images.test.ts`).
 *
 * Supported, dependency-free:
 * - ICC v2 / v4 matrix/TRC RGB profiles: `rXYZ`/`gXYZ`/`bXYZ` colorants (PCS
 *   XYZ, D50; v4 and Apple v2 profiles store them already adapted, a `chad`
 *   tag only documents that adaptation, so the colorants are used as they
 *   are — as lcms and skcms do) and `rTRC`/`gTRC`/`bTRC` as `curv` (identity,
 *   gamma or table) or `para` (functions 0–4). Relative colorimetric, clipped
 *   to the sRGB gamut, like Chromium.
 * - PNG `cICP` (BT.709 / Display P3 / BT.2020 primaries, sRGB / BT.709 /
 *   linear / gamma transfer), `iCCP`, `sRGB`, and `gAMA` + `cHRM` (`gAMA`
 *   alone: sRGB primaries), in the PNG spec's precedence order.
 * - JPEG APP2 `ICC_PROFILE` (possibly split over several segments).
 *
 * Anything else (LUT-based profiles without colorants, grey or CMYK
 * profiles, Lab PCS, HDR transfers) is `unsupported`.
 */
import { inflateSync } from 'node:zlib';

/** Linearising curve of one channel: encoded 0..1 → linear 0..1. */
export type Curve =
  | { type: 'gamma'; gamma: number }
  | { type: 'table'; values: Float64Array }
  /** ICC parametric curve, function type 0–4, parameters g, a, b, c, d, e, f (unused ones 0). */
  | { type: 'para'; fn: number; params: readonly number[] };

export interface RgbProfile {
  /** Linear RGB → XYZ (D50), row-major 3×3. */
  toXyzD50: readonly number[];
  curves: readonly [Curve, Curve, Curve];
}

/**
 * What an image says about its colours:
 * - `untagged`: nothing (sRGB by convention);
 * - `srgb`: an sRGB chunk, or a profile that is sRGB (by primaries and curves, not by name);
 * - `rgb`: a profile that needs converting;
 * - `unsupported`: a profile this module cannot convert.
 */
export type ColorEncoding =
  | { kind: 'untagged' }
  | { kind: 'srgb'; source: string }
  | { kind: 'rgb'; source: string; profile: RgbProfile }
  | { kind: 'unsupported'; source: string; reason: string };

// --- reference values --------------------------------------------------------------

/** sRGB colorants adapted to D50 (Bradford), as in the ICC's sRGB profiles. */
export const SRGB_TO_XYZ_D50: readonly number[] = [
  0.436065, 0.385151, 0.143078,
  0.222493, 0.716887, 0.060619,
  0.013924, 0.097087, 0.714173,
];

const D50 = [0.9642, 1, 0.8249] as const;

export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function srgbEncode(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Bradford chromatic adaptation from white `src` to white `dst` (XYZ), row-major 3×3. */
export function bradford(src: readonly number[], dst: readonly number[]): number[] {
  const B = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const Bi = invert3(B)!;
  const s = mul3v(B, src);
  const d = mul3v(B, dst);
  const D = [d[0]! / s[0]!, 0, 0, 0, d[1]! / s[1]!, 0, 0, 0, d[2]! / s[2]!];
  return mul3(Bi, mul3(D, B));
}

/** Linear RGB → XYZ for primaries and white given as CIE xy, adapted to D50. */
export function primariesToXyzD50(r: readonly [number, number], g: readonly [number, number], b: readonly [number, number], w: readonly [number, number]): number[] | undefined {
  const xyz = ([x, y]: readonly [number, number]): number[] => [x / y, 1, (1 - x - y) / y];
  if (![r, g, b, w].every(([x, y]) => y > 1e-6 && x >= 0 && x + y <= 1 + 1e-6)) return undefined;
  const P = [xyz(r), xyz(g), xyz(b)];
  const M = [P[0]![0]!, P[1]![0]!, P[2]![0]!, P[0]![1]!, P[1]![1]!, P[2]![1]!, P[0]![2]!, P[1]![2]!, P[2]![2]!];
  const Mi = invert3(M);
  if (!Mi) return undefined;
  const W = xyz(w);
  const S = mul3v(Mi, W);
  const toXyz = [M[0]! * S[0]!, M[1]! * S[1]!, M[2]! * S[2]!, M[3]! * S[0]!, M[4]! * S[1]!, M[5]! * S[2]!, M[6]! * S[0]!, M[7]! * S[1]!, M[8]! * S[2]!];
  return mul3(bradford(W, D50), toXyz);
}

// --- ICC ---------------------------------------------------------------------------

/** Parses an ICC profile (only what an RGB matrix/TRC conversion needs). */
export function parseIcc(bytes: Uint8Array, source = 'ICC profile'): ColorEncoding {
  const unsupported = (reason: string): ColorEncoding => ({ kind: 'unsupported', source, reason });
  if (bytes.length < 132) return unsupported('truncated profile');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = (o: number): string => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  const space = sig(16);
  if (space !== 'RGB ') return unsupported(`${space.trim() || 'unknown'} colour space`);
  if (sig(20) !== 'XYZ ') return unsupported(`${sig(20).trim()} connection space`);
  const count = view.getUint32(128);
  const tags = new Map<string, Uint8Array>();
  for (let i = 0; i < count && 132 + i * 12 + 12 <= bytes.length; i++) {
    const o = 132 + i * 12;
    const offset = view.getUint32(o + 4);
    const size = view.getUint32(o + 8);
    if (offset + size <= bytes.length) tags.set(sig(o), bytes.subarray(offset, offset + size));
  }
  const colorants = ['rXYZ', 'gXYZ', 'bXYZ'].map((t) => readXyz(tags.get(t)));
  const curves = ['rTRC', 'gTRC', 'bTRC'].map((t) => readCurve(tags.get(t)));
  if (colorants.some((c) => !c) || curves.some((c) => !c)) {
    return unsupported(tags.has('A2B0') || tags.has('A2B1') ? 'LUT-based profile' : 'no colorant / tone curve tags');
  }
  const [r, g, b] = colorants as number[][];
  const toXyzD50 = [r![0]!, g![0]!, b![0]!, r![1]!, g![1]!, b![1]!, r![2]!, g![2]!, b![2]!];
  if (!invert3(toXyzD50)) return unsupported('singular colorant matrix');
  const profile: RgbProfile = { toXyzD50, curves: curves as [Curve, Curve, Curve] };
  return isSrgb(profile) ? { kind: 'srgb', source } : { kind: 'rgb', source, profile };
}

function readXyz(tag: Uint8Array | undefined): number[] | undefined {
  if (!tag || tag.length < 20 || String.fromCharCode(...tag.subarray(0, 4)) !== 'XYZ ') return undefined;
  const v = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
  const xyz = [v.getInt32(8) / 65536, v.getInt32(12) / 65536, v.getInt32(16) / 65536];
  return xyz.every(Number.isFinite) ? xyz : undefined;
}

const PARA_COUNTS = [1, 3, 4, 5, 7];

function readCurve(tag: Uint8Array | undefined): Curve | undefined {
  if (!tag || tag.length < 12) return undefined;
  const type = String.fromCharCode(...tag.subarray(0, 4));
  const v = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
  if (type === 'curv') {
    const n = v.getUint32(8);
    if (n === 0) return { type: 'gamma', gamma: 1 };
    if (n === 1) return tag.length >= 14 ? { type: 'gamma', gamma: v.getUint16(12) / 256 } : undefined;
    if (tag.length < 12 + 2 * n) return undefined;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = v.getUint16(12 + 2 * i) / 65535;
    return { type: 'table', values };
  }
  if (type === 'para') {
    const fn = v.getUint16(8);
    const k = PARA_COUNTS[fn];
    if (k === undefined || tag.length < 12 + 4 * k) return undefined;
    const params = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < k; i++) params[i] = v.getInt32(12 + 4 * i) / 65536;
    return { type: 'para', fn, params };
  }
  return undefined;
}

/** Encoded 0..1 → linear, per the curve. */
export function evalCurve(c: Curve, x: number): number {
  switch (c.type) {
    case 'gamma':
      return x <= 0 ? 0 : x ** c.gamma;
    case 'table': {
      const n = c.values.length;
      const p = Math.min(1, Math.max(0, x)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(p));
      const f = p - i;
      return c.values[i]! * (1 - f) + c.values[i + 1]! * f;
    }
    case 'para': {
      const [g, a, b, cc, d, e, f] = c.params as [number, number, number, number, number, number, number];
      const pow = (t: number): number => (t <= 0 ? 0 : t ** g);
      switch (c.fn) {
        case 0:
          return pow(x);
        case 1:
          return x >= -b / a ? pow(a * x + b) : 0;
        case 2:
          return x >= -b / a ? pow(a * x + b) + cc : cc;
        case 3:
          return x >= d ? pow(a * x + b) : cc * x;
        default:
          return x >= d ? pow(a * x + b) + e : cc * x + f;
      }
    }
  }
}

/** Colorants within 0.0025 of sRGB's and every curve within half an 8-bit level of sRGB's. */
function isSrgb(p: RgbProfile): boolean {
  if (p.toXyzD50.some((v, i) => Math.abs(v - SRGB_TO_XYZ_D50[i]!) > 0.0025)) return false;
  for (const c of p.curves) {
    for (let i = 0; i <= 255; i++) {
      const x = i / 255;
      if (Math.abs(srgbEncode(Math.min(1, Math.max(0, evalCurve(c, x)))) - x) * 255 > 0.5) return false;
    }
  }
  return true;
}

// --- PNG ---------------------------------------------------------------------------

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

/** The chunks of a PNG, or undefined when the signature or the chunk structure is broken. */
export function pngChunks(bytes: Uint8Array): PngChunk[] | undefined {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PngChunk[] = [];
  let o = 8;
  while (o + 12 <= bytes.length) {
    const len = view.getUint32(o);
    if (o + 12 + len > bytes.length) return undefined;
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    out.push({ type, data: bytes.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') return out;
  }
  return undefined;
}

/** Chunks that describe the colour space of the samples. */
export const PNG_COLOR_CHUNKS: ReadonlySet<string> = new Set(['cICP', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'mDCV', 'cLLI']);

/**
 * The colour encoding a PNG declares (PNG 3rd edition precedence: cICP, iCCP, sRGB, gAMA/cHRM), read from
 * `chunks` (all of the file's by default).
 */
export function pngColorEncoding(bytes: Uint8Array, chunks: readonly PngChunk[] | undefined = pngChunks(bytes)): ColorEncoding {
  if (!chunks) return { kind: 'untagged' };
  const find = (type: string): Uint8Array | undefined => chunks.find((c) => c.type === type)?.data;
  const cicp = find('cICP');
  if (cicp && cicp.length >= 4) return cicpEncoding(cicp[0]!, cicp[1]!, cicp[2]!, cicp[3]!);
  const iccp = find('iCCP');
  if (iccp) {
    const nul = iccp.indexOf(0);
    if (nul < 0 || nul + 2 > iccp.length) return { kind: 'unsupported', source: 'PNG iCCP', reason: 'malformed iCCP chunk' };
    let profile: Uint8Array;
    try {
      profile = new Uint8Array(inflateSync(iccp.subarray(nul + 2)));
    } catch {
      return { kind: 'unsupported', source: 'PNG iCCP', reason: 'corrupt iCCP chunk' };
    }
    return parseIcc(profile, 'PNG iCCP');
  }
  if (find('sRGB')) return { kind: 'srgb', source: 'PNG sRGB' };
  const gama = find('gAMA');
  const chrm = find('cHRM');
  if (!gama && !chrm) return { kind: 'untagged' };
  const u32 = (d: Uint8Array, i: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(i * 4) / 100000;
  const curve: Curve =
    gama && gama.length >= 4 && u32(gama, 0) > 0 ? { type: 'gamma', gamma: 1 / u32(gama, 0) } : { type: 'para', fn: 4, params: SRGB_PARA };
  let toXyzD50: readonly number[] = SRGB_TO_XYZ_D50;
  if (chrm && chrm.length >= 32) {
    const xy = (i: number): [number, number] => [u32(chrm, 2 * i), u32(chrm, 2 * i + 1)];
    const m = primariesToXyzD50(xy(1), xy(2), xy(3), xy(0));
    if (!m) return { kind: 'unsupported', source: 'PNG cHRM', reason: 'degenerate chromaticities' };
    toXyzD50 = m;
  }
  const profile: RgbProfile = { toXyzD50, curves: [curve, curve, curve] };
  const source = gama && chrm ? 'PNG gAMA/cHRM' : gama ? 'PNG gAMA' : 'PNG cHRM';
  return isSrgb(profile) ? { kind: 'srgb', source } : { kind: 'rgb', source, profile };
}

/** sRGB's transfer function as an ICC parametric curve (type 4). */
const SRGB_PARA = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0, 0];

/** ITU-T H.273 code points (PNG cICP). */
function cicpEncoding(primaries: number, transfer: number, matrix: number, _fullRange: number): ColorEncoding {
  const source = 'PNG cICP';
  if (matrix !== 0) return { kind: 'unsupported', source, reason: `matrix coefficients ${matrix}` };
  const D65: [number, number] = [0.3127, 0.329];
  const prim: Record<number, [[number, number], [number, number], [number, number], [number, number]]> = {
    1: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06], D65],
    9: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046], D65],
    12: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06], D65],
  };
  const p = prim[primaries];
  if (!p) return { kind: 'unsupported', source, reason: `colour primaries ${primaries}` };
  const bt709: Curve = { type: 'para', fn: 3, params: [1 / 0.45, 1 / 1.099, 0.099 / 1.099, 1 / 4.5, 0.081, 0, 0] };
  const curves: Record<number, Curve> = {
    1: bt709,
    4: { type: 'gamma', gamma: 2.2 },
    5: { type: 'gamma', gamma: 2.8 },
    6: bt709,
    8: { type: 'gamma', gamma: 1 },
    13: { type: 'para', fn: 4, params: SRGB_PARA },
    14: bt709,
    15: bt709,
  };
  const curve = curves[transfer];
  if (!curve) return { kind: 'unsupported', source, reason: `transfer characteristics ${transfer}` };
  const toXyzD50 = primaries === 1 ? SRGB_TO_XYZ_D50 : primariesToXyzD50(p[0], p[1], p[2], p[3])!;
  const profile: RgbProfile = { toXyzD50, curves: [curve, curve, curve] };
  return isSrgb(profile) ? { kind: 'srgb', source } : { kind: 'rgb', source, profile };
}

// --- JPEG --------------------------------------------------------------------------

export interface JpegSegment {
  marker: number;
  /** Whole segment including the 0xFF marker bytes and the length. */
  start: number;
  end: number;
}

/** Marker segments before the first SOS (start of scan); undefined when the file is not a well-formed JPEG. */
export function jpegHeaderSegments(bytes: Uint8Array): JpegSegment[] | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const out: JpegSegment[] = [];
  let o = 2;
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) return undefined;
    const marker = bytes[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return out;
    const len = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    if (len < 2 || o + 2 + len > bytes.length) return undefined;
    out.push({ marker, start: o, end: o + 2 + len });
    o += 2 + len;
  }
  return out;
}

const ICC_SIGNATURE = 'ICC_PROFILE\u0000';

function isIccSegment(bytes: Uint8Array, s: JpegSegment): boolean {
  return s.marker === 0xe2 && s.end - s.start >= 18 && String.fromCharCode(...bytes.subarray(s.start + 4, s.start + 16)) === ICC_SIGNATURE;
}

/** The colour encoding of a JPEG: its APP2 ICC profile (chunks reassembled in sequence order), else untagged. */
export function jpegColorEncoding(bytes: Uint8Array): ColorEncoding {
  const segments = jpegHeaderSegments(bytes);
  if (!segments) return { kind: 'untagged' };
  const parts = segments.filter((s) => isIccSegment(bytes, s)).map((s) => ({ seq: bytes[s.start + 16]!, data: bytes.subarray(s.start + 18, s.end) }));
  if (parts.length === 0) return { kind: 'untagged' };
  parts.sort((a, b) => a.seq - b.seq);
  const total = parts.reduce((n, p) => n + p.data.length, 0);
  const profile = new Uint8Array(total);
  let k = 0;
  for (const p of parts) {
    profile.set(p.data, k);
    k += p.data.length;
  }
  return parseIcc(profile, 'JPEG ICC profile');
}

/** The JPEG without its ICC profile segments (lossless; the entropy-coded data is untouched). */
export function stripJpegProfile(bytes: Uint8Array): Uint8Array {
  const segments = jpegHeaderSegments(bytes);
  if (!segments) return bytes;
  const drop = segments.filter((s) => isIccSegment(bytes, s));
  if (drop.length === 0) return bytes;
  const out = new Uint8Array(bytes.length - drop.reduce((n, s) => n + s.end - s.start, 0));
  let from = 0;
  let k = 0;
  for (const s of drop) {
    out.set(bytes.subarray(from, s.start), k);
    k += s.start - from;
    from = s.end;
  }
  out.set(bytes.subarray(from), k);
  return out;
}

// --- conversion --------------------------------------------------------------------

/** Linear RGB in the source → linear sRGB (row-major 3×3). */
export function toLinearSrgb(profile: RgbProfile): number[] {
  return mul3(invert3(SRGB_TO_XYZ_D50 as number[])!, profile.toXyzD50 as number[]);
}

/**
 * Converts straight-alpha 8-bit RGBA pixels from `profile` to sRGB in place: colour channels only (alpha is
 * kept), relative colorimetric, clipped to the sRGB gamut, rounded to the nearest 8-bit level.
 */
export function convertRgba8(rgba: Uint8Array, profile: RgbProfile): void {
  const m = toLinearSrgb(profile);
  const lut = profile.curves.map((c) => {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++) t[i] = evalCurve(c, i / 255);
    return t;
  });
  const [lr, lg, lb] = lut as [Float64Array, Float64Array, Float64Array];
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m as [number, number, number, number, number, number, number, number, number];
  // Thresholds of the sRGB encoder: level k is chosen when lin ≥ t[k-1] (exact rounding of the encoded value).
  const t = new Float64Array(255);
  for (let k = 0; k < 255; k++) t[k] = srgbDecode((k + 0.5) / 255);
  const encode = (v: number): number => {
    if (!(v > t[0]!)) return 0;
    if (v >= t[254]!) return 255;
    let lo = 0;
    let hi = 254;
    // Largest k with t[k] <= v; result k + 1.
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid]! <= v) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  };
  let lastIn = -1;
  let lastOut = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const key = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!;
    if (key !== lastIn) {
      const r = lr[rgba[i]!]!;
      const g = lg[rgba[i + 1]!]!;
      const b = lb[rgba[i + 2]!]!;
      lastIn = key;
      lastOut = (encode(m0 * r + m1 * g + m2 * b) << 16) | (encode(m3 * r + m4 * g + m5 * b) << 8) | encode(m6 * r + m7 * g + m8 * b);
    }
    rgba[i] = lastOut >>> 16;
    rgba[i + 1] = (lastOut >>> 8) & 255;
    rgba[i + 2] = lastOut & 255;
  }
}

// --- 3×3 ---------------------------------------------------------------------------

function mul3(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return out;
}

function mul3v(a: readonly number[], v: readonly number[]): number[] {
  return [0, 1, 2].map((r) => a[r * 3]! * v[0]! + a[r * 3 + 1]! * v[1]! + a[r * 3 + 2]! * v[2]!);
}

function invert3(m: readonly number[]): number[] | undefined {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return undefined;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
