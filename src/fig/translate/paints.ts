import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { apply, invert } from '../../util/matrix.ts';
import { blendModeFromKiwi, clamp01, colorFromKiwi, finite, hex, matrixFromKiwi, warnOnce } from './common.ts';
import type { TranslateContext } from './context.ts';
import { resolveColorVariable } from './variables.ts';

const GRADIENT_TYPES = {
  GRADIENT_LINEAR: 'linear',
  GRADIENT_RADIAL: 'radial',
  GRADIENT_ANGULAR: 'angular',
  GRADIENT_DIAMOND: 'diamond',
} as const satisfies Partial<Record<fig.PaintType, ir.GradientPaint['gradientType']>>;

const SCALE_MODES: Record<fig.ImageScaleMode, ir.ImageScaleMode> = {
  FILL: 'fill',
  FIT: 'fit',
  // Kiwi's STRETCH is the UI's "Crop" (REST `STRETCH` + `imageTransform`).
  STRETCH: 'crop',
  TILE: 'tile',
};

/**
 * Translates a kiwi paint list (fills or strokes) into IR paints, bottom → top.
 * Unsupported paint types (emoji, video, pattern, noise, custom shaders) are
 * dropped with an `unsupported-paint` warning.
 */
export function translatePaints(paints: fig.Paint[] | undefined, ctx: TranslateContext, node?: FigNode): ir.Paint[] {
  const out: ir.Paint[] = [];
  for (const paint of paints ?? []) {
    const translated = translatePaint(paint, ctx, node);
    if (translated) out.push(translated);
  }
  return out;
}

function translatePaint(paint: fig.Paint, ctx: TranslateContext, node: FigNode | undefined): ir.Paint | undefined {
  const base = {
    visible: paint.visible ?? true,
    opacity: clamp01(paint.opacity ?? 1),
    blendMode: blendModeFromKiwi(paint.blendMode, 'normal'),
  };
  const type = paint.type ?? 'SOLID';
  switch (type) {
    case 'SOLID': {
      const color = (paint.colorVar && resolveColorVariable(ctx.doc, paint.colorVar, node)) || paint.color;
      if (!color) ctx.warn('paint-missing-color', 'solid paint without a colour; using black', node);
      else if (paint.colorVar && color === paint.color && !paint.colorVar.value?.colorValue) {
        ctx.warn('unresolved-color-variable', 'colour variable not found in the file; using the cached colour', node);
      }
      return { ...base, type: 'solid', color: colorFromKiwi(color) };
    }
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND': {
      const gradientType = GRADIENT_TYPES[type];
      // `stopsVar` parallels `stops` when stop colours are bound to variables.
      const stops: ir.GradientStop[] = (paint.stops ?? []).map((stop, i) => ({
        position: clamp01(stop.position),
        color: colorFromKiwi(resolveColorVariable(ctx.doc, paint.stopsVar?.[i]?.colorVar, node) ?? stop.color),
      }));
      if (stops.length === 0) {
        ctx.warn('gradient-without-stops', 'gradient paint has no stops; skipped', node);
        return undefined;
      }
      const space = paint.interpolationColorSpace;
      if (space && space !== 'DEFAULT') {
        warnOnce(ctx, 'unsupported-gradient-color-space', `gradient interpolated in ${space} is emitted with sRGB interpolation`, node);
      }
      return { ...base, type: 'gradient', gradientType, handles: gradientHandles(paint.transform, gradientType), stops };
    }
    case 'IMAGE':
      return imagePaint(paint, base, ctx, node);
    default:
      ctx.warn('unsupported-paint', `${type} paints are not supported; skipped`, node);
      return undefined;
  }
}

/**
 * The kiwi gradient transform maps the node's normalised space INTO gradient
 * space, where the gradient runs from (0, .5) to (1, .5) (linear) or is centred
 * at (.5, .5) with radii .5 (radial/angular/diamond). REST handle positions are
 * those canonical points mapped back with the inverse.
 */
export function gradientHandles(transform: fig.Matrix | undefined, type: ir.GradientPaint['gradientType']): [ir.Vec2, ir.Vec2, ir.Vec2] {
  const inverse = invert(matrixFromKiwi(transform)) ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const linear = type === 'linear';
  return [
    apply(inverse, { x: linear ? 0 : 0.5, y: 0.5 }),
    apply(inverse, { x: 1, y: 0.5 }),
    apply(inverse, { x: linear ? 0 : 0.5, y: 1 }),
  ];
}

function imagePaint(
  paint: fig.Paint,
  base: Pick<ir.ImagePaint, 'visible' | 'opacity' | 'blendMode'>,
  ctx: TranslateContext,
  node: FigNode | undefined,
): ir.ImagePaint | undefined {
  const hash = paint.image?.hash;
  if (!hash || hash.length === 0) {
    ctx.warn('missing-image', 'image paint has no image hash; skipped', node);
    return undefined;
  }
  const imageRef = hex(hash);
  if (!ctx.doc.file.images.has(imageRef) && paint.image?.dataBlob === undefined) {
    ctx.warn('missing-image', `image ${imageRef} is not embedded in the file`, node);
  }
  const scaleMode = SCALE_MODES[paint.imageScaleMode ?? 'FILL'] ?? 'fill';
  const out: ir.ImagePaint = { ...base, type: 'image', imageRef, scaleMode };
  if (scaleMode === 'crop' && paint.transform) out.imageTransform = matrixFromKiwi(paint.transform);
  if (scaleMode === 'tile') out.scalingFactor = finite(paint.scale, 1);
  const rotation = (((Math.round(finite(paint.rotation, 0)) % 360) + 360) % 360);
  if (rotation !== 0) out.rotation = rotation;
  const filters = imageFilters(paint.paintFilter);
  if (filters) out.filters = filters;
  const unmapped = UNMAPPED_FILTERS.filter((key) => {
    const value = paint.paintFilter?.[key];
    return value !== undefined && Number.isFinite(value) && value !== 0;
  });
  if (unmapped.length > 0) {
    warnOnce(ctx, 'unsupported-image-filter', `image filter ${unmapped.join(', ')} has no IR equivalent; dropped`, node);
  }
  return out;
}

/** `PaintFilterMessage` fields `imageFilters` does not map. */
const UNMAPPED_FILTERS = ['brightness', 'detail', 'vignette'] as const satisfies readonly (keyof fig.PaintFilterMessage)[];

function imageFilters(filter: fig.PaintFilterMessage | undefined): ir.ImageFilters | undefined {
  if (!filter) return undefined;
  const out: ir.ImageFilters = {};
  const set = (key: keyof ir.ImageFilters, value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value) && value !== 0) out[key] = value;
  };
  set('exposure', filter.exposure);
  set('contrast', filter.contrast);
  // The UI's "Saturation" slider is stored as `vibrance` (kiwi has no saturation field).
  set('saturation', filter.vibrance);
  set('temperature', filter.temperature);
  set('tint', filter.tint);
  set('highlights', filter.highlights);
  set('shadows', filter.shadows);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Ids of every image referenced by an image paint in `paints`, with its optional blob index. */
export function imageRefsOf(paints: readonly fig.Paint[] | undefined): { ref: string; dataBlob?: number }[] {
  const out: { ref: string; dataBlob?: number }[] = [];
  for (const paint of paints ?? []) {
    const hash = paint.type === 'IMAGE' ? paint.image?.hash : undefined;
    if (hash && hash.length > 0) out.push({ ref: hex(hash), dataBlob: paint.image?.dataBlob });
  }
  return out;
}
