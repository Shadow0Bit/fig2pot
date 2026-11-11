/**
 * Small software rasteriser for the paints Penpot cannot draw (see `bake.ts`):
 * tiled / rotated images and angular / diamond gradients.
 *
 * Pixels are premultiplied RGBA floats in 0..1 while they are resampled, so
 * that transparent pixels never bleed their colour; they are turned back into
 * straight 8-bit RGBA only when encoded. Output pixel (i, j) covers the unit
 * square [i, i+1) × [j, j+1); a `map` from output pixel coordinates to source
 * pixel coordinates places the source.
 *
 * Resampling: area average (box filter) when a pixel covers more than one
 * source pixel, bilinear when it covers less. An axis-aligned map is resampled
 * separably (exact box coverage); any other map is supersampled.
 */
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import type * as ir from '../ir.ts';

/** Premultiplied RGBA, row-major, 4 floats per pixel. */
export interface Raster {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Straight (not premultiplied) 8-bit RGBA, row-major: how decoded sources are kept, a quarter of a `Raster`'s
 * bytes. The resamplers premultiply its pixels as they read them, exactly as `fromStraight8` would.
 */
export interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** What the resamplers read. */
export type Source = Raster | Bitmap;

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Float32Array(width * height * 4) };
}

/**
 * Decodes PNG / JPEG bytes; undefined for any other format or a corrupt file. `adjust` may change the
 * straight 8-bit RGBA pixels (colour conversion). The EXIF orientation (`orientation`, 1–8) is applied, as
 * browsers and both Penpot renderers do when they draw the original file.
 */
export function decodeImage(bytes: Uint8Array, mimeType: string | undefined, adjust?: (rgba: Uint8Array) => void, orientation = 1): Bitmap | undefined {
  try {
    let width: number;
    let height: number;
    let rgba: Uint8Array;
    if (mimeType === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      ({ width, height } = png);
      rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    } else if (mimeType === 'image/jpeg') {
      const jpeg = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
      ({ width, height } = jpeg);
      rgba = jpeg.data;
    } else return undefined;
    if (!(width > 0 && height > 0) || rgba.length < width * height * 4) return undefined;
    adjust?.(rgba);
    return orient({ width, height, rgba: rgba.length === width * height * 4 ? rgba : rgba.slice(0, width * height * 4) }, orientation);
  } catch {
    return undefined;
  }
}

/**
 * The bitmap as EXIF orientation `orientation` (TIFF tag 0x0112) says to display it: 2 mirrored, 3 half
 * turn, 4 flipped, 5 transposed, 6 turned clockwise, 7 transversed, 8 turned counter-clockwise.
 */
export function orient(src: Bitmap, orientation: number): Bitmap {
  if (!(orientation >= 2 && orientation <= 8)) return src;
  const { width: w, height: h } = src;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(w * h * 4);
  const s32 = new Uint32Array(src.rgba.buffer, src.rgba.byteOffset, w * h);
  const d32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let tx: number;
      let ty: number;
      switch (orientation) {
        case 2: [tx, ty] = [w - 1 - x, y]; break;
        case 3: [tx, ty] = [w - 1 - x, h - 1 - y]; break;
        case 4: [tx, ty] = [x, h - 1 - y]; break;
        case 5: [tx, ty] = [y, x]; break;
        case 6: [tx, ty] = [h - 1 - y, x]; break;
        case 7: [tx, ty] = [h - 1 - y, w - 1 - x]; break;
        default: [tx, ty] = [y, w - 1 - x]; break;
      }
      d32[ty * ow + tx] = s32[y * w + x]!;
    }
  }
  return { width: ow, height: oh, rgba: out };
}

function isBitmap(src: Source): src is Bitmap {
  return 'rgba' in src;
}

/** Row `y` of `src` as premultiplied floats into `out` (width × 4). */
function premultipliedRow(src: Source, y: number, out: Float32Array): Float32Array {
  const n = src.width * 4;
  if (!isBitmap(src)) return src.data.subarray(y * n, (y + 1) * n);
  const s = src.rgba;
  for (let i = 0, si = y * n; i < n; i += 4, si += 4) {
    const a = s[si + 3]! / 255;
    out[i] = (s[si]! / 255) * a;
    out[i + 1] = (s[si + 1]! / 255) * a;
    out[i + 2] = (s[si + 2]! / 255) * a;
    out[i + 3] = a;
  }
  return out;
}

