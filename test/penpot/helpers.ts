import { strFromU8, unzipSync } from 'fflate';
import type * as ir from '../../src/ir.ts';
import { penpotId } from '../../src/penpot/ids.ts';
import { writePenpot, type WriteOptions } from '../../src/penpot/index.ts';
import { CollectingReporter } from '../../src/util/reporter.ts';

// --- IR builders ----------------------------------------------------------------

export const solid = (r: number, g: number, b: number, a = 1, extra: Partial<ir.SolidPaint> = {}): ir.SolidPaint => ({
  type: 'solid',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  color: { r, g, b, a },
  ...extra,
});

export const translate = (x: number, y: number): ir.Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export function rotateAbout(degrees: number, x: number, y: number): ir.Matrix {
  const r = (degrees * Math.PI) / 180;
  return { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: x, f: y };
}

function base<T extends ir.NodeType>(type: T, id: string, extra: Partial<ir.BaseNode>) {
  return {
    type,
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'pass-through' as ir.BlendMode,
    transform: translate(0, 0),
    size: { width: 100, height: 100 },
    fills: [] as ir.Paint[],
    effects: [] as ir.Effect[],
    ...extra,
  };
}

export const rect = (id: string, extra: Partial<ir.RectNode> = {}): ir.RectNode => ({ ...base('rect', id, extra), ...extra, type: 'rect' });
export const ellipse = (id: string, extra: Partial<ir.EllipseNode> = {}): ir.EllipseNode => ({ ...base('ellipse', id, extra), ...extra, type: 'ellipse' });
export const frame = (id: string, children: ir.Node[], extra: Partial<ir.FrameNode> = {}): ir.FrameNode => ({
  ...base('frame', id, extra),
  clipsContent: true,
  role: 'frame',
  ...extra,
  type: 'frame',
  children,
});
export const group = (id: string, children: ir.Node[], extra: Partial<ir.GroupNode> = {}): ir.GroupNode => ({
  ...base('group', id, extra),
  ...extra,
  type: 'group',
  children,
});
export const pathNode = (id: string, paths: ir.Path[], extra: Partial<ir.PathNode> = {}): ir.PathNode => ({
  ...base('path', id, extra),
  pathsAreExact: true,
  ...extra,
  type: 'path',
  paths,
});
export const booleanNode = (id: string, operation: ir.BooleanNode['operation'], children: ir.Node[], extra: Partial<ir.BooleanNode> = {}): ir.BooleanNode => ({
  ...base('boolean', id, extra),
  ...extra,
  type: 'boolean',
  operation,
  children,
});

export const textStyle = (extra: Partial<ir.TextStyle> = {}): ir.TextStyle => ({
  fontFamily: 'Roboto',
  fontStyle: 'Regular',
  fontWeight: 400,
  italic: false,
  fontSize: 16,
  lineHeight: { unit: 'auto', value: 0 },
  letterSpacing: { unit: 'px', value: 0 },
  textCase: 'original',
  textDecoration: 'none',
  fills: [solid(0, 0, 0)],
  ...extra,
});

export const text = (id: string, characters: string, extra: Partial<ir.TextNode> = {}): ir.TextNode => ({
  ...base('text', id, extra),
  characters,
  runs: [{ start: 0, end: characters.length, style: textStyle() }],
  autoResize: 'none',
  alignHorizontal: 'left',
  alignVertical: 'top',
  paragraphSpacing: 0,
  paragraphIndent: 0,
  ...extra,
  type: 'text',
});

export const square = (x: number, y: number, w: number, h: number, windingRule: ir.WindingRule = 'nonzero'): ir.Path => ({
  windingRule,
  commands: [
    { type: 'M', x, y },
    { type: 'L', x: x + w, y },
    { type: 'L', x: x + w, y: y + h },
    { type: 'L', x, y: y + h },
    { type: 'Z' },
  ],
});

export const stroke = (extra: Partial<ir.Stroke> = {}): ir.Stroke => ({
  paints: [solid(0, 0, 0)],
  weight: 2,
  align: 'inside',
  join: 'miter',
  startCap: 'none',
  endCap: 'none',
  dashPattern: [],
  ...extra,
});

export function doc(children: ir.Node[], extra: Partial<ir.Document> = {}, pageExtra: Partial<ir.Page> = {}): ir.Document {
  return {
    name: 'Test',
    pages: [{ id: '0:1', name: 'Page 1', kind: 'page', children, ...pageExtra }],
    components: {},
    images: {},
    styles: { colors: [], typographies: [] },
    ...extra,
  };
}

// --- output inspection ---------------------------------------------------------------

export type Json = Record<string, any>;

export interface Written {
  bytes: Uint8Array;
  files: Record<string, Uint8Array>;
  manifest: Json;
  /** All shapes of all pages by Penpot id. */
  shapes: Record<string, Json>;
  pages: Json[];
  components: Json[];
  colors: Json[];
  typographies: Json[];
  media: Json[];
  warnings: ir.Warning[];
  /** The shape for an IR id (+ optional suffix). */
  shape(irId: string, suffix?: string): Json;
  has(irId: string, suffix?: string): boolean;
  /** Child shapes of a shape, in Penpot order. */
  children(shape: Json): Json[];
  /** Top-level shapes of the first page. */
  roots(pageIndex?: number): Json[];
  codes(): string[];
}

