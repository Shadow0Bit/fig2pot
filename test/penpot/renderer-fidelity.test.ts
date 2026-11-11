/**
 * Regression tests for the rendering defects found against Penpot 2.19 (review E): numbers that depend on
 * the target renderer (`WriteOptions.renderer`), and renderer-independent fixes. The renderer models used
 * here were measured on a live Penpot; `test/penpot/live/` re-checks them there.
 */
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { rectCommands } from '../../src/penpot/paths.ts';
import { doc, ellipse, frame, group, pathNode, rect, solid, square, stroke, translate, write, type Json } from './helpers.ts';

const V = (x: number, y: number): ir.Vec2 => ({ x, y });
const bw: ir.GradientStop[] = [
  { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
  { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
];
const gradient = (gradientType: ir.GradientPaint['gradientType'], handles: [ir.Vec2, ir.Vec2, ir.Vec2]): ir.GradientPaint => ({
  type: 'gradient',
  gradientType,
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  handles,
  stops: bw,
});

/** Figma's gradient parameter at a node-normalised point. */
function figmaT(g: ir.GradientPaint, p: ir.Vec2): number {
  const [h0, h1, h2] = g.handles;
  const u = V(h1.x - h0.x, h1.y - h0.y);
  const v = V(h2.x - h0.x, h2.y - h0.y);
  const det = u.x * v.y - u.y * v.x;
  const d = V(p.x - h0.x, p.y - h0.y);
  const s = (d.x * v.y - d.y * v.x) / det;
  const t = (u.x * d.y - u.y * d.x) / det;
  return g.gradientType === 'linear' ? s : Math.hypot(s, t);
}

/** Penpot's gradient parameter at a box-normalised point, as each renderer draws it (measured on 2.19). */
function penpotT(g: Json, p: ir.Vec2, w: number, h: number, renderer: 'svg' | 'wasm'): number {
  const sx = renderer === 'wasm' ? w : 1;
  const sy = renderer === 'wasm' ? h : 1;
  const a1 = V((g.endX - g.startX) * sx, (g.endY - g.startY) * sy);
  const d = V((p.x - g.startX) * sx, (p.y - g.startY) * sy);
  if (g.type === 'linear') return (d.x * a1.x + d.y * a1.y) / (a1.x * a1.x + a1.y * a1.y);
  const k = g.width * (renderer === 'wasm' ? w / h : 1);
  const a2 = V(-a1.y * k, a1.x * k);
  const det = a1.x * a2.y - a1.y * a2.x;
  return Math.hypot((d.x * a2.y - d.y * a2.x) / det, (a1.x * d.y - a1.y * d.x) / det);
}

const samples = Array.from({ length: 49 }, (_, i) => V(((i % 7) + 0.5) / 7, (Math.floor(i / 7) + 0.5) / 7));

describe('gradients per target renderer (E1, E1b)', () => {
  // A pixel-space ellipse rx=120, ry=40 rotated 30° in a 300×200 box, and a sheared conjugate pair.
  const w = 300;
  const h = 200;
  const a = (30 * Math.PI) / 180;
  const n = (x: number, y: number): ir.Vec2 => V(x / w, y / h);
  const cases: [string, ir.GradientPaint][] = [
    ['radial inscribed', gradient('radial', [V(0.5, 0.5), V(1, 0.5), V(0.5, 1)])],
    ['radial rotated', gradient('radial', [n(150, 100), n(150 + 120 * Math.cos(a), 100 + 120 * Math.sin(a)), n(150 - 40 * Math.sin(a), 100 + 40 * Math.cos(a))])],
    ['radial conjugate', gradient('radial', [n(150, 100), n(250, 100), n(210, 150)])],
    ['linear skewed', gradient('linear', [V(0, 0), V(1, 1), V(-1, 1)])],
    ['linear tall skew', gradient('linear', [V(0, 0), V(1, 0.5), V(0.3, 1)])],
  ];
  for (const renderer of ['svg', 'wasm'] as const) {
    it.each(cases)(`reproduces Figma's %s gradient on a non-square box in the ${renderer} renderer`, async (_, paint) => {
      const out = await write(doc([rect('r', { size: { width: w, height: h }, fills: [paint] })]), { renderer });
      const g = out.shape('r').fills[0].fillColorGradient;
      for (const p of samples) expect(penpotT(g, p, w, h, renderer)).toBeCloseTo(figmaT(paint, p), 4);
    });
  }

  it('gives a 300×100 inscribed radial its 50 px radius in SVG (width 1) and WASM (width 1/9)', async () => {
    const paint = gradient('radial', [V(0.5, 0.5), V(1, 0.5), V(0.5, 1)]);
    const node = (): ir.Node => rect('r', { size: { width: 300, height: 100 }, fills: [paint] });
    expect((await write(doc([node()]))).shape('r').fills[0].fillColorGradient.width).toBeCloseTo(1, 6);
    expect((await write(doc([node()]), { renderer: 'wasm' })).shape('r').fills[0].fillColorGradient.width).toBeCloseTo(1 / 9, 6);
  });
});

describe('blur strengths per target renderer (E2)', () => {
  const effects: ir.Effect[] = [
    { type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 4 }, blur: 20, spread: 0, blendMode: 'normal' },
    { type: 'layer-blur', visible: true, radius: 20 },
    { type: 'background-blur', visible: true, radius: 40 },
  ];

  it('SVG: layer and background blur value = radius / 2 (σ), shadow blur unchanged (σ = blur / 2); warns that SVG draws no background blur', async () => {
    const w = await write(doc([rect('r', { effects })]));
    expect(w.shape('r').blur.value).toBe(10);
    expect(w.shape('r').backgroundBlur.value).toBe(20);
    expect(w.shape('r').shadow[0].blur).toBe(20);
    expect(w.codes()).toContain('background-blur-unsupported');
  });

  it('WASM: values whose Skia σ (≈ 0.565·value + 0.45) equals radius / 2', async () => {
    const w = await write(doc([rect('r', { effects })]), { renderer: 'wasm' });
    const sigma = (v: number): number => 0.565 * v + 0.45;
    expect(sigma(w.shape('r').blur.value)).toBeCloseTo(10, 4);
    expect(sigma(w.shape('r').backgroundBlur.value)).toBeCloseTo(20, 4);
    expect(sigma(w.shape('r').shadow[0].blur)).toBeCloseTo(10, 4);
    expect(w.codes()).not.toContain('background-blur-unsupported');
  });
});

describe('image crop (E3)', () => {
  it('draws a placed picture box exactly (keepAspectRatio false) and keeps cover for fill', async () => {
    const images = { img: { ref: 'img', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' as const, width: 80, height: 40 } };
    const image = (scaleMode: ir.ImageScaleMode, extra: Partial<ir.ImagePaint> = {}): ir.ImagePaint => ({
      type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: 'img', scaleMode, ...extra,
    });
    const w = await write(
      doc(
        [
          rect('crop', { size: { width: 300, height: 100 }, fills: [image('crop', { imageTransform: { a: 0.5, b: 0, c: 0, d: 1, e: 0.5, f: 0 } })] }),
          rect('fit', { size: { width: 300, height: 100 }, fills: [image('fit')] }),
          rect('fill', { size: { width: 300, height: 100 }, fills: [image('fill')] }),
        ],
        { images },
      ),
    );
    expect(w.shape('crop').fills[0].fillImage).toMatchObject({ keepAspectRatio: false, transform: { x: -1, y: 0, width: 2, height: 1 } });
    expect(w.shape('fit').fills[0].fillImage.keepAspectRatio).toBe(false);
    expect(w.shape('fill').fills[0].fillImage).toMatchObject({ keepAspectRatio: true });
    expect(w.shape('fill').fills[0].fillImage.transform).toBeUndefined();
  });
});

describe('dashes (E4)', () => {
  const line: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 }] };
  const dots = (weight: number, period: number): ir.Stroke => stroke({ weight, align: 'center', startCap: 'round', endCap: 'round', dashPattern: [0, period] });

  it.each([4, 10, 20])('writes round dots of weight %i as short dashes with the requested period', async (weight) => {
    const period = weight * 3;
    const node = (): ir.Node => pathNode('p', [line], { size: { width: 100, height: 0 }, stroke: dots(weight, period) });
    // SVG draws the round caps of an open path on each dash: a 1 px dash makes a round dot.
    const svg = (await write(doc([node()]))).shape('p').strokes[0];
    expect(svg).toMatchObject({ strokeStyle: 'dashed', strokeDash: 1, strokeGap: period - 1, strokeCapStart: 'round' });
    // WASM draws no caps on dashes: the dot becomes a square of the stroke width.
    const wasm = (await write(doc([node()]), { renderer: 'wasm' })).shape('p').strokes[0];
    expect(wasm).toMatchObject({ strokeStyle: 'dashed', strokeDash: weight, strokeGap: period - weight });
  });

  it('lengthens dashes by the caps a renderer will not draw, and merges touching dashes into a solid line', async () => {
    const capped = stroke({ weight: 4, align: 'center', startCap: 'round', endCap: 'round', dashPattern: [8, 12] });
    const nodes = (): ir.Node[] => [
      pathNode('open', [line], { size: { width: 100, height: 0 }, stroke: capped }),
      rect('closed', { stroke: capped }),
      rect('dense', { stroke: stroke({ weight: 4, startCap: 'round', endCap: 'round', dashPattern: [0, 3] }) }),
    ];
    const svg = await write(doc(nodes()));
    expect(svg.shape('open').strokes[0]).toMatchObject({ strokeDash: 8, strokeGap: 12 });
    expect(svg.shape('closed').strokes[0]).toMatchObject({ strokeDash: 12, strokeGap: 8 });
    expect(svg.shape('dense').strokes[0].strokeStyle).toBe('solid');
    const wasm = await write(doc(nodes()), { renderer: 'wasm' });
    expect(wasm.shape('open').strokes[0]).toMatchObject({ strokeDash: 12, strokeGap: 8 });
  });
});

