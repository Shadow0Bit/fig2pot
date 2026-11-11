/**
 * Override bookkeeping for instance materialisation (see `instances.ts`).
 *
 * Format facts this module relies on (established on real files, see
 * `test/fig/instances-oracle.test.ts` for the REST-API cross-check):
 *
 * - A `guidPath` (in `symbolData.symbolOverrides` and `derivedSymbolData`)
 *   has exactly ONE element per instance level: `[k1]` addresses node `k1`
 *   anywhere inside the instance's symbol (not just direct children),
 *   `[k1, k2]` addresses node `k2` inside the symbol of the nested instance
 *   `k1`, and so on. Each element is the target node's *override key*:
 *   `overrideKey` when the node has one (nodes of library symbols copied into
 *   the file keep their original library GUID there), otherwise its `guid`.
 *   On auto-layout-playground.fig 666 path elements match only an
 *   `overrideKey`, 1180 only a `guid`, none both.
 * - The REST API builds its `I<instance>;…` ids from the same override keys
 *   (e.g. `I1620:3539;3:145;3:137` where node 3:145 is stored as 721:986 with
 *   `overrideKey` 3:145), so materialised ids are `I<real instance id>;` +
 *   the override-key path.
 * - A path `[symbolKey]` addresses the symbol root, i.e. the instance itself.
 *   Those entries are often stale (REST agrees with the INSTANCE node's own
 *   stored paints in 54/54 fill and 35/35 stroke conflicts on
 *   auto-layout-playground.fig), so the instance node's own fields win and
 *   root-addressed entries are ignored.
 */
import type { NodeChange } from './types.ts';
import type { ComponentPropAssignment, ComponentPropNodeField, GUID, StyleId } from './schema.d.ts';
import { guidToString } from './tree.ts';

/** Kind of an override entry; applied in this order within one instance level. */
export const OVERRIDE = 0;
export const PROP = 1;
export const DERIVED = 2;
export type EntryKind = typeof OVERRIDE | typeof PROP | typeof DERIVED;

/**
 * One partial NodeChange to merge into the node at some path.
 *
 * `level` is the instance nesting level the entry was declared on: 0 for the
 * real (outermost) instance, 1 for an instance nested in its symbol, … Outer
 * levels win over inner ones; within a level, symbol overrides < component
 * property values < derived (layout) data.
 */
export interface OverrideEntry {
  level: number;
  kind: EntryKind;
  change: NodeChange;
  /**
   * Provenance only, never merged: what this level assigned before an outer
   * level re-assigned the same component property (the outer value is
   * another entry). Tells which text an inner level's derived layout was
   * computed for (`dropStaleDerivedData`).
   */
  shadowed?: true;
}

/** Fields of an override / derived entry that never describe the target node. */
const NON_MERGED_FIELDS = new Set<string>(['guidPath', 'guid', 'parentIndex', 'type', 'phase', 'overrideKey']);

/** A GUID with sessionID 0xFFFFFFFF is Figma's "none" sentinel (seen on `overrideKey`). */
export function isNullGuid(guid: GUID | undefined): boolean {
  return !guid || guid.sessionID === 0xffffffff;
}

export function guidKey(guid: GUID | undefined): string | undefined {
  return isNullGuid(guid) ? undefined : guidToString(guid!);
}

/** Override key of a node: `overrideKey` if set, otherwise its own GUID. */
export function overrideKeyOf(change: NodeChange, fallbackGuid: string): string {
  return guidKey(change.overrideKey) ?? fallbackGuid;
}

/**
 * Override entries of ONE outermost-instance expansion, keyed by the
 * `;`-joined override-key path relative to that instance's symbol.
 */
export class OverrideIndex {
  private readonly byPath = new Map<string, OverrideEntry[]>();
  private readonly consumed = new Set<string>();

  add(path: string, entry: OverrideEntry): void {
    const list = this.byPath.get(path);
    if (list) list.push(entry);
    else this.byPath.set(path, [entry]);
  }

  /** Entries for `path` in application order (inner levels first, then by kind). */
  get(path: string): readonly OverrideEntry[] {
    const list = this.byPath.get(path);
    if (!list) return EMPTY;
    this.consumed.add(path);
    if (list.length > 1) list.sort(compareEntries);
    return list;
  }

  /** Marks `path` as handled without reading it (root-addressed entries are ignored by design). */
  ignore(path: string): void {
    this.consumed.add(path);
  }

  /** Entries whose path never matched a materialised node (stale or unresolvable). */
  *unmatched(): Iterable<[string, OverrideEntry]> {
    for (const [path, list] of this.byPath) {
      if (this.consumed.has(path)) continue;
      for (const entry of list) yield [path, entry];
    }
  }
}

const EMPTY: readonly OverrideEntry[] = Object.freeze([]);

function compareEntries(a: OverrideEntry, b: OverrideEntry): number {
  return b.level - a.level || a.kind - b.kind;
}

