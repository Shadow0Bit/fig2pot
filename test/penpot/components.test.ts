import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { penpotId } from '../../src/penpot/ids.ts';
import { componentProblems, frame, rect, solid, translate, write, type Json } from './helpers.ts';

const def = (id: string, name: string, extra: Partial<ir.ComponentDef> = {}): ir.ComponentDef => ({ id, name, remote: false, ...extra });

function twoPages(page1: ir.Node[], page2: ir.Node[], components: Record<string, ir.ComponentDef>): ir.Document {
  return {
    name: 'Components',
    pages: [
      { id: '0:1', name: 'Screens', kind: 'page', children: page1 },
      { id: '0:2', name: 'Library', kind: 'page', children: page2 },
    ],
    components,
    images: {},
    styles: { colors: [], typographies: [] },
  };
}

const buttonMain = (): ir.FrameNode => frame('10:1', [rect('10:2', { fills: [solid(1, 0, 0)] })], { componentId: 'C1', role: 'component', name: 'Primary' });
const buttonCopy = (id: string, fill = solid(1, 0, 0), extra: Partial<ir.FrameNode> = {}): ir.FrameNode =>
  frame(id, [rect(`${id};10:2`, { componentRef: '10:2', name: '10:2', fills: [fill] })], { instanceOf: 'C1', role: 'instance', name: 'Primary', ...extra });

const cardMain = (): ir.FrameNode =>
  frame('30:1', [buttonCopy('I30:2', solid(1, 0, 0), { transform: translate(5, 5) }), rect('30:3')], { componentId: 'C2', role: 'component', name: 'Card' });

const cid = (id: string): string => penpotId(id, 'component');

