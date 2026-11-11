/**
 * Builds a small `.penpot` file with `@penpot/library` for the harness's
 * self-test (independent of the converter): one page, two boards with a rect,
 * a circle, a linear-gradient fill and an Inter text.
 *
 * Shape and page ids are set explicitly to `penpotId(<fake figma id>)`, the
 * way the converter does it, so the self-test exercises the id lookup path.
 */
import { penpotId } from '../../src/penpot/ids.ts';

export interface SampleBoard {
  nodeId: string;
  name: string;
  width: number;
  height: number;
}

export interface SampleOptions {
  /** Fill of the first board's rect (the self-test changes it for a "modified" variant). */
  rectColor?: string;
  fileName?: string;
  text?: string;
  font?: SampleFont;
}

export const SAMPLE_PAGE = { nodeId: '0:1', name: 'Sample page' } as const;
export const SAMPLE_BOARDS: SampleBoard[] = [
  { nodeId: '1:2', name: 'Board A', width: 360, height: 240 },
  { nodeId: '1:3', name: 'Board B', width: 320, height: 200 },
];

// `@penpot/library` ships no type declarations; keep it untyped and local.
type Lib = { createBuildContext(opts?: object): any; exportAsBytes(ctx: any): Promise<Uint8Array> };

async function loadLibrary(): Promise<Lib> {
  const spec = '@penpot/library';
  return (await import(spec)) as Lib;
}

export interface SampleFont {
  fontId: string;
  fontFamily: string;
}

export const INTER: SampleFont = { fontId: 'gfont-inter', fontFamily: 'Inter' };
/** A different Google font, used by the self-test as a "font is applied" control. */
export const ROBOTO: SampleFont = { fontId: 'gfont-roboto', fontFamily: 'Roboto' };

function textContent(text: string, size: number, color: string, font: SampleFont = INTER): object {
  const leaf = {
    text,
    fontId: font.fontId,
    fontFamily: font.fontFamily,
    fontVariantId: '700',
    fontSize: String(size),
    fontWeight: '700',
    fontStyle: 'normal',
    lineHeight: '1.2',
    letterSpacing: '0',
    textDecoration: 'none',
    textTransform: 'none',
    fills: [{ fillColor: color, fillOpacity: 1 }],
  };
  return {
    type: 'root',
    verticalAlign: 'top',
    children: [
      {
        type: 'paragraph-set',
        children: [{ type: 'paragraph', textAlign: 'left', ...leaf, children: [leaf] }],
      },
    ],
  };
}

export async function buildSamplePenpot(options: SampleOptions = {}): Promise<Uint8Array> {
  const lib = await loadLibrary();
  const ctx = lib.createBuildContext({ referer: 'fig2pot-visual-selftest' });
  ctx.addFile({ name: options.fileName ?? 'fig2pot visual selftest' });
  ctx.addPage({ id: penpotId(SAMPLE_PAGE.nodeId, 'page'), name: SAMPLE_PAGE.name });

  const [a, b] = SAMPLE_BOARDS as [SampleBoard, SampleBoard];

  // Board A: white board, rect, circle, Inter text.
  ctx.addBoard({
    id: penpotId(a.nodeId),
    name: a.name,
    x: 0,
    y: 0,
    width: a.width,
    height: a.height,
    fills: [{ fillColor: '#FFFFFF', fillOpacity: 1 }],
  });
  ctx.addRect({
    id: penpotId('1:10'),
    name: 'Rect',
    x: 20,
    y: 20,
    width: 140,
    height: 90,
    r1: 12,
    r2: 12,
    r3: 12,
    r4: 12,
    fills: [{ fillColor: options.rectColor ?? '#E5484D', fillOpacity: 1 }],
  });
  ctx.addCircle({
    id: penpotId('1:11'),
    name: 'Circle',
    x: 200,
    y: 20,
    width: 120,
    height: 120,
    fills: [{ fillColor: '#3E63DD', fillOpacity: 1 }],
    strokes: [{ strokeColor: '#11181C', strokeWidth: 4, strokeAlignment: 'inner', strokeStyle: 'solid', strokeOpacity: 1 }],
  });
  ctx.addText({
    id: penpotId('1:12'),
    name: 'Title',
    x: 20,
    y: 160,
    width: 320,
    height: 58,
    growType: 'fixed',
    content: textContent(options.text ?? 'Hamburgefonstiv 123', 28, '#11181C', options.font),
  });
  ctx.closeBoard();

  // Board B: gradient-filled board with a rect and a smaller text.
  ctx.addBoard({
    id: penpotId(b.nodeId),
    name: b.name,
    x: 420,
    y: 0,
    width: b.width,
    height: b.height,
    fills: [
      {
        fillOpacity: 1,
        fillColorGradient: {
          type: 'linear',
          startX: 0,
          startY: 0,
          endX: 1,
          endY: 1,
          width: 1,
          stops: [
            { color: '#FFC53D', opacity: 1, offset: 0 },
            { color: '#8E4EC6', opacity: 1, offset: 1 },
          ],
        },
      },
    ],
  });
  ctx.addRect({
    id: penpotId('1:20'),
    name: 'Card',
    x: 440,
    y: 20,
    width: 280,
    height: 100,
    r1: 8,
    r2: 8,
    r3: 8,
    r4: 8,
    fills: [{ fillColor: '#FFFFFF', fillOpacity: 0.85 }],
  });
  ctx.addText({
    id: penpotId('1:21'),
    name: 'Label',
    x: 456,
    y: 48,
    width: 248,
    height: 40,
    growType: 'fixed',
    content: textContent('Inter Bold 28', 28, '#1A1523', options.font),
  });
  ctx.closeBoard();

  ctx.closeFile();
  return lib.exportAsBytes(ctx);
}
