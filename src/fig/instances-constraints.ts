/**
 * Constraint-based resizing of materialised instance content — the FALLBACK
 * for when Figma did not store the layout result in `derivedSymbolData`.
 *
 * Figma normally writes the transform/size of every node that moves or
 * resizes when an instance differs in size from its symbol, so this path is
 * rarely needed: across all fixtures (incl. auto-layout-playground and
 * simple-design-system) no stored instance is resized without derived data
 * while having a child with a non-MIN constraint. It exists for nested
 * instances resized by an override without accompanying derived entries and
 * for files written by older Figma versions.
 *
 * Only non-auto-layout containers are handled (auto layout cannot be
 * re-run here; the content is left at the symbol's layout).
 */
import type { FigNode, NodeChange } from './types.ts';
import type { ConstraintType, Matrix, Vector } from './schema.d.ts';

const EPS = 0.01;

/** Node types whose children follow constraints when the node is resized. */
const CONSTRAINT_CONTAINERS = new Set<string>(['FRAME', 'INSTANCE', 'SYMBOL', 'SECTION']);

export function sizesDiffer(a: Vector | undefined, b: Vector | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) > EPS || Math.abs(a.y - b.y) > EPS;
}

export function hasAutoLayout(change: NodeChange): boolean {
  return change.stackMode !== undefined && change.stackMode !== 'NONE';
}

/**
 * Re-positions / resizes `container`'s (materialised, unshared) children for
 * a container resize `from` → `to`. Returns the number of nodes changed.
 */
export function applyConstraints(container: FigNode, from: Vector, to: Vector): number {
  if (hasAutoLayout(container.change)) return 0;
  let changed = 0;
  for (const child of container.children) {
    const before = child.change.size;
    const next = constrain(child.change, from, to);
    if (!next) continue;
    child.change = next;
    changed++;
    if (before && next.size && sizesDiffer(before, next.size) && CONSTRAINT_CONTAINERS.has(child.type)) {
      changed += applyConstraints(child, before, next.size);
    }
  }
  return changed;
}

/** The child's change after the parent resize, or `undefined` if unaffected. */
function constrain(change: NodeChange, from: Vector, to: Vector): NodeChange | undefined {
  const size = change.size;
  const t = change.transform;
  if (!size || !t) return undefined;
  const axisAligned = Math.abs(t.m01) < 1e-9 && Math.abs(t.m10) < 1e-9;

  // Axis-aligned bounding box of the child in parent space.
  const box = bounds(t, size);
  const x = resolveAxis(change.horizontalConstraint ?? 'MIN', box.x, box.w, from.x, to.x, axisAligned);
  const y = resolveAxis(change.verticalConstraint ?? 'MIN', box.y, box.h, from.y, to.y, axisAligned);
  if (Math.abs(x.start - box.x) < 1e-9 && Math.abs(y.start - box.y) < 1e-9 && x.size === box.w && y.size === box.h) {
    return undefined;
  }

  const out: NodeChange = { ...change };
  let newSize = size;
  if (axisAligned && (x.size !== box.w || y.size !== box.h)) {
    newSize = { x: x.size, y: y.size };
    out.size = newSize;
    // Cached geometry / text layout describe the old size.
    delete out.fillGeometry;
    delete out.strokeGeometry;
    delete out.derivedTextData;
  }
  const moved = bounds(t, newSize);
  out.transform = { ...t, m02: t.m02 + (x.start - moved.x), m12: t.m12 + (y.start - moved.y) };
  return out;
}

function bounds(t: Matrix, size: Vector): { x: number; y: number; w: number; h: number } {
  const xs = [0, size.x * t.m00, size.y * t.m01, size.x * t.m00 + size.y * t.m01];
  const ys = [0, size.x * t.m10, size.y * t.m11, size.x * t.m10 + size.y * t.m11];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: t.m02 + minX, y: t.m12 + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * One axis of Figma's constraint model. `start`/`length` are the child's
 * extent along the axis; `from`/`to` the parent's old/new length. A rotated
 * child is only moved, never resized.
 */
function resolveAxis(
  constraint: ConstraintType,
  start: number,
  length: number,
  from: number,
  to: number,
  resizable: boolean,
): { start: number; size: number } {
  const delta = to - from;
  switch (constraint) {
    case 'MAX':
    case 'FIXED_MAX':
      return { start: start + delta, size: length };
    case 'CENTER':
      return { start: start + delta / 2, size: length };
    case 'STRETCH':
      return resizable ? { start, size: Math.max(0, length + delta) } : { start: start + delta / 2, size: length };
    case 'SCALE': {
      const k = from > 0 ? to / from : 1;
      return resizable ? { start: start * k, size: length * k } : { start: start * k + (length * k - length) / 2, size: length };
    }
    default:
      return { start, size: length };
  }
}
