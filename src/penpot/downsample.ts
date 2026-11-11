/**
 * Reduced copies of images shown much smaller than their natural size.
 *
 * Figma exports a downscaled image fill with an area-average (box) filter:
 * on 155 downscaled image regions of auto-layout-playground (0.14–0.8×) the
 * box filter was the closest of nearest, bilinear, bicubic (Mitchell,
 * Catmull-Rom), Lanczos 2/3 and mipmapped (tri)linear in 150, with a median
 * error of 2.6 levels on detailed pixels (bilinear 11.2, mip-trilinear 12.2,
 * Lanczos3 6.0, Catmull-Rom 4.3). Penpot's SVG renderer is closest to
 * mipmapped trilinear with a −0.5 LOD bias, which breaks up small text inside
 * screenshots; the WASM renderer aliases more.
 *
 * So an image shown at less than 1 / `bakeScale` of its natural size gets a
 * copy area-averaged to `bakeScale` × its displayed size (rounded to whole
 * displayed pixels; never larger than the original): at 100 % zoom the
 * renderer's last step is a 2:1 reduction, which bilinear and mipmapped
 * samplers both perform as a 2×2 average, and zooming in to `bakeScale`
 * still shows full detail. The copy is placed by an explicit picture box
 * (`keepAspectRatio: false`), so rounding its size moves nothing. One copy
 * per (image, size), at most `MAX_VARIANTS` per image.
 *
 * Measured on the 145 regions of auto-layout-playground shown below 0.5×
 * (error vs Figma, mean / median levels): SVG renderer, original 2.24 / 1.00,
 * 1× copy 1.98 / 1.23 (worse boards: 1:1 resampling drifts), 2× copy
 * 1.68 / 0.70 (109 regions better, 9 worse); WASM renderer, original
 * 4.57 / 1.67, 2× copy 2.53 / 0.53 (143 better, none worse).
 */
import { encodeRgba8 } from './image-color.ts';
import { resampleStraight, type Source } from './raster.ts';

/** Most reduced copies of one image; further sizes use the original. */
export const MAX_VARIANTS = 8;

/**
 * The pixel size of the reduced copy for a picture of natural size `natural` shown at `shown` CSS px, or
 * undefined when the original is to be used (shown at ≥ 1 / scale of its size on either axis).
 */
export function variantSize(
  natural: { width: number; height: number },
  shown: { width: number; height: number },
  scale: number,
): { width: number; height: number } | undefined {
  // A whole number of copy pixels per displayed pixel when the scale allows: the renderer's halved mip level
  // is then exactly the displayed size (an odd copy halves to one pixel short, and drifts).
  const whole = Number.isInteger(scale);
  const width = whole ? Math.max(1, Math.round(shown.width)) * scale : Math.max(1, Math.round(shown.width * scale));
  const height = whole ? Math.max(1, Math.round(shown.height)) * scale : Math.max(1, Math.round(shown.height * scale));
  if (!(Number.isFinite(width) && Number.isFinite(height))) return undefined;
  if (width >= natural.width || height >= natural.height) return undefined;
  return { width, height };
}

/** The source area-averaged into `width` × `height` px (premultiplied box filter), as deterministic PNG bytes. */
export function downsamplePng(src: Source, width: number, height: number): Uint8Array {
  const map = { a: src.width / width, b: 0, c: 0, d: src.height / height, e: 0, f: 0 };
  return encodeRgba8(width, height, resampleStraight(src, width, height, map, 'transparent'));
}
