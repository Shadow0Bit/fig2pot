import type * as ir from '../ir.ts';
import { BakeCache } from './bake.ts';
import type { BuildContext, Uuid } from './library.ts';
import { MediaRegistry } from './media.ts';
import { StyleRegistry } from './styles.ts';

export interface ResolvedWriteOptions {
  textMode: 'auto' | 'editable' | 'outline';
  booleanMode: 'editable' | 'flatten';
  components: boolean;
  textLineBreaks: 'source' | 'reflow';
  /** Penpot renderer the numbers are tuned for (gradients, blurs). */
  renderer: 'svg' | 'wasm';
  /** Rasterise paints Penpot cannot draw into image fills (`bake.ts`). */
  bakeUnsupportedPaints: boolean;
  /** Device-pixel ratio of baked bitmaps. */
  bakeScale: number;
  /** Emit images as plain sRGB with the colours the source shows (`image-color.ts`). */
  convertImageProfiles: boolean;
  /** Pre-reduce images shown below 1 / bakeScale of their size, with Figma's box filter (`downsample.ts`). */
  downsampleImages: boolean;
  /** Also apply the structure-changing rewrites that only fix sub-pixel anti-aliasing (`WriteOptions.pixelExact`). */
  pixelExact: boolean;
  /** Letter spacing that corrects Penpot's glyph advances (`WriteOptions.textSpacing`; `line` when absent). */
  textSpacing?: 'line' | 'glyph' | 'none';
}

/** Shared state of one `writePenpot` run. */
export class WriterContext {
  readonly builder: BuildContext;
  readonly doc: ir.Document;
  readonly options: ResolvedWriteOptions;
  readonly reporter: ir.Reporter;
  readonly fileId: Uuid;
  readonly media: MediaRegistry;
  readonly styles: StyleRegistry;
  readonly bakes: BakeCache;
  private readonly reported = new Set<string>();
  private readonly reportedOnce = new Set<string>();

  constructor(init: {
    builder: BuildContext;
    doc: ir.Document;
    options: ResolvedWriteOptions;
    reporter: ir.Reporter;
    fileId: Uuid;
    /** Shared by the rebuild attempts of one write; a fresh one by default. */
    bakes?: BakeCache;
  }) {
    this.builder = init.builder;
    this.doc = init.doc;
    this.options = init.options;
    this.reporter = init.reporter;
    this.fileId = init.fileId;
    this.bakes = init.bakes ?? new BakeCache(init.doc.images, { convertProfiles: init.options.convertImageProfiles });
    this.media = new MediaRegistry(init.builder, init.doc.images, (code, message, node) => this.warn(code, message, node), this.bakes);
    this.styles = new StyleRegistry();
  }

  /** Reports a warning once per (code, node), whatever its message: the first one wins. */
  warnOnce(code: string, message: string, node?: Pick<ir.BaseNode, 'id' | 'name'>): void {
    const key = `${code}\u0000${node?.id ?? ''}`;
    if (this.reportedOnce.has(key)) return;
    this.reportedOnce.add(key);
    this.warn(code, message, node);
  }

  /** Reports a warning once per (code, node, message). */
  warn(code: string, message: string, node?: Pick<ir.BaseNode, 'id' | 'name'>): void {
    const key = `${code}\u0000${node?.id ?? ''}\u0000${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const warning: ir.Warning = { code, message };
    if (node) {
      warning.nodeId = node.id;
      warning.nodeName = node.name;
    }
    this.reporter.warn(warning);
  }
}