/** Looks up a shared style node (`styleType` set) by its `StyleId`. */
export type StyleLookup = (id: StyleId) => NodeChange | undefined;

/**
 * Style reference fields → the paint field they decide. A node bound to a
 * shared style shows the STYLE's paints; the paints stored next to the
 * reference are a cache that is frequently stale or missing, especially in
 * overrides. Established against REST on auto-layout-playground.fig:
 * instance 2411:10357 overrides only `styleIdForStrokeFill` (346:1220) on
 * its rectangles; instance 1620:1608 stores purple fills next to a library
 * fill style (asset key 98e12…) whose colour — orange — is what REST shows;
 * instance 2411:11019 stores no strokes at all but a stroke style.
 * A null-GUID reference (`4294967295:4294967295`) means "detached from the
 * style": the stored paints are authoritative then.
 */
const STYLE_PAINT_FIELDS = [
  ['styleIdForFill', 'fillPaints'],
  ['styleIdForStrokeFill', 'strokePaints'],
] as const;

/**
 * Returns a NEW NodeChange: `base` with `entries` applied in order, then
 * paints re-read from referenced styles. Nested values are shared with the
 * inputs (shallow copy) — all NodeChange objects are treated as immutable.
 */
export function mergeEntries(base: NodeChange, entries: readonly OverrideEntry[], styles: StyleLookup): NodeChange {
  const out: Record<string, unknown> = { ...base };
  // The characters each level saw: real entries plus what shadowed assignments set at their level.
  let seen = base.textData?.characters;
  const text: TextProvenance = { textLevel: undefined, derivedLevel: undefined, derivedFor: seen };
  for (const entry of entries) {
    if (entry.shadowed) {
      const shadowedText = entry.change.textData?.characters;
      if (shadowedText !== undefined) seen = shadowedText;
      continue;
    }
    for (const [field, value] of Object.entries(entry.change)) {
      if (value === undefined || NON_MERGED_FIELDS.has(field)) continue;
      if (field === 'componentPropAssignments') {
        out[field] = mergeAssignments(
          out[field] as ComponentPropAssignment[] | undefined,
          value as ComponentPropAssignment[],
        );
      } else {
        out[field] = value;
      }
      if (field === 'textData') {
        text.textLevel = entry.level;
        seen = (value as NodeChange['textData'])?.characters;
      }
    }
    // After the whole entry: an entry carrying both describes its own text.
    if (entry.change.derivedTextData !== undefined) {
      text.derivedLevel = entry.level;
      text.derivedFor = seen;
    }
  }
  const change = out as NodeChange;
  followStyles(change, styles);
  dropStaleDerivedData(change, text);
  return change;
}

/** Where a merged text's characters and its derived layout came from (instance levels; undefined = the base node). */
interface TextProvenance {
  textLevel: number | undefined;
  derivedLevel: number | undefined;
  /** Characters the level of the winning derived layout had assigned (shadowed property values included). */
  derivedFor: string | undefined;
}

/** Replaces paints of a (fresh, unshared) change by those of its referenced styles. */
export function followStyles(change: NodeChange, styles: StyleLookup): void {
  const out = change as Record<string, unknown>;
  for (const [styleField, paintField] of STYLE_PAINT_FIELDS) {
    const styleId = change[styleField];
    if (!styleId || (isNullGuid(styleId.guid) && !styleId.assetRef?.key)) continue;
    const paints = styles(styleId)?.fillPaints;
    if (paints) out[paintField] = paints;
  }
}

/**
 * Figma's computed text layout (`derivedTextData`: baselines, glyphs) is
 * only valid for the text it was computed for, so a layout that does not fit
 * the final characters is dropped and consumers never render glyphs of
 * another string. It fits when its last baseline ends at the string's length
 * — in code points or UTF-16 units, the two index units `text-index.ts`
 * recognises — and every glyph's `firstCharacter` lies inside the string in
 * that unit.
 *
 * Entries are applied inner → outer level, so a layout from an INNER level
 * than the winning `textData` may describe text overridden afterwards. A
 * fitting length is no proof ("Inner" overridden with "Outer" fits, and its
 * glyphs would draw "Inner"), so such a layout is kept only with positive
 * provenance: the text its own level assigned (a shadowed property value
 * counts; the base node counts as the innermost level) is the final string.
 * That is the case of simple-design-system's "Sign in" button: the nested
 * instance assigns "Sign in" through a component property that the outer
 * level re-assigns with the same value. A kept inner layout must also draw
 * the final string's character pattern (`glyphPatternFits`).
 */
