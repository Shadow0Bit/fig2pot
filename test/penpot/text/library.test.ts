/**
 * Checks buildTextAttrs output against Penpot itself:
 *  1. a port of Penpot's text content schema (`app.common.types.shape.text/schema:content`,
 *     `::sm/text` = non-blank string) plus the value rules of `app.common.types.text`
 *     (numeric strings, text-transform set, …);
 *  2. a real @penpot/library build + export, checking that the exported file carries
 *     our content unchanged.
 *
 * Why (1): @penpot/library 1.3.0 does NOT schema-check text shapes. `addText` only
 * runs `fb/decode-shape` (a coercing decoder) and the change is applied with
 * validation off; `types.shape/check-shape` runs for boards and groups only.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { buildTextAttrs } from '../../../src/penpot/text/index.ts';
import { BLACK, testDeps, textNode } from './helpers.ts';

interface BuildContext {
  addFile(params: { name: string }): string;
  addPage(params: { name: string }): string;
  addText(params: Record<string, unknown>): string;
  closePage(): void;
  closeFile(): void;
}
interface PenpotLibrary {
  createBuildContext(): BuildContext;
  exportAsBytes(context: BuildContext): Promise<Uint8Array>;
}

// Specifier kept dynamic so this test does not depend on whoever declares the library's types.
const LIBRARY = '@penpot/library';
const loadLibrary = async () => (await import(LIBRARY)) as PenpotLibrary;

/**
 * Runs `fn` with V8's plain stack formatting. vitest installs a source-mapping
 * `Error.prepareStackTrace` that crashes ("Cannot read properties of undefined
 * (reading 'map')") on the library's 9 MB source map whenever the library reads
 * an error's `.stack` internally, which `exportAsBytes` does; outside vitest the
 * export works as is.
 */
async function withPlainStacks<T>(fn: () => Promise<T>): Promise<T> {
  const E = Error as { prepareStackTrace?: unknown };
  const saved = E.prepareStackTrace;
  E.prepareStackTrace = undefined;
  try {
    return await fn();
  } finally {
    E.prepareStackTrace = saved;
  }
}

// --- port of Penpot's schema -------------------------------------------------

const NUMERIC_TEXT = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
const TEXT_ATTRS = ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'direction', 'textDecoration', 'textTransform'];
const NUMERIC_ATTRS = ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'];

function checkStyle(path: string, n: Record<string, unknown>, errors: string[]): void {
  for (const k of TEXT_ATTRS) {
    if (k in n && (typeof n[k] !== 'string' || (n[k] as string).trim() === '')) errors.push(`${path}.${k}: expected non-blank string`);
  }
  for (const k of NUMERIC_ATTRS) {
    if (k in n && (typeof n[k] !== 'string' || !NUMERIC_TEXT.test(n[k] as string))) errors.push(`${path}.${k}: not a numeric string: ${String(n[k])}`);
  }
  for (const k of ['lineHeight', 'letterSpacing']) {
    if (k in n && Math.abs(Number(n[k])) > 200) errors.push(`${path}.${k}: outside -200..200`);
  }
  if ('textTransform' in n && !['uppercase', 'capitalize', 'lowercase', 'none', 'unset'].includes(n.textTransform as string)) {
    errors.push(`${path}.textTransform: invalid`);
  }
  if ('textDecoration' in n && !['none', 'underline', 'line-through'].includes(n.textDecoration as string)) errors.push(`${path}.textDecoration: invalid`);
  if ('fontStyle' in n && !['normal', 'italic'].includes(n.fontStyle as string)) errors.push(`${path}.fontStyle: invalid`);
  if ('fontId' in n && typeof n.fontId !== 'string') errors.push(`${path}.fontId: not a string`);
  if ('fontVariantId' in n && typeof n.fontVariantId !== 'string') errors.push(`${path}.fontVariantId: not a string`);
  if ('fills' in n && n.fills !== null && !Array.isArray(n.fills)) errors.push(`${path}.fills: not a vector`);
  if ('typographyRefId' in n || 'typographyRefFile' in n) errors.push(`${path}: unexpected typography ref`);
}

