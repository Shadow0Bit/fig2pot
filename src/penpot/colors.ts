import type * as ir from '../ir.ts';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** `#rrggbb` (Penpot's hex colour schema), alpha is carried separately. */
export function hex(color: ir.Color): string {
  const channel = (v: number): string =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Rounds an opacity to a stable value in 0..1. */
export function opacity(value: number): number {
  return Math.round(clamp01(value) * 1e6) / 1e6;
}
