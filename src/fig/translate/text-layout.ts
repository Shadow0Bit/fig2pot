/**
 * Figma's computed text layout (`derivedTextData`, or `textData` in older
 * files) → `ir.TextNode['layout']`.
 *
 * Conventions (verified against real files, see test/fig/translate/text-layout.test.ts):
 * - Baseline `position` is the baseline origin of the line in node-local px;
 *   `lineY` is the top of the line box, so `ascent = position.y − lineY`.
 *   (`lineAscent` is a rounded font ascent, not the line-box ascent.)
 * - Glyph `commandsBlob` outlines are em-normalised with y up. A glyph point
 *   (gx, gy) lands at (position.x + gx·fontSize, position.y − gy·fontSize).
 * - Decoration rects (underline / strikethrough) are already node-local px.
 * - Glyphs without `firstCharacter` are synthesised by the layout: list
 *   bullets / numbers and the truncation ellipsis.
 * - Truncated text (`truncationStartIndex` ≥ 0) still lists glyphs for the
 *   hidden characters; they are dropped here.
 */
import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { decodeCommandsBlob } from '../blobs.ts';
import type { TranslateContext } from './context.ts';
import type { IndexMap } from './text-index.ts';

export interface LayoutSource {
  baselines: fig.Baseline[];
  glyphs: fig.Glyph[];
  decorations: fig.Decoration[];
  truncationStartIndex: number;
}

/** Prefers `derivedTextData`; falls back to the layout fields of `textData` (older files). */
export function layoutSourceOf(change: fig.NodeChange): LayoutSource | undefined {
  const pick = (d: fig.DerivedTextData | fig.TextData | undefined): LayoutSource | undefined => {
    if (!d || (!d.baselines?.length && !d.glyphs?.length)) return undefined;
    return {
      baselines: d.baselines ?? [],
      glyphs: d.glyphs ?? [],
      decorations: d.decorations ?? [],
      truncationStartIndex: d.truncationStartIndex ?? -1,
    };
  };
  return pick(change.derivedTextData) ?? pick(change.textData);
}

export interface RunLookup {
  /** Run index containing UTF-16 offset `u16` (clamped). */
  runAt(u16: number): number;
  /** Run index of the first character carrying `styleId`, if any. */
  runOfStyle(styleId: number): number | undefined;
}

const commandsCache = new WeakMap<Uint8Array, { commands: ir.PathCommand[]; corrupt: boolean }>();

/** Decoded glyph outline (finite commands only); `corrupt` when records had to be skipped. */
function glyphCommands(bytes: Uint8Array): { commands: ir.PathCommand[]; corrupt: boolean } {
  let hit = commandsCache.get(bytes);
  if (!hit) {
    let corrupt = false;
    const commands = decodeCommandsBlob(bytes, () => {
      corrupt = true;
    });
    hit = { commands, corrupt };
    commandsCache.set(bytes, hit);
  }
  return hit;
}

function finite(...values: (number | undefined)[]): boolean {
  return values.every((v) => v !== undefined && Number.isFinite(v));
}

export function buildLines(source: LayoutSource, map: IndexMap): ir.TextLine[] {
  const lines: ir.TextLine[] = [];
  const cut = source.truncationStartIndex;
  for (const b of source.baselines) {
    const first = b.firstCharacter ?? 0;
    if (cut >= 0 && first >= cut && lines.length > 0) break;
    const x = b.position?.x ?? 0;
    const y = b.position?.y ?? 0;
    const lineY = b.lineY ?? y;
    if (!finite(x, y, lineY)) continue;
    lines.push({
      start: map.toU16(first),
      end: map.toU16(b.endCharacter ?? first),
      baseline: { x, y },
      width: finite(b.width) ? (b.width as number) : 0,
      lineHeight: finite(b.lineHeight) ? (b.lineHeight as number) : 0,
      ascent: y - lineY,
    });
  }
  return lines;
}