describe('vector masks (E5)', () => {
  it('makes the mask shape of a vector mask opaque and leaves alpha masks alone', async () => {
    const translucent = (id: string): ir.Node =>
      rect(id, { fills: [gradient('linear', [V(0, 0.5), V(1, 0.5), V(0, 1)]), solid(0, 0, 0, 0.5)], opacity: 0.5, stroke: stroke({ paints: [solid(1, 0, 0, 0.3)] }) });
    const content = (id: string): ir.Node => rect(id, { fills: [solid(1, 0, 0)] });
    const w = await write(
      doc([
        group('gv', [translucent('mv'), content('cv')], { mask: { type: 'vector' } }),
        group('ga', [translucent('ma'), content('ca')], { mask: { type: 'alpha' } }),
      ]),
    );
    const mv = w.shape('mv');
    expect(mv.fills).toEqual([{ fillColor: '#000000', fillOpacity: 1 }]);
    expect(mv.strokes[0]).toMatchObject({ strokeColor: '#000000', strokeOpacity: 1 });
    expect(mv.opacity ?? 1).toBe(1);
    expect(w.shape('gv').maskedGroup).toBe(true);
    const ma = w.shape('ma');
    expect(ma.fills).toHaveLength(2);
    expect(ma.opacity).toBe(0.5);
  });
});

