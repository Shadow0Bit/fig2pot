import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { penpotId } from '../../src/penpot/ids.ts';
import { doc, pathNode, rect, rotateAbout, solid, square, translate, write, type Json } from './helpers.ts';

const gradient = (gradientType: ir.GradientPaint['gradientType'], handles: [ir.Vec2, ir.Vec2, ir.Vec2], extra: Partial<ir.GradientPaint> = {}): ir.GradientPaint => ({
  type: 'gradient',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  gradientType,
  handles,
  stops: [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
  ],
  ...extra,
});

const image = (imageRef: string, extra: Partial<ir.ImagePaint> = {}): ir.ImagePaint => ({
  type: 'image',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  imageRef,
  scaleMode: 'fill',
  ...extra,
});

const PNG: ir.ImageAsset = { ref: 'img1', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), mimeType: 'image/png', width: 200, height: 100 };

/** Figma's linear gradient parameter at normalised point p. */
function figmaLinearT(h: [ir.Vec2, ir.Vec2, ir.Vec2], p: ir.Vec2): number {
  // Solve p - h0 = t·(h1-h0) + s·(h2-h0).
  const ux = h[1].x - h[0].x;
  const uy = h[1].y - h[0].y;
  const vx = h[2].x - h[0].x;
  const vy = h[2].y - h[0].y;
  const det = ux * vy - uy * vx;
  return ((p.x - h[0].x) * vy - (p.y - h[0].y) * vx) / det;
}

/** Penpot's (SVG bounding-box units) linear gradient parameter at normalised point p. */
function penpotLinearT(g: Json, p: ir.Vec2): number {
  const dx = g.endX - g.startX;
  const dy = g.endY - g.startY;
  return ((p.x - g.startX) * dx + (p.y - g.startY) * dy) / (dx * dx + dy * dy);
}

describe('fills', () => {
  it('reverses the IR order (Penpot lists the top fill first) and drops invisible paints', async () => {
    const fills = [solid(1, 0, 0), solid(0, 1, 0, 1, { visible: false }), solid(0, 0, 1, 0.5, { opacity: 0.5 })];
    const w = await write(doc([rect('r', { fills })]));
    expect(w.shape('r').fills).toEqual([
      { fillColor: '#0000ff', fillOpacity: 0.25 },
      { fillColor: '#ff0000', fillOpacity: 1 },
    ]);
  });

  it('keeps at most 8 fills (the top ones) and warns', async () => {
    const fills = Array.from({ length: 10 }, (_, i) => solid(i / 10, 0, 0));
    const w = await write(doc([rect('r', { fills })]));
    const out = w.shape('r').fills as Json[];
    expect(out).toHaveLength(8);
    expect(out[0]!.fillColor).toBe('#e60000');
    expect(w.codes()).toContain('too-many-fills');
  });

  it('reports paint blend modes, which Penpot fills do not have', async () => {
    const w = await write(doc([rect('r', { fills: [solid(1, 0, 0, 1, { blendMode: 'multiply' })] })]));
    expect(w.codes()).toContain('paint-blend-mode-unsupported');
    expect(w.shape('r').fills).toHaveLength(1);
  });

  it('gives boards an explicit (possibly empty) fill list instead of Penpot\'s white default', async () => {
    const w = await write(doc([rect('r'), { ...rect('x'), type: 'frame', children: [], clipsContent: true, role: 'frame' } as ir.FrameNode]));
    expect(w.shape('x').fills).toEqual([]);
  });
});

