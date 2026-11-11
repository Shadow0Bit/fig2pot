/**
 * Verifies the glyph / baseline coordinate conventions on real files: every
 * TEXT node's transformed glyph outlines must sit inside the node's box and
 * on the baselines of their lines.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import type { FigNode } from '../../../src/fig/types.ts';
import { decodeFig } from '../../../src/fig/decode.ts';
import { buildTree } from '../../../src/fig/tree.ts';
import { createContext } from '../../../src/fig/translate/context.ts';
import { translateText } from '../../../src/fig/translate/text.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';

function baseOf(node: FigNode): ir.BaseNode {
  return {
    id: node.id,
    name: node.change.name ?? '',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'pass-through',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    size: { width: node.change.size?.x ?? 0, height: node.change.size?.y ?? 0 },
    fills: [],
    effects: [],
  };
}

interface GeometryStats {
  nodes: number;
  inside: number;
  lines: number;
  linesOnBaseline: number;
  failures: string[];
}

function checkGeometry(path: string): GeometryStats {
  const doc = buildTree(decodeFig(new Uint8Array(readFileSync(path))));
  const ctx = createContext(doc, new CollectingReporter());
  const stats: GeometryStats = { nodes: 0, inside: 0, lines: 0, linesOnBaseline: 0, failures: [] };
  for (const node of doc.byGuid.values()) {
    if (node.type !== 'TEXT') continue;
    const base = baseOf(node);
    const text = translateText(node, base, ctx);
    const outlines = text.layout?.outlines;
    if (!outlines?.length) continue;
    stats.nodes++;

    const points = outlines.flatMap(({ path }) => path.commands.flatMap((c) => (c.type === 'Z' ? [] : [{ x: c.x, y: c.y }])));
    const maxFontSize = Math.max(...text.runs.map((r) => r.style.fontSize));
    // Descenders / accents may legitimately poke out when the line height is
    // smaller than the font's extent, so allow a fraction of the font size.
    const tol = Math.max(2, 0.3 * maxFontSize);
    const x0 = Math.min(...points.map((p) => p.x));
    const x1 = Math.max(...points.map((p) => p.x));
    const y0 = Math.min(...points.map((p) => p.y));
    const y1 = Math.max(...points.map((p) => p.y));
    if (x0 >= -tol && y0 >= -tol && x1 <= base.size.width + tol && y1 <= base.size.height + tol) stats.inside++;
    else stats.failures.push(`${node.id} bbox ${[x0, y0, x1, y1].map((v) => v.toFixed(1))} size ${base.size.width}x${base.size.height}`);

    // Each line with letters has outline points rising well above its
    // baseline and reaching down to it (y down, glyphs flipped from y-up em space).
    for (const line of text.layout?.lines ?? []) {
      if (!/[\p{L}\p{N}]/u.test(text.characters.slice(line.start, line.end))) continue;
      const fs = Math.max(1, ...text.runs.filter((r) => r.start < line.end && r.end > line.start).map((r) => r.style.fontSize));
      const near = points.filter((p) => p.y > line.baseline.y - 1.3 * fs && p.y < line.baseline.y + 0.6 * fs && p.x >= line.baseline.x - fs && p.x <= line.baseline.x + line.width + fs);
      stats.lines++;
      const top = Math.min(...near.map((p) => p.y));
      const bottom = Math.max(...near.map((p) => p.y));
      if (top < line.baseline.y - 0.3 * fs && bottom >= line.baseline.y - 0.05 * fs) stats.linesOnBaseline++;
      else stats.failures.push(`${node.id} line ${JSON.stringify(text.characters.slice(line.start, line.end))}`);
    }
  }
  return stats;
}

const fixture = (name: string) => new URL(`../../fixtures/${name}`, import.meta.url).pathname;
const large = (name: string) => new URL(`../../fixtures-large/${name}`, import.meta.url).pathname;

describe('text glyph outline geometry', () => {
  for (const name of ['f2s-structure.fig', 'f2s-noise-and-grain.fig', 'f2s-prototyping.fig', 'f2s-prototyping-swaps-and-instances.fig']) {
    it(`outlines sit inside the box and on the baselines in ${name}`, () => {
      const stats = checkGeometry(fixture(name));
      expect(stats.nodes).toBeGreaterThan(0);
      expect(stats.failures).toEqual([]);
    });
  }

  for (const name of ['auto-layout-playground.fig', 'simple-design-system.fig']) {
    it.skipIf(!existsSync(large(name)))(`outlines sit inside the box and on the baselines in ${name} (large)`, () => {
      const stats = checkGeometry(large(name));
      console.log(`[text-geometry] ${name}: ${stats.inside}/${stats.nodes} nodes inside box, ${stats.linesOnBaseline}/${stats.lines} lines on baseline`);
      expect(stats.nodes).toBeGreaterThan(1000);
      expect(stats.inside / stats.nodes).toBeGreaterThan(0.995);
      expect(stats.linesOnBaseline / stats.lines).toBeGreaterThan(0.995);
    });
  }
});
