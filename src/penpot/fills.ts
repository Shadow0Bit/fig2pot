/**
 * IR paints → Penpot fills (and the colour part of strokes).
 *
 * IR paints are bottom → top; Penpot's `fills` vector is top → bottom
 * (index 0 is painted last), so the order is reversed. Penpot fills have no
 * `visible` flag nor blend mode: invisible paints are dropped, blend modes are
 * reported.
 */
import type * as ir from '../ir.ts';
import { apply, invert, multiply } from '../util/matrix.ts';
import { bakePaint, imageBakeReason } from './bake.ts';
import { hex, opacity } from './colors.ts';
import type { WriterContext } from './context.ts';
import { clean } from './geometry.ts';
import { variantSize } from './downsample.ts';
import { convertGradient, type GradientSpace } from './gradients.ts';
import type { PenpotFill, PenpotGradient, PenpotImageColor, PenpotImageTransform, Uuid } from './library.ts';

/** Penpot `MAX-FILLS`. */
export const MAX_FILLS = 8;

/** Where a paint is applied: the Penpot shape's box and the IR node it comes from. */
export interface PaintTarget {
  node: Pick<ir.BaseNode, 'id' | 'name'>;
  /** The IR node's local size (for image placement). */
  size: ir.Size;
  space: GradientSpace;
}

export interface PenpotColor {
  color?: string;
  opacity: number;
  gradient?: PenpotGradient;
  image?: PenpotImageColor;
  refId?: Uuid;
  /** For an image fill made from a source paint (an image, or a baked paint): that paint (`fillSource`). */
  source?: ir.ImagePaint | ir.GradientPaint;
}

/** What an image fill was made from: the source paint, and the stored bitmap's pixel size. */
export interface FillSource {
  /** The source paint, as stable text (an image copy reduced for its size, or a bitmap baked for its box, varies with them). */
  paint: string;
  pixels: number;
}

const FILL_SOURCES = new WeakMap<PenpotFill, FillSource>();

/**
 * The source paint of an image fill, which a component copy shares with its main whatever bitmap each one
 * stores (a reduced copy for its displayed size, a bitmap baked for its box); undefined for other fills.
 */
export function fillSource(fill: PenpotFill): FillSource | undefined {
  return FILL_SOURCES.get(fill);
}

export function convertFills(ctx: WriterContext, paints: readonly ir.Paint[], target: PaintTarget): PenpotFill[] {
  const fills = convertColors(ctx, paints, target, 'fill').map((c): PenpotFill => {
    const fill: PenpotFill = { fillOpacity: c.opacity };
    if (c.color !== undefined) fill.fillColor = c.color;
    else if (c.gradient) fill.fillColorGradient = c.gradient;
    else if (c.image) {
      fill.fillImage = c.image;
      if (c.source) FILL_SOURCES.set(fill, { paint: JSON.stringify({ ...c.source, styleId: undefined }), pixels: c.image.width * c.image.height });
    }
    if (c.refId) {
      fill.fillColorRefId = c.refId;
      fill.fillColorRefFile = ctx.fileId;
    }
    return fill;
  });
  if (fills.length > MAX_FILLS) {
    ctx.warn('too-many-fills', `Penpot supports at most ${MAX_FILLS} fills; the bottom ${fills.length - MAX_FILLS} were dropped`, target.node);
    return fills.slice(0, MAX_FILLS);
  }
  return fills;
}

