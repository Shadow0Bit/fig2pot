/**
 * Baking: paints Penpot cannot draw (tiled or rotated images, rotated crops,
 * angular and diamond gradients) are rasterised into a PNG that covers the
 * Penpot shape's box exactly and written as an ordinary image fill
 * (`keepAspectRatio: false`, no placement), so Penpot only has to stretch a
 * bitmap over the box — which both renderers do the same way.
 *
 * The bitmap is drawn in the Penpot box's own space (`PaintTarget.space`):
 * for box shapes that is the node's local box, so rotation and mirroring
 * still apply through the shape's transform; for paths it is the page-space
 * content bounds Penpot uses for their image fills. Non-rectangular shapes clip
 * the bitmap like any image fill.
 *
 * Results are cached per (paint, box, scale) across the writer's rebuild
 * attempts and shared by identical uses (one media object each). Bytes are
 * deterministic.
 */
import { createHash } from 'node:crypto';
import type * as ir from '../ir.ts';
import { invert, multiply, scaling } from '../util/matrix.ts';
import type { PaintTarget } from './fills.ts';
import { downsamplePng } from './downsample.ts';
import { orientPng, prepareImage, toSrgbInPlace, type PreparedImage } from './image-color.ts';
import { exifOrientation } from '../util/exif.ts';
import { decodeImage, encodePng, encodeStraightPng, renderGradient, resampleStraight, rotateQuarter, sourceBytes, type Bitmap } from './raster.ts';

/** Largest side and area of a baked bitmap; the scale is reduced to fit (`bake-downscaled`). */
export const MAX_BAKE_SIDE = 4096;
export const MAX_BAKE_PIXELS = 16_000_000;
export const DEFAULT_BAKE_SCALE = 2;

export interface BakedImage {
  /** Stable identity of the bitmap (paint + box + scale); media ids derive from it. */
  key: string;
  png: Uint8Array;
  width: number;
  height: number;
  /** The device-pixel ratio actually used. */
  scale: number;
  /** True when the requested scale had to be reduced to stay within the pixel budget. */
  downscaled: boolean;
}

export type BakeOutcome = { ok: true; image: BakedImage } | { ok: false; reason: string };

/**
 * Decoded sources kept at once (8-bit RGBA bytes). Sources are decoded when first needed and the least
 * recently used ones are dropped beyond this; results (encoded PNGs) are kept, so a source is decoded again
 * only for a bitmap not made yet. auto-layout-playground decodes ~1 GB of 8-bit pixels for its reduced copies;
 * with this budget its peak RSS is ~1.6 GB (1.5 GB without reduced copies; 2.5 GB when every source was kept
 * as premultiplied floats), and it converts faster.
 */
export const MAX_DECODED_BYTES = 64 << 20;

/** Decoded sources and encoded results, shared by every build attempt of one `writePenpot` call. */
export class BakeCache {
  private readonly images: Record<string, ir.ImageAsset>;
  /** Convert image colours to sRGB as the source draws them (`WriteOptions.convertImageProfiles`). */
  private readonly convertProfiles: boolean;
  /** Decoded sources, least recently used first (`MAX_DECODED_BYTES`); `null`: cannot be decoded. */
  private readonly sources = new Map<string, Bitmap | null>();
  private decodedBytes = 0;
  private readonly results = new Map<string, BakeOutcome>();
  private readonly prepared = new Map<string, PreparedImage>();
  private readonly variants = new Map<string, Uint8Array | null>();

  constructor(images: Record<string, ir.ImageAsset>, options: { convertProfiles?: boolean } = {}) {
    this.images = images;
    this.convertProfiles = options.convertProfiles !== false;
  }

  /** The bytes to store for an image asset (`image-color.ts`), computed once per ref. */
  media(asset: ir.ImageAsset): PreparedImage {
    let prepared = this.prepared.get(asset.ref);
    if (!prepared) {
      prepared = this.convertProfiles ? prepareImage(asset) : { bytes: asset.bytes, action: 'kept', encoding: { kind: 'untagged' } };
      // The WASM renderer ignores a PNG's eXIf chunk: store the pixels oriented (`image-color.ts`).
      const orientation = asset.mimeType === 'image/png' ? exifOrientation(asset.bytes, asset.mimeType) : 1;
      const oriented = orientation !== 1 ? orientPng(prepared.bytes, orientation) : undefined;
      if (oriented) prepared = { ...prepared, bytes: oriented, oriented: true };
      this.prepared.set(asset.ref, prepared);
    }
    return prepared;
  }