/** Bytes a decoded source holds in memory. */
export function sourceBytes(src: Source): number {
  return isBitmap(src) ? src.rgba.byteLength : src.data.byteLength;
}

/** Straight 8-bit RGBA → premultiplied float raster. */
export function fromStraight8(width: number, height: number, rgba: ArrayLike<number>): Raster {
  const out = createRaster(width, height);
  const d = out.data;
  for (let i = 0; i < width * height * 4; i += 4) {
    const a = rgba[i + 3]! / 255;
    d[i] = (rgba[i]! / 255) * a;
    d[i + 1] = (rgba[i + 1]! / 255) * a;
    d[i + 2] = (rgba[i + 2]! / 255) * a;
    d[i + 3] = a;
  }
  return out;
}

/** Premultiplied float raster → straight 8-bit RGBA, optionally multiplied by `opacity`. */
export function toStraight8(raster: Raster, opacity = 1): Uint8Array {
  const out = new Uint8Array(raster.width * raster.height * 4);
  straightInto(raster.data, out, 0, opacity);
  return out;
}

/** Premultiplied floats `d` → straight 8-bit RGBA at `out[offset…]`, multiplied by `opacity`. */
function straightInto(d: Float32Array, out: Uint8Array, offset: number, opacity: number): void {
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    const a = d[i + 3]!;
    const o = offset + i;
    const alpha = clamp01(a * opacity);
    out[o + 3] = Math.round(alpha * 255);
    if (out[o + 3] === 0) continue;
    out[o] = Math.round(clamp01(d[i]! / a) * 255);
    out[o + 1] = Math.round(clamp01(d[i + 1]! / a) * 255);
    out[o + 2] = Math.round(clamp01(d[i + 2]! / a) * 255);
  }
}

/** Deterministic PNG bytes (pngjs writes no timestamps; fixed filter and compression settings). */
export function encodePng(raster: Raster, opacity = 1): Uint8Array {
  return encodeStraightPng(raster.width, raster.height, toStraight8(raster, opacity));
}

/** `encodePng` of straight 8-bit RGBA. */
export function encodeStraightPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const png = new PNG({ width, height, colorType: 6, inputColorType: 6, bitDepth: 8 });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const bytes = PNG.sync.write(png, { colorType: 6, inputColorType: 6, bitDepth: 8, deflateLevel: 9, filterType: -1 });
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The source turned clockwise by a multiple of 90°. */
export function rotateQuarter<T extends Source>(src: T, degrees: number): T {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
  if (turns === 0) return src;
  if (isBitmap(src)) return orient(src, turns === 1 ? 6 : turns === 2 ? 3 : 8) as T;
  const { width: w, height: h } = src;
  const out = createRaster(turns === 2 ? w : h, turns === 2 ? h : w);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Clockwise: (x, y) → (h-1-y, x); half turn: (w-1-x, h-1-y); counter-clockwise: (y, w-1-x).
      let tx: number;
      let ty: number;
      if (turns === 1) [tx, ty] = [h - 1 - y, x];
      else if (turns === 2) [tx, ty] = [w - 1 - x, h - 1 - y];
      else [tx, ty] = [y, w - 1 - x];
      const si = (y * w + x) * 4;
      const di = (ty * out.width + tx) * 4;
      d[di] = s[si]!;
      d[di + 1] = s[si + 1]!;
      d[di + 2] = s[si + 2]!;
      d[di + 3] = s[si + 3]!;
    }
  }
  return out as T;
}

export type Edge = 'wrap' | 'transparent';

/**
 * Resamples `src` into a `width` × `height` raster: output pixel coordinates
 * map to source pixel coordinates through `map`. `wrap` repeats the source in
 * both directions (tiles); `transparent` leaves everything outside it empty.
 */