/** Visible paints converted to Penpot colours, top → bottom. */
export function convertColors(
  ctx: WriterContext,
  paints: readonly ir.Paint[],
  target: PaintTarget,
  usage: 'fill' | 'stroke',
): PenpotColor[] {
  const out: PenpotColor[] = [];
  const styleIndex = new Map<string, number>();
  for (const paint of paints) {
    let refIndex = -1;
    if (paint.styleId !== undefined) {
      refIndex = styleIndex.get(paint.styleId) ?? 0;
      styleIndex.set(paint.styleId, refIndex + 1);
    }
    if (!paint.visible) continue;
    const refId = paint.styleId !== undefined ? ctx.styles.colorRef(paint.styleId, refIndex) : undefined;
    // A paint linked to a library colour keeps that colour's image (the full-size original), not a reduced copy.
    const color = convertPaint(ctx, paint, target, usage, { downsample: refId === undefined });
    if (!color) continue;
    if (refId) color.refId = refId;
    out.push(color);
  }
  return out.reverse();
}

export function convertPaint(
  ctx: WriterContext,
  paint: ir.Paint,
  target: PaintTarget,
  usage: 'fill' | 'stroke' = 'fill',
  options: { downsample?: boolean } = {},
): PenpotColor | undefined {
  if (paint.blendMode !== 'normal' && paint.blendMode !== 'pass-through') {
    ctx.warn('paint-blend-mode-unsupported', `Penpot ${usage}s have no blend mode; "${paint.blendMode}" was ignored`, target.node);
  }
  switch (paint.type) {
    case 'solid':
      return { color: hex(paint.color), opacity: opacity(paint.color.a * paint.opacity) };
    case 'gradient': {
      if ((paint.gradientType === 'angular' || paint.gradientType === 'diamond') && usage === 'fill') {
        const baked = bakedColor(ctx, paint, target, `${paint.gradientType} gradients`);
        if (baked) return { ...baked, source: paint };
      }
      const result = convertGradient(paint, target.space, ctx.options.renderer);
      if (!result) {
        ctx.warn('invalid-gradient', `A degenerate ${paint.gradientType} gradient was dropped`, target.node);
        return undefined;
      }
      if (result.approximation) ctx.warn('gradient-approximated', `Gradient approximated: ${result.approximation}`, target.node);
      // The paint opacity is folded into the stops; Penpot does not apply fill opacity to gradients consistently.
      return { gradient: result.gradient, opacity: 1 };
    }
    case 'image': {
      const reason = usage === 'fill' ? imageBakeReason(paint, placeable(target.space)) : undefined;
      if (reason) {
        const baked = bakedColor(ctx, paint, target, reason);
        if (baked) {
          if (hasFilters(paint)) ctx.warn('image-filters-unsupported', 'Penpot has no image adjustments; exposure/contrast/… were ignored', target.node);
          return { ...baked, source: paint };
        }
      }
      const image = imageColor(ctx, paint, target, usage, options.downsample !== false);
      return image ? { image, opacity: opacity(paint.opacity), source: paint } : undefined;
    }
  }
}

/**
 * The paint rasterised into an image fill covering the Penpot box (`bake.ts`), or undefined when baking is
 * off or impossible (the caller then approximates). The paint opacity stays a fill attribute, except for the
 * WASM renderer, which ignores image fill opacity: there it is baked into the pixels.
 *
 * Strokes are not baked: Penpot 2.19's renderers place stroke images differently (SVG stretches the image
 * over the stroke's own bounds, WASM draws it at its pixel size), so no bitmap would land where Figma's
 * paint is; they keep the approximation and its warning.
 */
function bakedColor(ctx: WriterContext, paint: ir.ImagePaint | ir.GradientPaint, target: PaintTarget, reason: string): PenpotColor | undefined {
  if (!ctx.options.bakeUnsupportedPaints) return undefined;
  const bakeOpacity = ctx.options.renderer === 'wasm';
  const outcome = bakePaint(ctx.bakes, paint, target, { scale: ctx.options.bakeScale, opacity: bakeOpacity ? paint.opacity : 1 });
  if (!outcome.ok) {
    ctx.warn('paint-bake-failed', `Penpot cannot draw ${reason} and the paint could not be baked (${outcome.reason}); it was approximated`, target.node);
    return undefined;
  }
  const media = ctx.media.bakedImage(outcome.image, target.node);
  if (!media) return undefined;
  const { image } = outcome;
  if (image.downscaled) {
    ctx.warn('bake-downscaled', `The baked bitmap of ${reason} was reduced to ${image.width}×${image.height} px (${clean(image.scale, 3)}× instead of ${ctx.options.bakeScale}×) to stay within the pixel budget`, target.node);
  }
  ctx.warnOnce('paint-baked', `Penpot cannot draw ${reason}; the paint was rasterised into an image fill (${image.width}×${image.height} px)`, target.node);
  return { image: { ...media, keepAspectRatio: false }, opacity: bakeOpacity ? 1 : opacity(paint.opacity) };
}

