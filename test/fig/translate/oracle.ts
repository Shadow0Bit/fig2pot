/**
 * Compares a translated IR document with a Figma REST API dump
 * (`GET /v1/files/:key?geometry=paths`) of the same file. Node ids match
 * (`12:34`; instance descendants `I…;…`).
 */
import type * as ir from '../../../src/ir.ts';
import { isContainer } from '../../../src/ir.ts';
import { apply, identity, invert, multiply } from '../../../src/util/matrix.ts';
import type { Translated } from './helpers.ts';

/* eslint-disable @typescript-eslint/no-explicit-any -- REST JSON is untyped */
type Rest = any;

export interface FieldStats {
  compared: number;
  mismatched: number;
  samples: string[];
}

export interface OracleReport {
  /** REST nodes considered. */
  nodes: number;
  /** REST nodes with no IR counterpart, by REST type. */
  missing: Record<string, number>;
  fields: Record<string, FieldStats>;
}

export interface OracleOptions {
  /** Also compare instance descendants (`I…` ids). Default false. */
  includeInstanceChildren?: boolean;
  sampleLimit?: number;
}

interface Placed {
  node: ir.Node;
  abs: ir.Matrix;
  parent?: Placed;
}

const EPS_POS = 0.05;
const EPS = 1e-3;

export function compareWithRest(t: Translated, rest: Rest, options: OracleOptions = {}): OracleReport {
  const sampleLimit = options.sampleLimit ?? 8;
  const placed = new Map<string, Placed>();
  const place = (nodes: readonly ir.Node[], parentAbs: ir.Matrix, parent?: Placed): void => {
    for (const node of nodes) {
      const p: Placed = { node, abs: multiply(parentAbs, node.transform), parent };
      placed.set(node.id, p);
      if (isContainer(node)) place(node.children, p.abs, p);
    }
  };
  for (const page of t.ir.pages) place(page.children, identity());

  const report: OracleReport = { nodes: 0, missing: {}, fields: {} };
  let current = '';
  const check = (field: string, ok: boolean, detail: () => string): void => {
    const stats = (report.fields[field] ??= { compared: 0, mismatched: 0, samples: [] });
    stats.compared++;
    if (!ok) {
      stats.mismatched++;
      if (stats.samples.length < sampleLimit) stats.samples.push(`${current}: ${detail()}`);
    }
  };

  const visit = (r: Rest, restParent: Rest | undefined): void => {
    for (const child of r.children ?? []) visit(child, r);
    if (r.type === 'DOCUMENT' || r.type === 'CANVAS') return;
    if (!options.includeInstanceChildren && String(r.id).startsWith('I')) return;
    report.nodes++;
    const p = placed.get(r.id);
    if (!p) {
      report.missing[r.type] = (report.missing[r.type] ?? 0) + 1;
      return;
    }
    current = `${r.id} ${r.type} ${JSON.stringify(r.name)}`;
    compareNode(r, restParent, p, placed, check);
  };
  visit(rest.document, undefined);

  compareComponents(t, rest, check, (id) => (current = id));
  compareStyles(t, rest, check, (id) => (current = id));
  return report;
}

type Check = (field: string, ok: boolean, detail: () => string) => void;

const near = (a: number | undefined, b: number | undefined, eps = EPS): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= eps;

const TYPES: Record<string, ir.NodeType[]> = {
  FRAME: ['frame'],
  GROUP: ['group'],
  SECTION: ['frame'],
  COMPONENT: ['frame'],
  COMPONENT_SET: ['frame'],
  INSTANCE: ['frame'],
  RECTANGLE: ['rect'],
  ELLIPSE: ['ellipse', 'path'],
  VECTOR: ['path'],
  LINE: ['path'],
  STAR: ['path'],
  REGULAR_POLYGON: ['path'],
  BOOLEAN_OPERATION: ['boolean'],
  TEXT: ['text'],
};
const ROLES: Record<string, ir.FrameNode['role']> = {
  FRAME: 'frame',
  SECTION: 'section',
  COMPONENT: 'component',
  COMPONENT_SET: 'component-set',
  INSTANCE: 'instance',
};

