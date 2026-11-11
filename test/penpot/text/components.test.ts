import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { figToIR } from '../../../src/index.ts';
import type * as ir from '../../../src/ir.ts';
import { penpotId } from '../../../src/penpot/ids.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { componentProblems, copyShapesWithoutRef, doc, frame, text, textStyle, write } from '../helpers.ts';

const line = (y: number, width: number): ir.TextLine => ({ start: 0, end: 5, baseline: { x: 0, y }, width, lineHeight: 24, ascent: 17.8 });

describe('text copies of a component main', () => {
  it('are not geometry-touched when only their grown / shifted Penpot box differs from the main', async () => {
    // Same source box; the copy's layout reports a slightly wider line (as Figma's per-instance layout does), so its
    // Penpot box grows differently, and it sits at a fractional page y, so its baseline shift differs too.
    const main = frame('10:1', [text('10:2', 'Hello', { size: { width: 50, height: 24 }, layout: { lines: [line(17.8, 48)] } })], {
      componentId: 'C1',
      role: 'component',
      name: 'Label',
    });
    const copy = frame(
      'I2',
      [text('I2;10:2', 'Hello', { componentRef: '10:2', name: '10:2', size: { width: 50, height: 24 }, layout: { lines: [line(17.9, 53.4)] } })],
      { instanceOf: 'C1', role: 'instance', name: 'Label', transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 0.37 } },
    );
    const w = await write(doc([main, copy], { components: { C1: { id: 'C1', name: 'Label', remote: false } } }));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('I2;10:2').width).not.toBe(w.shape('10:2').width);
    expect(w.shape('I2;10:2').touched ?? []).not.toContain('geometry-group');
  });

  it('are geometry-touched when the source boxes differ', async () => {
    const main = frame('10:1', [text('10:2', 'Hello', { size: { width: 50, height: 24 } })], { componentId: 'C1', role: 'component', name: 'Label' });
    const copy = frame('I2', [text('I2;10:2', 'Hello', { componentRef: '10:2', name: '10:2', size: { width: 80, height: 24 } })], {
      instanceOf: 'C1',
      role: 'instance',
      name: 'Label',
      transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 0 },
    });
    const w = await write(doc([main, copy], { components: { C1: { id: 'C1', name: 'Label', remote: false } } }));
    expect(w.shape('I2;10:2').touched).toContain('geometry-group');
  });
});

describe('auto text mode per component class (K4)', () => {
  const underline = (t: ir.TextNode): ir.TextNode => ({ ...t, runs: t.runs.map((r) => ({ ...r, style: { ...r.style, textDecoration: 'underline' as const } })) });
  const outline = (y: number) => ({ path: { windingRule: 'nonzero' as const, commands: [{ type: 'M' as const, x: 0, y }, { type: 'L' as const, x: 10, y }, { type: 'L' as const, x: 10, y: y + 10 }, { type: 'Z' as const }] }, runIndex: 0 });
  const label = (id: string, characters: string, extra: Partial<ir.TextNode> = {}): ir.TextNode =>
    text(id, characters, { size: { width: 80, height: 24 }, layout: { outlines: [outline(4)] }, runs: [{ start: 0, end: characters.length, style: textStyle() }], ...extra });
  const setup = (mainText: ir.TextNode, copyText: ir.TextNode) => {
    const main = frame('10:1', [mainText], { componentId: 'C1', role: 'component', name: 'Label' });
    const copy = frame('I2', [copyText], { instanceOf: 'C1', role: 'instance', name: 'Label', transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 0 } });
    return doc([main, copy], { components: { C1: { id: 'C1', name: 'Label', remote: false } } });
  };

  it('outlines main and copies together when one of them must be outlined (a character the font lacks)', async () => {
    const w = await write(setup(label('10:2', 'Shift'), label('I2;10:2', '⇧', { componentRef: '10:2', name: '10:2' })));
    expect(componentProblems(w)).toEqual([]);
    expect(copyShapesWithoutRef(w)).toEqual([]);
    expect(w.shape('10:2').type).toBe('group');
    expect(w.shape('I2;10:2').type).toBe('group');
    expect(w.shape('I2;10:2', 'glyphs0-0').shapeRef).toBe(w.shape('10:2', 'glyphs0-0').id);
    expect(w.codes()).toContain('text-outlined-component');
    expect(w.codes()).toContain('text-outlined-fallback-glyphs');
  });

  it('keeps main and copies editable when a copy is only underlined', async () => {
    const w = await write(setup(label('10:2', 'Description'), underline(label('I2;10:2', 'Read our T&Cs', { componentRef: '10:2', name: '10:2' }))));
    expect(copyShapesWithoutRef(w)).toEqual([]);
    expect(w.shape('10:2').type).toBe('text');
    expect(w.shape('I2;10:2').type).toBe('text');
    expect(w.codes()).toContain('text-kept-editable-component');
  });

  it('gives outlined members parallel shapes when their run counts differ (one path per fill list)', async () => {
    const two = label('I2;10:2', '⇧ab', { componentRef: '10:2', name: '10:2', layout: { outlines: [outline(4), { ...outline(8), runIndex: 1 }] } });
    two.runs = [
      { start: 0, end: 1, style: textStyle() },
      { start: 1, end: 3, style: textStyle({ fontWeight: 700, fontStyle: 'Bold' }) },
    ];
    const w = await write(setup(label('10:2', 'Shift'), two));
    expect(copyShapesWithoutRef(w)).toEqual([]);
    expect(w.children(w.shape('I2;10:2'))).toHaveLength(1);
  });

  const FIXTURES = ['../../fixtures/grida-components.fig', '../../fixtures/radix-icons.fig', '../../fixtures-large/auto-layout-playground.fig', '../../fixtures-large/simple-design-system.fig'];
  for (const fixture of FIXTURES) {
    const url = new URL(fixture, import.meta.url);
    for (const renderer of ['svg', 'wasm'] as const) {
      it.skipIf(!existsSync(url))(`${fixture.split('/').pop()} (${renderer}): no copy shape of a text lacks its shapeRef`, async () => {
        const document = figToIR(new Uint8Array(readFileSync(url)), new CollectingReporter());
        const w = await write(document, { renderer });
        const textIds = new Set<string>();
        const visit = (n: ir.Node): void => {
          if (n.type === 'text') {
            textIds.add(penpotId(n.id));
            for (let i = 0; i < Math.max(1, n.layout?.outlines?.length ?? 0); i++) textIds.add(penpotId(`${n.id}/glyphs${i}-${i}`));
          }
          if ('children' in n) n.children.forEach(visit);
        };
        document.pages.forEach((p) => p.children.forEach(visit));
        expect(copyShapesWithoutRef(w).filter((s) => textIds.has(s.id) || textIds.has(s.parentId)).map((s) => s.name)).toEqual([]);
      }, 300_000);
    }
  }
});