describe('stroke scale (E6)', () => {
  it('scales path strokes and dash patterns under a scaled parent like box shapes', async () => {
    // Inside-aligned on a closed path: Penpot's own dashes (Figma's per-edge layout is drawn only for centred / open paths).
    const dashed = stroke({ weight: 2, align: 'inside', dashPattern: [4, 2] });
    const scaled: ir.Matrix = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    const w = await write(
      doc([
        frame('f', [pathNode('p', [square(0, 0, 10, 10)], { size: { width: 10, height: 10 }, stroke: dashed }), rect('r', { stroke: dashed })], {
          transform: scaled,
        }),
      ]),
    );
    expect(w.shape('p').strokes[0]).toMatchObject({ strokeWidth: 4, strokeDash: 8, strokeGap: 4 });
    // A dashed rect draws Figma's dashes as geometry (baked, so ×2) with a solid stroke of the scaled width.
    expect(w.shape('r', 'stroke-dashes').strokes[0]).toMatchObject({ strokeWidth: 4, strokeStyle: 'solid' });
  });
});

describe('rect outlines (E7)', () => {
  it('keeps radii that the CSS sum rule allows (no per-corner half-side clamp)', () => {
    const cmds = rectCommands(100, 300, [90, 10, 0, 0]);
    expect(cmds[0]).toEqual({ type: 'M', x: 90, y: 0 });
    // Over-large radii are scaled together: 150+150 on a 100-wide side → ×1/3.
    expect(rectCommands(100, 300, [150, 150, 0, 0])[0]).toEqual({ type: 'M', x: 50, y: 0 });
  });
});

