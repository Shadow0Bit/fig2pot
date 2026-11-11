/**
 * Regression tests for review F: component links, duplicate ids, names, touched groups and determinism.
 */
import { existsSync, readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../src/ir.ts';
import { convert } from '../../src/index.ts';
import { penpotId } from '../../src/penpot/ids.ts';
import { componentProblems, doc, frame, group, pathNode, rect, solid, square, stroke, text, textStyle, write, type Json } from './helpers.ts';

const def = (id: string, name: string, extra: Partial<ir.ComponentDef> = {}): ir.ComponentDef => ({ id, name, remote: false, ...extra });

describe('duplicate ids (F5)', () => {
  it('renumbers repeated node and page ids deterministically and keeps the structure valid', async () => {
    const document: ir.Document = {
      ...doc([]),
      pages: [
        { id: '0:1', name: 'A', kind: 'page', children: [frame('1:1', [rect('1:2'), rect('1:2')]), rect('1:1')] },
        { id: '0:1', name: 'B', kind: 'page', children: [rect('2:1')] },
      ],
    };
    const before = JSON.stringify(document);
    const w = await write(document);
    expect(JSON.stringify(document)).toBe(before);
    expect(w.pages.map((p) => p.name)).toEqual(['A', 'B']);
    expect(new Set(w.pages.map((p) => p.id)).size).toBe(2);
    expect(w.has('1:2#dup1')).toBe(true);
    expect(w.has('1:1#dup1')).toBe(true);
    // Every shape is listed by exactly the parent it names.
    for (const shape of Object.values(w.shapes)) {
      for (const child of w.children(shape)) expect(child.parentId).toBe(shape.id);
    }
    expect(w.codes().filter((c) => c === 'duplicate-id')).toHaveLength(3);
    const again = await write(document);
    expect(Buffer.compare(Buffer.from(again.bytes), Buffer.from(w.bytes))).toBe(0);
  });
});

describe('names (F6)', () => {
  it('keeps slashes of ordinary shape names (as U+2215) and real paths on component mains', async () => {
    const w = await write(
      doc(
        [
          rect('a', { name: '50/50' }),
          rect('b', { name: 'I/O' }),
          frame('m', [], { componentId: 'C', role: 'component', name: 'Ignored' }),
          frame('s', [], { componentId: 'S', role: 'component', name: ' / ' }),
        ],
        { components: { C: def('C', 'Icons/Arrow'), S: def('S', '//') } },
      ),
    );
    expect(w.shape('a').name).toBe('50∕50');
    expect(w.shape('b').name).toBe('I∕O');
    expect(w.shape('m').name).toBe('Icons / Arrow');
    expect(w.components.find((c) => c.mainInstanceId === w.shape('m').id)).toMatchObject({ name: 'Arrow', path: 'Icons' });
    // A name made only of slashes gets a valid one, the same on the component and its main.
    expect(w.shape('s').name).toBe('Unnamed');
    expect(w.components.find((c) => c.mainInstanceId === w.shape('s').id)).toMatchObject({ name: 'Unnamed' });
    expect(componentProblems(w)).toEqual([]);
  });
});

describe('touched groups (F8, F8b)', () => {
  it('compares copies with the final main names: variant copies named after their set are not name-touched', async () => {
    const variant = (id: string, value: string): ir.FrameNode =>
      frame(id, [rect(`${id}r`, { fills: [solid(1, 0, 0)] })], { componentId: `C${value}`, role: 'component', name: `Size=${value}` });
    const set = frame('set', [variant('v1', 'S'), variant('v2', 'L')], { role: 'component-set', name: 'Forms/Button' });
    const copy = frame('I1', [rect('I1;v1r', { componentRef: 'v1r', fills: [solid(1, 0, 0)] })], { instanceOf: 'CS', role: 'instance', name: 'Button' });
    const components = {
      CS: def('CS', 'Size=S', { set: { id: 'set', name: 'Forms/Button' }, variantProperties: { Size: 'S' } }),
      CL: def('CL', 'Size=L', { set: { id: 'set', name: 'Forms/Button' }, variantProperties: { Size: 'L' } }),
    };
    const w = await write(doc([set, copy], { components }));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('v1').name).toBe('Forms / Button');
    expect(w.shape('set').name).toBe('Forms / Button');
    expect(w.shape('I1').touched ?? []).not.toContain('name-group');
  });

  it('maps a changed path to geometry-group only, and links the extra shapes of a copy head to the main', async () => {
    const sides = stroke({ perSide: { top: 0, right: 0, bottom: 2, left: 0 }, paints: [solid(0, 0, 0)] });
    const main = frame('10:1', [pathNode('10:2', [square(0, 0, 10, 10)], { size: { width: 10, height: 10 } })], {
      componentId: 'C1', role: 'component', name: 'Row', stroke: sides,
    });
    const copy = frame('I2', [pathNode('I2;10:2', [square(0, 0, 20, 10)], { componentRef: '10:2', name: '10:2', size: { width: 20, height: 10 } })], {
      instanceOf: 'C1', role: 'instance', name: 'Row', stroke: sides, transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 0 },
    });
    const w = await write(doc([main, copy], { components: { C1: def('C1', 'Row') } }));
    expect(componentProblems(w)).toEqual([]);
    expect(w.shape('I2;10:2').touched).toEqual(['geometry-group']);
    // The emulated per-side stroke of the copy head refers to the main's.
    expect(w.shape('I2', 'stroke-sides').shapeRef).toBe(w.shape('10:1', 'stroke-sides').id);
  });
});