function validateContent(content: unknown): string[] {
  const errors: string[] = [];
  const root = content as Record<string, unknown>;
  if (root?.type !== 'root') return ['root.type must be "root"'];
  if (!['top', 'center', 'bottom'].includes(root.verticalAlign as string)) errors.push('root.verticalAlign invalid');
  const sets = root.children as Record<string, unknown>[];
  if (!Array.isArray(sets) || sets.length < 1) return [...errors, 'root.children must be a non-empty vector'];
  sets.forEach((set, si) => {
    if (set.type !== 'paragraph-set') errors.push(`set${si}.type`);
    const ps = set.children as Record<string, unknown>[];
    if (!Array.isArray(ps) || ps.length < 1) return errors.push(`set${si}.children empty`);
    ps.forEach((p, pi) => {
      const path = `p${pi}`;
      if (p.type !== 'paragraph') errors.push(`${path}.type`);
      if (!['left', 'center', 'right', 'justify'].includes(p.textAlign as string)) errors.push(`${path}.textAlign invalid`);
      checkStyle(path, p, errors);
      const leaves = p.children as Record<string, unknown>[];
      if (!Array.isArray(leaves) || leaves.length < 1) return errors.push(`${path}.children empty`);
      leaves.forEach((leaf, li) => {
        if (typeof leaf.text !== 'string') errors.push(`${path}.l${li}.text`);
        if ('type' in leaf) errors.push(`${path}.l${li}: leaves have no type`);
        checkStyle(`${path}.l${li}`, leaf, errors);
      });
    });
  });
  return errors;
}

// --- fixtures ----------------------------------------------------------------

const auto = { unit: 'auto', value: 0 } as const;
const RED: ir.SolidPaint = { ...BLACK, color: { r: 1, g: 0, b: 0, a: 0.5 } };

const FIXTURES: [string, ir.TextNode][] = [
  ['single run', textNode([['Hello']])],
  [
    'multi-paragraph mixed styles',
    textNode(
      [
        ['Title\n', { fontSize: 32, fontWeight: 700, lineHeight: auto }],
        ['\n'],
        ['Body ', { fills: [RED] }],
        ['italic', { italic: true, letterSpacing: { unit: 'percent', value: -2 } }],
        [' UPPER\n', { textCase: 'upper', textDecoration: 'underline' }],
      ],
      { alignHorizontal: 'justified', alignVertical: 'bottom', autoResize: 'height', layout: { lines: [] } },
    ),
  ],
  ['unavailable font', textNode([['Custom'], [' font', { fontFamily: 'Acme Grotesk', fontWeight: 350, fontStyle: 'Book' }]], { autoResize: 'width-and-height' })],
  ['missing variant', textNode([['Abel bold', { fontFamily: 'Abel', fontWeight: 700 }]])],
  ['built-in font', textNode([['Source', { fontFamily: 'Source Sans Pro', fontWeight: 600, italic: true }]])],
  ['spacing + indent', textNode([['a\nb\n\nc']], { paragraphSpacing: 10, paragraphIndent: 20, autoResize: 'truncate' })],
  ['empty text', textNode([['']])],
  ['no fills', textNode([['ghost', { fills: [] }]])],
];

describe('Penpot acceptance', () => {
  it.each(FIXTURES)('%s: content matches Penpot text schema', (_name, node) => {
    expect(validateContent(buildTextAttrs(node, testDeps()).content)).toEqual([]);
  });

  it('the validator catches violations', () => {
    expect(validateContent({ type: 'root', verticalAlign: 'top', children: [] })).not.toEqual([]);
    const bad = {
      type: 'root',
      verticalAlign: 'top',
      children: [{ type: 'paragraph-set', children: [{ type: 'paragraph', textAlign: 'left', children: [{ text: 'a', fontSize: 14, fontFamily: ' ' }] }] }],
    };
    expect(validateContent(bad)).toEqual([
      'p0.l0.fontFamily: expected non-blank string',
      'p0.l0.fontSize: expected non-blank string',
      'p0.l0.fontSize: not a numeric string: 14',
    ]);
  });

  it('builds and exports a .penpot file whose text shapes carry our content unchanged', async () => {
    const penpot = await loadLibrary();
    const context = penpot.createBuildContext();
    context.addFile({ name: 'text' });
    context.addPage({ name: 'page' });
    const expected = new Map<string, { content: unknown; growType: string }>();
    FIXTURES.forEach(([name, node], i) => {
      const attrs = buildTextAttrs(node, testDeps());
      const id = context.addText({ name, x: 0, y: i * 100, width: node.size.width, height: node.size.height, ...attrs });
      expected.set(id, { content: attrs.content, growType: attrs.growType });
    });
    context.closePage();
    context.closeFile();
    const bytes = await withPlainStacks(() => penpot.exportAsBytes(context));

    const files = unzipSync(bytes);
    const shapes = Object.entries(files)
      .filter(([path]) => /\/pages\/[^/]+\/[^/]+\.json$/.test(path))
      .map(([, data]) => JSON.parse(strFromU8(data)) as { id: string; type: string; content?: unknown; growType?: string })
      .filter((s) => s.type === 'text');
    expect(shapes).toHaveLength(FIXTURES.length);
    for (const shape of shapes) {
      const want = expected.get(shape.id);
      expect(want).toBeDefined();
      expect(shape.growType).toBe(want!.growType);
      expect(shape.content).toEqual(want!.content);
    }
  });
});
