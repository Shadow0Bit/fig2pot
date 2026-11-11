import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { doc, ellipse, frame, group, pathNode, rect, segments, solid, square, stroke, translate, write } from './helpers.ts';

const openLine: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 50, y: 0 }] };

describe('strokes', () => {
  it('maps weight, alignment and colour, one Penpot stroke per paint, top first', async () => {
    const s = stroke({ weight: 3, align: 'outside', paints: [solid(1, 0, 0), solid(0, 0, 1, 1, { opacity: 0.5 }), solid(0, 1, 0, 1, { visible: false })] });
    const w = await write(doc([rect('r', { stroke: s }), ellipse('e', { stroke: stroke({ align: 'center' }) })]));
    expect(w.shape('r').strokes).toEqual([
      { strokeWidth: 3, strokeAlignment: 'outer', strokeStyle: 'solid', strokeColor: '#0000ff', strokeOpacity: 0.5 },
      { strokeWidth: 3, strokeAlignment: 'outer', strokeStyle: 'solid', strokeColor: '#ff0000', strokeOpacity: 1 },
    ]);
    expect(w.shape('e').strokes[0].strokeAlignment).toBe('center');
  });

  it('centres strokes of open paths and keeps their caps', async () => {
    const w = await write(doc([pathNode('l', [openLine], { stroke: stroke({ align: 'inside', startCap: 'round', endCap: 'triangle-arrow' }) })]));
    const st = w.shape('l').strokes[0];
    expect(st).toMatchObject({ strokeAlignment: 'center', strokeCapStart: 'round', strokeCapEnd: 'triangle-arrow' });
  });

  it('maps marker caps', async () => {
    const w = await write(doc([pathNode('l', [openLine], { stroke: stroke({ align: 'center', startCap: 'circle', endCap: 'diamond' }) })]));
    expect(w.shape('l').strokes[0]).toMatchObject({ strokeCapStart: 'circle-marker', strokeCapEnd: 'diamond-marker' });
  });

  it('maps dash patterns to dashed strokes (dots become short dashes)', async () => {
    const w = await write(
      doc([
        // Closed inside-aligned paths and dots keep Penpot's dashes (box shapes draw Figma's: dashes.test.ts).
        pathNode('dash', [square(0, 0, 10, 10)], { stroke: stroke({ dashPattern: [4, 2] }) }),
        rect('dots', { stroke: stroke({ dashPattern: [0, 3] }) }),
        pathNode('mixed', [square(0, 0, 10, 10)], { stroke: stroke({ dashPattern: [4, 2, 1, 2] }) }),
      ]),
    );
    expect(w.shape('dash').strokes[0]).toMatchObject({ strokeStyle: 'dashed', strokeDash: 4, strokeGap: 2 });
    // Penpot's `dotted` ignores the gap: a short dash keeps the period (0 + 3).
    expect(w.shape('dots').strokes[0]).toMatchObject({ strokeStyle: 'dashed', strokeDash: 1, strokeGap: 2 });
    expect(w.warnings.find((x) => x.code === 'stroke-dash-approximated')?.nodeId).toBe('mixed');
  });

  it('supports gradient strokes and reports joins Penpot cannot draw', async () => {
    const g: ir.GradientPaint = {
      type: 'gradient',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      gradientType: 'linear',
      handles: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }],
      stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }],
    };
    const w = await write(doc([rect('r', { stroke: stroke({ paints: [g], join: 'round' }) })]));
    const st = w.shape('r').strokes[0];
    expect(st.strokeColorGradient).toMatchObject({ type: 'linear', startX: 0, endX: 1 });
    expect(st.strokeColor).toBeUndefined();
    expect(w.codes()).toContain('stroke-join-unsupported');
  });

  it('reports a join only where it shows: a real corner, once per node', async () => {
    const round = stroke({ weight: 2, join: 'round' });
    const zigzag: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 10 }, { type: 'L', x: 20, y: 0 }] };
    const bend: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'L', x: 20, y: 0.2 }] };
    const curve: ir.Path = { windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'C', x1: 15, y1: 0, x2: 20, y2: 5, x: 20, y: 10 }] };
    const w = await write(
      doc([
        rect('sharp', { stroke: round, fills: [solid(1, 0, 0)], effects: [] }),
        rect('rounded', { stroke: round, cornerRadii: [4, 4, 4, 4] }),
        ellipse('oval', { stroke: round }),
        pathNode('line', [{ windingRule: 'nonzero', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 50, y: 0 }] }], { stroke: round }),
        pathNode('bend', [bend], { stroke: round }),
        pathNode('curve', [curve], { stroke: round }),
        pathNode('zigzag', [zigzag], { stroke: round }),
        pathNode('bevel', [zigzag], { stroke: stroke({ weight: 2, join: 'bevel' }) }),
        pathNode('miter', [zigzag], { stroke: stroke({ weight: 2, join: 'miter' }) }),
        frame('board', [], { stroke: round, cornerRadii: [0, 4, 4, 4] }),
      ]),
    );
    expect(w.warnings.filter((x) => x.code === 'stroke-join-unsupported').map((x) => x.nodeId)).toEqual(['sharp', 'zigzag', 'bevel', 'board']);
  });

  it('uses a uniform stroke when every side has the same non-zero width', async () => {
    const w = await write(doc([rect('r', { stroke: stroke({ weight: 1, perSide: { top: 2, right: 2, bottom: 2, left: 2 } }) })]));
    expect(w.shape('r').type).toBe('rect');
    expect(w.shape('r').strokes[0].strokeWidth).toBe(2);
  });

  it('draws differing per-side widths of a rect as an even-odd filled outline next to it', async () => {
    const s = stroke({ align: 'inside', perSide: { top: 4, right: 0, bottom: 2, left: 0 }, paints: [solid(1, 0, 0)] });
    const w = await write(doc([rect('r', { size: { width: 100, height: 50 }, transform: translate(10, 10), stroke: s, fills: [solid(0, 0, 1)] })]));
    const g = w.shape('r');
    expect(g.type).toBe('group');
    const [shape, sides] = w.children(g);
    expect(shape).toMatchObject({ type: 'rect', strokes: [], fills: [{ fillColor: '#0000ff', fillOpacity: 1 }] });
    expect(sides).toMatchObject({ type: 'path', strokes: [], fills: [{ fillColor: '#ff0000', fillOpacity: 1 }], svgAttrs: { fillRule: 'evenodd' } });
    expect(segments(sides!)).toEqual([
      ['M', 10, 10], ['L', 110, 10], ['L', 110, 60], ['L', 10, 60], ['Z'],
      ['M', 10, 14], ['L', 110, 14], ['L', 110, 58], ['L', 10, 58], ['Z'],
    ]);
    expect(w.codes()).toContain('per-side-stroke-emulated');
  });

  it('adds the per-side outline of a non-clipping board as its bottom child (Figma), outside the layout flow', async () => {
    const s = stroke({ align: 'outside', perSide: { top: 0, right: 0, bottom: 1, left: 0 } });
    const layout: ir.AutoLayout = {
      direction: 'vertical', wrap: false, itemSpacing: 0, counterSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 },
      primaryAlign: 'start', counterAlign: 'start', counterAlignContent: 'auto', reverseZIndex: false, strokesIncludedInLayout: false,
    };
    const w = await write(doc([frame('f', [rect('c')], { stroke: s, layout, clipsContent: false })]));
    const kids = w.children(w.shape('f'));
    expect(kids.map((k) => k.type)).toEqual(['path', 'rect']);
    expect(kids[0]).toMatchObject({ layoutItemAbsolute: true, constraintsH: 'leftright', constraintsV: 'topbottom' });
    expect(w.shape('f').strokes).toEqual([]);
    expect(segments(kids[0]!)).toEqual([['M', 0, 0], ['L', 100, 0], ['L', 100, 101], ['L', 0, 101], ['Z'], ['M', 0, 0], ['L', 100, 0], ['L', 100, 100], ['L', 0, 100], ['Z']]);
  });
});

