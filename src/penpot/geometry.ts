/**
 * IR transforms (local → parent) → Penpot geometry (absolute page space).
 */
import type * as ir from '../ir.ts';
import { apply, applyVector, determinant, invert } from '../util/matrix.ts';
import type { BoxGeometry, PenpotMatrix } from './library.ts';

const EPS = 1e-9;
/** Penpot misbehaves with zero-sized boxes; this is its own minimum (`make-minimal-shape`). */
const MIN_SIZE = 0.01;

/** Penpot's `safe-number` bound: coordinates and sizes beyond it make the whole file unimportable. */
export const MAX_COORD = 2_147_483_647;

const IDENTITY: PenpotMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Rounds away float noise so that output is stable and `-0` never appears. */
export function clean(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

export interface BoxFit {
  geometry: BoxGeometry;
  /** The transform shears (its axes are not perpendicular). */
  skewed: boolean;
  /** Scale factors of the local axes that were baked into width/height. */
  scaleX: number;
  scaleY: number;
}

/**
 * Penpot's box model for a node whose local space maps to the page through `m`.
 *
 * Penpot keeps the untransformed box centred on the real centre and applies a
 * normalised linear transform around it (see `calculate-geometry` in
 * `app.common.geom.shapes.transforms`); any scale is moved into width/height.
 * A mirroring transform is stored with `flipX` and a rotation measured from the
 * mirrored x axis, which is what Penpot itself produces when the user flips.
 */
export function boxGeometry(m: ir.Matrix, size: ir.Size): BoxFit {
  const col1 = applyVector(m, { x: 1, y: 0 });
  const col2 = applyVector(m, { x: 0, y: 1 });
  const scaleX = Math.hypot(col1.x, col1.y);
  const scaleY = Math.hypot(col2.x, col2.y);
  const u1 = scaleX > EPS ? { x: col1.x / scaleX, y: col1.y / scaleX } : { x: 1, y: 0 };
  const sign = determinant(m) < 0 ? -1 : 1;
  const u2 = scaleY > EPS ? { x: col2.x / scaleY, y: col2.y / scaleY } : { x: -u1.y * sign, y: u1.x * sign };

  const width = Math.max(size.width * scaleX, MIN_SIZE);
  const height = Math.max(size.height * scaleY, MIN_SIZE);
  const center = apply(m, { x: size.width / 2, y: size.height / 2 });

  const linear = { a: u1.x, b: u1.y, c: u2.x, d: u2.y, e: 0, f: 0 };
  const mirrored = determinant(linear) < 0;
  const transform = isIdentityLinear(linear) ? IDENTITY : cleanMatrix(linear);
  const inverse = invert(transform) ?? IDENTITY;
  const rotationRad = mirrored ? Math.atan2(-u1.y, -u1.x) : Math.atan2(u1.y, u1.x);

  const geometry: BoxGeometry = {
    x: clean(center.x - width / 2),
    y: clean(center.y - height / 2),
    width: clean(width),
    height: clean(height),
    rotation: normalizeDegrees((rotationRad * 180) / Math.PI),
    transform,
    transformInverse: isIdentityLinear(inverse) ? IDENTITY : cleanMatrix(inverse),
  };
  if (mirrored) geometry.flipX = true;
  return {
    geometry,
    skewed: Math.abs(u1.x * u2.x + u1.y * u2.y) > 1e-6,
    scaleX,
    scaleY,
  };
}

function isIdentityLinear(m: PenpotMatrix): boolean {
  return Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9;
}

function cleanMatrix(m: PenpotMatrix): PenpotMatrix {
  return { a: clean(m.a, 9), b: clean(m.b, 9), c: clean(m.c, 9), d: clean(m.d, 9), e: 0, f: 0 };
}

function normalizeDegrees(deg: number): number {
  const d = clean(((deg % 360) + 360) % 360, 6);
  return d === 360 ? 0 : d;
}

/** An axis-aligned box at the origin; for groups and booleans, whose box Penpot recomputes from the children. */
export function unitBox(): BoxGeometry {
  return { x: 0, y: 0, width: 1, height: 1, rotation: 0, transform: IDENTITY, transformInverse: IDENTITY };
}

/**
 * Geometry for a group: only its orientation matters (Penpot recomputes the
 * box from the children). Shearing or mirroring orientations are dropped, the
 * group then gets an axis-aligned box, which changes nothing visually.
 */
export function orientation(fit: BoxFit): BoxGeometry {
  if (fit.skewed || fit.geometry.flipX) return unitBox();
  return { ...fit.geometry };
}

/** Page-space bounding box of a node's local box. */
export function pageBounds(m: ir.Matrix, size: ir.Size): { x: number; y: number; width: number; height: number } {
  const corners = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: size.width, y: size.height },
    { x: 0, y: size.height },
  ].map((p) => apply(m, p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
