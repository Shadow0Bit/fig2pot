import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { FIXTURES, LARGE_FIXTURES, allNodes, translateFixture } from './helpers.ts';

const files = [
  ...readdirSync(FIXTURES).filter((f) => f.endsWith('.fig')).map((f) => `${FIXTURES}${f}`),
  ...safeReaddir(LARGE_FIXTURES).filter((f) => f.endsWith('.fig')).map((f) => `${LARGE_FIXTURES}${f}`),
];

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const finiteMatrix = (m: ir.Matrix): boolean => [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite);

describe('translateDocument smoke test', () => {
  for (const path of files) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    it(`${name} translates into a consistent IR`, () => {
      const { ir: doc, reporter } = translateFixture(path);
      const summary = reporter.summary().map((s) => `${s.code}×${s.count}`);
      console.log(`${name}: ${doc.pages.length} pages, ${Object.keys(doc.components).length} components, ${Object.keys(doc.images).length} images; warnings: ${summary.join(', ') || 'none'}`);

      const nodes = doc.pages.flatMap((p) => allNodes(p.children));
      const ids = new Set<string>();
      const styleIds = new Set([...doc.styles.colors, ...doc.styles.typographies].map((s) => s.id));
      for (const node of nodes) {
        expect(ids.has(node.id), `duplicate id ${node.id}`).toBe(false);
        ids.add(node.id);
        expect(finiteMatrix(node.transform), node.id).toBe(true);
        expect(Number.isFinite(node.size.width) && Number.isFinite(node.size.height), node.id).toBe(true);
        if (node.type === 'frame' && node.instanceOf) expect(doc.components[node.instanceOf], `instanceOf ${node.instanceOf}`).toBeDefined();
        if (node.type === 'frame' && node.componentId) expect(doc.components[node.componentId]).toBeDefined();
        for (const paint of [...node.fills, ...(node.stroke?.paints ?? [])]) {
          if (paint.styleId) expect(styleIds.has(paint.styleId), `style ${paint.styleId}`).toBe(true);
          if (paint.type === 'gradient') expect(paint.handles.flatMap((h) => [h.x, h.y]).every(Number.isFinite)).toBe(true);
        }
      }
      expect(new Set(doc.pages.map((p) => p.id)).size).toBe(doc.pages.length);
      // Missing images are always reported.
      const missing = new Set(reporter.warnings.filter((w) => w.code === 'missing-image').map((w) => w.message));
      for (const node of nodes) {
        for (const paint of node.fills) {
          if (paint.type === 'image' && !doc.images[paint.imageRef]) {
            expect([...missing].some((m) => m.includes(paint.imageRef)), paint.imageRef).toBe(true);
          }
        }
      }
      expect(reporter.warnings.filter((w) => w.code === 'node-translation-failed')).toEqual([]);
    });
  }
});