export async function write(document: ir.Document, options?: WriteOptions): Promise<Written> {
  const reporter = new CollectingReporter();
  const bytes = await writePenpot(document, options, reporter);
  const files = unzipSync(bytes);
  const json = (path: string): Json => JSON.parse(strFromU8(files[path]!));
  const manifest = json('manifest.json');
  const shapes: Record<string, Json> = {};
  const pages: Json[] = [];
  const components: Json[] = [];
  const colors: Json[] = [];
  const typographies: Json[] = [];
  const media: Json[] = [];
  const pageRoots = new Map<string, Json>();
  for (const path of Object.keys(files).sort()) {
    if (!path.endsWith('.json') || path === 'manifest.json') continue;
    const parts = path.split('/');
    if (parts[0] !== 'files' || parts.length < 3) continue;
    const data = json(path);
    if (parts[2] === 'pages' && parts.length === 4) pages.push(data);
    else if (parts[2] === 'pages' && parts.length === 5) {
      shapes[data.id] = data;
      if (data.id === '00000000-0000-0000-0000-000000000000') pageRoots.set(data.pageId, data);
    } else if (parts[2] === 'components') components.push(data);
    else if (parts[2] === 'colors') colors.push(data);
    else if (parts[2] === 'typographies') typographies.push(data);
    else if (parts[2] === 'media') media.push(data);
  }
  pages.sort((p, q) => p.index - q.index);
  const id = (irId: string, suffix = ''): string => penpotId(suffix ? `${irId}/${suffix}` : irId);
  const result: Written = {
    bytes,
    files,
    manifest,
    shapes,
    pages,
    components,
    colors,
    typographies,
    media,
    warnings: reporter.warnings,
    shape(irId, suffix = '') {
      const s = shapes[id(irId, suffix)];
      if (!s) throw new Error(`no shape for ${irId}${suffix ? '/' + suffix : ''}`);
      return s;
    },
    has(irId, suffix = '') {
      return shapes[id(irId, suffix)] !== undefined;
    },
    children(shape) {
      return (shape.shapes ?? []).map((sid: string) => shapes[sid]!);
    },
    roots(pageIndex = 0) {
      const page = pages[pageIndex]!;
      const root = pageRoots.get(page.id)!;
      return (root.shapes ?? []).map((sid: string) => shapes[sid]!);
    },
    codes() {
      return reporter.warnings.map((w) => w.code);
    },
  };
  return result;
}

/** Parses Penpot path content (exported as segment objects) into [command, ...numbers] tuples. */
export function segments(shape: Json): (string | number)[][] {
  return (shape.content as Json[]).map((s) => {
    const p = s.params ?? {};
    switch (s.command) {
      case 'move-to':
        return ['M', p.x, p.y];
      case 'line-to':
        return ['L', p.x, p.y];
      case 'curve-to':
        return ['C', p.c1x, p.c1y, p.c2x, p.c2y, p.x, p.y];
      default:
        return ['Z'];
    }
  });
}

export const close = (actual: number, expected: number, eps = 1e-3): boolean => Math.abs(actual - expected) < eps;

const ROOT = '00000000-0000-0000-0000-000000000000';

/**
 * Re-implements the component checks of Penpot's file validation
 * (`app.common.files.validate`) on the written shapes; returns the problems found.
 */