  /**
   * The decoded source (EXIF orientation applied, in sRGB as the source draws it) turned clockwise by
   * `rotation` (a multiple of 90), or undefined when it cannot be decoded.
   */
  source(ref: string, rotation: number): Bitmap | undefined {
    const key = `${ref}\u0000${rotation}`;
    let bitmap = this.sources.get(key);
    if (bitmap !== undefined) {
      // Most recently used last.
      this.sources.delete(key);
      this.sources.set(key, bitmap);
      return bitmap ?? undefined;
    }
    if (rotation === 0) {
      const asset = Object.hasOwn(this.images, ref) ? this.images[ref] : undefined;
      // In sRGB, as the source draws it (the baked PNG is untagged).
      const adjust = asset && this.convertProfiles ? (rgba: Uint8Array): void => toSrgbInPlace(asset, rgba) : undefined;
      bitmap = (asset && asset.bytes.length > 0 ? decodeImage(asset.bytes, asset.mimeType, adjust, exifOrientation(asset.bytes, asset.mimeType)) : undefined) ?? null;
    } else {
      const base = this.source(ref, 0);
      bitmap = base ? rotateQuarter(base, rotation) : null;
    }
    this.keep(key, bitmap);
    return bitmap ?? undefined;
  }

  /** Caches a decoded source, dropping the least recently used ones beyond `MAX_DECODED_BYTES`. */
  private keep(key: string, bitmap: Bitmap | null): void {
    const size = bitmap ? sourceBytes(bitmap) : 0;
    for (const [k, b] of this.sources) {
      if (this.decodedBytes + size <= MAX_DECODED_BYTES) break;
      if (!b) continue;
      this.sources.delete(k);
      this.decodedBytes -= sourceBytes(b);
    }
    this.sources.set(key, bitmap);
    this.decodedBytes += size;
  }

  /** The image area-averaged to `width` × `height` px (`downsample.ts`), or undefined when it cannot be decoded. */
  downsampled(ref: string, width: number, height: number): Uint8Array | undefined {
    const key = `${ref}\u0000${width}\u0000${height}`;
    let bytes = this.variants.get(key);
    if (bytes === undefined) {
      const src = this.source(ref, 0);
      bytes = src ? downsamplePng(src, width, height) : null;
      this.variants.set(key, bytes);
    }
    return bytes ?? undefined;
  }

  /** Bytes of the reduced copies made so far (for the `images-downsampled` summary). */
  downsampledBytes(ref: string, width: number, height: number): number {
    return this.variants.get(`${ref}\u0000${width}\u0000${height}`)?.length ?? 0;
  }

  memo(key: string, make: () => BakeOutcome): BakeOutcome {
    let outcome = this.results.get(key);
    if (!outcome) {
      outcome = make();
      this.results.set(key, outcome);
    }
    return outcome;
  }

  mimeType(ref: string): string | undefined {
    return Object.hasOwn(this.images, ref) ? this.images[ref]?.mimeType : undefined;
  }
}

export interface BakeOptions {
  /** Requested device-pixel ratio. */
  scale: number;
  /** Multiplied into the pixels (for renderers that ignore image fill opacity); 1 keeps it a fill attribute. */
  opacity: number;
}

/** Bitmap size for a box of `width` × `height` CSS px at `scale`, within the pixel budget. */
export function bakeSize(width: number, height: number, scale: number): { width: number; height: number; scale: number; downscaled: boolean } {
  let s = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_BAKE_SCALE;
  const requested = s;
  s = Math.min(s, MAX_BAKE_SIDE / Math.max(width, 1e-9), MAX_BAKE_SIDE / Math.max(height, 1e-9), Math.sqrt(MAX_BAKE_PIXELS / Math.max(width * height, 1e-9)));
  const w = Math.min(MAX_BAKE_SIDE, Math.max(1, Math.round(width * s)));
  const h = Math.min(MAX_BAKE_SIDE, Math.max(1, Math.round(height * s)));
  return { width: w, height: h, scale: s, downscaled: s < requested - 1e-9 };
}