export function resample(src: Source, width: number, height: number, map: ir.Matrix, edge: Edge): Raster {
  const out = createRaster(width, height);
  resampleRows(src, width, height, map, edge, (j, row) => out.data.set(row, j * width * 4));
  return out;
}

/**
 * `resample` straight into straight 8-bit RGBA multiplied by `opacity` (what `toStraight8(resample(…))`
 * gives), row by row: no full float raster of the output is held.
 */
export function resampleStraight(src: Source, width: number, height: number, map: ir.Matrix, edge: Edge, opacity = 1): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  resampleRows(src, width, height, map, edge, (j, row) => straightInto(row, out, j * width * 4, opacity));
  return out;
}

/** Calls `emit` with each output row (premultiplied floats, reused between calls), top to bottom. */
function resampleRows(src: Source, width: number, height: number, map: ir.Matrix, edge: Edge, emit: (j: number, row: Float32Array) => void): void {
  if (Math.abs(map.b) < 1e-12 && Math.abs(map.c) < 1e-12) resampleSeparable(src, width, height, map, edge, emit);
  else resampleGeneral(src, width, height, map, edge, emit);
}

interface Tap {
  index: number;
  weight: number;
}

/**
 * Per output index, the source indices and weights along one axis, for the
 * output interval [i, i+1) mapped to [scale·i + offset, scale·(i+1) + offset).
 */
function axisTaps(count: number, scale: number, offset: number, size: number, edge: Edge): Tap[][] {
  const taps: Tap[][] = [];
  const footprint = Math.abs(scale);
  for (let i = 0; i < count; i++) {
    const list: Tap[] = [];
    const add = (k: number, weight: number): void => {
      if (weight <= 0) return;
      let index = k;
      if (edge === 'wrap') index = ((k % size) + size) % size;
      else if (k < 0 || k >= size) return;
      const existing = list.find((t) => t.index === index);
      if (existing) existing.weight += weight;
      else list.push({ index, weight });
    };
    if (footprint >= 1) {
      // Area average: every source pixel weighted by its overlap with the footprint.
      const a = Math.min(scale * i + offset, scale * (i + 1) + offset);
      const b = a + footprint;
      for (let k = Math.floor(a); k < b; k++) add(k, (Math.min(b, k + 1) - Math.max(a, k)) / footprint);
    } else {
      // Bilinear at the pixel centre (source pixel centres sit at k + 0.5). Without wrapping, the image's
      // edge pixels extend to its border and the output pixel is weighted by how much of it the image covers.
      const c = scale * (i + 0.5) + offset - 0.5;
      const k = Math.floor(c);
      const f = c - k;
      let coverage = 1;
      if (edge === 'transparent') {
        const a = Math.min(scale * i + offset, scale * (i + 1) + offset);
        coverage = Math.max(0, Math.min(a + footprint, size) - Math.max(a, 0)) / footprint;
      }
      const clampIndex = (n: number): number => (edge === 'wrap' ? n : Math.min(size - 1, Math.max(0, n)));
      add(clampIndex(k), (1 - f) * coverage);
      add(clampIndex(k + 1), f * coverage);
    }
    taps.push(list);
  }
  return taps;
}

function resampleSeparable(src: Source, width: number, height: number, map: ir.Matrix, edge: Edge, emit: (j: number, row: Float32Array) => void): void {
  const xTaps = axisTaps(width, map.a, map.e, src.width, edge);
  const yTaps = axisTaps(height, map.d, map.f, src.height, edge);
  // Source rows filtered horizontally, kept only until the last output row that reads them.
  const lastUse = new Map<number, number>();
  yTaps.forEach((list, j) => list.forEach((t) => lastUse.set(t.index, j)));
  const rows = new Map<number, Float32Array>();
  const scratch = new Float32Array(src.width * 4);
  const filtered = (y: number): Float32Array => {
    let row = rows.get(y);
    if (row) return row;
    row = new Float32Array(width * 4);
    const s = premultipliedRow(src, y, scratch);
    for (let i = 0; i < width; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const t of xTaps[i]!) {
        const si = t.index * 4;
        r += s[si]! * t.weight;
        g += s[si + 1]! * t.weight;
        b += s[si + 2]! * t.weight;
        a += s[si + 3]! * t.weight;
      }
      row[i * 4] = r;
      row[i * 4 + 1] = g;
      row[i * 4 + 2] = b;
      row[i * 4 + 3] = a;
    }
    rows.set(y, row);
    return row;
  };
  const out = new Float32Array(width * 4);
  for (let j = 0; j < height; j++) {
    out.fill(0);
    const list = yTaps[j]!;
    for (const t of list) {
      const row = filtered(t.index);
      for (let k = 0; k < width * 4; k++) out[k]! += row[k]! * t.weight;
    }
    emit(j, out);
    for (const t of list) if (lastUse.get(t.index) === j) rows.delete(t.index);
  }
}

