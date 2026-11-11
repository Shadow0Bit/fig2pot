import type * as ir from '../../ir.ts';
import type { FigDocument, FigNode } from '../types.ts';
import { colorFromKiwi } from './common.ts';
import { componentDef, remoteSymbols, translateRemotePage } from './components.ts';
import { createContext, type TranslateContext, type TranslateOptions } from './context.ts';
import { collectImages } from './images.ts';
import { translateChildren } from './nodes.ts';
import { collectStyles } from './styles.ts';

export function translateDocument(doc: FigDocument, reporter: ir.Reporter, options?: TranslateOptions): ir.Document {
  const ctx = createContext(doc, reporter, options);
  warnDroppedGrids(doc, ctx);
  const pages = doc.pages.map((page) => translatePage(page, ctx));
  const remote = remoteSymbols(doc);
  if (remote.length > 0) pages.push(translateRemotePage(remote, ctx));

  const components: Record<string, ir.ComponentDef> = {};
  const imageRefs = new Set<string>();
  const styleRefs = new Set<string>();
  const notePaints = (paints: readonly ir.Paint[] | undefined): void => {
    for (const paint of paints ?? []) {
      if (paint.type === 'image') imageRefs.add(paint.imageRef);
      if (paint.styleId) styleRefs.add(paint.styleId);
    }
  };
  for (const page of pages) {
    walk(page.children, (node) => {
      notePaints(node.fills);
      notePaints(node.stroke?.paints);
      if (node.type === 'text') {
        for (const run of node.runs) {
          notePaints(run.style.fills);
          if (run.style.styleId) styleRefs.add(run.style.styleId);
        }
      }
      if (node.type === 'frame' && node.componentId) {
        const symbol = doc.byId.get(node.componentId);
        if (symbol) components[node.componentId] = componentDef(symbol, page.kind === 'remote-components');
      }
    });
  }

  const styles = collectStyles(ctx, styleRefs);
  for (const style of styles.colors) notePaints(style.paints);

  return {
    name: documentName(doc),
    pages,
    components,
    images: collectImages(doc, imageRefs),
    styles,
  };
}

function translatePage(canvas: FigNode, ctx: TranslateContext): ir.Page {
  const c = canvas.change;
  const page: ir.Page = { id: canvas.id, name: c.name ?? 'Page', kind: 'page', children: translateChildren(canvas, ctx) };
  if (c.backgroundColor && c.backgroundEnabled !== false) page.background = colorFromKiwi(c.backgroundColor);
  return page;
}

/** Layout grids and ruler guides are editor aids the IR does not model; reported once per document. */
function warnDroppedGrids(doc: FigDocument, ctx: TranslateContext): void {
  let grids = 0;
  let guides = 0;
  let first: FigNode | undefined;
  for (const node of doc.byId.values()) {
    const g = node.change.layoutGrids?.length ?? 0;
    const r = node.change.guides?.length ?? 0;
    if (g + r > 0) first ??= node;
    grids += g;
    guides += r;
  }
  if (first) ctx.warn('layout-grids-dropped', `${grids} layout grid(s) and ${guides} guide(s) are not converted`, first);
}

function documentName(doc: FigDocument): string {
  const fileName = doc.file.meta?.['file_name'];
  if (typeof fileName === 'string' && fileName.trim()) return fileName;
  return doc.root.change.name || 'Untitled';
}

function walk(nodes: readonly ir.Node[], fn: (node: ir.Node) => void): void {
  for (const node of nodes) {
    fn(node);
    if (node.type === 'frame' || node.type === 'group' || node.type === 'boolean') walk(node.children, fn);
  }
}