/**
 * `glyph.advance` (em, the font's own advance: one value per glyph across the
 * whole corpus, kerning lives in the positions) × `fontSize` per character.
 */
export function buildAdvances(source: LayoutSource, map: IndexMap): { offset: number; x: number; y: number; advance: number }[] {
  const cut = source.truncationStartIndex;
  const out = new Map<number, { offset: number; x: number; y: number; advance: number }>();
  for (const g of source.glyphs) {
    if (g.firstCharacter === undefined || (cut >= 0 && g.firstCharacter >= cut)) continue;
    if (g.emojiCodePoints?.length || g.rotation || !finite(g.advance, g.fontSize, g.position?.x, g.position?.y)) continue;
    const offset = map.toU16(g.firstCharacter);
    if (!out.has(offset)) out.set(offset, { offset, x: g.position!.x!, y: g.position!.y!, advance: (g.advance as number) * (g.fontSize as number) });
  }
  return [...out.values()].sort((a, b) => a.offset - b.offset);
}

/**
 * Synthesised glyphs (no `firstCharacter`) that precede a character: list
 * bullets and numbers, attached to the first character after them. The
 * truncation ellipsis follows the shown text and is left out.
 */
export function buildMarkers(source: LayoutSource, map: IndexMap): NonNullable<NonNullable<ir.TextNode['layout']>['markers']> {
  const out: NonNullable<NonNullable<ir.TextNode['layout']>['markers']> = [];
  const cut = source.truncationStartIndex;
  source.glyphs.forEach((g, i) => {
    if (g.firstCharacter !== undefined || g.emojiCodePoints?.length || !finite(g.advance, g.fontSize, g.position?.x, g.position?.y)) return;
    const next = source.glyphs.slice(i + 1).find((x) => x.firstCharacter !== undefined);
    if (!next || (cut >= 0 && next.firstCharacter! >= cut)) return;
    out.push({ start: map.toU16(next.firstCharacter!), x: g.position!.x!, y: g.position!.y!, advance: (g.advance as number) * (g.fontSize as number), fontSize: g.fontSize as number });
  });
  return out;
}

