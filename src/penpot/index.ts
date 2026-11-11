/**
 * IR → `.penpot` bytes.
 *
 * 1. Shared styles and the file are registered.
 * 2. Every page is converted into an intermediate Penpot shape tree
 *    (`shapes.ts`); images are registered as they are first used.
 * 3. Component copies are linked to their mains across the whole document
 *    (`components.ts`).
 * 4. The trees are sent to the library page by page (`emit.ts`), then the
 *    components are registered on their (now existing) main boards. When
 *    Penpot rejects one, everything is rebuilt with it demoted to plain boards.
 * 5. The export is normalised to be byte-identical across runs (`zip.ts`).
 */
import type * as ir from '../ir.ts';
import { CollectingReporter, silentReporter } from '../util/reporter.ts';
import { BakeCache, DEFAULT_BAKE_SCALE } from './bake.ts';
import { hex } from './colors.ts';
import { ComponentLinker, type PageTree } from './components.ts';
import { WriterContext, type ResolvedWriteOptions } from './context.ts';
import { Emitter } from './emit.ts';
import { penpotId } from './ids.ts';
import { createBuildContext, describeBuilderError, exportAsBytes, type BuildContext } from './library.ts';
import { ShapeBuilder } from './shapes.ts';
import { normalizeExport } from './zip.ts';

export type { PenpotFill } from './library.ts';

export interface WriteOptions {
  /**
   * `auto` (default): editable text where Penpot is expected to draw it as the source did, glyph outlines
   * otherwise (`text/editability.ts`: font or characters missing, truncation, lists it cannot emulate,
   * decorations, SVG-renderer gradient / image fills); `editable` / `outline`: every text so.
   */
  textMode?: 'auto' | 'editable' | 'outline';
  /** `flatten` (default): the source's computed outline as one path (exact); `editable`: Penpot boolean groups. */
  booleanMode?: 'editable' | 'flatten';
  /** Emit component mains and copies (default true); false emits plain boards. */
  components?: boolean;
  /**
   * `source` (default): editable text keeps the source's line breaks exactly (each wrap becomes an explicit
   * soft break, and the box gets room so Penpot never wraps again). `reflow`: Penpot wraps the text itself,
   * as on any later edit. Justified text always reflows.
   */
  textLineBreaks?: 'source' | 'reflow';
  /**
   * Penpot renderer the file is tuned for (default `svg`, Penpot's default renderer). The SVG and the
   * WASM renderer interpret gradient coordinates and blur radii differently; everything else is the same.
   */
  renderer?: 'svg' | 'wasm';
  /**
   * Rasterise the paints Penpot cannot draw (tiled and rotated images, rotated crops, angular and diamond
   * gradients) into image fills that look like the source (default true). false keeps the editable
   * approximations (tile → cover, angular → linear, …), with warnings.
   */
  bakeUnsupportedPaints?: boolean;
  /**
   * Device-pixel ratio of baked bitmaps (default 2). Reduced, with a `bake-downscaled` warning, so that no
   * bitmap exceeds 4096 px a side or 16 megapixels.
   */
  bakeScale?: number;
  /**
   * Make Penpot show image colours as the source does (default true). Penpot's SVG renderer applies an
   * image's embedded ICC profile / PNG gAMA·cHRM and the WASM renderer ignores them, so every PNG / JPEG is
   * stored as plain sRGB: profiles the source ignores (Figma files without a colour profile ignore ICC
   * profiles and gAMA / cHRM) are dropped losslessly, other non-sRGB images are converted to sRGB. false
   * stores the bytes as they are, except that a PNG with an EXIF orientation is always stored with turned
   * pixels (the WASM renderer ignores `eXIf`; `image-color.ts`).
   */
  convertImageProfiles?: boolean;
  /**
   * Images shown at less than 1 / `bakeScale` of their natural size are stored as an area-averaged copy at
   * `bakeScale` × the displayed size (default true), which is how Figma draws them; Penpot's renderers
   * reduce the original with coarser filters, so fine detail (small text in screenshots) breaks up.
   */
  downsampleImages?: boolean;
  /**
   * Also apply rewrites that only change sub-pixel anti-aliasing but alter the design's structure (default
   * false): frames that hide nothing are written non-clipping, inside/outside strokes are redrawn on inset
   * boxes, text spacing is corrected per glyph (`textSpacing: 'glyph'`, unless `textSpacing` is given), and
   * `textMode: 'auto'` outlines texts whose glyphs Penpot's copy of the font draws with other shapes
   * (`text-outlined-glyph-shapes`). Each such rewrite is reported (`pixel-exact-unclipped`,
   * `pixel-exact-stroke-inset`, `pixel-exact-text-spacing`).
   */
  pixelExact?: boolean;
  /**
   * Letter spacing that corrects the glyph advances of Penpot's copy of a font where they differ from the
   * source's (Figma's Inter 3 vs Penpot's Inter 4): `line` (default) one extra spacing per source line, so that
   * each line starts and ends where the source drew it (`text-spacing-corrected`); `glyph` (default with
   * `pixelExact`) per character, which splits runs into many leaves; `none` keeps the source's spacing.
   */
  textSpacing?: 'line' | 'glyph' | 'none';
}

