/**
 * Per-line letter spacing (`textSpacing: 'line'`, src/penpot/text/advances.ts `lineSpacing`), live in both
 * renderers: real Figma texts of auto-layout-playground (Inter 3 advances, Figma's glyph outlines) are written
 * left / centred / right-aligned and rendered editable and as outlines; each line's first and last ink column
 * and its ink rows must match the outline render. Skipped unless PENPOT_LIVE=1 and the large fixture exists.
 *
 *   PENPOT_LIVE=1 pnpm exec vitest run test/penpot/live/text-spacing.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import { figToIR } from '../../../src/index.ts';
import type { WriteOptions } from '../../../src/penpot/index.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import type { Renderer } from '../../../tools/visual/penpot.ts';
import { RENDERERS, inkRows, placed, renderBoards, type Board, type Img, type Ink } from './harness.ts';

const FIG = fileURLToPath(new URL('../../fixtures-large/auto-layout-playground.fig', import.meta.url));
const ALIGNS = ['left', 'center', 'right'] as const;
type Align = (typeof ALIGNS)[number];
/** Source texts: "Button 5" (24 px Bold: 1.4 px short in Penpot), a 58-character line and a 3-line paragraph (16 px Medium). */
const SOURCES = { label: { id: '2411:12964' }, line: { id: '1843:3531', line: 1 }, paragraph: { id: '2411:11975' } } as const;
type Kind = keyof typeof SOURCES;

/** The subpaths of a path (each starts with M). */
function subpaths(path: ir.Path): ir.PathCommand[][] {
  const out: ir.PathCommand[][] = [];
  for (const c of path.commands) {
    if (c.type === 'M') out.push([]);
    out[out.length - 1]?.push(c);
  }
  return out;
}

const moved = (c: ir.PathCommand, dx: number, dy: number): ir.PathCommand => {
  if (c.type === 'Z') return c;
  const out = { ...c, x: c.x + dx, y: c.y + dy };
  if ('x1' in out) Object.assign(out, { x1: out.x1 + dx, y1: out.y1 + dy });
  if ('x2' in out) Object.assign(out, { x2: out.x2 + dx, y2: out.y2 + dy });
  return out as ir.PathCommand;
};

/** A source text reduced to one run (and to one of its lines): characters, lines, glyphs, and its outline subpaths per line. */
function base(node: ir.TextNode, only?: number) {
  const layout = node.layout!;
  const all = layout.lines!;
  const lineOf = (y: number): number => all.reduce((best, l, k) => (Math.abs(l.baseline.y - 0.35 * l.ascent - y) < Math.abs(all[best]!.baseline.y - 0.35 * all[best]!.ascent - y) ? k : best), 0);
  const paths = layout.outlines!.flatMap((o) => subpaths(o.path)).map((s) => {
    const ys = s.flatMap((c) => (c.type === 'Z' ? [] : [c.y]));
    return { line: lineOf((Math.min(...ys) + Math.max(...ys)) / 2), commands: s };
  });
  if (only === undefined) return { characters: node.characters, size: node.size, style: node.runs[0]!.style, lines: all, glyphs: layout.glyphAdvances!, paths };
  const l = all[only]!;
  const text = node.characters.slice(l.start, l.end).trimEnd();
  const dy = l.baseline.y - all[0]!.baseline.y;
  return {
    characters: text,
    size: { width: node.size.width, height: l.lineHeight },
    style: node.runs[0]!.style,
    lines: [{ ...l, start: 0, end: text.length, baseline: { ...l.baseline, y: l.baseline.y - dy } }],
    glyphs: layout.glyphAdvances!.filter((g) => g.offset >= l.start && g.offset < l.start + text.length).map((g) => ({ ...g, offset: g.offset - l.start, y: g.y - dy })),
    paths: paths.filter((p) => p.line === only).map((p) => ({ line: 0, commands: p.commands.map((c) => moved(c, 0, -dy)) })),
  };
}

/**
 * The left-aligned source text as Figma lays it out with another alignment: each line moved by what the
 * alignment adds (its width without trailing spaces, inside the box). The label stays auto-width (its box is
 * its line rounded up, as Figma sizes it); the others get a fixed box 40 px wider than their widest line.
 */
