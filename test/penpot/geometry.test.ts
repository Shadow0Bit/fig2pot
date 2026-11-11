import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { penpotId } from '../../src/penpot/ids.ts';
import { close, doc, ellipse, frame, rect, rotateAbout, segments, solid, stroke, translate, write } from './helpers.ts';

describe('document structure', () => {
  it('writes the manifest, the file and pages with deterministic ids and backgrounds', async () => {
    const d = doc([rect('1:2')], {}, { background: { r: 1, g: 0.5, b: 0, a: 1 } });
    d.pages.push({ id: '0:9', name: 'Second', kind: 'page', children: [] });
    const w = await write(d);
    expect(w.manifest.type).toBe('penpot/export-files');
    expect(w.manifest.files).toHaveLength(1);
    expect(w.manifest.files[0].name).toBe('Test');
    expect(w.pages.map((p) => [p.id, p.name, p.index])).toEqual([
      [penpotId('0:1', 'page'), 'Page 1', 0],
      [penpotId('0:9', 'page'), 'Second', 1],
    ]);
    expect(w.pages[0]!.background).toBe('#ff8000');
    expect(w.shape('1:2').id).toBe(penpotId('1:2'));

    const again = await write(d);
    expect(again.manifest.files[0].id).toBe(w.manifest.files[0].id);
    expect(Object.keys(again.shapes).sort()).toEqual(Object.keys(w.shapes).sort());
    expect(again.shape('1:2')).toEqual(w.shape('1:2'));
  });

  it('keeps the IR back-to-front order (last shape on top) at the root and inside boards', async () => {
    const w = await write(doc([rect('a'), frame('f', [rect('c1'), rect('c2'), rect('c3')]), rect('b')]));
    expect(w.roots().map((s) => s.name)).toEqual(['a', 'f', 'b']);
    expect(w.children(w.shape('f')).map((s) => s.name)).toEqual(['c1', 'c2', 'c3']);
    expect(w.shape('c1').parentId).toBe(w.shape('f').id);
    expect(w.shape('c1').frameId).toBe(w.shape('f').id);
  });
});