describe('gradients', () => {
  it('maps an axis-aligned linear gradient directly and folds opacity into the stops', async () => {
    const g = gradient('linear', [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], { opacity: 0.5 });
    const w = await write(doc([rect('r', { size: { width: 100, height: 100 }, fills: [g] })]));
    const fill = w.shape('r').fills[0];
    expect(fill.fillOpacity).toBe(1);
    expect(fill.fillColorGradient).toEqual({
      type: 'linear',
      startX: 0,
      startY: 0.5,
      endX: 1,
      endY: 0.5,
      width: 1,
      stops: [
        { color: '#ff0000', opacity: 0.5, offset: 0 },
        { color: '#0000ff', opacity: 0.25, offset: 1 },
      ],
    });
  });

  it('reproduces a diagonal linear gradient on a non-square node at every point', async () => {
    // Handles perpendicular in PIXELS on a 200×100 node (Figma UI semantics), not in normalised space.
    const handles: [ir.Vec2, ir.Vec2, ir.Vec2] = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: -0.25, y: 0.5 }];
    const w = await write(doc([rect('r', { size: { width: 200, height: 100 }, fills: [gradient('linear', handles)] })]));
    const g = w.shape('r').fills[0].fillColorGradient;
    for (const p of [{ x: 0.3, y: 0.7 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.5 }]) {
      expect(penpotLinearT(g, p)).toBeCloseTo(figmaLinearT(handles, p), 5);
    }
  });

  it('maps a radial gradient to centre, axis end and relative width', async () => {
    // Figma's default radial: ellipse inscribed in the node.
    const handles: [ir.Vec2, ir.Vec2, ir.Vec2] = [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }];
    const w = await write(doc([rect('r', { size: { width: 200, height: 100 }, fills: [gradient('radial', handles)] })]));
    const g = w.shape('r').fills[0].fillColorGradient;
    expect(g).toMatchObject({ type: 'radial', startX: 0.5, startY: 0.5, endX: 1, endY: 0.5 });
    // SVG renderer (default): a circle in normalised space, stretched with the box ⇒ width = 1.
    expect(g.width).toBeCloseTo(1, 6);
    // WASM renderer: perpendicular radius 50px = |start→end|(100px) · width · (200/100) ⇒ width = 0.25.
    const wasm = await write(doc([rect('r', { size: { width: 200, height: 100 }, fills: [gradient('radial', handles)] })]), { renderer: 'wasm' });
    expect(wasm.shape('r').fills[0].fillColorGradient).toMatchObject({ type: 'radial', startX: 0.5, startY: 0.5, endX: 1, endY: 0.5 });
    expect(wasm.shape('r').fills[0].fillColorGradient.width).toBeCloseTo(0.25, 6);
  });

  it('turns angular and diamond gradients into linear / radial ones with a warning when baking is off', async () => {
    const handles: [ir.Vec2, ir.Vec2, ir.Vec2] = [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }];
    const w = await write(doc([rect('a', { fills: [gradient('angular', handles)] }), rect('d', { fills: [gradient('diamond', handles)] })]), { bakeUnsupportedPaints: false });
    expect(w.shape('a').fills[0].fillColorGradient.type).toBe('linear');
    expect(w.shape('d').fills[0].fillColorGradient.type).toBe('radial');
    expect(w.warnings.filter((x) => x.code === 'gradient-approximated').map((x) => x.nodeId)).toEqual(['a', 'd']);
  });

  it('expresses gradients of baked paths relative to their page-space bounds', async () => {
    // A 100×50 vector rotated 90°: its bounds are 50 wide, 100 tall.
    const handles: [ir.Vec2, ir.Vec2, ir.Vec2] = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }];
    const node = pathNode('p', [square(0, 0, 100, 50)], { size: { width: 100, height: 50 }, transform: rotateAbout(90, 50, 0), fills: [gradient('linear', handles)] });
    const w = await write(doc([node]));
    const g = w.shape('p').fills[0].fillColorGradient;
    // The gradient now runs top → bottom along the middle of the rotated shape.
    expect(g.startX).toBeCloseTo(0.5, 6);
    expect(g.startY).toBeCloseTo(0, 6);
    expect(g.endX).toBeCloseTo(0.5, 6);
    expect(g.endY).toBeCloseTo(1, 6);
  });
});

describe('image fills', () => {
  it('registers the asset once as file media and references it from the fill', async () => {
    const w = await write(doc([rect('a', { fills: [image('img1', { opacity: 0.8 })] }), rect('b', { fills: [image('img1')] })], { images: { img1: PNG } }));
    expect(w.media).toHaveLength(1);
    expect(w.media[0]).toMatchObject({ id: penpotId('img1', 'media'), width: 200, height: 100, mtype: 'image/png' });
    expect(w.shape('a').fills).toEqual([
      { fillOpacity: 0.8, fillImage: { id: penpotId('img1', 'media'), width: 200, height: 100, mtype: 'image/png', name: 'img1', keepAspectRatio: true } },
    ]);
    expect(Object.keys(w.files).filter((f) => f.startsWith('objects/') && f.endsWith('.png'))).toHaveLength(1);
  });

  it('drops fills whose asset is missing or of unknown format, with warnings', async () => {
    const unknown: ir.ImageAsset = { ref: 'img2', bytes: new Uint8Array([1, 2, 3]) };
    const w = await write(doc([rect('a', { fills: [image('nope'), solid(1, 0, 0)] }), rect('b', { fills: [image('img2')] })], { images: { img2: unknown } }));
    expect(w.shape('a').fills).toEqual([{ fillColor: '#ff0000', fillOpacity: 1 }]);
    expect(w.shape('b').fills).toEqual([]);
    expect(w.codes()).toEqual(expect.arrayContaining(['missing-image', 'unsupported-image']));
    expect(w.media).toHaveLength(0);
  });

  it('places "fit" and "crop" images with an image transform and warns', async () => {
    const crop = image('img1', { scaleMode: 'crop', imageTransform: { a: 0.5, b: 0, c: 0, d: 0.5, e: 0.25, f: 0.25 } });
    const w = await write(
      doc([rect('fit', { size: { width: 100, height: 100 }, fills: [image('img1', { scaleMode: 'fit' })] }), rect('crop', { fills: [crop] }), rect('tile', { fills: [image('img1', { scaleMode: 'tile' })] })], {
        images: { img1: PNG },
      }),
    );
    // 200×100 image fitted in 100×100: full width, half height, centred.
    expect(w.shape('fit').fills[0].fillImage.transform).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 });
    // Showing the image's centre quarter: the picture is twice the node, shifted by half a node.
    expect(w.shape('crop').fills[0].fillImage.transform).toEqual({ x: -0.5, y: -0.5, width: 2, height: 2 });
    expect(w.shape('tile').fills[0].fillImage.transform).toBeUndefined();
    expect(w.warnings.filter((x) => x.code === 'image-scale-mode-approximated').map((x) => x.nodeId)).toEqual(['fit', 'crop', 'tile']);
  });

  it('keeps the fill box of a translated rect identical to the node box', async () => {
    const w = await write(doc([rect('r', { transform: translate(40, 40), fills: [image('img1', { scaleMode: 'fit' })] })], { images: { img1: PNG } }));
    expect(w.shape('r').fills[0].fillImage.transform).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 });
  });
});