describe('components', () => {
  it('registers mains that come after their copies, on another page', async () => {
    const w = await write(twoPages([buttonCopy('I20:1', solid(0, 0, 1))], [buttonMain()], { C1: def('C1', 'Buttons/Primary') }));
    expect(componentProblems(w)).toEqual([]);
    const fileId = w.manifest.files[0].id;
    expect(w.components).toHaveLength(1);
    expect(w.components[0]).toMatchObject({
      id: cid('C1'),
      name: 'Primary',
      path: 'Buttons',
      mainInstanceId: penpotId('10:1'),
      mainInstancePage: penpotId('0:2', 'page'),
    });
    expect(w.shape('10:1')).toMatchObject({ name: 'Buttons / Primary', componentId: cid('C1'), componentFile: fileId, componentRoot: true, mainInstance: true });
    expect(w.shape('10:1').shapeRef).toBeUndefined();
    expect(w.shape('10:2').shapeRef).toBeUndefined();

    const copy = w.shape('I20:1');
    expect(copy).toMatchObject({ componentId: cid('C1'), componentFile: fileId, componentRoot: true, shapeRef: penpotId('10:1') });
    expect(copy.mainInstance).toBeUndefined();
    const child = w.shape('I20:1;10:2');
    expect(child.shapeRef).toBe(penpotId('10:2'));
    expect(child.componentId).toBeUndefined();
    // The copy overrides the fill.
    expect(child.touched).toEqual(['fill-group']);
  });

  it('does not mark copies identical to their main as touched', async () => {
    const w = await write(twoPages([buttonMain(), buttonCopy('I20:1')], [], { C1: def('C1', 'Primary') }));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('I20:1;10:2').touched).toBeUndefined();
  });

  it('links nested copies to the nested copy inside the enclosing main', async () => {
    const outerCopy = frame(
      'I40:1',
      [
        frame('I40:1;30:2', [rect('I40:1;30:2;10:2', { componentRef: '10:2', fills: [solid(1, 0, 0)] })], { instanceOf: 'C1', role: 'instance', name: 'Primary', transform: translate(5, 5) }),
        rect('I40:1;30:3', { componentRef: '30:3' }),
      ],
      { instanceOf: 'C2', role: 'instance', name: 'Card' },
    );
    const w = await write(twoPages([outerCopy], [buttonMain(), cardMain()], { C1: def('C1', 'Primary'), C2: def('C2', 'Card') }));
    expect(componentProblems(w)).toEqual([]);

    // Inside the main: a nested copy (not a component root) of C1.
    const nestedInMain = w.shape('I30:2');
    expect(nestedInMain).toMatchObject({ componentId: cid('C1'), shapeRef: penpotId('10:1') });
    expect(nestedInMain.componentRoot).toBeUndefined();
    expect(nestedInMain.mainInstance).toBeUndefined();
    expect(w.shape('I30:2;10:2').shapeRef).toBe(penpotId('10:2'));

    // In the copy of the outer component.
    expect(w.shape('I40:1')).toMatchObject({ componentId: cid('C2'), componentRoot: true, shapeRef: penpotId('30:1') });
    const nested = w.shape('I40:1;30:2');
    expect(nested).toMatchObject({ componentId: cid('C1'), shapeRef: penpotId('I30:2') });
    expect(nested.componentRoot).toBeUndefined();
    expect(w.shape('I40:1;30:2;10:2').shapeRef).toBe(penpotId('I30:2;10:2'));
    expect(w.shape('I40:1;30:3').shapeRef).toBe(penpotId('30:3'));
  });

  it('records swapped nested copies with a swap slot', async () => {
    const iconMain = frame('50:1', [rect('50:2')], { componentId: 'C3', role: 'component', name: 'Icon' });
    const swappedCopy = frame(
      'I60:1',
      [frame('I60:1;30:2', [rect('I60:1;30:2;50:2', { componentRef: '50:2' })], { instanceOf: 'C3', role: 'instance', name: 'Icon' }), rect('I60:1;30:3', { componentRef: '30:3' })],
      { instanceOf: 'C2', role: 'instance', name: 'Card' },
    );
    const w = await write(
      twoPages([buttonMain(), cardMain(), iconMain, swappedCopy], [], { C1: def('C1', 'Primary'), C2: def('C2', 'Card'), C3: def('C3', 'Icon') }),
    );
    expect(componentProblems(w)).toEqual([]);
    const head = w.shape('I60:1;30:2');
    expect(head).toMatchObject({ componentId: cid('C3'), shapeRef: penpotId('50:1') });
    expect(head.touched).toContain(`swap-slot-${penpotId('I30:2')}`);
    expect(w.shape('I60:1;30:2;50:2').shapeRef).toBe(penpotId('50:2'));
  });

  it('turns component sets with consistent variant properties into Penpot variants', async () => {
    const set = frame('70:0', [frame('70:1', [], { componentId: 'V1', role: 'component', name: 'Size=Small, State=On' }), frame('70:2', [], { componentId: 'V2', role: 'component', name: 'Size=Large, State=On' })], {
      role: 'component-set',
      name: 'Controls/Button',
    });
    const components = {
      V1: def('V1', 'Size=Small, State=On', { set: { id: 'S', name: 'Controls/Button' }, variantProperties: { State: 'On', Size: 'Small' } }),
      V2: def('V2', 'Size=Large, State=On', { set: { id: 'S', name: 'Controls/Button' }, variantProperties: { Size: 'Large', State: 'On' } }),
    };
    const w = await write(twoPages([set], [], components));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('70:0').isVariantContainer).toBe(true);
    expect(w.shape('70:1')).toMatchObject({ variantId: penpotId('70:0'), variantName: 'Small, On', name: 'Controls / Button', mainInstance: true });
    const comp = w.components.find((c: Json) => c.id === cid('V1'))!;
    expect(comp).toMatchObject({
      name: 'Button',
      path: 'Controls',
      variantId: penpotId('70:0'),
      variantProperties: [
        { name: 'Size', value: 'Small' },
        { name: 'State', value: 'On' },
      ],
    });
  });

  it('names variants "Set / variant" when the set cannot become a Penpot variant set', async () => {
    const set = frame('70:0', [frame('70:1', [], { componentId: 'V1', role: 'component' }), frame('70:2', [], { componentId: 'V2', role: 'component' })], { role: 'component-set', name: 'Button' });
    const components = {
      V1: def('V1', 'Size=Small', { set: { id: 'S', name: 'Button' }, variantProperties: { Size: 'Small' } }),
      V2: def('V2', 'Kind=Big', { set: { id: 'S', name: 'Button' }, variantProperties: { Kind: 'Big' } }),
    };
    const w = await write(twoPages([set], [], components));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('70:0').isVariantContainer).toBeUndefined();
    expect(w.shape('70:1').name).toBe('Button / Size=Small');
    expect(w.components.find((c: Json) => c.id === cid('V1'))).toMatchObject({ name: 'Size=Small', path: 'Button' });
    expect(w.codes()).toContain('variants-as-components');
  });

  it('writes plain boards when components are disabled', async () => {
    const w = await write(twoPages([buttonCopy('I20:1')], [buttonMain()], { C1: def('C1', 'Primary') }), { components: false });
    expect(componentProblems(w)).toEqual([]);
    expect(w.components).toHaveLength(0);
    for (const id of ['I20:1', 'I20:1;10:2', '10:1']) {
      const s = w.shape(id);
      expect([s.componentId, s.shapeRef, s.mainInstance]).toEqual([undefined, undefined, undefined]);
    }
    expect(w.shape('10:1').name).toBe('Primary');
  });

  it('writes copies without a main as plain boards, with a warning', async () => {
    const w = await write(twoPages([buttonCopy('I20:1')], [], { C1: def('C1', 'Primary') }));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('I20:1').componentId).toBeUndefined();
    expect(w.shape('I20:1;10:2').shapeRef).toBeUndefined();
    expect(w.codes()).toContain('missing-main-component');
  });
});