export async function writePenpot(doc: ir.Document, options: WriteOptions = {}, reporter: ir.Reporter = silentReporter): Promise<Uint8Array> {
  const resolved: ResolvedWriteOptions = {
    textMode: options.textMode ?? 'auto',
    booleanMode: options.booleanMode ?? 'flatten',
    components: options.components !== false,
    textLineBreaks: options.textLineBreaks === 'reflow' ? 'reflow' : 'source',
    renderer: options.renderer === 'wasm' ? 'wasm' : 'svg',
    bakeUnsupportedPaints: options.bakeUnsupportedPaints !== false,
    bakeScale: options.bakeScale !== undefined && Number.isFinite(options.bakeScale) && options.bakeScale > 0 ? options.bakeScale : DEFAULT_BAKE_SCALE,
    convertImageProfiles: options.convertImageProfiles !== false,
    downsampleImages: options.downsampleImages !== false,
    pixelExact: options.pixelExact === true,
    textSpacing:
      options.textSpacing === 'line' || options.textSpacing === 'glyph' || options.textSpacing === 'none' ? options.textSpacing : options.pixelExact === true ? 'glyph' : 'line',
  };
  const document = uniqueIds(doc, reporter);
  // Decoded images and baked bitmaps survive the rebuilds below.
  const bakes = new BakeCache(document.images, { convertProfiles: resolved.convertImageProfiles });
  // Penpot may reject a component only once the pages are built (its main board, or the component itself):
  // the file is then rebuilt with those components demoted to plain boards, so that no copy is left
  // pointing at a missing component. Only the final build's warnings are reported.
  const excluded = new Set<string>();
  const rejections: ir.Warning[] = [];
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= MAX_ATTEMPTS;
    const buffer = new CollectingReporter();
    const options = last && attempt > 1 ? { ...resolved, components: false } : resolved;
    const result = build(document, options, buffer, excluded, bakes);
    if (result.rejected.length === 0 || last) {
      if (last && attempt > 1) {
        buffer.warn({ code: 'components-dropped', message: `Penpot kept rejecting components after ${attempt - 1} attempts; all components were written as plain boards` });
      }
      for (const w of [...buffer.warnings, ...rejections, ...result.rejected.map((r) => r.warning)]) reporter.warn(w);
      return normalizeExport(await exportAsBytes(result.builder));
    }
    for (const r of result.rejected) {
      excluded.add(r.irId);
      rejections.push(r.warning);
    }
  }
}

const MAX_ATTEMPTS = 4;

interface Build {
  builder: BuildContext;
  /** Components Penpot rejected, with the warning that says so. */
  rejected: { irId: string; warning: ir.Warning }[];
}