/** Bilinear sample at source coordinates (pixel centres at k + 0.5), premultiplied. */
function sampleBilinear(src: Source, u: number, v: number, edge: Edge, out: Float32Array): void {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out.fill(0);
  if (edge === 'transparent' && (u < 0 || v < 0 || u >= src.width || v >= src.height)) return;
  const bitmap = isBitmap(src) ? src.rgba : undefined;
  const s = isBitmap(src) ? undefined : src.data;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (w <= 0) continue;
      let px = x0 + dx;
      let py = y0 + dy;
      if (edge === 'wrap') {
        px = ((px % src.width) + src.width) % src.width;
        py = ((py % src.height) + src.height) % src.height;
      } else {
        px = Math.min(src.width - 1, Math.max(0, px));
        py = Math.min(src.height - 1, Math.max(0, py));
      }
      const si = (py * src.width + px) * 4;
      if (bitmap) {
        // Premultiplied as `fromStraight8` does.
        const a = bitmap[si + 3]! / 255;
        out[0]! += (bitmap[si]! / 255) * a * w;
        out[1]! += (bitmap[si + 1]! / 255) * a * w;
        out[2]! += (bitmap[si + 2]! / 255) * a * w;
        out[3]! += a * w;
      } else {
        out[0]! += s![si]! * w;
        out[1]! += s![si + 1]! * w;
        out[2]! += s![si + 2]! * w;
        out[3]! += s![si + 3]! * w;
      }
    }
  }
}

/** Rotated / sheared maps: n × n bilinear samples per pixel, n following the footprint (≤ 8). */
function resampleGeneral(src: Source, width: number, height: number, map: ir.Matrix, edge: Edge, emit: (j: number, row: Float32Array) => void): void {
  const fx = Math.hypot(map.a, map.b);
  const fy = Math.hypot(map.c, map.d);
  const nx = Math.min(8, Math.max(1, Math.ceil(fx)));
  const ny = Math.min(8, Math.max(1, Math.ceil(fy)));
  const d = new Float32Array(width * 4);
  const tmp = new Float32Array(4);
  const norm = 1 / (nx * ny);
  for (let j = 0; j < height; j++) {
    d.fill(0);
    for (let i = 0; i < width; i++) {
      const o = i * 4;
      for (let sy = 0; sy < ny; sy++) {
        const y = j + (sy + 0.5) / ny;
        for (let sx = 0; sx < nx; sx++) {
          const x = i + (sx + 0.5) / nx;
          sampleBilinear(src, map.a * x + map.c * y + map.e, map.b * x + map.d * y + map.f, edge, tmp);
          d[o]! += tmp[0]! * norm;
          d[o + 1]! += tmp[1]! * norm;
          d[o + 2]! += tmp[2]! * norm;
          d[o + 3]! += tmp[3]! * norm;
        }
      }
    }
    emit(j, d);
  }
}

// --- gradients ---------------------------------------------------------------------

/**
 * Angular or diamond gradient. `toNorm` maps output pixel coordinates to the
 * node's normalised space, where the IR handles live (Figma REST semantics):
 * with u = h1 − h0 and v = h2 − h0, a point is h0 + s·u + t·v and
 *
 * - diamond: position = |s| + |t| (the L1 analogue of radial's √(s² + t²));
 * - angular: position = atan2(t, s) / 2π, i.e. 0 along u, sweeping towards v
 *   (clockwise on screen for Figma's default handles).
 *
 * Stops are interpolated in straight-alpha sRGB; before the first / after the
 * last stop the end colours extend. Angular pixels straddling the seam (where
 * the last stop meets the first) are supersampled.
 */
