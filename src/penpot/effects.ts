/**
 * IR effects → Penpot `shadow`, `blur` and `backgroundBlur`.
 *
 * Penpot lists shadows top first (reverse of the IR order), has a single layer
 * blur and a single background blur per shape, and no shadow blend modes (a
 * grey `multiply` shadow over opaque content is written as the equivalent
 * black one).
 *
 * Blur strengths (measured on Penpot 2.19; Figma's gaussian has σ = radius / 2):
 * - SVG renderer: layer blur σ = value (an SVG `feGaussianBlur` stdDeviation),
 *   shadow σ = blur / 2; background blurs are not drawn at all.
 * - WASM renderer (Skia): layer blur, background blur and shadow blur all have
 *   σ ≈ 0.565 · value + 0.45 (Skia's radius → sigma conversion; fitted on
 *   values 2–100, within ±0.35 px).
 */
import type * as ir from '../ir.ts';
import { hex, opacity } from './colors.ts';
import type { WriterContext } from './context.ts';
import { clean, MAX_COORD } from './geometry.ts';
import { penpotId } from './ids.ts';
import type { PenpotBackgroundBlur, PenpotBlur, PenpotShadow } from './library.ts';

export interface PenpotEffects {
  shadow?: PenpotShadow[];
  blur?: PenpotBlur;
  backgroundBlur?: PenpotBackgroundBlur;
}

/** The WASM renderer's blur value whose gaussian has standard deviation `sigma`. */
export function wasmBlurValue(sigma: number): number {
  return sigma <= 0 ? 0 : Math.max(0, (sigma - 0.45) / 0.565);
}

/**
 * `opaqueBackdrop`: the node's nearest enclosing frame has an opaque fill, so its shadows land on opaque content
 * (a blend-mode equivalence that holds over opaque content only is then exact).
 */
export function convertEffects(ctx: WriterContext, node: ir.BaseNode, idBase: string = node.id, opaqueBackdrop = false): PenpotEffects {
  const out: PenpotEffects = {};
  const shadows: PenpotShadow[] = [];
  const wasm = ctx.options.renderer === 'wasm';
  let layerBlur: ir.BlurEffect | undefined;
  let backgroundBlur: ir.BlurEffect | undefined;
  node.effects.forEach((effect, index) => {
    if (!usable(effect)) {
      // A NaN would be written as `null`, which makes Penpot reject the whole file.
      ctx.warn('invalid-effect', `A ${effect.type} effect with non-finite parameters was dropped`, node);
      return;
    }
    if (isShadow(effect)) {
      if (effect.type === 'drop-shadow' && effect.visible && effect.showBehindNode === false && seeThrough(node)) {
        ctx.warn('shadow-behind-translucent-fill', 'Penpot draws the drop shadow under the translucent fill, where Figma hides it', node);
      }
      const color = shadowColor(effect, opaqueBackdrop);
      if (!color) {
        ctx.warn('shadow-blend-mode-unsupported', `Penpot shadows have no blend mode; "${effect.blendMode}" was ignored`, node);
      } else if (effect.blendMode !== 'normal' && effect.blendMode !== 'pass-through') {
        ctx.warn('shadow-blend-mode-converted', `Penpot shadows have no blend mode; the grey "${effect.blendMode}" shadow over opaque content is written as the black normal shadow that darkens it the same`, node);
      }
      shadows.push({
        id: penpotId(`${idBase}#effect${index}`, 'effect'),
        style: effect.type,
        offsetX: clean(effect.offset.x),
        offsetY: clean(effect.offset.y),
        // SVG: σ = blur / 2 like Figma. WASM: same σ through its own scale.
        blur: clean(wasm ? wasmBlurValue(Math.max(0, effect.blur) / 2) : Math.max(0, effect.blur)),
        spread: clean(effect.spread),
        hidden: !effect.visible,
        color: color ?? { color: hex(effect.color), opacity: opacity(effect.color.a) },
      });
      return;
    }
    const blur = effect;
    const current = blur.type === 'layer-blur' ? layerBlur : backgroundBlur;
    let chosen = blur;
    if (current) {
      ctx.warn('multiple-blurs', `Penpot supports one ${blur.type}; extra ones were dropped`, node);
      // Prefer a visible blur over a hidden one.
      chosen = !current.visible && blur.visible ? blur : current;
    }
    if (blur.type === 'layer-blur') layerBlur = chosen;
    else backgroundBlur = chosen;
  });
  if (shadows.length) out.shadow = shadows.reverse();
  if (layerBlur) {
    out.blur = {
      id: penpotId(`${idBase}#blur`, 'effect'),
      type: 'layer-blur',
      value: clean(blurValue(layerBlur.radius, wasm)),
      hidden: !layerBlur.visible,
    };
  }
  if (backgroundBlur) {
    if (!wasm && backgroundBlur.visible) {
      ctx.warn('background-blur-unsupported', "Penpot's SVG renderer does not draw background blurs; it is kept for the WASM renderer", node);
    }
    out.backgroundBlur = {
      id: penpotId(`${idBase}#background-blur`, 'effect'),
      type: 'background-blur',
      value: clean(blurValue(backgroundBlur.radius, wasm)),
      hidden: !backgroundBlur.visible,
    };
  }
  return out;
}

