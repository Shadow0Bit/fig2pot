/**
 * F4: when Penpot rejects a component after the pages are built, the file is rebuilt with that component
 * demoted: its main and every copy become plain boards, so no copy points at a missing component.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { componentProblems, frame, rect, solid, write } from './helpers.ts';

vi.mock('../../src/penpot/library.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/penpot/library.ts')>();
  return {
    ...original,
    createBuildContext: (options?: { referer?: string }) => {
      const builder = original.createBuildContext(options);
      // The library's context exposes getters only: wrap it instead of patching it.
      return new Proxy(builder, {
        get(target, key) {
          if (key === 'addComponent') {
            return (params: Parameters<typeof builder.addComponent>[0]) => {
              if (params.name === 'Rejected') throw new Error('simulated rejection');
              target.addComponent(params);
            };
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
});

describe('rejected components', () => {
  it('turns the rejected component’s main and copies into plain boards, warning once', async () => {
    const main = (id: string, componentId: string, name: string): ir.FrameNode =>
      frame(id, [rect(`${id}c`, { fills: [solid(1, 0, 0)] })], { componentId, role: 'component', name });
    const copy = (id: string, of: string, child: string): ir.FrameNode =>
      frame(id, [rect(`${id};${child}`, { componentRef: child, fills: [solid(0, 0, 1)] })], { instanceOf: of, role: 'instance' });
    const document: ir.Document = {
      name: 'Rejection',
      pages: [{ id: '0:1', name: 'Page', kind: 'page', children: [main('m1', 'BAD', 'Rejected'), main('m2', 'OK', 'Kept'), copy('c1', 'BAD', 'm1c'), copy('c2', 'OK', 'm2c')] }],
      components: { BAD: { id: 'BAD', name: 'Rejected', remote: false }, OK: { id: 'OK', name: 'Kept', remote: false } },
      images: {},
      styles: { colors: [], typographies: [] },
    };
    const w = await write(document);
    expect(componentProblems(w)).toEqual([]);
    expect(w.components.map((c) => c.name)).toEqual(['Kept']);
    for (const id of ['m1', 'c1', 'c1;m1c']) {
      expect(w.shape(id).componentId).toBeUndefined();
      expect(w.shape(id).shapeRef).toBeUndefined();
    }
    expect(w.shape('c2').componentId).toBeDefined();
    expect(w.shape('c2;m2c').shapeRef).toBe(w.shape('m2c').id);
    expect(w.codes().filter((c) => c === 'invalid-component')).toHaveLength(1);
    expect(w.codes()).not.toContain('missing-main-component');
  });
});
