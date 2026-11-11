import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { blendModeFromKiwi, colorFromKiwi, finite } from './common.ts';
import type { TranslateContext } from './context.ts';
import { resolveColorVariable } from './variables.ts';

export function translateEffects(effects: fig.Effect[] | undefined, ctx: TranslateContext, node?: FigNode): ir.Effect[] {
  const out: ir.Effect[] = [];
  for (const effect of effects ?? []) {
    const visible = effect.visible ?? true;
    switch (effect.type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW': {
        const shadow: ir.ShadowEffect = {
          type: effect.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow',
          visible,
          color: colorFromKiwi(resolveColorVariable(ctx.doc, effect.colorVar, node) ?? effect.color),
          offset: { x: finite(effect.offset?.x, 0), y: finite(effect.offset?.y, 0) },
          blur: Math.max(0, finite(effect.radius, 0)),
          spread: finite(effect.spread, 0),
          blendMode: blendModeFromKiwi(effect.blendMode, 'normal'),
        };
        if (effect.type === 'DROP_SHADOW') shadow.showBehindNode = effect.showShadowBehindNode ?? false;
        out.push(shadow);
        break;
      }
      case 'FOREGROUND_BLUR':
      case 'BACKGROUND_BLUR': {
        let radius = Math.max(0, finite(effect.radius, 0));
        if (effect.blurOpType === 'PROGRESSIVE') {
          // A progressive blur ramps from `startRadius` to `radius` across the node. A uniform
          // blur at the END radius smears parts Figma shows sharp, which looks far worse than
          // under-blurring, so the weaker end of the ramp is used (often 0: no blur at all).
          radius = Math.min(radius, Math.max(0, finite(effect.startRadius, 0)));
          ctx.warn('progressive-blur', 'progressive blur is not supported; its weakest radius is applied uniformly', node);
          if (radius === 0) break;
        }
        out.push({
          type: effect.type === 'FOREGROUND_BLUR' ? 'layer-blur' : 'background-blur',
          visible,
          radius,
        });
        break;
      }
      default:
        ctx.warn('unsupported-effect', `${effect.type ?? 'unknown'} effects are not supported; skipped`, node);
    }
  }
  return out;
}