describe('box geometry', () => {
  it('places a rotated rect by its centre with the rotation in transform', async () => {
    const w = await write(doc([rect('r', { size: { width: 40, height: 20 }, transform: rotateAbout(30, 10, 10) })]));
    const s = w.shape('r');
    expect(s.rotation).toBeCloseTo(30, 6);
    expect(s.width).toBe(40);
    expect(s.height).toBe(20);
    expect(s.transform.a).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(s.transform.b).toBeCloseTo(0.5, 6);
    expect(s.transformInverse.b).toBeCloseTo(-0.5, 6);
    // Corners: local (0,0) maps to the transform origin, (40,0) along the rotated x axis.
    expect(close(s.points[0].x, 10) && close(s.points[0].y, 10)).toBe(true);
    expect(close(s.points[1].x, 10 + 40 * Math.cos(Math.PI / 6)) && close(s.points[1].y, 10 + 20)).toBe(true);
    // The untransformed box is centred on the real centre.
    const cx = (s.points[0].x + s.points[2].x) / 2;
    expect(cx).toBeCloseTo(s.x + s.width / 2, 4);
  });

  it('composes parent transforms (child of a rotated board)', async () => {
    const child = rect('c', { size: { width: 10, height: 10 }, transform: translate(20, 0) });
    const w = await write(doc([frame('f', [child], { transform: rotateAbout(90, 100, 100) })]));
    const s = w.shape('c');
    // Board rotated 90° about its origin (100,100): local (20,0) → (100,120).
    expect(close(s.points[0].x, 100) && close(s.points[0].y, 120)).toBe(true);
    expect(s.rotation).toBeCloseTo(90, 6);
    expect(w.shape('f').rotation).toBeCloseTo(90, 6);
  });

  it('stores mirrored transforms with flipX and a matching rotation', async () => {
    const mirrored = { a: -1, b: 0, c: 0, d: 1, e: 50, f: 0 };
    const w = await write(doc([rect('r', { size: { width: 50, height: 10 }, transform: mirrored })]));
    const s = w.shape('r');
    expect(s.flipX).toBe(true);
    expect(s.transform.a).toBeCloseTo(-1, 9);
    expect(s.transform.d).toBeCloseTo(1, 9);
    expect(s.rotation).toBe(0);
    // Local (0,0) lands on page (50,0): the mirrored box still covers 0..50.
    expect(close(s.points[0].x, 50) && close(s.points[1].x, 0)).toBe(true);
    expect(s.selrect).toMatchObject({ x: 0, y: 0, width: 50, height: 10 });
  });

  it('bakes a scaling transform into width, height and radii (with a warning)', async () => {
    const w = await write(
      doc([rect('r', { size: { width: 10, height: 10 }, cornerRadii: [2, 2, 2, 2], transform: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 } })]),
    );
    const s = w.shape('r');
    expect([s.width, s.height, s.r1, s.r4]).toEqual([20, 20, 4, 4]);
    expect(w.codes()).toContain('transform-scale-baked');
  });

  it('converts a sheared rect to an exact path', async () => {
    const shear = { a: 1, b: 0, c: 0.5, d: 1, e: 0, f: 0 };
    const w = await write(doc([rect('r', { size: { width: 10, height: 10 }, transform: shear, fills: [solid(1, 0, 0)] })]));
    const s = w.shape('r');
    expect(s.type).toBe('path');
    expect(segments(s)).toEqual([['M', 0, 0], ['L', 10, 0], ['L', 15, 10], ['L', 5, 10], ['L', 0, 0], ['Z']]);
    expect(s.fills).toEqual([{ fillColor: '#ff0000', fillOpacity: 1 }]);
    expect(w.codes()).toContain('sheared-shape-to-path');
  });

  it('converts a sheared ellipse to a curve outline', async () => {
    const shear = { a: 1, b: 0.3, c: 0, d: 1, e: 0, f: 0 };
    const w = await write(doc([ellipse('e', { size: { width: 10, height: 10 }, transform: shear })]));
    const s = w.shape('e');
    expect(s.type).toBe('path');
    expect(segments(s).filter((c) => c[0] === 'C')).toHaveLength(4);
  });

  it('keeps a sheared board as a board, warning about it', async () => {
    const w = await write(doc([frame('f', [], { transform: { a: 1, b: 0, c: 0.5, d: 1, e: 0, f: 0 } })]));
    expect(w.shape('f').type).toBe('frame');
    expect(w.shape('f').transform.c).toBeCloseTo(0.5 / Math.hypot(0.5, 1), 6);
    expect(w.codes()).toContain('skewed-board');
  });

  it('maps rect corner radii and board clipping', async () => {
    const w = await write(
      doc([
        frame('f', [], { cornerRadii: [1, 2, 3, 4], clipsContent: false }),
        frame('g', [rect('over', { transform: translate(50, 50) })], { clipsContent: true }),
        rect('r', { cornerRadii: [5, 6, 7, 8] }),
      ]),
    );
    expect([w.shape('f').r1, w.shape('f').r2, w.shape('f').r3, w.shape('f').r4]).toEqual([1, 2, 3, 4]);
    expect(w.shape('f').showContent).toBe(true);
    expect(w.shape('g').showContent).toBe(false);
    expect([w.shape('r').r1, w.shape('r').r4]).toEqual([5, 8]);
  });

  it('with pixelExact, drops a clip that hides nothing (its anti-aliased edge would thin the content ending there)', async () => {
    const inside = (id: string, extra: Partial<ir.RectNode> = {}): ir.RectNode => rect(id, { transform: translate(10, 10.25), size: { width: 80, height: 20 }, ...extra });
    const document = doc([
        frame(
          'page',
          [
            frame('fits', [inside('a', { stroke: stroke({ weight: 2, align: 'inside' }) })], { clipsContent: true }),
            frame('stroke', [inside('b', { stroke: stroke({ weight: 12, align: 'outside' }) })], { clipsContent: true }),
            frame('shadow', [inside('c', { effects: [{ type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 4 }, blur: 70, spread: 0, blendMode: 'normal' }] })], { clipsContent: true }),
            frame('hidden', [inside('d', { visible: false, transform: translate(-50, 0) })], { clipsContent: true }),
            // The rounded corner clips the square corner of a child that fills the frame's top.
            frame('round', [rect('e', { size: { width: 100, height: 40 } })], { clipsContent: true, cornerRadii: [24, 24, 24, 24] }),
          ],
          { clipsContent: true, size: { width: 500, height: 500 } },
        ),
      ]);
    const w = await write(document, { pixelExact: true });
    // A page-level board keeps its clip: Penpot's exporter crops a non-clipping board to its box.
    expect(w.shape('page').showContent).toBe(false);
    expect(w.shape('fits').showContent).toBe(true);
    expect(w.shape('stroke').showContent).toBe(false);
    expect(w.shape('shadow').showContent).toBe(false);
    expect(w.shape('hidden').showContent).toBe(true);
    expect(w.shape('round').showContent).toBe(false);
    expect(w.warnings.filter((x) => x.code === 'pixel-exact-unclipped').map((x) => x.nodeId)).toEqual(['fits', 'hidden']);
    // By default every frame keeps Figma's clip.
    const plain = await write(document);
    for (const id of ['page', 'fits', 'stroke', 'shadow', 'hidden', 'round']) expect(plain.shape(id).showContent).toBe(false);
    expect(plain.codes()).not.toContain('pixel-exact-unclipped');
  });

  it('writes ellipses as circles', async () => {
    const w = await write(doc([ellipse('e', { size: { width: 30, height: 20 }, transform: translate(5, 6) })]));
    expect(w.shape('e')).toMatchObject({ type: 'circle', x: 5, y: 6, width: 30, height: 20 });
  });
});
