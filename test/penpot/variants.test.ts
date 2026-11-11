/**
 * Regression pins: component sets stay Penpot variant sets on real files. A synthesized child of a set board (a
 * stroke shape for the dashed border Figma gives component sets by default, a band, a per-side outline) makes
 * it an invalid variant container, and its variants then become plain components (`variants-as-components`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { figToIR } from '../../src/index.ts';
import { CollectingReporter } from '../../src/util/reporter.ts';
import { componentCounts, componentProblems, write } from './helpers.ts';

/**
 * Every component set with a set frame becomes a container; the sets of the remote-components page without one
 * (simple-design-system: 2 of 78, 5 variants) stay plain components.
 */
const CASES = [
  { fixture: '../fixtures/grida-components.fig', counts: { components: 4, variantContainers: 1, variantComponents: 2, copyHeads: 8 } },
  { fixture: '../fixtures-large/simple-design-system.fig', counts: { components: 2077, variantContainers: 76, variantComponents: 300, copyHeads: 5056 } },
];

describe('variant sets on real files', () => {
  for (const { fixture, counts } of CASES) {
    const url = new URL(fixture, import.meta.url);
    // The large fixtures are not in git: their pin runs only where they exist.
    for (const pixelExact of [false, true]) {
      it.skipIf(!existsSync(url))(`${fixture.split('/').pop()}${pixelExact ? ' (pixelExact)' : ''}: ${counts.variantContainers} variant containers, ${counts.variantComponents} variant components`, async () => {
        const doc = figToIR(new Uint8Array(readFileSync(url)), new CollectingReporter());
        const w = await write(doc, { pixelExact });
        expect(componentCounts(w)).toEqual(counts);
        expect(w.codes()).not.toContain('variants-as-components');
        expect(componentProblems(w)).toEqual([]);
      }, 300_000);
    }
  }
});