export function buildOutlines(
  source: LayoutSource,
  map: IndexMap,
  runs: RunLookup,
  node: FigNode,
  ctx: TranslateContext,
): { path: ir.Path; runIndex: number }[] {
  const perRun = new Map<number, ir.PathCommand[]>();
  const push = (runIndex: number, cmds: ir.PathCommand[]): void => {
    let list = perRun.get(runIndex);
    if (!list) perRun.set(runIndex, (list = []));
    for (const c of cmds) list.push(c);
  };

  const cut = source.truncationStartIndex;
  let lastRun = 0;
  let emoji = false;
  let rotated = false;
  let corruptWarned = false;
  for (let i = 0; i < source.glyphs.length; i++) {
    const g = source.glyphs[i]!;
    let runIndex: number;
    if (g.firstCharacter !== undefined) {
      if (cut >= 0 && g.firstCharacter >= cut) continue;
      runIndex = runs.runAt(map.toU16(g.firstCharacter));
    } else if (g.styleID !== undefined && runs.runOfStyle(g.styleID) !== undefined) {
      runIndex = runs.runOfStyle(g.styleID)!;
    } else {
      // Synthesised glyph: bullets precede their line, the ellipsis follows the text.
      const next = source.glyphs.slice(i + 1).find((x) => x.firstCharacter !== undefined);
      runIndex = next ? runs.runAt(map.toU16(next.firstCharacter!)) : lastRun;
    }
    lastRun = runIndex;

    if (g.emojiCodePoints?.length) emoji = true;
    if (g.commandsBlob === undefined) continue;
    const bytes = ctx.blob(g.commandsBlob, node);
    if (!bytes) continue;
    const { commands: local, corrupt } = glyphCommands(bytes);
    if (corrupt && !corruptWarned) {
      corruptWarned = true;
      ctx.warn('corrupt-geometry', `glyph outline ${g.commandsBlob} has non-finite coordinates; skipped them`, node);
    }
    if (!local.some((c) => c.type !== 'Z' && c.type !== 'M')) continue;

    const px = g.position?.x ?? 0;
    const py = g.position?.y ?? 0;
    const fs = g.fontSize ?? 0;
    if (!finite(px, py, fs)) continue;
    if (g.rotation) rotated = true;
    const rot = g.rotation ? (g.rotation * Math.PI) / 180 : 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const tx = (x: number, y: number): [number, number] => {
      const lx = x * fs;
      const ly = -y * fs;
      return [px + lx * cos - ly * sin, py + lx * sin + ly * cos];
    };
    const out: ir.PathCommand[] = [];
    for (const c of local) {
      switch (c.type) {
        case 'M':
        case 'L': {
          const [x, y] = tx(c.x, c.y);
          out.push({ type: c.type, x, y });
          break;
        }
        case 'Q': {
          const [x1, y1] = tx(c.x1, c.y1);
          const [x, y] = tx(c.x, c.y);
          out.push({ type: 'Q', x1, y1, x, y });
          break;
        }
        case 'C': {
          const [x1, y1] = tx(c.x1, c.y1);
          const [x2, y2] = tx(c.x2, c.y2);
          const [x, y] = tx(c.x, c.y);
          out.push({ type: 'C', x1, y1, x2, y2, x, y });
          break;
        }
        case 'Z':
          out.push({ type: 'Z' });
          break;
      }
    }
    push(runIndex, out);
  }

  // Decorations join their run's path. Under `nonzero` a rect wound against the
  // glyphs would punch holes where it overlaps them, so it follows their winding.
  for (const d of source.decorations) {
    const runIndex = runs.runOfStyle(d.styleID ?? 0) ?? 0;
    const reversed = signedArea(perRun.get(runIndex) ?? []) < 0;
    for (const r of d.rects ?? []) {
      if (!finite(r.x, r.y, r.w, r.h) || r.w <= 0 || r.h <= 0) continue;
      const corners: [number, number][] = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h],
        [r.x, r.y + r.h],
      ];
      if (reversed) corners.reverse();
      push(runIndex, [
        ...corners.map(([x, y], i): ir.PathCommand => ({ type: i === 0 ? 'M' : 'L', x, y })),
        { type: 'Z' },
      ]);
    }
  }

  if (emoji) ctx.warn('text-emoji-not-outlined', 'emoji glyphs are images and are missing from the text outlines', node);
  if (rotated) ctx.warn('text-glyph-rotation', 'text contains rotated glyphs; outline rotation is a best guess', node);

  return [...perRun.keys()]
    .sort((a, b) => a - b)
    .map((runIndex) => ({ runIndex, path: { windingRule: 'nonzero' as const, commands: perRun.get(runIndex)! } }));
}

/**
 * Shoelace area over every point of every sub-path (control points included —
 * good enough for the sign, which outer contours dominate). Positive =
 * clockwise on screen (y down).
 */
export function signedArea(commands: readonly ir.PathCommand[]): number {
  let area = 0;
  let start: [number, number] | undefined;
  let prev: [number, number] | undefined;
  const edge = (x: number, y: number): void => {
    if (prev) area += prev[0] * y - x * prev[1];
    prev = [x, y];
  };
  const close = (): void => {
    if (start && prev) edge(start[0], start[1]);
    start = prev = undefined;
  };
  for (const c of commands) {
    if (c.type === 'Z') close();
    else if (c.type === 'M') {
      close();
      start = prev = [c.x, c.y];
    } else {
      if (c.type === 'Q') edge(c.x1, c.y1);
      if (c.type === 'C') {
        edge(c.x1, c.y1);
        edge(c.x2, c.y2);
      }
      edge(c.x, c.y);
    }
  }
  close();
  return area / 2;
}
