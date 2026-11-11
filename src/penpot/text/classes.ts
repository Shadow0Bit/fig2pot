/**
 * `textMode: 'auto'` per component class. A main text and every copy text that
 * references it (`componentRef`, transitively) must be written alike: an
 * outlined copy of an editable main is a group of paths where the main has a
 * text shape, so none of the copy's shapes can reference the main's
 * (simple-design-system: 20 copy shapes without `shapeRef`).
 *
 * - A class with a member Penpot cannot draw at all as the source did
 *   (`STRONG`: unavailable font, characters its font lacks, a list it cannot
 *   emulate, an SVG gradient text fill) is outlined as a whole: every member
 *   with outlines, each warned with its own reason or `text-outlined-component`.
 * - A class whose members are only partly off (`text-outlined-decoration`,
 *   `text-outlined-truncated`, `text-outlined-glyph-shapes` (`pixelExact` only): underline ~1 px
 *   off, truncation emulated, another design of a few glyphs) stays
 *   editable as a whole when some member is fine (simple-design-system: 110
 *   "Description" texts and 4 underlined copies); those members are warned
 *   `text-kept-editable-component`. When every member has a reason, all are
 *   outlined.
 *
 * Outlined members have parallel shapes: one path per run when every member has
 * the same number of outlined runs, else one per distinct fill list, else one
 * path (warned `text-outline-fills-merged`).
 */
import type * as ir from '../../ir.ts';
import { GlyphCensus } from './advances.ts';
import { autoOutlineReason, type OutlineReason } from './editability.ts';

const STRONG = new Set(['font-unavailable', 'text-outlined-fallback-glyphs', 'text-outlined-list', 'text-outlined-gradient-fill']);
// Weak: text-outlined-decoration, text-outlined-truncated, text-outlined-glyph-shapes (another quote design).

export type OutlineGrouping = 'runs' | 'fills' | 'single';

export interface TextDecision {
  /** Outline this text. */
  outline: boolean;
  /** Its own reason (undefined when it is fine on its own). */
  reason?: OutlineReason;
  /** The class's first reason, for a member outlined or kept editable because of the others. */
  classReason?: OutlineReason;
  /** How outlined members split their glyphs into paths. */
  grouping: OutlineGrouping;
}

interface Member {
  node: ir.TextNode;
  reason: OutlineReason | undefined;
}

/** The outline groups of a text by fill list (first appearance order). */
export function fillGroups(node: ir.TextNode): number[][] {
  const groups = new Map<string, number[]>();
  (node.layout?.outlines ?? []).forEach((o, i) => {
    const key = JSON.stringify(node.runs[o.runIndex]?.style.fills ?? []);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  return [...groups.values()];
}

export class TextOutlineClasses {
  private readonly parent = new Map<string, string>();
  private readonly members = new Map<string, Member[]>();
  private readonly decisions = new Map<string, TextDecision>();
  private readonly renderer: 'svg' | 'wasm';
  /** Outline texts drawn with other glyph shapes (`text-outlined-glyph-shapes`; `pixelExact` only). */
  private readonly glyphShapes: boolean;
  /** The document's glyphs compared with Penpot's fonts (advances.ts). */
  readonly census = new GlyphCensus();

  constructor(doc: ir.Document, renderer: 'svg' | 'wasm', components: boolean, glyphShapes = false) {
    this.renderer = renderer;
    this.glyphShapes = glyphShapes;
    const texts = new Map<string, ir.TextNode>();
    const visit = (node: ir.Node): void => {
      if (node.type === 'text') {
        texts.set(node.id, node);
        this.census.add(node);
      }
      if ('children' in node) node.children.forEach(visit);
    };
    doc.pages.forEach((p) => p.children.forEach(visit));
    if (components) for (const node of texts.values()) if (node.componentRef !== undefined && texts.has(node.componentRef)) this.union(node.id, node.componentRef);
    for (const node of texts.values()) {
      const root = this.find(node.id);
      const list = this.members.get(root);
      const member = { node, reason: undefined };
      if (list) list.push(member);
      else this.members.set(root, [member]);
    }
  }

  decide(node: ir.TextNode): TextDecision {
    const known = this.decisions.get(node.id);
    if (known) return known;
    const members = this.members.get(this.find(node.id)) ?? [{ node, reason: undefined }];
    for (const m of members) m.reason = autoOutlineReason(m.node, this.renderer, this.census, { glyphShapes: this.glyphShapes });
    const reasons = members.flatMap((m) => (m.reason ? [m.reason] : []));
    const classReason = reasons.find((r) => STRONG.has(r.code)) ?? reasons[0];
    const outline = reasons.length > 0 && (reasons.some((r) => STRONG.has(r.code)) || reasons.length === members.length);
    let grouping: OutlineGrouping = 'runs';
    if (outline && members.length > 1) {
      const count = (f: (n: ir.TextNode) => number): boolean => new Set(members.map((m) => f(m.node))).size === 1;
      if (!count((n) => n.layout?.outlines?.length ?? 0)) grouping = count((n) => fillGroups(n).length) ? 'fills' : 'single';
    }
    for (const m of members) {
      const decision: TextDecision = { outline, grouping };
      if (m.reason) decision.reason = m.reason;
      if (classReason && (!m.reason || !outline)) decision.classReason = classReason;
      this.decisions.set(m.node.id, decision);
    }
    return this.decisions.get(node.id) ?? { outline, grouping };
  }

  private find(id: string): string {
    let root = id;
    while (this.parent.has(root)) root = this.parent.get(root)!;
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}