describe('unimportable numbers (E8)', () => {
  it('drops effects with non-finite numbers instead of writing null', async () => {
    const effects: ir.Effect[] = [
      { type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: Number.NaN, y: 0 }, blur: 4, spread: 0, blendMode: 'normal' },
      { type: 'layer-blur', visible: true, radius: Number.POSITIVE_INFINITY },
      { type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 1, y: 1 }, blur: 4, spread: 0, blendMode: 'normal' },
    ];
    const w = await write(doc([rect('r', { effects })]));
    expect(w.shape('r').shadow).toHaveLength(1);
    expect(w.shape('r').blur).toBeUndefined();
    expect(w.codes().filter((c) => c === 'invalid-effect')).toHaveLength(2);
    expect(JSON.stringify(w.shape('r').shadow)).not.toContain('null');
  });

  it('skips nodes beyond Penpot’s number range, with their content, and keeps the rest', async () => {
    const far = 3e9;
    const w = await write(
      doc([
        frame('far', [rect('inside')], { transform: translate(far, 0) }),
        rect('huge', { size: { width: far, height: 10 } }),
        pathNode('p', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: far, y: 0 }, { type: 'L', x: 0, y: 5 }, { type: 'Z' }] }]),
        rect('ok'),
      ]),
    );
    expect(['far', 'inside', 'huge', 'p'].filter((id) => w.has(id))).toEqual([]);
    expect(w.has('ok')).toBe(true);
    expect(w.warnings.filter((x) => x.code === 'geometry-out-of-range').map((x) => x.nodeId)).toEqual(['far', 'huge', 'p']);
  });
});

describe('shadows and blend isolation (E9)', () => {
  it('warns when a hidden-behind drop shadow sits under a translucent fill', async () => {
    const shadow = (showBehindNode: boolean): ir.Effect => ({
      type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 4, y: 4 }, blur: 0, spread: 0, blendMode: 'normal', showBehindNode,
    });
    const w = await write(
      doc([
        rect('glass', { fills: [solid(1, 1, 1, 0.2)], effects: [shadow(false)] }),
        rect('behind', { fills: [solid(1, 1, 1, 0.2)], effects: [shadow(true)] }),
        ellipse('opaque', { fills: [solid(1, 1, 1)], effects: [shadow(false)] }),
      ]),
    );
    expect(w.warnings.filter((x) => x.code === 'shadow-behind-translucent-fill').map((x) => x.nodeId)).toEqual(['glass']);
  });

  it('isolates "normal" containers whose content blends (opacity 0.999), not pass-through ones', async () => {
    const blending = (id: string): ir.Node => rect(id, { fills: [solid(1, 1, 0)], blendMode: 'multiply' });
    const w = await write(
      doc([
        group('normal', [blending('n1')], { blendMode: 'normal' }),
        group('pass', [blending('p1')], { blendMode: 'pass-through' }),
        frame('board', [group('inner', [blending('b1')], { blendMode: 'pass-through' })], { blendMode: 'normal' }),
        group('plain', [rect('x')], { blendMode: 'normal' }),
      ]),
    );
    expect(w.shape('normal').opacity).toBe(0.999);
    expect(w.shape('board').opacity).toBe(0.999);
    expect(w.shape('pass').opacity ?? 1).toBe(1);
    expect(w.shape('plain').opacity ?? 1).toBe(1);
    expect(w.codes()).toContain('blend-isolation-emulated');
  });
});
