/**
 * Image colour handling: makes Penpot show an image's colours the way the
 * source drew them, in both renderers.
 *
 * Penpot 2.19 stores image media byte for byte; its SVG renderer (Chromium)
 * then applies an embedded ICC profile, `cICP`, `gAMA` and `cHRM` (even
 * `gAMA` alone), while the WASM renderer ignores all of them. So the writer
 * emits every image as plain sRGB:
 * - the colours the source shows are already the stored values (untagged,
 *   `sRGB` chunk, a profile that is sRGB, or a profile the source ignores —
 *   `ImageAsset.ignoresEmbeddedProfile`): the colour chunks / ICC segments are
 *   dropped, losslessly (pixels untouched);
 * - the source applies a non-sRGB profile: the pixels are converted to sRGB
 *   (`color-profile.ts`) and re-encoded (PNG → PNG; JPEG → JPEG at quality 95,
 *   EXIF kept);
 * - a profile that cannot be converted: the bytes stay as they are
 *   (`image-profile-unsupported`).
 *
 * EXIF orientation: the SVG renderer honours a JPEG's EXIF and a PNG's `eXIf`
 * chunk, the WASM renderer only a JPEG's (measured on Penpot 2.19). So a PNG
 * whose orientation is not 1 is stored with its pixels turned as the
 * orientation says and without `eXIf` (`orientPng`), whatever the colour
 * handling; JPEGs keep their EXIF.
 */
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import type * as ir from '../ir.ts';
import { swapsAxes } from '../util/exif.ts';
import {
  PNG_COLOR_CHUNKS,
  convertRgba8,
  jpegColorEncoding,
  jpegHeaderSegments,
  pngChunks,
  pngColorEncoding,
  stripJpegProfile,
  type ColorEncoding,
  type PngChunk,
} from './color-profile.ts';
import { orient } from './raster.ts';

export interface PreparedImage {
  bytes: Uint8Array;
  /** What was done to the source bytes. */
  action: 'kept' | 'stripped' | 'converted';
  /** Set when a PNG's EXIF orientation was applied to its pixels (`orientPng`). */
  oriented?: true;
  /** Set when the colours could not be converted: why (for `image-profile-unsupported`). */
  unsupported?: string;
  /** The encoding the source's colours were read in. */
  encoding: ColorEncoding;
}

/** The colour encoding the source draws the asset in (honouring `ignoresEmbeddedProfile`). */
export function effectiveEncoding(asset: ir.ImageAsset): ColorEncoding {
  if (asset.mimeType === 'image/png') {
    const chunks = pngChunks(asset.bytes);
    if (!chunks) return { kind: 'untagged' };
    if (!asset.ignoresEmbeddedProfile) return pngColorEncoding(asset.bytes, chunks);
    // Every colour chunk is ignored, gAMA / cHRM included (`ImageAsset.ignoresEmbeddedProfile`): the stored values.
    return pngColorEncoding(asset.bytes, chunks.filter((c) => !PNG_COLOR_CHUNKS.has(c.type) || c.type === 'sRGB'));
  }
  if (asset.mimeType === 'image/jpeg') return asset.ignoresEmbeddedProfile ? { kind: 'untagged' } : jpegColorEncoding(asset.bytes);
  return { kind: 'untagged' };
}

/** Whether a renderer could read colour information from the file other than "sRGB". */
function hasColorTags(asset: ir.ImageAsset): boolean {
  if (asset.mimeType === 'image/png') return (pngChunks(asset.bytes) ?? []).some((c) => PNG_COLOR_CHUNKS.has(c.type) && c.type !== 'sRGB');
  if (asset.mimeType === 'image/jpeg') return stripJpegProfile(asset.bytes) !== asset.bytes;
  return false;
}

