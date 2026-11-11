import type * as ir from '../../ir.ts';
import type { FigDocument } from '../types.ts';
import { exifOrientation, swapsAxes } from '../../util/exif.ts';
import { imageRefsOf } from './paints.ts';

/**
 * Builds `Document.images` for the given image refs (sorted for determinism).
 * Bytes come from the ZIP's `images/` folder or, for bare `fig-kiwi` files,
 * from the paint's `image.dataBlob`. Refs with no bytes are left out (paints
 * keep referencing them; `missing-image` was reported when the paint was translated).
 */
export function collectImages(doc: FigDocument, refs: Iterable<string>): Record<string, ir.ImageAsset> {
  const blobRefs = blobImageIndex(doc);
  const unmanaged = ignoresEmbeddedProfiles(doc);
  const images: Record<string, ir.ImageAsset> = {};
  for (const ref of [...new Set(refs)].sort()) {
    let bytes = doc.file.images.get(ref);
    if (!bytes) {
      const blob = blobRefs.get(ref);
      bytes = blob === undefined ? undefined : doc.file.blobs[blob];
    }
    if (!bytes || bytes.length === 0) continue;
    const asset: ir.ImageAsset = { ref, bytes, ...sniffImage(bytes) };
    if (unmanaged) asset.ignoresEmbeddedProfile = true;
    images[ref] = asset;
  }
  return images;
}

/**
 * Whether Figma draws images' stored values, ignoring their embedded colour information (ICC profiles, PNG
 * gAMA / cHRM / cICP): in files without a colour profile (`documentColorProfile` absent or LEGACY). Measured
 * on auto-layout-playground (LEGACY): 17 PNGs with Display P3 / calibrated display profiles render with their
 * raw values (0 levels off, 45–58 levels for the converted colours); its one gAMA 1/2.2 + cHRM PNG (the 32 px
 * avatar `960e197d…` of 2495:1898, exact 16:1 placement, pixels well inside the circle) renders raw too:
 * RMSE 3.86 levels, mean ref − raw −0.04, against 5.55 and +2.66 for the converted values, at every
 * registration offset. Files with an sRGB / Display P3 profile are assumed to colour-manage images (no
 * reference renders yet).
 */
function ignoresEmbeddedProfiles(doc: FigDocument): boolean {
  const profile = doc.root.change.documentColorProfile;
  return profile === undefined || profile === 'LEGACY';
}

/** image ref → blob index, for image paints that embed their bytes in a blob. */
function blobImageIndex(doc: FigDocument): Map<string, number> {
  const index = new Map<string, number>();
  const add = (change: { fillPaints?: Parameters<typeof imageRefsOf>[0]; strokePaints?: Parameters<typeof imageRefsOf>[0] }): void => {
    for (const { ref, dataBlob } of [...imageRefsOf(change.fillPaints), ...imageRefsOf(change.strokePaints)]) {
      if (dataBlob !== undefined && !index.has(ref)) index.set(ref, dataBlob);
    }
  };
  for (const node of doc.byId.values()) {
    add(node.change);
    for (const override of node.change.symbolData?.symbolOverrides ?? []) add(override);
  }
  return index;
}

type Sniffed = Pick<ir.ImageAsset, 'mimeType' | 'width' | 'height'>;

/**
 * Mime type and pixel size from magic bytes (PNG, JPEG, GIF, WebP, SVG). The size is the displayed one: a
 * JPEG / PNG whose EXIF orientation turns it a quarter (5–8) has its width and height swapped, as browsers
 * and Penpot's renderers draw it (`util/exif.ts`). No image of the corpus has an orientation other than 1,
 * so what Figma does with one is not measured; this follows the browsers.
 */
export function sniffImage(bytes: Uint8Array): Sniffed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (offset: number, magic: readonly number[]): boolean => magic.every((b, i) => bytes[offset + i] === b);
  const oriented = (sniffed: Sniffed): Sniffed =>
    sniffed.width !== undefined && sniffed.height !== undefined && swapsAxes(exifOrientation(bytes, sniffed.mimeType)) ? { ...sniffed, width: sniffed.height, height: sniffed.width } : sniffed;

  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (bytes.length >= 24 && at(12, [0x49, 0x48, 0x44, 0x52])) {
      return oriented({ mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) });
    }
    return { mimeType: 'image/png' };
  }
  if (at(0, [0xff, 0xd8, 0xff])) return oriented({ mimeType: 'image/jpeg', ...jpegSize(bytes, view) });
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && bytes.length >= 10) {
    return { mimeType: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return { mimeType: 'image/webp', ...webpSize(bytes, view) };
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { mimeType: 'image/svg+xml' };
  return {};
}

function jpegSize(bytes: Uint8Array, view: DataView): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return {};
}

function webpSize(bytes: Uint8Array, view: DataView): { width?: number; height?: number } {
  if (bytes.length < 30) return {};
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const w = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16);
    const h = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16);
    return { width: w + 1, height: h + 1 };
  }
  return {};
}
