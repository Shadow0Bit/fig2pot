/**
 * Cross-checks materialised instances against Figma REST API dumps
 * (`GET /v1/files/:key?geometry=paths`) of the same community files. The
 * REST API returns instances expanded, with `I<instance>;…` child ids, so for
 * every INSTANCE on a visible page we compare the whole subtree: child ids
 * and order, type, name, visibility, text, solid paints, component ids and
 * absolute bounding boxes (composed from our relative transforms).
 *
 * Gated on the large fixtures (`pnpm fixtures:large`) being present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFig } from '../../src/fig/decode.ts';
import { resolveInstancesWithStats } from '../../src/fig/instances.ts';
import { buildTree } from '../../src/fig/tree.ts';
import type { FigDocument, FigNode, NodeChange } from '../../src/fig/types.ts';

const path = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const CASES = [
  { name: 'radix-icons', fig: 'fixtures/radix-icons.fig', rest: 'fixtures-large/rest/radix-icons.document.json' },
  {
    name: 'auto-layout-playground',
    fig: 'fixtures-large/auto-layout-playground.fig',
    rest: 'fixtures-large/rest/auto-layout-playground.document.json',
  },
];

interface RestNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  componentId?: string;
  fills?: RestPaint[];
  strokes?: RestPaint[];
  absoluteBoundingBox?: Box | null;
  children?: RestNode[];
}
interface RestPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a: number };
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Affine = [number, number, number, number, number, number]; // a b c d e f

const BOX_TOLERANCE = 0.01;

/** REST node type for a kiwi node. */
function restType(node: FigNode): string {
  if (node.type === 'ROUNDED_RECTANGLE') return 'RECTANGLE';
  if (node.type === 'SYMBOL') return 'COMPONENT';
  if (node.type === 'FRAME' && node.change.isStateGroup) return 'COMPONENT_SET';
  if (node.type === 'FRAME' && node.change.resizeToFit) return 'GROUP';
  return node.type;
}

class Comparator {
  readonly mismatches = new Map<string, string[]>();
  instances = 0;
  nodes = 0;
  private readonly absolute = new Map<FigNode, Affine>();
  private readonly variables = new Map<string, NodeChange>();
  private readonly doc: FigDocument;

  constructor(doc: FigDocument) {
    this.doc = doc;
    for (const change of doc.file.message.nodeChanges ?? []) {
      if (change.type !== 'VARIABLE' || !change.guid) continue;
      this.variables.set(`${change.guid.sessionID}:${change.guid.localID}`, change);
      if (change.key) this.variables.set(change.key, change);
    }
  }

  run(root: RestNode): void {
    const walk = (rest: RestNode): void => {
      if (rest.type === 'INSTANCE') {
        this.instances++;
        const ours = this.doc.byId.get(rest.id);
        if (ours) this.compare(rest, ours);
        else this.mismatch('instance-not-found', rest.id);
        return;
      }
      for (const child of rest.children ?? []) walk(child);
    };
    walk(root);
  }

  private mismatch(kind: string, detail: string): void {
    const list = this.mismatches.get(kind) ?? [];
    list.push(detail);
    this.mismatches.set(kind, list);
  }

  private compare(rest: RestNode, ours: FigNode): void {
    this.nodes++;
    const c = ours.change;
    const id = rest.id;
    if (restType(ours) !== rest.type) this.mismatch('type', `${id}: ${restType(ours)} vs ${rest.type}`);
    if ((c.name ?? '') !== rest.name) this.mismatch('name', `${id}: ${c.name} vs ${rest.name}`);
    if ((c.visible ?? true) !== (rest.visible ?? true)) this.mismatch('visible', `${id}: ${c.visible} vs ${rest.visible}`);
    if (rest.type === 'TEXT' && (c.textData?.characters ?? '') !== rest.characters) {
      this.mismatch('characters', `${id}: ${JSON.stringify(c.textData?.characters)} vs ${JSON.stringify(rest.characters)}`);
    }
    if (rest.fills && this.paints(c.fillPaints) !== restPaints(rest.fills)) {
      this.mismatch('fills', `${id}: ${this.paints(c.fillPaints)} vs ${restPaints(rest.fills)}`);
    }
    if (rest.strokes && this.paints(c.strokePaints) !== restPaints(rest.strokes)) {
      this.mismatch('strokes', `${id}: ${this.paints(c.strokePaints)} vs ${restPaints(rest.strokes)}`);
    }
    if (rest.type === 'INSTANCE' && rest.componentId && ours.symbolId !== rest.componentId) {
      this.mismatch('component-id', `${id}: ${ours.symbolId} vs ${rest.componentId}`);
    }
    if (rest.absoluteBoundingBox) {
      const box = this.box(ours);
      const r = rest.absoluteBoundingBox;
      const delta = Math.max(
        Math.abs(box.x - r.x),
        Math.abs(box.y - r.y),
        Math.abs(box.width - r.width),
        Math.abs(box.height - r.height),
      );
      if (delta > BOX_TOLERANCE) this.mismatch('bounding-box', `${id} (${rest.type}): ${JSON.stringify(box)} vs ${JSON.stringify(r)}`);
    }

    const restIds = (rest.children ?? []).map((x) => x.id);
    const ourIds = ours.children.map((x) => x.id);
    if (restIds.join('|') !== ourIds.join('|')) {
      const missing = restIds.filter((x) => !ourIds.includes(x));
      const extra = ourIds.filter((x) => !restIds.includes(x));
      if (missing.length) this.mismatch('children-missing', `${id}: ${missing.join(', ')}`);
      if (extra.length) this.mismatch('children-extra', `${id}: ${extra.join(', ')}`);
      if (!missing.length && !extra.length) this.mismatch('children-order', id);
    }
    for (const child of rest.children ?? []) {
      const match = ours.children.find((x) => x.id === child.id);
      if (match) this.compare(child, match);
    }
  }