/** The bytes to store for an asset (see the module comment). */
export function prepareImage(asset: ir.ImageAsset): PreparedImage {
  const encoding = effectiveEncoding(asset);
  const keep = (unsupported?: string): PreparedImage => (unsupported === undefined ? { bytes: asset.bytes, action: 'kept', encoding } : { bytes: asset.bytes, action: 'kept', encoding, unsupported });
  if (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') return keep();
  switch (encoding.kind) {
    case 'unsupported':
      return keep(`${encoding.source}: ${encoding.reason}`);
    case 'untagged':
    case 'srgb': {
      if (!hasColorTags(asset)) return keep();
      const bytes = asset.mimeType === 'image/png' ? stripPngColor(asset.bytes) : stripJpegProfile(asset.bytes);
      return bytes ? { bytes, action: 'stripped', encoding } : keep();
    }
    case 'rgb': {
      const bytes = asset.mimeType === 'image/png' ? convertPng(asset.bytes, encoding) : convertJpeg(asset.bytes, encoding);
      return bytes ? { bytes, action: 'converted', encoding } : keep('the image could not be decoded');
    }
  }
}

/** Straight 8-bit RGBA of the source converted to sRGB in place (what `prepareImage` stores), for baking. */
export function toSrgbInPlace(asset: ir.ImageAsset, rgba: Uint8Array): void {
  const encoding = effectiveEncoding(asset);
  if (encoding.kind === 'rgb') convertRgba8(rgba, encoding.profile);
}

// --- PNG ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Chunk bytes (length, type, data, CRC) of a chunk returned by `pngChunks`. */
function rawChunk(c: PngChunk): Uint8Array {
  return new Uint8Array(c.data.buffer, c.data.byteOffset - 8, c.data.byteLength + 12);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

/**
 * The PNG without colour chunks (except `sRGB`, which every renderer reads as sRGB) and without Apple's
 * `iDOT` decoding hint (it records byte offsets of the IDAT chunks). Undefined when the chunks are broken.
 */
export function stripPngColor(bytes: Uint8Array): Uint8Array | undefined {
  const chunks = pngChunks(bytes);
  if (!chunks) return undefined;
  const kept = chunks.filter((c) => !(PNG_COLOR_CHUNKS.has(c.type) && c.type !== 'sRGB') && c.type !== 'iDOT');
  return concat([PNG_SIGNATURE, ...kept.map(rawChunk)]);
}

/** Ancillary chunks carried over into a re-encoded PNG (orientation, density, text). */
const CARRIED_PNG_CHUNKS = new Set(['eXIf', 'pHYs', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function convertPng(bytes: Uint8Array, encoding: Extract<ColorEncoding, { kind: 'rgb' }>): Uint8Array | undefined {
  const chunks = pngChunks(bytes);
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    return undefined;
  }
  const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  convertRgba8(rgba, encoding.profile);
  return encodeRgba8(png.width, png.height, rgba, (chunks ?? []).filter((c) => CARRIED_PNG_CHUNKS.has(c.type)));
}

/**
 * Deterministic 8-bit PNG (RGB when every pixel is opaque, else RGBA; no colour chunk, i.e. sRGB), with
 * `extra` chunks inserted after IHDR.
 */
export function encodeRgba8(width: number, height: number, rgba: Uint8Array, extra: readonly PngChunk[] = []): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length && opaque; i += 4) opaque = rgba[i] === 255;
  const colorType = opaque ? 2 : 6;
  const png = new PNG({ width, height, colorType, inputColorType: 6, bitDepth: 8 });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const out = PNG.sync.write(png, { colorType, inputColorType: 6, bitDepth: 8, deflateLevel: 9, filterType: -1 });
  const encoded = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  if (extra.length === 0) return encoded;
  const written = pngChunks(encoded)!;
  return concat([PNG_SIGNATURE, rawChunk(written[0]!), ...extra.map(rawChunk), ...written.slice(1).map(rawChunk)]);
}

/**
 * A PNG re-encoded with its pixels turned as EXIF orientation `orientation` (2–8) says, without the `eXIf`
 * chunk: what both renderers draw alike. Colour chunks and text are carried over; `pHYs` too unless the axes
 * swap. Undefined when the PNG cannot be decoded.
 */
export function orientPng(bytes: Uint8Array, orientation: number): Uint8Array | undefined {
  const chunks = pngChunks(bytes);
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    return undefined;
  }
  const src = { width: png.width, height: png.height, rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.width * png.height * 4) };
  const turned = orient(src, orientation);
  const carried = (chunks ?? []).filter(
    (c) => c.type !== 'eXIf' && (PNG_COLOR_CHUNKS.has(c.type) || CARRIED_PNG_CHUNKS.has(c.type)) && !(c.type === 'pHYs' && swapsAxes(orientation)),
  );
  return encodeRgba8(turned.width, turned.height, turned.rgba, carried);
}

// --- JPEG --------------------------------------------------------------------------

export const JPEG_QUALITY = 95;

function convertJpeg(bytes: Uint8Array, encoding: Extract<ColorEncoding, { kind: 'rgb' }>): Uint8Array | undefined {
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
  } catch {
    return undefined;
  }
  convertRgba8(decoded.data, encoding.profile);
  const encoded = new Uint8Array(encodeJpeg({ width: decoded.width, height: decoded.height, data: decoded.data }, JPEG_QUALITY).data);
  // Keep the source's EXIF (orientation) segments, right after the encoder's SOI + APP0.
  const exif = (jpegHeaderSegments(bytes) ?? []).filter((s) => s.marker === 0xe1).map((s) => bytes.subarray(s.start, s.end));
  if (exif.length === 0) return encoded;
  const head = jpegHeaderSegments(encoded)?.[0];
  const at = head && head.marker === 0xe0 ? head.end : 2;
  return concat([encoded.subarray(0, at), ...exif, encoded.subarray(at)]);
}