export function componentProblems(w: Written): string[] {
  const problems: string[] = [];
  const shapes = w.shapes;
  const components = new Map<string, Json>(w.components.map((c) => [c.id, c]));
  const fileId = w.manifest.files[0].id;
  const isHead = (s: Json): boolean => s.componentId !== undefined;
  const ancestors = (s: Json): Json[] => {
    const out: Json[] = [];
    let cur = s;
    while (cur.parentId && cur.parentId !== ROOT && cur.id !== ROOT) {
      cur = shapes[cur.parentId]!;
      out.push(cur);
    }
    return out;
  };
  const subtree = (rootId: string): Set<string> => {
    const out = new Set<string>();
    const visit = (id: string): void => {
      out.add(id);
      for (const c of shapes[id]?.shapes ?? []) visit(c);
    };
    visit(rootId);
    return out;
  };
  /** `find-ref-shape`: looks the shape-ref up in the component of every enclosing head, nearest first. */
  const findRef = (s: Json): Json | undefined => {
    for (const head of [s, ...ancestors(s)].filter(isHead)) {
      const comp = components.get(head.componentId);
      if (!comp) continue;
      if (subtree(comp.mainInstanceId).has(s.shapeRef)) return shapes[s.shapeRef];
    }
    return undefined;
  };
  for (const s of Object.values(shapes)) {
    if (s.id === ROOT) continue;
    const label = `${s.name} (${s.id})`;
    const up = ancestors(s);
    const insideComponent = up.some(isHead);
    if (isHead(s)) {
      if (s.type !== 'frame') problems.push(`${label}: instance head is not a board`);
      if (s.componentFile !== fileId) problems.push(`${label}: component-file is not this file`);
      const comp = components.get(s.componentId);
      if (!comp) problems.push(`${label}: component ${s.componentId} not found`);
      if (s.componentRoot === true && insideComponent) problems.push(`${label}: component-root inside another component`);
      if (s.componentRoot !== true && !insideComponent) problems.push(`${label}: top-level head without component-root`);
      if (s.mainInstance) {
        if (insideComponent) problems.push(`${label}: main nested in a component`);
        if (comp && comp.mainInstanceId !== s.id) problems.push(`${label}: main-instance-id mismatch`);
        if (s.shapeRef) problems.push(`${label}: main with shape-ref`);
        if (comp && !s.variantId) {
          const expected = comp.path ? `${comp.path} / ${comp.name}` : comp.name;
          if (s.name !== expected) problems.push(`${label}: main name should be "${expected}"`);
        }
      } else {
        const ref = s.shapeRef ? findRef(s) : undefined;
        if (!ref) problems.push(`${label}: copy head ref not found`);
        else if (!isHead(ref)) problems.push(`${label}: copy head refs a non-head`);
        const swapped = (s.touched ?? []).some((t: string) => t.startsWith('swap-slot-'));
        if (ref && s.componentRoot !== true && !swapped && ref.componentId !== s.componentId) problems.push(`${label}: component-id differs from the near main`);
        if (s.componentRoot !== true && !swapped) {
          const parent = shapes[s.parentId];
          const parentRef = parent?.shapeRef ? findRef(parent) : undefined;
          if (parentRef && !(parentRef.shapes ?? []).includes(s.shapeRef)) problems.push(`${label}: swapped but no swap slot`);
        }
      }
    } else if (s.shapeRef !== undefined) {
      const ref = findRef(s);
      if (!up.some((a) => isHead(a) && !a.mainInstance)) problems.push(`${label}: shape-ref outside a copy`);
      if (!ref) problems.push(`${label}: ref not found in near component`);
      else if (isHead(ref)) problems.push(`${label}: non-head refs a head`);
    } else if (s.mainInstance) {
      problems.push(`${label}: main-instance without component`);
    }
    const touched: string[] = s.touched ?? [];
    if (touched.some((t) => t.startsWith('text-content')) && !touched.includes('content-group')) problems.push(`${label}: text touched without content-group`);
  }
  for (const c of w.components) if (!shapes[c.mainInstanceId]) problems.push(`component ${c.name}: main board missing`);
  // Variants (`check-variant-container`, `check-variant`): a container holds variant mains only, each pointing
  // at it, and the component agrees.
  for (const s of Object.values(shapes)) {
    const label = `${s.name} (${s.id})`;
    if (s.isVariantContainer) {
      for (const child of w.children(s)) {
        if (!child.mainInstance || child.variantId !== s.id) problems.push(`${label}: variant container child ${child.name} (${child.id}) is not one of its variants`);
      }
    }
    if (s.variantId !== undefined && s.mainInstance) {
      if (!shapes[s.parentId]?.isVariantContainer || s.parentId !== s.variantId) problems.push(`${label}: variant main outside its variant container`);
      const comp = components.get(s.componentId);
      if (comp && comp.variantId !== s.variantId) problems.push(`${label}: variant id differs from its component's`);
    }
  }
  for (const c of w.components) {
    if (c.variantId !== undefined && shapes[c.mainInstanceId]?.variantId !== c.variantId) problems.push(`component ${c.name}: variant main without the variant id`);
  }
  return problems;
}

/** Component structure counts of a written file (regression pins and reports). */
export function componentCounts(w: Written): { components: number; variantContainers: number; variantComponents: number; copyHeads: number } {
  const shapes = Object.values(w.shapes);
  return {
    components: w.components.length,
    variantContainers: shapes.filter((s) => s.isVariantContainer === true).length,
    variantComponents: w.components.filter((c) => c.variantId !== undefined).length,
    copyHeads: shapes.filter((s) => s.componentId !== undefined && !s.mainInstance).length,
  };
}

/**
 * Shapes inside a component copy that are not a nested copy head and have no `shapeRef`: a copy shape without
 * a counterpart in its main (Penpot keeps it as an extra shape that no main change reaches).
 */
export function copyShapesWithoutRef(w: Written): Json[] {
  const out: Json[] = [];
  for (const s of Object.values(w.shapes)) {
    if (s.id === ROOT || s.componentId !== undefined || s.shapeRef !== undefined) continue;
    let cur = s;
    let inCopy = false;
    while (cur.parentId && cur.parentId !== ROOT) {
      cur = w.shapes[cur.parentId]!;
      if (cur.componentId !== undefined) {
        inCopy = !cur.mainInstance;
        break;
      }
    }
    if (inCopy) out.push(s);
  }
  return out;
}