function aligned(kind: Kind, b: ReturnType<typeof base>, align: Align): ir.TextNode {
  const ink = b.lines.map((l) => {
    const gs = b.glyphs.filter((g) => g.offset >= l.start && g.offset < l.end && !/\s/u.test(b.characters[g.offset]!));
    const last = gs[gs.length - 1]!;
    return last.x + last.advance - l.baseline.x;
  });
  const auto = kind === 'label';
  const width = auto ? Math.ceil(Math.max(...ink)) : Math.ceil(Math.max(...ink)) + 40;
  const dx = ink.map((w, k) => (align === 'left' ? 0 : (align === 'right' ? 1 : 0.5) * (width - w) - b.lines[k]!.baseline.x));
  const lineAt = (offset: number): number => b.lines.findIndex((l) => offset >= l.start && offset < l.end);
  const path: ir.Path = { windingRule: 'nonzero', commands: b.paths.flatMap((p) => p.commands.map((c) => moved(c, dx[p.line]!, 0))) };
  return {
    type: 'text',
    id: `${kind}-${align}`,
    name: `${kind} ${align}`,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'pass-through',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    size: { width, height: b.size.height },
    fills: [],
    effects: [],
    characters: b.characters,
    runs: [{ start: 0, end: b.characters.length, style: b.style }],
    autoResize: auto ? 'width-and-height' : 'none',
    alignHorizontal: align,
    alignVertical: 'top',
    paragraphSpacing: 0,
    paragraphIndent: 0,
    layout: {
      lines: b.lines.map((l, k) => ({ ...l, baseline: { ...l.baseline, x: l.baseline.x + dx[k]! } })),
      glyphAdvances: b.glyphs.map((g) => ({ ...g, x: g.x + dx[lineAt(g.offset)]! })),
      outlines: [{ path, runIndex: 0 }],
    },
  };
}

const keys: string[] = [];
const boards: Board[] = [];
type Variant = 'line' | 'none' | 'outline';
const renders: Record<Variant, Record<Renderer, (Img | undefined)[]>> = { line: { svg: [], wasm: [] }, none: { svg: [], wasm: [] }, outline: { svg: [], wasm: [] } };
const rows = (v: Variant, r: Renderer, key: string): Ink[] => {
  const img = renders[v][r][keys.indexOf(key)];
  if (!img) throw new Error(`${key} (${v}) failed to export with ${r}`);
  return inkRows(img);
};

describe.skipIf(process.env.PENPOT_LIVE !== '1' || !existsSync(FIG))('per-line text spacing (live)', () => {
  beforeAll(async () => {
    const doc = figToIR(readFileSync(FIG), new CollectingReporter());
    const texts = new Map<string, ir.TextNode>();
    const visit = (n: ir.Node): void => {
      if (n.type === 'text') texts.set(n.id, n);
      if ('children' in n) n.children.forEach(visit);
    };
    doc.pages.forEach((p) => p.children.forEach(visit));
    for (const [kind, source] of Object.entries(SOURCES) as [Kind, (typeof SOURCES)[Kind]][]) {
      const b = base(texts.get(source.id)!, 'line' in source ? source.line : undefined);
      for (const align of ALIGNS) {
        const node = aligned(kind, b, align);
        keys.push(node.id);
        boards.push({ nodes: [placed(node)], width: Math.ceil(node.size.width) + 80, height: Math.ceil(node.size.height) + 40 });
      }
    }
    for (const renderer of RENDERERS) {
      const run = async (v: Variant, options: WriteOptions) =>
        (renders[v][renderer] = (await renderBoards(`text-spacing-${v}-${renderer}`, boards, { renderer, ...options }))[renderer]);
      await run('line', { textMode: 'editable' });
      await run('none', { textMode: 'editable', textSpacing: 'none' });
      await run('outline', { textMode: 'outline' });
    }
    // The measurements behind the README table.
    for (const r of RENDERERS) {
      for (const key of keys) {
        const o = rows('outline', r, key);
        const fmt = (v: Variant): string =>
          rows(v, r, key)
            .map((row, k) => `${(row.left - o[k]!.left).toFixed(1)}/${(row.right - o[k]!.right).toFixed(1)}`)
            .join(' ');
        console.log(`${r} ${key.padEnd(16)} none ${fmt('none').padEnd(30)} line ${fmt('line')}`);
      }
    }
  }, 900_000);

  describe.each(RENDERERS)('%s renderer', (r) => {
    it.each(ALIGNS.flatMap((a) => (['label', 'line', 'paragraph'] as const).map((k) => `${k}-${a}`)))('%s: each line starts and ends where Figma drew it', (key) => {
      const outline = rows('outline', r, key);
      const editable = rows('line', r, key);
      // "Button 5" in WASM: its end is 1 px short (SVG 0.5) with the advances corrected. Every "Button N" of the
      // corpus ends ~0.6 px shorter than its advance differences explain in both renderers (kerning that Inter 4
      // does differently, which no advance table shows); render-wasm also moves a left-aligned line's first glyph
      // by half its spacing, so less of the line can be corrected there.
      const tolerance = r === 'wasm' && key === 'label-left' ? 1 : 0.5;
      expect(editable).toHaveLength(outline.length);
      editable.forEach((row, k) => {
        expect(Math.abs(row.left - outline[k]!.left), `line ${k} left`).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(row.right - outline[k]!.right), `line ${k} right`).toBeLessThanOrEqual(tolerance);
      });
    });

    it.each(ALIGNS.flatMap((a) => (['label', 'line', 'paragraph'] as const).map((k) => `${k}-${a}`)))('%s: the baselines stay where Figma drew them', (key) => {
      const outline = rows('outline', r, key);
      rows('line', r, key).forEach((row, k) => {
        expect(Math.abs(row.top - outline[k]!.top), `line ${k} top`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(row.bottom - outline[k]!.bottom), `line ${k} bottom`).toBeLessThanOrEqual(0.5);
      });
    });
  });
});