/** Rasterises `paint` over the Penpot box of `target`. */
export function bakePaint(cache: BakeCache, paint: ir.ImagePaint | ir.GradientPaint, target: PaintTarget, options: BakeOptions): BakeOutcome {
  const box = { width: target.space.width, height: target.space.height };
  const { width: nw, height: nh } = target.size;
  if (!(box.width > 1e-6 && box.height > 1e-6 && nw > 1e-6 && nh > 1e-6)) return { ok: false, reason: 'the shape has no area' };
  const fromBox = invert(target.space.toBox);
  if (!fromBox) return { ok: false, reason: 'the paint space is degenerate' };
  const size = bakeSize(box.width, box.height, options.scale);
  // Output pixel → Penpot-box-normalised → node-normalised.
  const toNorm = multiply(fromBox, scaling(1 / size.width, 1 / size.height));
  const opacity = options.opacity;
  const descriptor = paint.type === 'image' ? imageDescriptor(paint) : gradientDescriptor(paint);
  const key = hash(JSON.stringify([descriptor, size.width, size.height, round(toNorm), round([nw, nh]), round([opacity])]));
  return cache.memo(key, () => {
    let png: Uint8Array;
    if (paint.type === 'gradient') {
      if (paint.gradientType !== 'angular' && paint.gradientType !== 'diamond') return { ok: false, reason: `${paint.gradientType} gradients are not baked` };
      const raster = renderGradient(paint.gradientType, paint.handles, paint.stops, size.width, size.height, toNorm);
      if (!raster) return { ok: false, reason: 'the gradient is degenerate' };
      png = encodePng(raster, opacity);
    } else {
      const rotation = quarterTurns(paint.rotation ?? 0) * 90;
      const src = cache.source(paint.imageRef, rotation);
      if (!src) return { ok: false, reason: `the image (${cache.mimeType(paint.imageRef) ?? 'unknown format'}) cannot be decoded` };
      const placement = imagePlacement(paint, src, { width: nw, height: nh });
      if (!placement) return { ok: false, reason: 'the image placement is degenerate' };
      const toLocal = multiply(scaling(nw, nh), toNorm);
      png = encodeStraightPng(size.width, size.height, resampleStraight(src, size.width, size.height, multiply(placement.localToSource, toLocal), placement.edge, opacity));
    }
    return { ok: true, image: { key, png, width: size.width, height: size.height, scale: size.scale, downscaled: size.downscaled } };
  });
}

/**
 * Node-local px → source px (of the source already turned by `rotation`), Figma semantics:
 * - tile: one tile is the image at `scalingFactor` × its natural size, the first tile's
 *   top-left corner on the node's top-left corner (checked against Figma renders);
 * - fill: cover, centred; fit: contain, centred;
 * - crop: `imageTransform` maps node-normalised space into image-normalised space.
 */
function imagePlacement(paint: ir.ImagePaint, src: { width: number; height: number }, size: ir.Size): { localToSource: ir.Matrix; edge: 'wrap' | 'transparent' } | undefined {
  const { width: w, height: h } = size;
  const iw = src.width;
  const ih = src.height;
  switch (paint.scaleMode) {
    case 'tile': {
      const factor = paint.scalingFactor !== undefined && Number.isFinite(paint.scalingFactor) && paint.scalingFactor > 0 ? paint.scalingFactor : 1;
      let localToSource = scaling(1 / factor, 1 / factor);
      if (paint.imageTransform) {
        // A tile transform acts in node-normalised space before the tiling.
        localToSource = multiply(localToSource, multiply(scaling(w, h), multiply(paint.imageTransform, scaling(1 / w, 1 / h))));
      }
      return { localToSource, edge: 'wrap' };
    }
    case 'fill':
    case 'fit': {
      const k = paint.scaleMode === 'fill' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      if (!(k > 0) || !Number.isFinite(k)) return undefined;
      const ox = (w - iw * k) / 2;
      const oy = (h - ih * k) / 2;
      return { localToSource: { a: 1 / k, b: 0, c: 0, d: 1 / k, e: -ox / k, f: -oy / k }, edge: 'transparent' };
    }
    case 'crop': {
      const t = paint.imageTransform ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      return { localToSource: multiply(scaling(iw, ih), multiply(t, scaling(1 / w, 1 / h))), edge: 'transparent' };
    }
  }
}

function quarterTurns(degrees: number): number {
  return ((Math.round(degrees / 90) % 4) + 4) % 4;
}

function imageDescriptor(p: ir.ImagePaint): unknown {
  return ['image', p.imageRef, p.scaleMode, p.scalingFactor ?? null, quarterTurns(p.rotation ?? 0), p.imageTransform ? round(p.imageTransform) : null];
}

function gradientDescriptor(p: ir.GradientPaint): unknown {
  return ['gradient', p.gradientType, round(p.handles), p.stops.map((s) => [s.position, s.color.r, s.color.g, s.color.b, s.color.a])];
}

function round(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 + 0 : v)));
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Why Penpot cannot draw an image paint as is (undefined when it can), given
 * whether its picture box could be placed in the Penpot box (`placeable`).
 */
export function imageBakeReason(paint: ir.ImagePaint, placeable: boolean): string | undefined {
  if (paint.scaleMode === 'tile') return 'tiled images';
  if (quarterTurns(paint.rotation ?? 0) !== 0) return 'rotated images';
  if (paint.scaleMode === 'crop' && paint.imageTransform) {
    const inv = invert(paint.imageTransform);
    if (!inv || Math.abs(inv.b) > 1e-6 || Math.abs(inv.c) > 1e-6 || inv.a <= 0 || inv.d <= 0) return 'rotated or mirrored image crops';
  }
  if ((paint.scaleMode === 'crop' || paint.scaleMode === 'fit') && !placeable) return `image "${paint.scaleMode}" placement on a rotated path`;
  return undefined;
}