function build(doc: ir.Document, resolved: ResolvedWriteOptions, reporter: ir.Reporter, excluded: ReadonlySet<string>, bakes: BakeCache): Build {
  const builder = createBuildContext({ referer: 'fig2pot' });
  const fileId = penpotId(`${doc.name}\u0000${doc.pages.map((p) => p.id).join('\u0000')}`, 'file');
  builder.addFile({ id: fileId, name: doc.name || 'Untitled' });

  const ctx = new WriterContext({ builder, doc, options: resolved, reporter, fileId, bakes });
  const warn = (code: string, message: string): void => ctx.warn(code, message);
  ctx.styles.registerColors(builder, doc.styles.colors, ctx.media, warn);
  ctx.styles.registerTypographies(builder, doc.styles.typographies, warn);

  const shapes = new ShapeBuilder(ctx);
  const pageIds = uniquePageIds(doc.pages, ctx);
  const pages: PageTree[] = doc.pages.map((page, i) => ({ pageId: pageIds[i]!, nodes: shapes.page(page) }));

  const components = resolved.components ? new ComponentLinker(ctx, pages, excluded).link() : [];

  const emitter = new Emitter(ctx);
  doc.pages.forEach((page, i) => {
    const tree = pages[i]!;
    const params: { id: string; name: string; background?: string } = { id: tree.pageId, name: page.name || `Page ${i + 1}` };
    if (page.background) params.background = hex(page.background);
    builder.addPage(params);
    emitter.emitAll(tree.nodes);
    builder.closePage();
  });

  const rejected: Build['rejected'] = [];
  for (const { irId, params: component } of components) {
    if (!component.frameId || !emitter.emitted.has(component.frameId)) {
      rejected.push({ irId, warning: { code: 'component-dropped', message: `Component "${component.name ?? ''}" lost its main board; it and its copies became plain boards` } });
      continue;
    }
    try {
      builder.addComponent(component);
    } catch (error) {
      const message = `Penpot rejected component "${component.name ?? ''}" (${describeBuilderError(error)}); it and its copies became plain boards`;
      rejected.push({ irId, warning: { code: 'invalid-component', message } });
    }
  }

  if (doc.pages.length === 0) {
    // A Penpot file needs at least one page to open.
    builder.addPage({ id: penpotId('empty', 'page'), name: 'Page 1' });
    builder.closePage();
  }

  ctx.media.reportDownsampling(resolved.bakeScale);
  builder.closeFile();
  return { builder, rejected };
}

/** Penpot page ids; a repeated IR page id gets a deterministic suffix (the same id twice corrupts the file). */
function uniquePageIds(pages: readonly ir.Page[], ctx: WriterContext): string[] {
  const seen = new Set<string>();
  return pages.map((page) => {
    let id = page.id;
    for (let n = 1; seen.has(id); n++) id = `${page.id}#dup${n}`;
    if (id !== page.id) ctx.warn('duplicate-id', `Page id ${page.id} is used by several pages; this one was renumbered`);
    seen.add(id);
    return penpotId(id, 'page');
  });
}

/**
 * The document with every node id unique. Penpot ids derive from IR ids, so a repeated id would make two
 * shapes share one Penpot id (`:child-not-in-parent`, `:invalid-parent`, …). Later occurrences get a
 * `#dup<n>` suffix, in document order; the input is not modified (a copy is made only when needed).
 */
function uniqueIds(doc: ir.Document, reporter: ir.Reporter): ir.Document {
  const all = new Set<string>();
  let duplicated = false;
  const scan = (node: ir.Node): void => {
    if (all.has(node.id)) duplicated = true;
    all.add(node.id);
    if ('children' in node) node.children.forEach(scan);
  };
  doc.pages.forEach((page) => page.children.forEach(scan));
  if (!duplicated) return doc;

  const used = new Set<string>();
  const rename = (node: ir.Node): ir.Node => {
    let id = node.id;
    if (used.has(id)) {
      let n = 1;
      while (all.has(`${node.id}#dup${n}`) || used.has(`${node.id}#dup${n}`)) n++;
      id = `${node.id}#dup${n}`;
      reporter.warn({ code: 'duplicate-id', message: `Node id ${node.id} is used by several nodes; this one became ${id}`, nodeId: node.id, nodeName: node.name });
    }
    used.add(id);
    const copy = { ...node, id } as ir.Node;
    if ('children' in copy) (copy as ir.ContainerNode).children = (node as ir.ContainerNode).children.map(rename);
    return copy;
  };
  return { ...doc, pages: doc.pages.map((page) => ({ ...page, children: page.children.map(rename) })) };
}
