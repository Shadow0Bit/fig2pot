import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as ir from '../../../src/ir.ts';
import { isContainer } from '../../../src/ir.ts';
import type { FigDocument } from '../../../src/fig/types.ts';
import { decodeFig } from '../../../src/fig/decode.ts';
import { buildTree } from '../../../src/fig/tree.ts';
import { resolveInstances } from '../../../src/fig/instances.ts';
import { translateDocument } from '../../../src/fig/translate/index.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';

export const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
export const LARGE_FIXTURES = fileURLToPath(new URL('../../fixtures-large/', import.meta.url));

export interface Translated {
  doc: FigDocument;
  ir: ir.Document;
  reporter: CollectingReporter;
}

const cache = new Map<string, Translated>();

/** decode → buildTree → resolveInstances → translateDocument, memoised per path. */
export function translateFixture(path: string): Translated {
  let hit = cache.get(path);
  if (!hit) {
    const doc = buildTree(decodeFig(readFileSync(path)));
    const reporter = new CollectingReporter();
    resolveInstances(doc, reporter);
    hit = { doc, ir: translateDocument(doc, reporter), reporter };
    cache.set(path, hit);
  }
  return hit;
}

export const fixture = (name: string): Translated => translateFixture(`${FIXTURES}${name}`);

export const hasLarge = (name: string): boolean => existsSync(`${LARGE_FIXTURES}${name}`);

export function allNodes(nodes: readonly ir.Node[]): ir.Node[] {
  const out: ir.Node[] = [];
  const visit = (list: readonly ir.Node[]): void => {
    for (const node of list) {
      out.push(node);
      if (isContainer(node)) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

export function nodesOf(t: Translated): ir.Node[] {
  return t.ir.pages.flatMap((page) => allNodes(page.children));
}

export function byId(t: Translated, id: string): ir.Node {
  const node = nodesOf(t).find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} not found`);
  return node;
}

export function byName(t: Translated, name: string): ir.Node {
  const node = nodesOf(t).find((n) => n.name === name);
  if (!node) throw new Error(`node named ${JSON.stringify(name)} not found`);
  return node;
}