export function renderGradient(
  type: 'angular' | 'diamond',
  handles: readonly [ir.Vec2, ir.Vec2, ir.Vec2],
  stops: readonly ir.GradientStop[],
  width: number,
  height: number,
  toNorm: ir.Matrix,
): Raster | undefined {
  const [h0, h1, h2] = handles;
  const u = { x: h1.x - h0.x, y: h1.y - h0.y };
  const v = { x: h2.x - h0.x, y: h2.y - h0.y };
  const det = u.x * v.y - u.y * v.x;
  if (!(Math.abs(det) > 1e-12) || stops.length === 0) return undefined;
  // Output pixel coordinates → (s, t), one affine map.
  const ps = { x: v.y / det, y: -v.x / det };
  const pt = { x: -u.y / det, y: u.x / det };
  const m = toNorm;
  const sA = ps.x * m.a + ps.y * m.b;
  const sC = ps.x * m.c + ps.y * m.d;
  const sE = ps.x * (m.e - h0.x) + ps.y * (m.f - h0.y);
  const tA = pt.x * m.a + pt.y * m.b;
  const tC = pt.x * m.c + pt.y * m.d;
  const tE = pt.x * (m.e - h0.x) + pt.y * (m.f - h0.y);
  const position = (x: number, y: number): number => {
    const s = sA * x + sC * y + sE;
    const t = tA * x + tC * y + tE;
    if (type === 'diamond') return Math.abs(s) + Math.abs(t);
    const angle = Math.atan2(t, s) / (2 * Math.PI);
    return angle < 0 ? angle + 1 : angle;
  };
  const ramp = colorRamp(stops);
  const out = createRaster(width, height);
  const d = out.data;
  // Angular: positions at pixel corners tell where the seam (or the centre) crosses a pixel.
  let corners: Float32Array | undefined;
  if (type === 'angular') {
    corners = new Float32Array((width + 1) * (height + 1));
    for (let j = 0; j <= height; j++) for (let i = 0; i <= width; i++) corners[j * (width + 1) + i] = position(i, j);
  }
  const SS = 4;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const o = (j * width + i) * 4;
      let seam = false;
      if (corners) {
        const c = [corners[j * (width + 1) + i]!, corners[j * (width + 1) + i + 1]!, corners[(j + 1) * (width + 1) + i]!, corners[(j + 1) * (width + 1) + i + 1]!];
        seam = Math.max(...c) - Math.min(...c) > 0.25;
      }
      if (!seam) {
        ramp(position(i + 0.5, j + 0.5), d, o, 1);
        continue;
      }
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) ramp(position(i + (sx + 0.5) / SS, j + (sy + 0.5) / SS), d, o, 1 / (SS * SS));
      }
    }
  }
  return out;
}

/** Position → premultiplied colour, accumulated into `out[o..o+3]` with `weight`. */
function colorRamp(stops: readonly ir.GradientStop[]): (position: number, out: Float32Array, o: number, weight: number) => void {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return (position, out, o, weight) => {
    let c: ir.Color;
    if (!(position > first.position)) c = first.color;
    else if (position >= last.position) c = last.color;
    else {
      let k = 1;
      while (k < sorted.length - 1 && sorted[k]!.position < position) k++;
      const a = sorted[k - 1]!;
      const b = sorted[k]!;
      const span = b.position - a.position;
      const f = span > 1e-12 ? (position - a.position) / span : 1;
      c = {
        r: a.color.r + (b.color.r - a.color.r) * f,
        g: a.color.g + (b.color.g - a.color.g) * f,
        b: a.color.b + (b.color.b - a.color.b) * f,
        a: a.color.a + (b.color.a - a.color.a) * f,
      };
    }
    const alpha = clamp01(c.a);
    out[o]! += clamp01(c.r) * alpha * weight;
    out[o + 1]! += clamp01(c.g) * alpha * weight;
    out[o + 2]! += clamp01(c.b) * alpha * weight;
    out[o + 3]! += alpha * weight;
  };
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}