/** Whether a picture box in node-normalised space maps onto an axis-aligned box in the Penpot box. */
function placeable(space: GradientSpace): boolean {
  return Math.abs(space.toBox.b) <= 1e-6 && Math.abs(space.toBox.c) <= 1e-6;
}

function hasFilters(paint: ir.ImagePaint): boolean {
  return !!paint.filters && Object.values(paint.filters).some((v) => v !== undefined && v !== 0);
}

function imageColor(ctx: WriterContext, paint: ir.ImagePaint, target: PaintTarget, usage: 'fill' | 'stroke', mayDownsample: boolean): PenpotImageColor | undefined {
  const natural = ctx.media.naturalSize(paint.imageRef);
  if (!natural) {
    // An unusable asset: `image` reports why.
    ctx.media.image(paint.imageRef, target.node);
    return undefined;
  }
  if (paint.rotation && paint.rotation % 360 !== 0) {
    ctx.warn('image-rotation-unsupported', `Penpot cannot rotate image fills; the ${paint.rotation}° rotation was ignored`, target.node);
  }
  if (hasFilters(paint)) {
    ctx.warn('image-filters-unsupported', 'Penpot has no image adjustments; exposure/contrast/… were ignored', target.node);
  }
  const box = pictureBox(ctx, paint, natural, target);
  const placed = box ? toPenpotBox(box, target.space) : undefined;
  if (box && !placed) ctx.warn('image-scale-mode-approximated', `Image "${paint.scaleMode}" placement on a rotated path is drawn as cover`, target.node);
  if (usage === 'fill' && ctx.options.downsampleImages && mayDownsample) {
    const shownBox = placed ?? (paint.scaleMode === 'fill' ? toPenpotBox(coverBox(natural, target.size), target.space) : undefined);
    const variant = shownBox && downsampled(ctx, paint.imageRef, natural, shownBox, target);
    if (variant) return { ...variant, keepAspectRatio: false, transform: shownBox };
  }
  const media = ctx.media.image(paint.imageRef, target.node);
  if (!media) return undefined;
  const image: PenpotImageColor = { ...media, keepAspectRatio: true };
  if (placed) {
    image.transform = placed;
    // The box already has the picture's final proportions; with keepAspectRatio Penpot would cover-fit the
    // image inside it again, showing the wrong region of a crop whose box aspect differs from the image's.
    image.keepAspectRatio = false;
  }
  return image;
}

/** `fill` (cover, centred) as a picture box in node-normalised space. */
function coverBox(media: { width: number; height: number }, size: ir.Size): PenpotImageTransform {
  const { width: w, height: h } = size;
  const k = Math.max(w / media.width, h / media.height);
  const bw = (media.width * k) / w;
  const bh = (media.height * k) / h;
  return { x: (1 - bw) / 2, y: (1 - bh) / 2, width: bw, height: bh };
}

/**
 * A reduced copy of the image for a picture shown much smaller than its natural size (`downsample.ts`), or
 * undefined to use the original. `placed` is the picture box in the Penpot box's normalised space.
 */
