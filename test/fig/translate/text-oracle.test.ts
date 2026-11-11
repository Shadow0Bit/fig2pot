/**
 * Oracle test: compares `translateText` against the Figma REST API dump of
 * the same file (test/fixtures-large/rest/auto-layout-playground.document.json)
 * for every non-instance TEXT node, character by character. Skipped when the
 * large fixtures are absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as ir from '../../../src/ir.ts';
import type { FigNode } from '../../../src/fig/types.ts';
import { decodeFig } from '../../../src/fig/decode.ts';
import { buildTree } from '../../../src/fig/tree.ts';
import { createContext } from '../../../src/fig/translate/context.ts';
import { translatePaints } from '../../../src/fig/translate/paints.ts';
import { translateText } from '../../../src/fig/translate/text.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';
import { nodesOf, translateFixture } from './helpers.ts';

const FIG = new URL('../../fixtures-large/auto-layout-playground.fig', import.meta.url).pathname;
const REST = new URL('../../fixtures-large/rest/auto-layout-playground.document.json', import.meta.url).pathname;

type RestNode = any;

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;
const CASES: Record<string, ir.TextStyle['textCase']> = { ORIGINAL: 'original', UPPER: 'upper', LOWER: 'lower', TITLE: 'title', SMALL_CAPS: 'small-caps', SMALL_CAPS_FORCED: 'small-caps' };
const DECORATIONS: Record<string, ir.TextStyle['textDecoration']> = { NONE: 'none', UNDERLINE: 'underline', STRIKETHROUGH: 'strikethrough' };
const RESIZE: Record<ir.TextNode['autoResize'], string> = { none: 'NONE', height: 'HEIGHT', 'width-and-height': 'WIDTH_AND_HEIGHT', truncate: 'TRUNCATE' };

function solidKey(paints: { type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number }[]): string {
  return paints
    .filter((p) => p.type === 'solid' || p.type === 'SOLID')
    .map((p) => [p.color!.r, p.color!.g, p.color!.b, p.color!.a * (p.opacity ?? 1)].map((v) => v.toFixed(3)).join(','))
    .join('|');
}

function lineHeightMatches(lh: ir.LineHeight, rest: RestNode): boolean {
  switch (rest.lineHeightUnit) {
    case 'INTRINSIC_%':
      return lh.unit === 'auto' ? near(rest.lineHeightPercent ?? 100, 100) : lh.unit === 'percent';
    case 'PIXELS':
      return lh.unit === 'px' && near(lh.value, rest.lineHeightPx);
    case 'FONT_SIZE_%':
      return lh.unit === 'percent' && near(lh.value, rest.lineHeightPercentFontSize);
    default:
      return false;
  }
}

class Tally {
  readonly counts = new Map<string, { ok: number; total: number; samples: string[] }>();
  add(field: string, ok: boolean, sample: () => string): void {
    let c = this.counts.get(field);
    if (!c) this.counts.set(field, (c = { ok: 0, total: 0, samples: [] }));
    c.total++;
    if (ok) c.ok++;
    else if (c.samples.length < 3) c.samples.push(sample());
  }
  ratio(field: string): number {
    const c = this.counts.get(field);
    return c ? c.ok / c.total : 0;
  }
  report(): string {
    return [...this.counts]
      .map(([k, c]) => `${k.padEnd(17)} ${c.ok}/${c.total} (${((100 * c.ok) / c.total).toFixed(2)}%)${c.samples.length ? `  e.g. ${c.samples.join(' | ')}` : ''}`)
      .join('\n');
  }
}

describe('translateText vs Figma REST API (auto-layout-playground)', () => {
  it.skipIf(!existsSync(FIG) || !existsSync(REST))('agrees with the REST dump for every non-instance TEXT node', () => {
    const doc = buildTree(decodeFig(new Uint8Array(readFileSync(FIG))));
    const rest = JSON.parse(readFileSync(REST, 'utf8'));
    const restTexts = new Map<string, RestNode>();
    const walk = (n: RestNode): void => {
      if (n.type === 'TEXT' && !String(n.id).startsWith('I')) restTexts.set(n.id, n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(rest.document);

    const ctx = createContext(doc, new CollectingReporter());
    const tally = new Tally();
    let nodes = 0;
    for (const [id, r] of restTexts) {
      const node: FigNode | undefined = doc.byGuid.get(id);
      if (!node || node.type !== 'TEXT') continue;
      nodes++;
      const base: ir.BaseNode = {
        id,
        name: node.change.name ?? '',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'pass-through',
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        size: { width: node.change.size?.x ?? 0, height: node.change.size?.y ?? 0 },
        fills: translatePaints(node.change.fillPaints, ctx, node),
        effects: [],
      };
      const text = translateText(node, base, ctx);

      tally.add('characters', text.characters === r.characters, () => id);
      tally.add('autoResize', RESIZE[text.autoResize] === (r.style.textAutoResize ?? 'NONE'), () => `${id} ${text.autoResize}/${r.style.textAutoResize}`);
      tally.add('alignHorizontal', text.alignHorizontal.toUpperCase() === r.style.textAlignHorizontal, () => id);
      tally.add('alignVertical', text.alignVertical.toUpperCase() === r.style.textAlignVertical, () => id);
      tally.add('paragraphSpacing', near(text.paragraphSpacing, r.style.paragraphSpacing ?? 0), () => `${id} ${text.paragraphSpacing}/${r.style.paragraphSpacing}`);
      tally.add('paragraphIndent', near(text.paragraphIndent, r.style.paragraphIndent ?? 0), () => id);
      tally.add('styleId', (text.runs[0]!.style.styleId ?? null) === (r.styles?.text ?? null) || (r.characterStyleOverrides?.[0] ?? 0) !== 0, () => `${id} ${text.runs[0]!.style.styleId}/${r.styles?.text}`);
      let contiguous = text.runs[0]?.start === 0 && text.runs.at(-1)?.end === text.characters.length;
      for (let i = 1; i < text.runs.length; i++) if (text.runs[i]!.start !== text.runs[i - 1]!.end) contiguous = false;
      tally.add('runsContiguous', contiguous, () => id);

      const overrides: number[] = r.characterStyleOverrides ?? [];
      let runIndex = 0;
      for (let i = 0; i < text.characters.length; i++) {
        while (text.runs[runIndex]!.end <= i) runIndex++;
        const style = text.runs[runIndex]!.style;
        const overrideId = overrides[i] ?? 0;
        const override = overrideId ? (r.styleOverrideTable?.[String(overrideId)] ?? {}) : {};
        const rs = { ...r.style, ...override };
        const at = () => `${id}@${i}`;
        tally.add('fontFamily', style.fontFamily === rs.fontFamily, () => `${at()} ${style.fontFamily}/${rs.fontFamily}`);
        tally.add('fontStyle', style.fontStyle === rs.fontStyle, () => `${at()} ${style.fontStyle}/${rs.fontStyle}`);
        tally.add('fontWeight', style.fontWeight === rs.fontWeight, () => `${at()} ${style.fontWeight}/${rs.fontWeight}`);
        tally.add('italic', style.italic === !!rs.italic, () => at());
        tally.add('fontSize', near(style.fontSize, rs.fontSize), () => `${at()} ${style.fontSize}/${rs.fontSize}`);
        const letterPx = style.letterSpacing.unit === 'px' ? style.letterSpacing.value : (style.letterSpacing.value * style.fontSize) / 100;
        tally.add('letterSpacing', near(letterPx, rs.letterSpacing ?? 0), () => `${at()} ${letterPx}/${rs.letterSpacing}`);
        tally.add('lineHeight', lineHeightMatches(style.lineHeight, rs), () => `${at()} ${JSON.stringify(style.lineHeight)}/${rs.lineHeightUnit}`);
        tally.add('textCase', style.textCase === CASES[rs.textCase ?? 'ORIGINAL'], () => at());
        tally.add('textDecoration', style.textDecoration === DECORATIONS[rs.textDecoration ?? 'NONE'], () => at());
        tally.add('hyperlink', (style.hyperlink ?? null) === (rs.hyperlink?.url ?? null), () => at());
        tally.add('fills', solidKey(style.fills as never) === solidKey(override.fills ?? r.fills), () => `${at()} ${solidKey(style.fills as never)}/${solidKey(override.fills ?? r.fills)}`);
      }
    }

    console.log(`[text-oracle] ${nodes} TEXT nodes\n${tally.report()}`);
    expect(nodes).toBeGreaterThan(1300);
    for (const field of ['characters', 'autoResize', 'alignHorizontal', 'alignVertical', 'paragraphSpacing', 'paragraphIndent', 'styleId', 'runsContiguous', 'fontFamily', 'fontStyle', 'fontWeight', 'italic', 'fontSize', 'letterSpacing', 'lineHeight', 'textCase', 'textDecoration', 'hyperlink']) {
      expect([field, tally.ratio(field)]).toEqual([field, 1]);
    }
    // Node-level fills come from `base` (built here from the node's stored
    // `fillPaints`); one node's stored paints are stale against its fill style.
    expect(tally.ratio('fills')).toBeGreaterThan(0.999);
  });
});

describe('text metrics vs Figma REST API, instance descendants included (auto-layout-playground)', () => {
  // Nodes inside scaled instances keep their text style reference but carry
  // scaled font size / line height; REST (and Figma's layout) use the scaled
  // values. Every TEXT node, `I…;…` ids included, must agree per character.
  it.skipIf(!existsSync(FIG) || !existsSync(REST))('matches fontSize, lineHeight and letterSpacing for every character', () => {
    const t = translateFixture(FIG);
    const rest = JSON.parse(readFileSync(REST, 'utf8'));
    const restTexts = new Map<string, RestNode>();
    const walk = (n: RestNode): void => {
      if (n.type === 'TEXT') restTexts.set(n.id, n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(rest.document);

    const mismatches: string[] = [];
    let compared = 0;
    let instances = 0;
    for (const node of nodesOf(t)) {
      if (node.type !== 'text') continue;
      const r = restTexts.get(node.id);
      if (!r || r.characters !== node.characters) continue;
      compared++;
      if (node.id.startsWith('I')) instances++;
      const chars = [...node.characters];
      let u16 = 0;
      for (let i = 0; i < chars.length; i++) {
        const id = r.characterStyleOverrides?.[i] ?? 0;
        const want = { ...r.style, ...(id ? (r.styleOverrideTable?.[String(id)] ?? {}) : {}) };
        const got = node.runs.find((run) => u16 >= run.start && u16 < run.end)?.style;
        u16 += chars[i]!.length;
        if (!got) continue;
        const problems: string[] = [];
        if (!near(got.fontSize, want.fontSize, 1e-3)) problems.push(`fontSize ${got.fontSize} vs ${want.fontSize}`);
        const ls = got.letterSpacing.unit === 'px' ? got.letterSpacing.value : (got.letterSpacing.value / 100) * got.fontSize;
        if (!near(ls, want.letterSpacing ?? 0, 0.02)) problems.push(`letterSpacing ${JSON.stringify(got.letterSpacing)} vs ${want.letterSpacing}`);
        if (want.lineHeightPx !== undefined) {
          const lh = got.lineHeight;
          const px = lh.unit === 'px' ? lh.value : lh.unit === 'percent' ? (lh.value / 100) * got.fontSize : undefined;
          const ok = px === undefined ? want.lineHeightUnit === 'INTRINSIC_%' : near(px, want.lineHeightPx, 0.05 * Math.max(1, got.fontSize / 12));
          if (!ok) problems.push(`lineHeight ${JSON.stringify(lh)} vs ${want.lineHeightPx} ${want.lineHeightUnit}`);
        }
        if (problems.length > 0) {
          mismatches.push(`${node.id} @${i}: ${problems.join(', ')}`);
          break;
        }
      }
    }
    expect(compared).toBeGreaterThan(1500);
    expect(instances).toBeGreaterThan(100);
    expect(mismatches, mismatches.slice(0, 10).join('\n')).toEqual([]);
  });
});
