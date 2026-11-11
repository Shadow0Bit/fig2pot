/**
 * Live rendering helper for writer checks (gradients, blurs, crops, dashes, masks): writes a document
 * tuned for one renderer, imports it into the local Penpot (tools/visual, http://localhost:9001), exports
 * the requested boards with that renderer at scale 1 and deletes the file again.
 *
 * Only used with `PENPOT_LIVE=1` and a running stack (`docker compose -f tools/visual/docker-compose.yaml up -d`).
 */
import { PNG } from 'pngjs';
import type * as ir from '../../../src/ir.ts';
import { penpotId } from '../../../src/penpot/ids.ts';
import { writePenpot, type WriteOptions } from '../../../src/penpot/index.ts';
import { apply, invert } from '../../../src/util/matrix.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { PenpotClient, type PenpotShape, type Renderer } from '../../../tools/visual/penpot.ts';

export const LIVE = process.env.PENPOT_LIVE === '1';

export interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Rendered {
  /** IR board id → PNG. */
  boards: Map<string, Img>;
  /** Shapes of the imported first page, by Penpot id. */
  objects: Record<string, PenpotShape>;
  warnings: ir.Warning[];
}

let client: Promise<PenpotClient> | undefined;

export async function renderFor(renderer: Renderer, name: string, doc: ir.Document, boardIds: string[], options: WriteOptions = {}): Promise<Rendered> {
  const reporter = new CollectingReporter();
  const bytes = await writePenpot(doc, { ...options, renderer }, reporter);
  const c = await (client ??= PenpotClient.connect());
  const { fileId } = await c.importPenpotFile(bytes, `live-${name}-${renderer}`);
  try {
    const file = await c.getFile(fileId);
    const page = file.pages[0]!;
    const boards = new Map<string, Img>();
    for (const id of boardIds) {
      let error: unknown;
      for (let attempt = 0; attempt < 3 && !boards.has(id); attempt++) {
        try {
          const png = await c.exportShape({ fileId, pageId: page.id, objectId: penpotId(id), renderer, scale: 1 });
          boards.set(id, PNG.sync.read(Buffer.from(png)));
        } catch (e) {
          // The exporter occasionally loses a temporary resource; a retry renders fine.
          error = e;
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
      if (!boards.has(id)) throw error;
    }
    return { boards, objects: page.objects, warnings: reporter.warnings };
  } finally {
    await c.deleteFile(fileId);
  }
}

export function rgb(img: Img, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** Expected 0..255 grey of a black → white gradient at a node-local pixel centre (Figma semantics). */
export function figmaGrey(g: ir.GradientPaint, size: ir.Size, local: ir.Vec2): number {
  const p = { x: local.x / size.width, y: local.y / size.height };
  const [h0, h1, h2] = g.handles;
  const u = { x: h1.x - h0.x, y: h1.y - h0.y };
  const v = { x: h2.x - h0.x, y: h2.y - h0.y };
  const det = u.x * v.y - u.y * v.x;
  const d = { x: p.x - h0.x, y: p.y - h0.y };
  const s = (d.x * v.y - d.y * v.x) / det;
  const t = (u.x * d.y - u.y * d.x) / det;
  const k = g.gradientType === 'linear' ? s : Math.hypot(s, t);
  return Math.min(1, Math.max(0, k)) * 255;
}

/**
 * Mean absolute grey error between a rendered gradient and Figma's, over the pixels whose centre lies
 * inside the node (`m`: node local → board pixels), `margin` px away from its edges.
 */
export function gradientError(img: Img, g: ir.GradientPaint, m: ir.Matrix, size: ir.Size, inside: (p: ir.Vec2) => boolean = () => true, margin = 3): number {
  const inv = invert(m)!;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const l = apply(inv, { x: x + 0.5, y: y + 0.5 });
      if (l.x < margin || l.y < margin || l.x > size.width - margin || l.y > size.height - margin || !inside(l)) continue;
      sum += Math.abs(rgb(img, x, y)[0] - figmaGrey(g, size, l));
      n++;
    }
  }
  return n === 0 ? Number.NaN : sum / n;
}

/**
 * σ of a blurred edge: the distance between the 15.87 % and 84.13 % crossings of a monotone coverage
 * profile, halved. `coverage(x)` is 0..1 along a row; the edge is searched in [from, to).
 */
export function edgeSigma(coverage: (x: number) => number, from: number, to: number): number {
  const rising = coverage(to - 1) > coverage(from);
  const cov = rising ? coverage : (x: number): number => 1 - coverage(x);
  const cross = (t: number): number => {
    for (let x = from; x < to - 1; x++) {
      const a = cov(x);
      const b = cov(x + 1);
      if (a <= t && b >= t && b !== a) return x + (t - a) / (b - a);
    }
    return Number.NaN;
  };
  return Math.abs(cross(0.8413) - cross(0.1587)) / 2;
}

/** Runs of "dark" pixels (red channel < 128) along a row: [start, end) pairs. */
export function darkRuns(img: Img, y: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= img.width; x++) {
    const dark = x < img.width && rgb(img, x, y)[0] < 128;
    if (dark && start < 0) start = x;
    if (!dark && start >= 0) {
      out.push([start, x]);
      start = -1;
    }
  }
  return out;
}