  /**
   * Visible solid paints as rounded RGBA. A paint bound to a colour variable
   * is resolved through the variable's (first) mode, as REST shows resolved
   * colours; the stored `color` is only the authoring-time fallback.
   */
  private paints(paints: NodeChange['fillPaints']): string {
    return JSON.stringify(
      (paints ?? [])
        .filter((p) => p.visible !== false)
        .map((p) => {
          if (p.type !== 'SOLID' || !p.color) return p.type;
          const color = this.resolveColor(p.colorVar) ?? p.color;
          return [color.r, color.g, color.b, p.opacity ?? 1].map(round);
        }),
    );
  }

  private resolveColor(data: unknown, depth = 0): { r: number; g: number; b: number } | undefined {
    const alias = (data as { value?: { alias?: { guid?: { sessionID: number; localID: number }; assetRef?: { key?: string } } } })
      ?.value?.alias;
    if (!alias || depth > 8) return undefined;
    const key = alias.assetRef?.key ?? (alias.guid ? `${alias.guid.sessionID}:${alias.guid.localID}` : '');
    const value = this.variables.get(key)?.variableDataValues?.entries?.[0]?.variableData;
    return value?.value?.colorValue ?? this.resolveColor(value, depth + 1);
  }

  private box(node: FigNode): Box {
    const [a, b, c, d, e, f] = this.matrix(node);
    const w = node.change.size?.x ?? 0;
    const h = node.change.size?.y ?? 0;
    const xs = [e, a * w + e, c * h + e, a * w + c * h + e];
    const ys = [f, b * w + f, d * h + f, b * w + d * h + f];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  private matrix(node: FigNode | undefined): Affine {
    if (!node || node.type === 'CANVAS' || node.type === 'DOCUMENT') return [1, 0, 0, 1, 0, 0];
    const cached = this.absolute.get(node);
    if (cached) return cached;
    const t = node.change.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const [pa, pb, pc, pd, pe, pf] = this.matrix(node.parent);
    const m: Affine = [
      pa * t.m00 + pc * t.m10,
      pb * t.m00 + pd * t.m10,
      pa * t.m01 + pc * t.m11,
      pb * t.m01 + pd * t.m11,
      pa * t.m02 + pc * t.m12 + pe,
      pb * t.m02 + pd * t.m12 + pf,
    ];
    this.absolute.set(node, m);
    return m;
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function restPaints(paints: RestPaint[]): string {
  return JSON.stringify(
    paints
      .filter((p) => p.visible !== false)
      .map((p) => (p.type === 'SOLID' && p.color ? [p.color.r, p.color.g, p.color.b, p.opacity ?? 1].map(round) : p.type)),
  );
}

describe('resolveInstances vs Figma REST API', () => {
  for (const c of CASES) {
    const available = existsSync(path(c.fig)) && existsSync(path(c.rest));
    it.skipIf(!available)(`${c.name}: materialised subtrees match the REST dump`, () => {
      const doc = buildTree(decodeFig(new Uint8Array(readFileSync(path(c.fig)))));
      const warnings: unknown[] = [];
      const stats = resolveInstancesWithStats(doc, { warn: (w) => warnings.push(w) });
      expect(warnings).toEqual([]);

      const rest = JSON.parse(readFileSync(path(c.rest), 'utf8')) as { document: RestNode };
      const comparator = new Comparator(doc);
      comparator.run(rest.document);

      const summary = Object.fromEntries([...comparator.mismatches].map(([kind, list]) => [kind, list.length]));
      console.info(
        `[oracle] ${c.name}: ${comparator.instances} instances, ${comparator.nodes} nodes compared, ` +
          `mismatches ${JSON.stringify(summary)}; stats ${JSON.stringify(stats)}`,
      );
      expect(comparator.instances).toBeGreaterThan(200);
      expect(Object.fromEntries([...comparator.mismatches].map(([kind, list]) => [kind, list.slice(0, 5)]))).toEqual({});
    });
  }
});
