import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { penpotAdvance } from '../../../src/penpot/text/advances.ts';
import { autoOutlineReason } from '../../../src/penpot/text/editability.ts';
import { buildText } from '../../../src/penpot/text/index.ts';
import { BULLET, listEmulation } from '../../../src/penpot/text/lists.ts';
import { paragraphs, testDeps, textNode } from './helpers.ts';

const BULLET_EM = penpotAdvance('Inter', 'regular', BULLET.codePointAt(0)!)!;

/**
 * "a", "", "b" as a bulleted list (simple-design-system's "List item" geometry: bullet at 7.5, text at 24), with
 * a marker on the empty item only when `emptyMarker`.
 */
function list(emptyMarker: boolean, emptyIsListed = true): ir.TextNode {
  const marker = (start: number, y: number) => ({ start, x: 7.5, y, advance: BULLET_EM * 16, fontSize: 16 });
  const line = (start: number, end: number, y: number) => ({ start, end, baseline: { x: 24, y }, width: 10, lineHeight: 24, ascent: 17 });
  return textNode([['a\n\nb', {}]], {
    lists: [
      { start: 0, type: 'unordered', level: 1 },
      ...(emptyIsListed ? [{ start: 2, type: 'unordered' as const, level: 1 }] : []),
      { start: 3, type: 'unordered', level: 1 },
    ],
    layout: {
      lines: [line(0, 2, 17), line(2, 3, 41), line(3, 4, 65)],
      glyphAdvances: [
        { offset: 0, x: 24, y: 17, advance: 9 },
        { offset: 3, x: 24, y: 65, advance: 9 },
      ],
      markers: [marker(0, 17), ...(emptyMarker ? [marker(2, 41)] : []), marker(3, 65)],
    },
  });
}

const texts = (node: ir.TextNode): string[] => paragraphs(buildText(node, testDeps()).attrs.content).map((p) => p.children.map((c) => c.text).join(''));

describe('list emulation', () => {
  it('keeps a list with an empty item editable; the empty item draws no bullet where the source drew no marker', () => {
    const node = list(false);
    const emulation = listEmulation(node);
    expect(emulation && 'items' in emulation && [...emulation.items.keys()]).toEqual([0, 3]);
    expect(autoOutlineReason(node, 'svg')).toBeUndefined();
    const [first, empty, last] = texts(node);
    expect(first).toContain(`${BULLET}`);
    expect(first!.endsWith('a')).toBe(true);
    expect(empty).not.toContain(BULLET);
    expect(last).toContain(BULLET);
  });

  it('draws the bullet alone on an empty item where the source drew a marker', () => {
    const node = list(true);
    const emulation = listEmulation(node);
    expect(emulation && 'items' in emulation && emulation.items.get(2)).toMatchObject({ markerX: 7.5, textX: 7.5 + BULLET_EM * 16 });
    expect(autoOutlineReason(node, 'svg')).toBeUndefined();
    const deps = testDeps();
    const empty = paragraphs(buildText(node, deps).attrs.content)[1]!;
    // Spacers up to the bullet, the bullet, the empty line's zero-width space; no spacer after the bullet.
    expect(empty.children.map((c) => c.text).join('').replace(/ /g, '')).toBe(`${BULLET}​`);
    expect(deps.reporter.warnings.map((w) => w.code)).toContain('text-list-emulated');
  });

  it('still reports a non-empty item whose marker is missing from the layout', () => {
    const node = list(false);
    node.layout!.markers = node.layout!.markers!.filter((m) => m.start !== 3);
    expect(listEmulation(node)).toEqual({ problem: 'the list marker or its line is not in the source layout' });
    expect(autoOutlineReason(node, 'svg')?.code).toBe('text-outlined-list');
  });
});