/** Penpot blur value for a Figma blur radius (σ = radius / 2). */
function blurValue(radius: number, wasm: boolean): number {
  const sigma = Math.max(0, radius) / 2;
  return wasm ? wasmBlurValue(sigma) : sigma;
}

function usable(effect: ir.Effect): boolean {
  const values = isShadow(effect) ? [effect.offset.x, effect.offset.y, effect.blur, effect.spread] : [effect.radius];
  return values.every((v) => Number.isFinite(v) && Math.abs(v) < MAX_COORD);
}

/**
 * A leaf shape (or empty board) whose fill lets the shadow show through. Containers with content are not
 * checked: their children usually cover the translucent parts.
 */
function seeThrough(node: ir.BaseNode): boolean {
  const n = node as ir.Node;
  if (n.type === 'group' || n.type === 'boolean' || n.type === 'text' || (n.type === 'frame' && n.children.length > 0)) return false;
  const visible = node.fills.filter((p) => p.visible && p.opacity > 0);
  if (visible.length === 0) return false;
  return !visible.some((p) => {
    if (p.type === 'solid') return p.color.a * p.opacity >= 0.999;
    if (p.type === 'gradient') return p.stops.length > 0 && p.stops.every((s) => s.color.a * p.opacity >= 0.999);
    // Images: their alpha is unknown here; assume opaque rather than warn on every photo.
    return p.opacity >= 0.999;
  });
}

/**
 * The shadow colour in normal blending, undefined when the blend mode cannot be expressed. Over opaque content,
 * a grey `multiply` shadow (grey g, alpha a) scales what is under it by 1 − a + a·g, which is exactly a black
 * shadow with alpha a·(1 − g) (auto-layout-playground's card shadows: #acacac at 50 %, multiply). Over
 * transparency multiply draws the colour itself, so without an opaque backdrop the colour is kept
 * (auto-layout-playground 2411:10790, a fill-less board).
 */
function shadowColor(effect: ir.ShadowEffect, opaqueBackdrop: boolean): PenpotShadow['color'] | undefined {
  if (effect.blendMode === 'normal' || effect.blendMode === 'pass-through') return { color: hex(effect.color), opacity: opacity(effect.color.a) };
  const { r, g, b, a } = effect.color;
  const grey = Math.max(r, g, b) - Math.min(r, g, b) <= 0.5 / 255;
  if (effect.blendMode === 'multiply' && grey && opaqueBackdrop) return { color: '#000000', opacity: opacity(a * (1 - (r + g + b) / 3)) };
  return undefined;
}

function isShadow(effect: ir.Effect): effect is ir.ShadowEffect {
  return effect.type === 'drop-shadow' || effect.type === 'inner-shadow';
}
