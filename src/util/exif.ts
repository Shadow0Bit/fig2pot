/**
 * The EXIF orientation of a JPEG (APP1 `Exif`) or PNG (`eXIf` chunk): TIFF tag 0x0112 of IFD0, 1–8.
 * Browsers draw images oriented (`image-orientation: from-image`). Penpot 2.19's SVG renderer honours both
 * forms, its WASM renderer only the JPEG one (it draws a PNG's pixels as stored), so the writer stores PNGs
 * with orientation ≠ 1 re-encoded with oriented pixels (`penpot/image-color.ts`, `orientPng`); whoever
 * decodes the pixels itself (baking, downsampling) applies it too.
 */

/** The orientation (1–8), or 1 when the image has none (or an unreadable one). */
export function exifOrientation(bytes: Uint8Array, mimeType: string | undefined): number {
  try {
    const tiff = mimeType === 'image/jpeg' ? jpegExif(bytes) : mimeType === 'image/png' ? pngExif(bytes) : undefined;
    const value = tiff ? tiffOrientation(tiff) : undefined;
    return value !== undefined && value >= 1 && value <= 8 ? value : 1;
  } catch {
    return 1;
  }
}

/** Whether an orientation swaps width and height (5–8: transposed or turned a quarter). */
export function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/** The TIFF block of the first APP1 `Exif\0\0` segment before the image data. */
function jpegExif(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Start of scan / end of image: no more header segments.
    if (marker === 0xda || marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return undefined;
    const start = offset + 4;
    const end = Math.min(bytes.length, offset + 2 + length);
    if (marker === 0xe1 && end - start > 6 && bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66 && bytes[start + 4] === 0 && bytes[start + 5] === 0) {
      return bytes.subarray(start + 6, end);
    }
    offset += 2 + length;
  }
  return undefined;
}

/** The data of the `eXIf` chunk (a TIFF block) before the first `IDAT`. */
function pngExif(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (type === 'IDAT' || type === 'IEND') return undefined;
    if (type === 'eXIf') return bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + length));
    offset += 12 + length;
  }
  return undefined;
}

function tiffOrientation(t: Uint8Array): number | undefined {
  if (t.length < 8) return undefined;
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return undefined;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number): number => view.getUint16(o, little);
  if (u16(2) !== 42) return undefined;
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > t.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > t.length) return undefined;
    if (u16(entry) !== 0x0112) continue;
    // Tag 0x0112 is a SHORT (3) by the standard; like tolerant readers, a single BYTE (1) or LONG (4) is
    // accepted too. One value fits the value field, stored in its first bytes.
    if (view.getUint32(entry + 4, little) !== 1) return undefined;
    switch (u16(entry + 2)) {
      case 1:
        return t[entry + 8];
      case 3:
        return u16(entry + 8);
      case 4:
        return view.getUint32(entry + 8, little);
      default:
        return undefined;
    }
  }
  return undefined;
}