function downsampled(
  ctx: WriterContext,
  ref: string,
  media: { width: number; height: number },
  placed: PenpotImageTransform,
  target: PaintTarget,
): Omit<PenpotImageColor, 'keepAspectRatio' | 'transform'> | undefined {
  const shown = { width: placed.width * target.space.width, height: placed.height * target.space.height };
  const size = variantSize(media, shown, ctx.options.bakeScale);
  return size ? ctx.media.downsampled(ref, size, target.node) : undefined;
}

/**
 * Where the picture sits in node-normalised space for `fit`/`crop`, or
 * undefined for "covers the node". Penpot's image `transform` reproduces it
 * (with `keepAspectRatio: false`: the box is drawn exactly as given).
 */
function pictureBox(
  ctx: WriterContext,
  paint: ir.ImagePaint,
  media: { width: number; height: number },
  target: PaintTarget,
): PenpotImageTransform | undefined {
  const { width: w, height: h } = target.size;
  switch (paint.scaleMode) {
    case 'fill':
      return undefined;
    case 'fit': {
      if (!(w > 0 && h > 0)) return undefined;
      ctx.warn('image-scale-mode-approximated', 'Image "fit" relies on Penpot image transforms; older renderers draw it as cover', target.node);
      const scale = Math.min(w / media.width, h / media.height);
      const bw = (media.width * scale) / w;
      const bh = (media.height * scale) / h;
      return { x: (1 - bw) / 2, y: (1 - bh) / 2, width: bw, height: bh };
    }
    case 'crop': {
      const inv = paint.imageTransform ? invert(paint.imageTransform) : undefined;
      if (!inv) return undefined;
      if (Math.abs(inv.b) > 1e-6 || Math.abs(inv.c) > 1e-6 || inv.a <= 0 || inv.d <= 0) {
        ctx.warn('image-scale-mode-approximated', 'A rotated or mirrored image crop was drawn as cover', target.node);
        return undefined;
      }
      ctx.warn('image-scale-mode-approximated', 'Image "crop" relies on Penpot image transforms; older renderers draw it as cover', target.node);
      return { x: inv.e, y: inv.f, width: inv.a, height: inv.d };
    }
    case 'tile':
      ctx.warn('image-scale-mode-approximated', 'Penpot cannot tile images; the tiled image was drawn as cover', target.node);
      return undefined;
  }
}

/** Moves a node-normalised picture box into the Penpot box; undefined when the mapping rotates. */
function toPenpotBox(box: PenpotImageTransform, space: GradientSpace): PenpotImageTransform | undefined {
  const m = space.toBox;
  if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) return undefined;
  const p0 = apply(m, { x: box.x, y: box.y });
  const p1 = apply(m, { x: box.x + box.width, y: box.y + box.height });
  const result = {
    x: clean(Math.min(p0.x, p1.x)),
    y: clean(Math.min(p0.y, p1.y)),
    width: clean(Math.abs(p1.x - p0.x)),
    height: clean(Math.abs(p1.y - p0.y)),
  };
  return result;
}

/** Gradient space of a box shape: Penpot's box is the node's own box. */
export function boxSpace(width: number, height: number): GradientSpace {
  return { toBox: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width, height };
}

/**
 * Gradient space of a shape whose Penpot box is an axis-aligned page-space
 * rectangle (`bounds`) while the node maps to the page through `absolute`.
 */
export function boundsSpace(
  absolute: ir.Matrix,
  size: ir.Size,
  bounds: { x: number; y: number; width: number; height: number },
): GradientSpace {
  const bw = bounds.width > 1e-9 ? bounds.width : 1;
  const bh = bounds.height > 1e-9 ? bounds.height : 1;
  const pageToBox: ir.Matrix = { a: 1 / bw, b: 0, c: 0, d: 1 / bh, e: -bounds.x / bw, f: -bounds.y / bh };
  const normToLocal: ir.Matrix = { a: size.width, b: 0, c: 0, d: size.height, e: 0, f: 0 };
  return { toBox: multiply(pageToBox, multiply(absolute, normToLocal)), width: bounds.width, height: bounds.height };
}