describe('effects and layer attributes', () => {
  it('maps shadows (top first), layer blur and background blur', async () => {
    const effects: ir.Effect[] = [
      { type: 'drop-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 1, y: 2 }, blur: 4, spread: 1, blendMode: 'normal' },
      { type: 'inner-shadow', visible: false, color: { r: 1, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 0 }, blur: 2, spread: 0, blendMode: 'normal' },
      { type: 'layer-blur', visible: true, radius: 3 },
      { type: 'background-blur', visible: true, radius: 8 },
    ];
    const w = await write(doc([rect('r', { effects })]));
    const s = w.shape('r');
    expect(s.shadow.map((x: { style: string }) => x.style)).toEqual(['inner-shadow', 'drop-shadow']);
    expect(s.shadow[1]).toMatchObject({ offsetX: 1, offsetY: 2, blur: 4, spread: 1, hidden: false, color: { color: '#000000', opacity: 0.25 } });
    expect(s.shadow[0].hidden).toBe(true);
    // Figma's σ is radius / 2, which is the SVG renderer's blur value.
    expect(s.blur).toMatchObject({ type: 'layer-blur', value: 1.5, hidden: false });
    expect(s.backgroundBlur).toMatchObject({ type: 'background-blur', value: 4, hidden: false });
    expect(w.codes()).toContain('background-blur-unsupported');
  });

  it('warns about extra blurs and shadow blend modes', async () => {
    const effects: ir.Effect[] = [
      { type: 'layer-blur', visible: false, radius: 1 },
      { type: 'layer-blur', visible: true, radius: 5 },
      { type: 'drop-shadow', visible: true, color: { r: 1, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 0 }, blur: 0, spread: 0, blendMode: 'multiply' },
    ];
    const w = await write(doc([rect('r', { effects })]));
    expect(w.shape('r').blur.value).toBe(2.5);
    expect(w.codes()).toEqual(expect.arrayContaining(['multiple-blurs', 'shadow-blend-mode-unsupported']));
  });

  it('writes a grey multiply shadow over opaque content as the equivalent black one (d · (1 − a + a·g) = black at a·(1 − g))', async () => {
    const grey = 0.675;
    const effects: ir.Effect[] = [{ type: 'drop-shadow', visible: true, color: { r: grey, g: grey, b: grey, a: 0.5 }, offset: { x: 0, y: 4 }, blur: 0, spread: 0, blendMode: 'multiply' }];
    const w = await write(doc([frame('bg', [rect('r', { effects })], { fills: [solid(1, 1, 1)] }), frame('clear', [rect('t', { effects })])]));
    expect(w.shape('r').shadow[0].color).toEqual({ color: '#000000', opacity: 0.1625 });
    // Over transparency multiply draws the colour itself.
    expect(w.shape('t').shadow[0].color).toEqual({ color: '#acacac', opacity: 0.5 });
    expect(w.warnings.filter((x) => x.code === 'shadow-blend-mode-unsupported').map((x) => x.nodeId)).toEqual(['t']);
  });

  it('K5: converts the multiply shadow only where Figma composes it over the opaque frame', async () => {
    const grey = 0.675;
    const effects: ir.Effect[] = [{ type: 'drop-shadow', visible: true, color: { r: grey, g: grey, b: grey, a: 0.5 }, offset: { x: 0, y: 4 }, blur: 4, spread: 0, blendMode: 'multiply' }];
    const small = { size: { width: 20, height: 20 }, effects };
    const w = await write(
      doc([
        frame(
          'bg',
          [
            rect('plain', { ...small, transform: translate(10, 10) }),
            group('pass', [rect('inPass', { ...small, transform: translate(40, 10) })], { size: { width: 20, height: 20 } }),
            group('faded', [rect('inFaded', { ...small, transform: translate(70, 10) })], { size: { width: 20, height: 20 }, opacity: 0.5 }),
            group('normal', [rect('inNormal', { ...small, transform: translate(100, 10) })], { size: { width: 20, height: 20 }, blendMode: 'normal' }),
            group('masked', [rect('m', { size: { width: 30, height: 30 }, transform: translate(130, 10) }), rect('inMask', { ...small, transform: translate(130, 10) })], { size: { width: 30, height: 30 }, mask: { type: 'alpha' } }),
            // At the bottom edge: the shadow (4 px down, 4 px blur) spills past the frame.
            rect('edge', { ...small, transform: translate(10, 80) }),
          ],
          { size: { width: 200, height: 100 }, fills: [solid(1, 1, 1)], clipsContent: false },
        ),
        frame('clipped', [rect('edge2', { ...small, transform: translate(10, 80) })], { transform: translate(0, 200), size: { width: 200, height: 100 }, fills: [solid(1, 1, 1)], clipsContent: true }),
      ]),
    );
    const black = { color: '#000000', opacity: 0.1625 };
    const kept = { color: '#acacac', opacity: 0.5 };
    expect(w.shape('plain').shadow[0].color).toEqual(black);
    expect(w.shape('inPass').shadow[0].color).toEqual(black);
    expect(w.shape('inFaded').shadow[0].color).toEqual(kept);
    expect(w.shape('inNormal').shadow[0].color).toEqual(kept);
    expect(w.shape('inMask').shadow[0].color).toEqual(kept);
    expect(w.shape('edge').shadow[0].color).toEqual(kept);
    // A clipping frame cuts the spill: converted.
    expect(w.shape('edge2').shadow[0].color).toEqual(black);
  });

  it('maps opacity, blend mode, visibility, lock and constraints', async () => {
    const w = await write(
      doc([
        rect('a', { opacity: 0.5, blendMode: 'multiply', visible: false, locked: true, constraints: { horizontal: 'left-right', vertical: 'top-bottom' } }),
        rect('b', { blendMode: 'pass-through', constraints: { horizontal: 'scale', vertical: 'center' } }),
        rect('c', { blendMode: 'linear-burn' }),
      ]),
    );
    expect(w.shape('a')).toMatchObject({ opacity: 0.5, blendMode: 'multiply', hidden: true, blocked: true, constraintsH: 'leftright', constraintsV: 'topbottom' });
    expect(w.shape('b').blendMode).toBeUndefined();
    expect(w.shape('b')).toMatchObject({ constraintsH: 'scale', constraintsV: 'center' });
    expect(w.shape('c').blendMode).toBe('darken');
    expect(w.codes()).toContain('blend-mode-approximated');
  });
});

describe('auto layout', () => {
  const layout = (extra: Partial<ir.AutoLayout> = {}): ir.AutoLayout => ({
    direction: 'horizontal',
    wrap: false,
    itemSpacing: 8,
    counterSpacing: 4,
    padding: { top: 1, right: 2, bottom: 3, left: 4 },
    primaryAlign: 'center',
    counterAlign: 'end',
    counterAlignContent: 'auto',
    reverseZIndex: false,
    strokesIncludedInLayout: false,
    ...extra,
  });

  it('maps a horizontal flex layout, keeping the IR child order with a reversed direction', async () => {
    const w = await write(doc([frame('f', [rect('a'), rect('b')], { layout: layout(), sizing: { horizontal: 'hug', vertical: 'fixed' } })]));
    const f = w.shape('f');
    expect(f).toMatchObject({
      layout: 'flex',
      layoutFlexDir: 'row-reverse',
      layoutGap: { rowGap: 0, columnGap: 8 },
      layoutGapType: 'multiple',
      layoutWrapType: 'nowrap',
      layoutPadding: { p1: 1, p2: 2, p3: 3, p4: 4 },
      layoutPaddingType: 'multiple',
      layoutJustifyContent: 'center',
      layoutAlignItems: 'end',
      layoutItemHSizing: 'auto',
      layoutItemVSizing: 'fix',
    });
    expect(w.children(f).map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('maps vertical wrap-free layouts, space-between and wrapping gaps', async () => {
    const w = await write(
      doc([
        frame('v', [], { layout: layout({ direction: 'vertical', primaryAlign: 'space-between' }) }),
        frame('h', [], { layout: layout({ wrap: true, counterAlignContent: 'space-between' }) }),
        frame('w', [], { layout: layout({ wrap: true }) }),
      ]),
    );
    expect(w.shape('v')).toMatchObject({ layoutFlexDir: 'column-reverse', layoutGap: { rowGap: 0, columnGap: 0 }, layoutJustifyContent: 'space-between' });
    expect(w.shape('h')).toMatchObject({ layoutWrapType: 'wrap', layoutGap: { rowGap: 0, columnGap: 8 }, layoutAlignContent: 'space-between' });
    expect(w.shape('w').layoutGap).toEqual({ rowGap: 4, columnGap: 8 });
  });

  it('maps child sizing, absolute positioning, align-self, min/max and "first on top" stacking', async () => {
    const children: ir.Node[] = [
      rect('fill', { sizing: { horizontal: 'fill', vertical: 'fixed' }, layoutChild: { positioning: 'auto', alignSelf: 'stretch', minWidth: 10, maxWidth: 90 } }),
      rect('abs', { layoutChild: { positioning: 'absolute' } }),
      rect('last', { layoutChild: { positioning: 'auto' } }),
    ];
    const w = await write(doc([frame('f', children, { layout: layout({ reverseZIndex: true }) }), rect('free', { sizing: { horizontal: 'fill', vertical: 'fill' } })]));
    expect(w.shape('fill')).toMatchObject({ layoutItemHSizing: 'fill', layoutItemVSizing: 'fix', layoutItemAlignSelf: 'stretch', layoutItemMinW: 10, layoutItemMaxW: 90, layoutItemZIndex: 2 });
    expect(w.shape('abs').layoutItemAbsolute).toBe(true);
    expect(w.shape('abs').layoutItemZIndex).toBeUndefined();
    expect(w.shape('last').layoutItemZIndex).toBe(0);
    expect(w.shape('free').layoutItemHSizing).toBeUndefined();
  });

  it('nudges paddings that add up to the board size', async () => {
    const w = await write(doc([frame('f', [], { size: { width: 10, height: 10 }, layout: layout({ padding: { top: 5, right: 0, bottom: 5, left: 0 } }) })]));
    expect(w.shape('f').layoutPadding.p1).toBeCloseTo(4.9999, 6);
  });

  it('leaves positions untouched (they are already resolved in the IR)', async () => {
    const w = await write(doc([frame('f', [rect('a', { transform: translate(37, 3), size: { width: 5, height: 5 } })], { layout: layout() })]));
    expect(w.shape('a')).toMatchObject({ x: 37, y: 3, width: 5, height: 5 });
  });
});

describe('paths geometry', () => {
  it('fills a path and strokes it with the same geometry', async () => {
    const w = await write(doc([pathNode('p', [square(0, 0, 10, 10)], { fills: [solid(1, 0, 0)], stroke: stroke() })]));
    expect(w.shape('p').strokes[0].strokeAlignment).toBe('inner');
  });
});

describe('opaque aligned strokes on filled boxes (SVG renderer, pixelExact)', () => {
  const px = { pixelExact: true } as const;
  const green = solid(0, 1, 0);
  const box = (id: string, align: ir.Stroke['align'], extra: Partial<ir.RectNode> = {}): ir.RectNode =>
    rect(id, { transform: translate(10.33, 10.33), size: { width: 60, height: 40 }, fills: [green], cornerRadii: [8, 8, 8, 8], stroke: stroke({ weight: 3, align }), ...extra });

  it('draws an inside stroke centred on the box inset by half its width, an outside one on the box outset by it', async () => {
    const w = await write(doc([box('in', 'inside'), box('out', 'outside')]), px);
    expect(w.shape('in')).toMatchObject({ x: 11.83, y: 11.83, width: 57, height: 37, r1: 6.5, strokes: [{ strokeAlignment: 'center', strokeWidth: 3 }], fills: [{ fillColor: '#00ff00' }] });
    expect(w.shape('out')).toMatchObject({ x: 8.83, y: 8.83, width: 63, height: 43, r1: 9.5, strokes: [{ strokeAlignment: 'center', strokeWidth: 3 }] });
    expect(w.warnings.filter((x) => x.code === 'pixel-exact-stroke-inset').map((x) => x.nodeId)).toEqual(['in', 'out']);
  });

  it('keeps the true box, fill and aligned stroke by default', async () => {
    const card = frame('card', [], { size: { width: 100, height: 60 }, fills: [green], cornerRadii: [12, 12, 12, 12], stroke: stroke({ weight: 3, align: 'inside' }) });
    const w = await write(doc([frame('page', [box('in', 'inside'), box('out', 'outside'), ellipse('c', { size: { width: 40, height: 40 }, fills: [green], stroke: stroke({ weight: 4, align: 'inside' }) }), card], { size: { width: 300, height: 300 } })]));
    expect(w.shape('in')).toMatchObject({ x: 10.33, y: 10.33, width: 60, height: 40, r1: 8, strokes: [{ strokeAlignment: 'inner', strokeWidth: 3 }] });
    expect(w.shape('out')).toMatchObject({ x: 10.33, width: 60, strokes: [{ strokeAlignment: 'outer' }] });
    expect(w.shape('c')).toMatchObject({ x: 0, width: 40, strokes: [{ strokeAlignment: 'inner' }] });
    expect(w.shape('card')).toMatchObject({ fills: [{ fillColor: '#00ff00' }], strokes: [{ strokeAlignment: 'inner' }] });
    expect(w.children(w.shape('card'))).toEqual([]);
    expect(w.codes()).not.toContain('pixel-exact-stroke-inset');
  });

  it("draws a board's fill and inside stroke by an inset first child when no child reaches the stroke", async () => {
    const card = (id: string, kids: ir.Node[]): ir.FrameNode =>
      frame(id, kids, { transform: translate(0.5, 0.25), size: { width: 100, height: 60 }, fills: [green], cornerRadii: [12, 12, 12, 12], stroke: stroke({ weight: 3, align: 'inside' }) });
    const w = await write(doc([frame('page', [card('free', [rect('in', { transform: translate(10, 10), size: { width: 20, height: 20 } })]), card('met', [rect('edge', { size: { width: 20, height: 20 } })])], { size: { width: 300, height: 300 } })]), px);
    const free = w.shape('free');
    expect(free).toMatchObject({ fills: [], strokes: [], r1: 12 });
    const [band, inner] = w.children(free);
    expect(band).toMatchObject({ type: 'rect', name: 'Fill and stroke', x: 2, y: 1.75, width: 97, height: 57, r1: 10.5, fills: [{ fillColor: '#00ff00' }], strokes: [{ strokeAlignment: 'center', strokeWidth: 3 }] });
    expect(inner!.id).toBe(w.shape('in').id);
    // A child in the stroke band: Figma paints the stroke above it, the board keeps it.
    expect(w.shape('met')).toMatchObject({ fills: [{ fillColor: '#00ff00' }], strokes: [{ strokeAlignment: 'inner' }] });
  });

  it('does the same for circles, not for ellipses', async () => {
    const w = await write(
      doc([
        ellipse('c', { size: { width: 40, height: 40 }, fills: [green], stroke: stroke({ weight: 4, align: 'inside' }) }),
        ellipse('e', { size: { width: 40, height: 20 }, fills: [green], stroke: stroke({ weight: 4, align: 'inside' }) }),
      ]),
      px,
    );
    expect(w.shape('c')).toMatchObject({ x: 2, y: 2, width: 36, height: 36, strokes: [{ strokeAlignment: 'center' }] });
    expect(w.shape('e')).toMatchObject({ x: 0, width: 40, strokes: [{ strokeAlignment: 'inner' }] });
  });

  it('keeps the aligned stroke where the band would not look the same, and for the WASM renderer', async () => {
    const translucent = stroke({ weight: 3, align: 'inside', paints: [solid(0, 0, 0, 0.5)] });
    const layout: ir.AutoLayout = { direction: 'horizontal', wrap: false, itemSpacing: 0, counterSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'start', counterAlign: 'start', counterAlignContent: 'auto', reverseZIndex: false, strokesIncludedInLayout: false };
    const w = await write(
      doc([
        box('translucent', 'inside', { stroke: translucent }),
        box('nofill', 'inside', { fills: [] }),
        box('small-radius', 'inside', { cornerRadii: [1, 1, 1, 1] }),
        box('inner-shadow', 'inside', { effects: [{ type: 'inner-shadow', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 1 }, blur: 2, spread: 0, blendMode: 'normal' }] }),
        frame('flex', [box('flowing', 'inside'), box('flowing-out', 'outside')], { layout }),
      ]),
      px,
    );
    for (const id of ['translucent', 'nofill', 'small-radius', 'inner-shadow']) expect(w.shape(id).strokes[0].strokeAlignment).toBe('inner');
    // In an auto layout flow: margins of the inset keep the box's place; an outset would need negative ones.
    expect(w.shape('flowing')).toMatchObject({ width: 57, layoutItemMargin: { m1: 1.5, m2: 1.5, m3: 1.5, m4: 1.5 }, layoutItemMarginType: 'multiple', strokes: [{ strokeAlignment: 'center' }] });
    expect(w.shape('flowing-out').strokes[0].strokeAlignment).toBe('outer');
    const wasm = await write(doc([box('in', 'inside')]), { renderer: 'wasm', pixelExact: true });
    expect(wasm.shape('in')).toMatchObject({ width: 60, strokes: [{ strokeAlignment: 'inner' }] });
  });
});
