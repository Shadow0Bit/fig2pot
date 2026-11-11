/**
 * Figma lists (`TextNode.lists`): the source draws a marker (bullet or number)
 * that is not part of the text before each list paragraph and indents the
 * text ("List item" of simple-design-system: bullet at x = 7.5, text at 24).
 * Penpot text has no lists, so the writer emulates a bulleted item: invisible
 * spacers (`indentLeaves`) up to the bullet, the bullet character "•" in the
 * paragraph's own style, spacers up to the text (README, Lists). An empty
 * item keeps its line: with the bullet alone when the source drew a marker
 * there, as a plain empty line when it drew none. Numbered items, nested
 * items, wrapped items and non-left-aligned lists are not emulated
 * (`textMode: 'auto'` outlines them).
 */
import type * as ir from '../../ir.ts';
import { SUBSTITUTED_GLYPH_EM, penpotAdvance } from './advances.ts';
import { resolveFont } from './fonts.ts';

export const BULLET = '•';

export interface ListItem {
  /** Where the bullet starts and the text starts, px from the line start. */
  markerX: number;
  textX: number;
  /** Penpot's advance of the bullet in the item's font, px. */
  bulletAdvance: number;
}

/**
 * The emulation of every list paragraph that draws a marker (keyed by its start offset), or why the lists
 * cannot be emulated. An empty item without a marker in the source layout has no entry: it is a plain empty
 * line.
 */
export function listEmulation(node: ir.TextNode): { items: Map<number, ListItem> } | { problem: string } | undefined {
  const lists = node.lists ?? [];
  if (lists.length === 0) return undefined;
  const items = new Map<number, ListItem>();
  if (node.alignHorizontal !== 'left' || node.paragraphIndent > 0) return { problem: 'only left-aligned lists without paragraph indent are emulated' };
  const text = typeof node.characters === 'string' ? node.characters : '';
  const markers = node.layout?.markers ?? [];
  const lines = node.layout?.lines ?? [];
  const glyphs = node.layout?.glyphAdvances ?? [];
  for (const list of lists) {
    if (list.type !== 'unordered') return { problem: 'numbered lists are not emulated' };
    if (list.level !== 1) return { problem: 'nested lists are not emulated' };
    const end = text.indexOf('\n', list.start) === -1 ? text.length : text.indexOf('\n', list.start);
    const own = markers.filter((m) => m.start === list.start);
    const line = lines.find((l) => l.start === list.start);
    const first = glyphs.find((g) => g.offset === list.start);
    const empty = end === list.start;
    // An empty item has no glyph; the source may draw no marker on it either.
    if (empty && own.length === 0 && line) continue;
    if (own.length !== 1 || !line || (!first && !empty)) return { problem: 'the list marker or its line is not in the source layout' };
    if (line.end < end) return { problem: 'wrapped list items are not emulated' };
    const run = node.runs.find((r) => r.start <= list.start && list.start < r.end) ?? node.runs[0];
    if (!run) return { problem: 'the list item has no style' };
    const font = resolveFont(run.style.fontFamily ?? '', run.style.fontWeight, run.style.italic);
    const em = font.exact ? penpotAdvance(font.fontFamily, font.fontVariantId, BULLET.codePointAt(0)!) : undefined;
    const marker = own[0]!;
    // The bullet Penpot would draw must be the one the source drew (same advance; level 1 is "•").
    if (em === undefined || Math.abs(marker.advance / marker.fontSize - em) > SUBSTITUTED_GLYPH_EM) return { problem: 'the list bullet is not a known glyph of the font' };
    // A left-aligned line without paragraph indent starts at x = 0.
    // No text follows the bullet of an empty item: no spacer after it.
    const item: ListItem = { markerX: marker.x, textX: first ? first.x : marker.x + em * run.style.fontSize, bulletAdvance: em * run.style.fontSize };
    if (item.markerX < -0.01 || item.textX < item.markerX + item.bulletAdvance - 0.01) return { problem: 'the list marker is outside the text box' };
    items.set(list.start, item);
  }
  return { items };
}
