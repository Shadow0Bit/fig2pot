/**
 * Live Penpot checks: write a tiny document with the real writer, import it
 * into the local Penpot (tools/visual, http://localhost:9001), export each
 * board with both renderers and measure ink in the PNGs.
 *
 * These pin down Penpot *behaviour* the unit tests cannot see. They only run
 * with `PENPOT_LIVE=1` (and a running stack:
 * `docker compose -f tools/visual/docker-compose.yaml up -d`).
 */
import { PNG } from 'pngjs';
import type * as ir from '../../../src/ir.ts';
import { IDENTITY } from '../../../src/ir.ts';
import { penpotId } from '../../../src/penpot/ids.ts';
import { writePenpot, type WriteOptions } from '../../../src/penpot/index.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { PenpotClient, type Renderer } from '../../../tools/visual/penpot.ts';

export const LIVE = process.env.PENPOT_LIVE === '1';
export const RENDERERS: Renderer[] = ['svg', 'wasm'];
/** Export scale; every measurement below is converted back to CSS px. */
export const SCALE = 2;
/** Where each text sits inside its (white) board. */
export const PAD = 20;

export interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Ink {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Board {
  /** Board size; defaults to the text's size + 2 × PAD. */
  width?: number;
  height?: number;
  nodes: ir.Node[];
}

let client: Promise<PenpotClient> | undefined;

/** Renders each board with each renderer; result[renderer][boardIndex]. A failed export is `undefined`. */
export async function renderBoards(
  name: string,
  boards: Board[],
  options: WriteOptions = {},
): Promise<Record<Renderer, (Img | undefined)[]>> {
  const frames: ir.FrameNode[] = [];
  let x = 0;
  boards.forEach((board, i) => {
    const first = board.nodes[0];
    const width = board.width ?? Math.ceil((first?.size.width ?? 100) + 2 * PAD);
    const height = board.height ?? Math.ceil((first?.size.height ?? 100) + 2 * PAD);
    frames.push({
      type: 'frame',
      id: `${name}:b${i}`,
      name: `b${i}`,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: 'pass-through',
      transform: { ...IDENTITY, e: x, f: 0 },
      size: { width, height },
      fills: [{ type: 'solid', visible: true, opacity: 1, blendMode: 'normal', color: { r: 1, g: 1, b: 1, a: 1 } }],
      effects: [],
      // Unique ids: test helpers give every node the same one.
      children: board.nodes.map((node, j) => ({ ...node, id: `${name}:b${i}:n${j}` })),
      clipsContent: false,
      role: 'frame',
    });
    x += width + 40;
  });
  const doc: ir.Document = {
    name: `live-${name}`,
    pages: [{ id: `${name}:page`, name: 'p', kind: 'page', children: frames }],
    components: {},
    images: {},
    styles: { colors: [], typographies: [] },
  };
  const bytes = await writePenpot(doc, { textMode: 'editable', ...options }, new CollectingReporter());
  const c = await (client ??= PenpotClient.connect());
  const { fileId, pages } = await c.importPenpotFile(bytes, `live-${name}`);
  const out = { svg: [], wasm: [] } as Record<Renderer, (Img | undefined)[]>;
  try {
    for (const renderer of RENDERERS) {
      for (const frame of frames) {
        let png: Uint8Array | undefined;
        for (let attempt = 0; attempt < 3 && !png; attempt++) {
          try {
            png = await c.exportShape({ fileId, pageId: pages[0]!.id, objectId: penpotId(frame.id), renderer, scale: SCALE });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
        out[renderer].push(png ? PNG.sync.read(Buffer.from(png)) : undefined);
      }
    }
  } finally {
    await c.deleteFile(fileId);
  }
  return out;
}

function isInk(img: Img, x: number, y: number): boolean {
  const i = (y * img.width + x) * 4;
  const lum = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
  return img.data[i + 3]! > 128 && lum < 155;
}

/** Ink extent inside the CSS-px band [y0, y1) (whole image by default), in CSS px. */
export function ink(img: Img, y0 = 0, y1 = img.height / SCALE): Ink | undefined {
  let left = Infinity;
  let right = -1;
  let top = Infinity;
  let bottom = -1;
  const from = Math.max(0, Math.round(y0 * SCALE));
  const to = Math.min(img.height, Math.round(y1 * SCALE));
  for (let y = from; y < to; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!isInk(img, x, y)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return undefined;
  return { left: left / SCALE, right: (right + 1) / SCALE, top: top / SCALE, bottom: (bottom + 1) / SCALE };
}

/** Vertical runs of rows that contain ink (one per text line, for text without descenders), in CSS px. */
export function inkRows(img: Img): Ink[] {
  const rows: Ink[] = [];
  let start = -1;
  for (let y = 0; y <= img.height; y++) {
    let has = false;
    if (y < img.height) for (let x = 0; x < img.width && !has; x++) has = isInk(img, x, y);
    if (has && start < 0) start = y;
    if (!has && start >= 0) {
      rows.push(ink(img, start / SCALE, y / SCALE)!);
      start = -1;
    }
  }
  return rows;
}

export const BLACK: ir.SolidPaint = { type: 'solid', visible: true, opacity: 1, blendMode: 'normal', color: { r: 0, g: 0, b: 0, a: 1 } };

/** A Figma line record: offsets, baseline, advance width, intrinsic line height, ascent. */
export function line(start: number, end: number, baselineY: number, width: number, lineHeight: number, ascent: number, x = 0): ir.TextLine {
  return { start, end, baseline: { x, y: baselineY }, width, lineHeight, ascent };
}

/** Inter's hhea metrics (1984 / −494, 2048 upm), as Figma and both Penpot renderers use them. */
export const INTER = { ascent: 1984 / 2048, descent: 494 / 2048 };

/** Figma's first baseline for a px line height (half leading), relative to the line box top. */
export function interBaseline(fontSize: number, lineHeight: number): number {
  return (lineHeight - (INTER.ascent + INTER.descent) * fontSize) / 2 + INTER.ascent * fontSize;
}

/** Moves a node to (PAD, PAD) in its board. */
export function placed<T extends ir.Node>(node: T, dx = PAD, dy = PAD): T {
  return { ...node, transform: { ...node.transform, e: dx, f: dy } };
}
