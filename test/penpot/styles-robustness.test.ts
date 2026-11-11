import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { WriterContext } from '../../src/penpot/context.ts';
import { Emitter } from '../../src/penpot/emit.ts';
import { penpotId } from '../../src/penpot/ids.ts';
import { createBuildContext, exportAsBytes, type BoardParams } from '../../src/penpot/library.ts';
import type { PNode } from '../../src/penpot/pnode.ts';
import { CollectingReporter } from '../../src/util/reporter.ts';
import { doc, frame, rect, solid, text, textStyle, write } from './helpers.ts';

describe('shared styles', () => {
  const colorStyle: ir.ColorStyle = { id: 'S:1', name: 'Brand/Primary', paints: [solid(1, 0, 0, 1, { opacity: 0.5 })] };
  const typography: ir.TypographyStyle = {
    id: 'T:1',
    name: 'Headings/H1',
    style: { ...textStyle({ fontSize: 32, fontWeight: 700, lineHeight: { unit: 'percent', value: 120 } }), fills: undefined, styleId: undefined } as unknown as ir.TypographyStyle['style'],
  };

  it('registers library colours and links paints that use them', async () => {
    const w = await write(doc([rect('r', { fills: [solid(1, 0, 0, 1, { opacity: 0.5, styleId: 'S:1' })] })], { styles: { colors: [colorStyle], typographies: [] } }));
    expect(w.colors).toEqual([expect.objectContaining({ id: penpotId('S:1#0', 'color'), name: 'Primary', path: 'Brand', color: '#ff0000', opacity: 0.5 })]);
    expect(w.shape('r').fills[0]).toMatchObject({ fillColor: '#ff0000', fillOpacity: 0.5, fillColorRefId: penpotId('S:1#0', 'color'), fillColorRefFile: w.manifest.files[0].id });
  });

  it('links stroke paints and gradient colour styles', async () => {
    const gradientStyle: ir.ColorStyle = {
      id: 'S:2',
      name: 'Sunset',
      paints: [
        {
          type: 'gradient',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          gradientType: 'linear',
          handles: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
          stops: [{ position: 0, color: { r: 1, g: 1, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 0, b: 0, a: 1 } }],
        },
      ],
    };
    const st: ir.Stroke = { paints: [solid(1, 0, 0, 1, { opacity: 0.5, styleId: 'S:1' })], weight: 1, align: 'inside', join: 'miter', startCap: 'none', endCap: 'none', dashPattern: [] };
    const w = await write(doc([rect('r', { stroke: st })], { styles: { colors: [colorStyle, gradientStyle], typographies: [] } }));
    expect(w.shape('r').strokes[0].strokeColorRefId).toBe(penpotId('S:1#0', 'color'));
    expect(w.colors.find((c) => c.name === 'Sunset')?.gradient).toMatchObject({ type: 'linear', startX: 0, endX: 1 });
  });

  it('registers typographies', async () => {
    const w = await write(doc([], { styles: { colors: [], typographies: [typography] } }));
    expect(w.typographies).toEqual([
      expect.objectContaining({
        id: penpotId('T:1', 'typography'),
        name: 'H1',
        path: 'Headings',
        fontFamily: 'Roboto',
        fontId: 'gfont-roboto',
        fontVariantId: '700',
        fontSize: '32',
        fontWeight: '700',
        // 120 % of 32 px: Figma lays it out at round(38.4) = 38 px (text/line-height.ts), like the leaves using it.
        lineHeight: '1.1875',
      }),
    ]);
  });

  it('passes a fill converter to the text module (text fills use library colours too)', async () => {
    const node = text('t', 'Hi', { runs: [{ start: 0, end: 2, style: textStyle({ fills: [solid(1, 0, 0, 1, { opacity: 0.5, styleId: 'S:1' })] }) }] });
    const w = await write(doc([node], { styles: { colors: [colorStyle], typographies: [] } }));
    expect(JSON.stringify(w.shape('t').content)).toContain(penpotId('S:1#0', 'color'));
  });
});

describe('robustness', () => {
  it('skips a node with broken geometry and keeps the rest', async () => {
    const bad = rect('bad', { transform: { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    const w = await write(doc([bad, rect('ok')]));
    expect(w.has('bad')).toBe(false);
    expect(w.has('ok')).toBe(true);
    expect(w.warnings.find((x) => x.code === 'invalid-geometry')).toMatchObject({ nodeId: 'bad', nodeName: 'bad' });
  });

  it('retries a board the library rejects without its styling, keeping the container stack balanced', async () => {
    const builder = createBuildContext();
    const reporter = new CollectingReporter();
    const ctx = new WriterContext({ builder, doc: doc([]), options: { textMode: 'auto', booleanMode: 'editable', components: true, textLineBreaks: 'source', renderer: 'svg', bakeUnsupportedPaints: true, bakeScale: 2, convertImageProfiles: true, downsampleImages: true, pixelExact: false }, reporter, fileId: penpotId('f', 'file') });
    builder.addFile({ id: ctx.fileId, name: 'f' });
    const pageId = builder.addPage({ name: 'p' });
    const geometry = { x: 0, y: 0, width: 10, height: 10, rotation: 0, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, transformInverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
    const badParams = { id: penpotId('b'), name: 'bad', ...geometry, fills: [{ fillColor: 'not-a-colour' }] } as BoardParams;
    const irNode = frame('b', []);
    const tree: PNode[] = [
      {
        kind: 'board',
        origin: { irId: 'b', suffix: '' },
        node: irNode,
        params: badParams,
        children: [{ kind: 'rect', origin: { irId: 'c', suffix: '' }, node: rect('c'), params: { id: penpotId('c'), name: 'child', ...geometry, fills: [], strokes: [] } }],
      },
      { kind: 'rect', origin: { irId: 'after', suffix: '' }, node: rect('after'), params: { id: penpotId('after'), name: 'after', ...geometry, fills: [], strokes: [] } },
    ];
    new Emitter(ctx).emitAll(tree);
    builder.closePage();
    builder.closeFile();
    expect(reporter.warnings.map((x) => x.code)).toEqual(['invalid-shape']);
    const files = unzipSync(await exportAsBytes(builder));
    const shape = (id: string) => JSON.parse(strFromU8(files[Object.keys(files).find((k) => k.includes(`/pages/${pageId}/${id}.json`))!]!));
    expect(shape(penpotId('b')).fills).toEqual([]);
    expect(shape(penpotId('c')).parentId).toBe(penpotId('b'));
    // The rect added after the board is back at the root.
    expect(shape(penpotId('after')).parentId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('writes one empty page for a document without pages', async () => {
    const w = await write({ ...doc([]), pages: [] });
    expect(w.pages).toHaveLength(1);
  });

  it('produces the same shapes for the same document', async () => {
    const d = doc([frame('f', [rect('a', { fills: [solid(0.2, 0.4, 0.6)] })]), text('t', 'x')]);
    const [one, two] = await Promise.all([write(d), write(d)]);
    expect(two.shapes).toEqual(one.shapes);
    expect(two.pages).toEqual(one.pages);
  });
});
