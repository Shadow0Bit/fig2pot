/** Small kiwi → IR value mappings shared by the translate modules. */
import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import type { TranslateContext } from './context.ts';

const warnedKeys = new WeakMap<TranslateContext, Set<string>>();

/**
 * `ctx.warn`, at most once per `code` and `scope` for one translation
 * (`scope` defaults to the node id: "once per node"; pass `'document'` for
 * once per document).
 */
export function warnOnce(ctx: TranslateContext, code: string, message: string, node?: FigNode, scope = node?.id ?? ''): void {
  let seen = warnedKeys.get(ctx);
  if (!seen) warnedKeys.set(ctx, (seen = new Set()));
  const key = `${code}\u0000${scope}`;
  if (seen.has(key)) return;
  seen.add(key);
  ctx.warn(code, message, node);
}

/** Kiwi `Matrix {m00 m01 m02 m10 m11 m12}` → IR matrix (see docs/ARCHITECTURE.md). */
export function matrixFromKiwi(m: fig.Matrix | undefined): ir.Matrix {
  if (!m) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    a: finite(m.m00, 1),
    b: finite(m.m10, 0),
    c: finite(m.m01, 0),
    d: finite(m.m11, 1),
    e: finite(m.m02, 0),
    f: finite(m.m12, 0),
  };
}

export function colorFromKiwi(c: fig.Color | undefined): ir.Color {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) };
}

const BLEND_MODES: Record<Exclude<fig.BlendMode, 'UNSET'>, ir.BlendMode> = {
  PASS_THROUGH: 'pass-through',
  NORMAL: 'normal',
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  LINEAR_BURN: 'linear-burn',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  LINEAR_DODGE: 'linear-dodge',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

/** `fallback` is used for absent/UNSET: `pass-through` for layers, `normal` for paints and effects. */
export function blendModeFromKiwi(mode: fig.BlendMode | undefined, fallback: ir.BlendMode): ir.BlendMode {
  if (!mode || mode === 'UNSET') return fallback;
  return BLEND_MODES[mode] ?? fallback;
}

export function windingFromKiwi(rule: fig.WindingRule | undefined): ir.WindingRule {
  return rule === 'ODD' ? 'evenodd' : 'nonzero';
}

export function finite(value: number | undefined | null, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clamp01(value: number | undefined): number {
  const v = finite(value, 0);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