function dropStaleDerivedData(change: NodeChange, text: TextProvenance): void {
  const derived = change.derivedTextData;
  if (!derived) return;
  const characters = change.textData?.characters;
  const derivedIsInner =
    text.textLevel !== undefined && (text.derivedLevel === undefined || text.derivedLevel > text.textLevel);
  const fit = characters === undefined ? undefined : layoutFits(derived, characters);
  const stale =
    fit === false ||
    (derivedIsInner && (characters !== text.derivedFor || (characters !== undefined && !glyphPatternFits(derived, characters))));
  if (stale) delete (change as Record<string, unknown>).derivedTextData;
}

/**
 * A cheap identity check of a layout against `characters`: two glyphs drawn
 * with the same outline and advance stand for the same character (compared
 * case-insensitively: a text case transform draws "a" and "A" alike). Wrong
 * for "Inner" laid out and shown as "Outer" (both "n" glyphs would be "u"
 * and "t"). Glyphs whose character cannot be located in `characters` fail.
 */
function glyphPatternFits(derived: NonNullable<NodeChange['derivedTextData']>, characters: string): boolean {
  const codePoints = [...characters];
  const units = derived.baselines?.at(-1)?.endCharacter === characters.length && codePoints.length !== characters.length ? undefined : codePoints;
  const charAt = (i: number): string | undefined => (units ? units[i] : characters[i])?.toLowerCase();
  const byGlyph = new Map<string, string>();
  for (const glyph of derived.glyphs ?? []) {
    if (glyph.firstCharacter === undefined || glyph.commandsBlob === undefined || glyph.advance === undefined) continue;
    const ch = charAt(glyph.firstCharacter);
    if (ch === undefined) return false;
    const key = `${glyph.commandsBlob}|${glyph.advance}|${glyph.fontSize}`;
    const known = byGlyph.get(key);
    if (known === undefined) byGlyph.set(key, ch);
    else if (known !== ch) return false;
  }
  return true;
}

/** Whether a derived layout is consistent with `characters`; undefined when it has no baseline end to check. */
function layoutFits(derived: NonNullable<NodeChange['derivedTextData']>, characters: string): boolean | undefined {
  const baselines = derived.baselines;
  const end = baselines?.[baselines.length - 1]?.endCharacter;
  if (typeof end !== 'number') return undefined;
  if (end !== characters.length && end !== codePointLength(characters)) return false;
  return (derived.glyphs ?? []).every((glyph) => glyph.firstCharacter === undefined || glyph.firstCharacter < end);
}

function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  return n;
}

/** Assignment lists merge per `defID`; later lists win. */
export function mergeAssignments(
  base: readonly ComponentPropAssignment[] | undefined,
  over: readonly ComponentPropAssignment[],
): ComponentPropAssignment[] {
  if (!base || base.length === 0) return [...over];
  const byDef = new Map<string, ComponentPropAssignment>();
  const order: string[] = [];
  for (const list of [base, over]) {
    for (const assignment of list) {
      const def = guidKey(assignment.defID);
      if (!def) continue;
      if (!byDef.has(def)) order.push(def);
      byDef.set(def, assignment);
    }
  }
  return order.map((def) => byDef.get(def)!);
}

// ---------------------------------------------------------------------------
// Component properties
// ---------------------------------------------------------------------------

/** A `componentPropRefs` entry found in a symbol's own subtree. */
export interface PropRef {
  defID: string;
  field: ComponentPropNodeField;
  /** Override key of the referencing node (path element relative to the symbol). */
  key: string;
}

/**
 * Converts a property value to the partial NodeChange it stands for on a
 * referencing node, or `undefined` when the assignment carries no usable value
 * for that field (e.g. unresolved variable aliases).
 *
 * Older files store the value in `value`; newer ones (also) in `varValue.value`
 * like a variable value (`textDataValue`, `symbolIdValue.guid`, `boolValue`).
 */
export function propValueChange(assignment: ComponentPropAssignment, field: ComponentPropNodeField): NodeChange | undefined {
  const value = assignment.value;
  const varValue = assignment.varValue?.value;
  switch (field) {
    case 'VISIBLE': {
      const visible = value?.boolValue ?? varValue?.boolValue;
      return visible === undefined ? undefined : { visible };
    }
    case 'TEXT_DATA': {
      const text = value?.textValue ?? varValue?.textDataValue;
      if (!text || text.characters === undefined) return undefined;
      // A property value replaces the whole text. It carries characters and
      // line metadata but normally no per-character style ids; then the
      // node's mixed-style table no longer lines up and is dropped (the node's
      // base style applies to all characters).
      return { textData: text.characterStyleIDs ? text : { ...text, styleOverrideTable: undefined, characterStyleIDs: undefined } };
    }
    case 'OVERRIDDEN_SYMBOL_ID': {
      const guid = value?.guidValue ?? varValue?.symbolIdValue?.guid;
      return isNullGuid(guid) ? undefined : { overriddenSymbolID: guid };
    }
    default:
      // INHERIT_FILL_STYLE_ID / SLOT_CONTENT_ID: not materialised.
      return undefined;
  }
}