const kebab = (s: string | undefined): string | undefined => s?.toLowerCase().replace(/_/g, '-');

function aabb(m: ir.Matrix, w: number, h: number): { x: number; y: number; width: number; height: number } {
  const pts = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((pt) => apply(m, pt));
  const xs = pts.map((pt) => pt.x);
  const ys = pts.map((pt) => pt.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function compareNode(r: Rest, restParent: Rest, p: Placed, placed: Map<string, Placed>, check: Check): void {
  const n = p.node;
  // A VECTOR with per-region fills becomes a group of fill paths plus a stroke-only path (src/fig/translate/vector.ts);
  // REST keeps those fills in `fillOverrideTable`, so only the stroke is compared.
  const regionGroup = r.type === 'VECTOR' && n.type === 'group' && n.children.some((c) => c.id.startsWith(`${n.id}#`));
  const stroked = regionGroup ? (n.children.find((c) => c.id === `${n.id}#stroke`) ?? n) : n;
  check('type', regionGroup || (TYPES[r.type] ?? []).includes(n.type), () => `IR ${n.type}`);
  if (n.type === 'frame' && ROLES[r.type]) check('role', n.role === ROLES[r.type], () => `IR role ${n.role}`);

  if (r.size) check('size', near(r.size.x, n.size.width, EPS_POS) && near(r.size.y, n.size.height, EPS_POS), () => `REST ${r.size.x}×${r.size.y} IR ${n.size.width}×${n.size.height}`);

  // Page-space bounds: the composed IR transforms, axis-aligned (so rotated nodes compare their bounds).
  if (r.absoluteBoundingBox) {
    const box = aabb(p.abs, n.size.width, n.size.height);
    const b = r.absoluteBoundingBox;
    const ok = near(b.x, box.x, EPS_POS) && near(b.y, box.y, EPS_POS) && near(b.width, box.width, EPS_POS) && near(b.height, box.height, EPS_POS);
    check('absoluteBoundingBox', ok, () => `REST ${JSON.stringify(b)} IR ${JSON.stringify(box)}`);
  }

  if (r.relativeTransform) {
    const parentAbs = restParent && restParent.type !== 'CANVAS' ? placed.get(restParent.id)?.abs : identity();
    const inv = parentAbs ? invert(parentAbs) : undefined;
    if (inv) {
      const rel = multiply(inv, p.abs);
      const [[a, c, e], [b, d, f]] = r.relativeTransform;
      const ok = near(rel.a, a) && near(rel.b, b) && near(rel.c, c) && near(rel.d, d) && near(rel.e, e, EPS_POS) && near(rel.f, f, EPS_POS);
      check('relativeTransform', ok, () => `REST ${JSON.stringify(r.relativeTransform)} IR ${JSON.stringify(rel)}`);
    }
  }

  check('visible', (r.visible ?? true) === n.visible, () => `IR ${n.visible}`);
  check('locked', (r.locked ?? false) === n.locked, () => `IR ${n.locked}`);
  check('opacity', near(r.opacity ?? 1, n.opacity), () => `REST ${r.opacity} IR ${n.opacity}`);
  if (r.blendMode) check('blendMode', kebab(r.blendMode) === n.blendMode, () => `REST ${r.blendMode} IR ${n.blendMode}`);

  if (r.fills && !regionGroup) comparePaints('fills', r.fills, n.fills, check);
  if (r.strokes) comparePaints('strokes', r.strokes, stroked.stroke?.paints ?? [], check);
  if (r.strokes?.length && stroked.stroke) compareStroke(r, stroked.stroke, check, stroked.type === 'path' && openOnly(stroked.paths));

  // REST does not report the (fixed, cosmetic) corner radius of sections.
  if ((n.type === 'frame' && n.role !== 'section') || n.type === 'rect') {
    // REST reports the stored radii; the IR holds what Figma renders (clamped to the box).
    const raw: number[] = r.rectangleCornerRadii ?? (r.cornerRadius ? [r.cornerRadius, r.cornerRadius, r.cornerRadius, r.cornerRadius] : [0, 0, 0, 0]);
    const want = clampToBox(raw, r.size?.x ?? n.size.width, r.size?.y ?? n.size.height);
    const got = n.cornerRadii ?? [0, 0, 0, 0];
    check('cornerRadii', want.every((v, i) => near(v, got[i])), () => `REST ${JSON.stringify(want)} IR ${JSON.stringify(n.cornerRadii)}`);
    if (r.cornerSmoothing && n.cornerRadii) check('cornerSmoothing', near(r.cornerSmoothing, n.cornerSmoothing ?? 0), () => `REST ${r.cornerSmoothing} IR ${n.cornerSmoothing}`);
  }

  if (r.effects) compareEffects(r.effects, n.effects, check);
  if (n.type === 'frame' && r.clipsContent !== undefined) check('clipsContent', r.clipsContent === n.clipsContent, () => `REST ${r.clipsContent}`);
  if (n.type === 'frame' && r.layoutMode !== undefined) compareLayout(r, n, check);

  if (r.layoutSizingHorizontal) {
    const want = `${r.layoutSizingHorizontal}/${r.layoutSizingVertical}`.toLowerCase();
    const got = n.sizing ? `${n.sizing.horizontal}/${n.sizing.vertical}` : 'none';
    check('sizing', want === got, () => `REST ${want} IR ${got}`);
  }
  if (r.layoutPositioning === 'ABSOLUTE' || n.layoutChild?.positioning === 'absolute') {
    check('layoutPositioning', (r.layoutPositioning === 'ABSOLUTE') === (n.layoutChild?.positioning === 'absolute'), () => `REST ${r.layoutPositioning}`);
  }
  for (const [restKey, irKey] of [['minWidth', 'minWidth'], ['maxWidth', 'maxWidth'], ['minHeight', 'minHeight'], ['maxHeight', 'maxHeight']] as const) {
    if (r[restKey] !== undefined && r[restKey] !== null && restParent?.layoutMode && restParent.layoutMode !== 'NONE') {
      check('minMax', near(r[restKey], n.layoutChild?.[irKey]), () => `${restKey} REST ${r[restKey]} IR ${n.layoutChild?.[irKey]}`);
    }
  }
  if (r.constraints) {
    const h: Record<string, string> = { LEFT: 'left', RIGHT: 'right', CENTER: 'center', LEFT_RIGHT: 'left-right', SCALE: 'scale' };
    const v: Record<string, string> = { TOP: 'top', BOTTOM: 'bottom', CENTER: 'center', TOP_BOTTOM: 'top-bottom', SCALE: 'scale' };
    check('constraints', h[r.constraints.horizontal] === n.constraints?.horizontal && v[r.constraints.vertical] === n.constraints?.vertical, () => `REST ${JSON.stringify(r.constraints)} IR ${JSON.stringify(n.constraints)}`);
  }

  if (r.isMask) {
    const group = p.parent?.node;
    const ok = group?.type === 'group' && !!group.mask && group.children[0] === n;
    check('mask', ok, () => 'not the first child of a mask group');
    if (ok && group.type === 'group') {
      const want = r.maskType === 'VECTOR' ? 'vector' : r.maskType === 'LUMINANCE' ? 'luminance' : 'alpha';
      check('maskType', group.mask!.type === want, () => `REST ${r.maskType} IR ${group.mask!.type}`);
    }
  }
  if (r.type === 'BOOLEAN_OPERATION' && n.type === 'boolean') {
    const map: Record<string, string> = { UNION: 'union', SUBTRACT: 'subtract', INTERSECT: 'intersect', EXCLUDE: 'exclude' };
    check('booleanOperation', map[r.booleanOperation] === n.operation, () => `REST ${r.booleanOperation} IR ${n.operation}`);
  }

  if (r.fillGeometry?.length) {
    const want = svgBounds(r.fillGeometry.map((g: Rest) => g.path).join(' '));
    const got = pathBounds(n.geometry?.fill ?? []);
    check('fillGeometry', boundsNear(want, got), () => `REST ${JSON.stringify(want)} IR ${JSON.stringify(got)}`);
    if (n.type === 'path' && n.pathsAreExact && n.fills.some((f) => f.visible)) {
      const paths = pathBounds(n.paths);
      check('pathsVsFillGeometry', boundsNear(want, paths), () => `REST ${JSON.stringify(want)} IR paths ${JSON.stringify(paths)}`);
    }
  }
  if (r.strokeGeometry?.length) {
    check('strokeGeometry', boundsNear(svgBounds(r.strokeGeometry.map((g: Rest) => g.path).join(' ')), pathBounds(n.geometry?.stroke ?? [])), () => 'bounds differ');
  }
}

/** CSS corner clamping: scale all radii so that no side's two radii overlap. */
function clampToBox(radii: number[], w: number, h: number): number[] {
  const [tl = 0, tr = 0, br = 0, bl = 0] = radii;
  const sides: [number, number][] = [[w, tl + tr], [w, bl + br], [h, tl + bl], [h, tr + br]];
  const f = Math.min(1, ...sides.filter(([, sum]) => sum > 0).map(([side, sum]) => side / sum));
  return [tl * f, tr * f, br * f, bl * f];
}

function comparePaints(field: string, want: Rest[], got: ir.Paint[], check: Check): void {
  check(`${field}.count`, want.length === got.length, () => `REST ${want.map((p) => p.type).join(',')} IR ${got.map((p) => p.type).join(',')}`);
  if (want.length !== got.length) return;
  want.forEach((w, i) => {
    const g = got[i]!;
    const type = w.type === 'SOLID' ? 'solid' : w.type === 'IMAGE' ? 'image' : String(w.type).startsWith('GRADIENT_') ? 'gradient' : '?';
    check(`${field}.type`, type === g.type, () => `REST ${w.type} IR ${g.type}`);
    check(`${field}.visible`, (w.visible ?? true) === g.visible, () => `REST ${w.visible} IR ${g.visible}`);
    check(`${field}.opacity`, near(w.opacity ?? 1, g.opacity), () => `REST ${w.opacity} IR ${g.opacity}`);
    check(`${field}.blendMode`, kebab(w.blendMode ?? 'NORMAL') === g.blendMode, () => `REST ${w.blendMode} IR ${g.blendMode}`);
    if (g.type === 'solid' && w.color) check(`${field}.color`, colorNear(w.color, g.color), () => `REST ${JSON.stringify(w.color)} IR ${JSON.stringify(g.color)}`);
    if (g.type === 'gradient') {
      check(`${field}.gradientType`, `GRADIENT_${g.gradientType.toUpperCase()}` === w.type, () => `REST ${w.type} IR ${g.gradientType}`);
      const handles: Rest[] = w.gradientHandlePositions ?? [];
      check(`${field}.gradientHandles`, handles.length === 3 && handles.every((h, k) => near(h.x, g.handles[k]!.x) && near(h.y, g.handles[k]!.y)), () => `REST ${JSON.stringify(handles)} IR ${JSON.stringify(g.handles)}`);
      const stops: Rest[] = w.gradientStops ?? [];
      check(`${field}.gradientStops`, stops.length === g.stops.length && stops.every((s, k) => near(s.position, g.stops[k]!.position) && colorNear(s.color, g.stops[k]!.color)), () => `REST ${JSON.stringify(stops)} IR ${JSON.stringify(g.stops)}`);
    }
    if (g.type === 'image') {
      check(`${field}.imageRef`, w.imageRef === g.imageRef, () => `REST ${w.imageRef} IR ${g.imageRef}`);
      const mode: Record<string, string> = { FILL: 'fill', FIT: 'fit', TILE: 'tile', STRETCH: 'crop' };
      check(`${field}.scaleMode`, mode[w.scaleMode] === g.scaleMode, () => `REST ${w.scaleMode} IR ${g.scaleMode}`);
      if (w.imageTransform) {
        const [[a, c, e], [b, d, f]] = w.imageTransform;
        const m = g.imageTransform;
        check(`${field}.imageTransform`, !!m && near(m.a, a) && near(m.b, b) && near(m.c, c) && near(m.d, d) && near(m.e, e) && near(m.f, f), () => `REST ${JSON.stringify(w.imageTransform)} IR ${JSON.stringify(m)}`);
      }
      if (w.scalingFactor !== undefined) check(`${field}.scalingFactor`, near(w.scalingFactor, g.scalingFactor), () => `REST ${w.scalingFactor} IR ${g.scalingFactor}`);
      if (w.rotation) check(`${field}.rotation`, near(((w.rotation % 360) + 360) % 360, g.rotation ?? 0), () => `REST ${w.rotation} IR ${g.rotation}`);
    }
  });
}

function colorNear(a: Rest, b: ir.Color): boolean {
  return near(a.r, b.r) && near(a.g, b.g) && near(a.b, b.b) && near(a.a ?? 1, b.a);
}

/** Whether the outline has sub-paths and none of them is closed. */
function openOnly(paths: readonly ir.Path[]): boolean {
  const commands = paths.flatMap((p) => p.commands);
  return commands.some((c) => c.type === 'M') && !commands.some((c) => c.type === 'Z');
}

/**
 * `open`: the IR path has open sub-paths only, which Figma strokes centred
 * whatever `strokeAlign` says, so `center` is right too (except dashed ones
 * Figma draws 2w wide; open-stroke.test.ts pins which alignment each gets).
 */
function compareStroke(r: Rest, s: ir.Stroke, check: Check, open: boolean): void {
  if (r.individualStrokeWeights) {
    const w = r.individualStrokeWeights;
    const got = s.perSide ?? { top: s.weight, right: s.weight, bottom: s.weight, left: s.weight };
    check('strokeWeight', near(w.top, got.top) && near(w.right, got.right) && near(w.bottom, got.bottom) && near(w.left, got.left), () => `REST ${JSON.stringify(w)} IR ${JSON.stringify(got)}`);
  } else {
    check('strokeWeight', near(r.strokeWeight, s.weight) && !s.perSide, () => `REST ${r.strokeWeight} IR ${s.weight} ${JSON.stringify(s.perSide)}`);
  }
  check('strokeAlign', kebab(r.strokeAlign) === s.align || (open && s.align === 'center'), () => `REST ${r.strokeAlign}${open ? ' (open path)' : ''} IR ${s.align}`);
  // REST's strokeCap / strokeJoin are node-level; per-vertex caps and joins (vectorNetwork `meta`) override them.
  const perVertex = (r.vectorNetwork?.vertices ?? []).some((v: Rest) => v.meta);
  if (!perVertex) check('strokeJoin', kebab(r.strokeJoin ?? 'MITER') === s.join, () => `REST ${r.strokeJoin} IR ${s.join}`);
  check('strokeDashes', JSON.stringify(r.strokeDashes ?? []) === JSON.stringify(s.dashPattern), () => `REST ${JSON.stringify(r.strokeDashes)} IR ${JSON.stringify(s.dashPattern)}`);
  const caps: Record<string, ir.StrokeCap> = { NONE: 'none', ROUND: 'round', SQUARE: 'square', LINE_ARROW: 'line-arrow', TRIANGLE_ARROW: 'triangle-arrow', TRIANGLE_FILLED: 'triangle-arrow', DIAMOND_FILLED: 'diamond', CIRCLE_FILLED: 'circle' };
  if (r.strokeCap !== 'MIXED' && !perVertex) {
    const want = caps[r.strokeCap ?? 'NONE'];
    check('strokeCap', want === s.startCap && want === s.endCap, () => `REST ${r.strokeCap} IR ${s.startCap}/${s.endCap}`);
  }
}

function compareEffects(want: Rest[], got: ir.Effect[], check: Check): void {
  const known = want.filter((e) => ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'].includes(e.type));
  check('effects.count', known.length === got.length, () => `REST ${want.map((e) => e.type).join(',')} IR ${got.map((e) => e.type).join(',')}`);
  if (known.length !== got.length) return;
  known.forEach((w, i) => {
    const g = got[i]!;
    check('effects.type', kebab(w.type) === g.type, () => `REST ${w.type} IR ${g.type}`);
    check('effects.visible', (w.visible ?? true) === g.visible, () => `REST ${w.visible} IR ${g.visible}`);
    if (g.type === 'drop-shadow' || g.type === 'inner-shadow') {
      const ok =
        near(w.radius, g.blur) &&
        near(w.spread ?? 0, g.spread) &&
        near(w.offset?.x, g.offset.x) &&
        near(w.offset?.y, g.offset.y) &&
        colorNear(w.color, g.color) &&
        kebab(w.blendMode ?? 'NORMAL') === g.blendMode &&
        (g.type === 'inner-shadow' || (w.showShadowBehindNode ?? false) === g.showBehindNode);
      check('effects.shadow', ok, () => `REST ${JSON.stringify(w)} IR ${JSON.stringify(g)}`);
    } else if (g.type === 'layer-blur' || g.type === 'background-blur') {
      check('effects.blur', near(w.radius, g.radius), () => `REST ${w.radius} IR ${g.radius}`);
    }
  });
}

function compareLayout(r: Rest, n: ir.FrameNode, check: Check): void {
  const auto = r.layoutMode === 'HORIZONTAL' || r.layoutMode === 'VERTICAL';
  check('layout.mode', auto ? n.layout?.direction === r.layoutMode.toLowerCase() : !n.layout, () => `REST ${r.layoutMode} IR ${n.layout?.direction}`);
  const l = n.layout;
  if (!auto || !l) return;
  check('layout.itemSpacing', near(r.itemSpacing ?? 0, l.itemSpacing), () => `REST ${r.itemSpacing} IR ${l.itemSpacing}`);
  const pad = { top: r.paddingTop ?? 0, right: r.paddingRight ?? 0, bottom: r.paddingBottom ?? 0, left: r.paddingLeft ?? 0 };
  check('layout.padding', near(pad.top, l.padding.top) && near(pad.right, l.padding.right) && near(pad.bottom, l.padding.bottom) && near(pad.left, l.padding.left), () => `REST ${JSON.stringify(pad)} IR ${JSON.stringify(l.padding)}`);
  const primary: Record<string, string> = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space-between' };
  check('layout.primaryAlign', primary[r.primaryAxisAlignItems ?? 'MIN'] === l.primaryAlign, () => `REST ${r.primaryAxisAlignItems} IR ${l.primaryAlign}`);
  const counter: Record<string, string> = { MIN: 'start', CENTER: 'center', MAX: 'end', BASELINE: 'baseline' };
  check('layout.counterAlign', counter[r.counterAxisAlignItems ?? 'MIN'] === l.counterAlign, () => `REST ${r.counterAxisAlignItems} IR ${l.counterAlign}`);
  check('layout.wrap', (r.layoutWrap === 'WRAP') === l.wrap, () => `REST ${r.layoutWrap} IR ${l.wrap}`);
  if (r.layoutWrap === 'WRAP') {
    check('layout.counterSpacing', near(r.counterAxisSpacing ?? 0, l.counterSpacing), () => `REST ${r.counterAxisSpacing} IR ${l.counterSpacing}`);
    check('layout.counterAlignContent', (r.counterAxisAlignContent ?? 'AUTO').toLowerCase().replace('_', '-') === l.counterAlignContent, () => `REST ${r.counterAxisAlignContent} IR ${l.counterAlignContent}`);
  }
  check('layout.reverseZIndex', (r.itemReverseZIndex ?? false) === l.reverseZIndex, () => `REST ${r.itemReverseZIndex}`);
  check('layout.strokesIncluded', (r.strokesIncludedInLayout ?? false) === l.strokesIncludedInLayout, () => `REST ${r.strokesIncludedInLayout}`);
}

function compareComponents(t: Translated, rest: Rest, check: Check, at: (id: string) => void): void {
  const inTree = new Set<string>();
  const index = (r: Rest): void => {
    inTree.add(r.id);
    for (const child of r.children ?? []) index(child);
  };
  index(rest.document);
  for (const [id, c] of Object.entries<Rest>(rest.components ?? {})) {
    at(`component ${id}`);
    const def = t.ir.components[id];
    check('components.present', !!def, () => 'missing');
    if (!def) continue;
    check('components.name', def.name === c.name, () => `REST ${c.name} IR ${def.name}`);
    check('components.description', (def.description ?? '') === (c.description ?? ''), () => `REST ${JSON.stringify(c.description)} IR ${JSON.stringify(def.description)}`);
    check('components.set', (def.set?.id ?? undefined) === (c.componentSetId ?? undefined), () => `REST ${c.componentSetId} IR ${def.set?.id}`);
    if (c.componentSetId) {
      const setName = rest.componentSets?.[c.componentSetId]?.name;
      if (setName) check('components.setName', def.set?.name === setName, () => `REST ${setName} IR ${def.set?.name}`);
    }
    // IR `remote` means "the main lives on the remote-components page", i.e. outside the visible pages
    // (library components, but also deleted local mains Figma keeps for their instances).
    check('components.remote', def.remote === !inTree.has(id), () => `REST remote=${c.remote} inTree=${inTree.has(id)} IR ${def.remote}`);
  }
}

function compareStyles(t: Translated, rest: Rest, check: Check, at: (id: string) => void): void {
  for (const [id, s] of Object.entries<Rest>(rest.styles ?? {})) {
    if (s.styleType !== 'FILL' && s.styleType !== 'TEXT') continue;
    at(`style ${id}`);
    const list: { id: string; name: string }[] = s.styleType === 'FILL' ? t.ir.styles.colors : t.ir.styles.typographies;
    const style = list.find((x) => x.id === id);
    check(`styles.${s.styleType}`, !!style && style.name === s.name, () => `REST ${s.name} IR ${style?.name}`);
  }
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function svgBounds(d: string): Bounds | undefined {
  const nums = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i + 1 < nums.length; i += 2) grow(b, nums[i]!, nums[i + 1]!);
  return Number.isFinite(b.minX) ? b : undefined;
}

function pathBounds(paths: readonly ir.Path[]): Bounds | undefined {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const path of paths) {
    for (const c of path.commands) {
      if (c.type === 'Z') continue;
      grow(b, c.x, c.y);
      if (c.type === 'C') {
        grow(b, c.x1, c.y1);
        grow(b, c.x2, c.y2);
      } else if (c.type === 'Q') grow(b, c.x1, c.y1);
    }
  }
  return Number.isFinite(b.minX) ? b : undefined;
}

function grow(b: Bounds, x: number, y: number): void {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.maxX = Math.max(b.maxX, x);
  b.maxY = Math.max(b.maxY, y);
}

function boundsNear(a: Bounds | undefined, b: Bounds | undefined): boolean {
  if (!a || !b) return a === b;
  return near(a.minX, b.minX, 0.02) && near(a.minY, b.minY, 0.02) && near(a.maxX, b.maxX, 0.02) && near(a.maxY, b.maxY, 0.02);
}

/**
 * Combines per-page REST dumps (`GET /v1/files/:key/nodes?ids=<page>`, one
 * `{document: CANVAS, components, componentSets, styles}` per page) into one
 * file-shaped dump, so that component/style checks see every page.
 */
export function combinePageDumps(pages: readonly Rest[]): Rest {
  return {
    document: { id: '0:0', type: 'DOCUMENT', children: pages.map((p) => p.document) },
    components: Object.assign({}, ...pages.map((p) => p.components ?? {})),
    componentSets: Object.assign({}, ...pages.map((p) => p.componentSets ?? {})),
    styles: Object.assign({}, ...pages.map((p) => p.styles ?? {})),
  };
}

export function formatReport(name: string, report: OracleReport): string {
  const lines = [`${name}: ${report.nodes} REST nodes compared; missing in IR: ${JSON.stringify(report.missing)}`];
  for (const [field, s] of Object.entries(report.fields).sort()) {
    lines.push(`  ${field.padEnd(28)} ${String(s.compared).padStart(6)} compared ${String(s.mismatched).padStart(5)} mismatched`);
    for (const sample of s.mismatched ? s.samples : []) lines.push(`      ${sample.slice(0, 300)}`);
  }
  return lines.join('\n');
}