describe('deterministic output (F9)', () => {
  for (const fixture of ['radix-icons', 'f2s-structure']) {
    it(`converts ${fixture}.fig to identical bytes twice`, async () => {
      const fig = new Uint8Array(readFileSync(new URL(`../fixtures/${fixture}.fig`, import.meta.url)));
      const a = (await convert(fig)).penpot;
      const b = (await convert(fig)).penpot;
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
      // Storage objects are renamed consistently: every mediaId names an object in the archive.
      const files = unzipSync(a);
      for (const [path, data] of Object.entries(files)) {
        if (!/\/media\/[^/]+\.json$/.test(path)) continue;
        const media = JSON.parse(strFromU8(data)) as { mediaId: string; createdAt: string };
        expect(Object.keys(files).some((p) => p.startsWith(`objects/${media.mediaId}.`) && !p.endsWith('.json'))).toBe(true);
        expect(JSON.parse(strFromU8(files[`objects/${media.mediaId}.json`]!)).id).toBe(media.mediaId);
        expect(media.createdAt).toBe('1970-01-01T00:00:00+00:00');
      }
    }, 60_000);
  }

  // Baked paints (tiled images): the large fixture is not in git, so the check runs only where it exists.
  const large = new URL('../fixtures-large/auto-layout-playground.fig', import.meta.url);
  it.skipIf(!existsSync(large))('converts auto-layout-playground.fig (tiled images, baked) to identical bytes twice', async () => {
    const fig = new Uint8Array(readFileSync(large));
    const first = await convert(fig);
    expect(first.warnings.filter((w) => w.code === 'paint-baked').length).toBeGreaterThan(0);
    const again = (await convert(fig)).penpot;
    expect(Buffer.compare(Buffer.from(first.penpot), Buffer.from(again))).toBe(0);
  }, 120_000);
});

describe('time-zone independence (F9)', () => {
  it('writes the same bytes whatever the local time zone (zip times use local date getters)', async () => {
    const images = { img: { ref: 'img', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' as const, width: 2, height: 2 } };
    const fill: ir.ImagePaint = { type: 'image', visible: true, opacity: 1, blendMode: 'normal', imageRef: 'img', scaleMode: 'fill' };
    const document = doc([rect('r', { fills: [fill] })], { images });
    const saved = process.env.TZ;
    try {
      const outputs: Buffer[] = [];
      for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        outputs.push(Buffer.from((await write(document)).bytes));
      }
      expect(outputs.every((b) => Buffer.compare(b, outputs[0]!) === 0)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe('typography links (F7)', () => {
  it('links text leaves whose run uses a shared text style to its library typography', async () => {
    const { fills: _f, hyperlink: _h, styleId: _s, ...style } = textStyle();
    const typography: ir.TypographyStyle = { id: 'S:1', name: 'Body/Regular', style };
    const node = text('t', 'Hello world', {
      runs: [
        { start: 0, end: 6, style: textStyle({ styleId: 'S:1' }) },
        { start: 6, end: 11, style: textStyle({ styleId: 'S:missing', fontWeight: 700, fontStyle: 'Bold' }) },
      ],
    });
    const w = await write(doc([node], { styles: { colors: [], typographies: [typography] } }), { textMode: 'editable' });
    const leaves: Json[] = [];
    const walk = (n: Json): void => {
      if (typeof n.text === 'string') leaves.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(w.shape('t').content);
    const linked = leaves.filter((l) => l.typographyRefId !== undefined);
    expect(linked.length).toBeGreaterThan(0);
    for (const l of linked) expect(l).toMatchObject({ typographyRefId: penpotId('S:1', 'typography'), typographyRefFile: w.manifest.files[0].id });
    expect(w.typographies.map((t) => t.id)).toEqual([penpotId('S:1', 'typography')]);
    // Runs of an unknown style stay unlinked.
    expect(leaves.some((l) => l.text.includes('world') && l.typographyRefId === undefined)).toBe(true);
  });
});

describe('groups only (no components)', () => {
  it('still writes plain groups', async () => {
    const w = await write(doc([group('g', [rect('r')])]), { components: false });
    expect(w.shape('g').type).toBe('group');
  });
});
