/**
 * Mapping between Figma's text indices and UTF-16 code unit offsets.
 *
 * `characterStyleIDs`, glyph `firstCharacter`, baseline `firstCharacter` /
 * `endCharacter` and `truncationStartIndex` all index the string in the same
 * unit. For BMP-only strings (every string in our real fixtures) code points
 * and UTF-16 code units coincide. For strings with astral characters
 * (emoji, …) the unit is detected per node, preferring code points — the
 * unit every real astral node we have uses (e.g. "🍪 We use cookies!" in
 * simple-design-system: 17 glyphs at 0…16, last baseline ending at 17):
 * - a glyph starting at a UTF-16 index that is the low half of a surrogate
 *   pair proves code points — no layout starts a glyph in the middle of a
 *   character;
 * - the last baseline's `endCharacter` always equals the string length in
 *   Figma's unit (verified on ~2,400 real nodes, truncated ones included),
 *   so it decides when it matches exactly one of the two lengths;
 * - a `characterStyleIDs` array longer than the code-point count can only be
 *   UTF-16 (absent a contradicting baseline);
 * - otherwise we assume code points, which is what fig2sketch (Sketch's
 *   official converter) documents.
 */
export interface IndexMap {
  unit: 'code-point' | 'utf16';
  /** Length of the string in Figma's unit. */
  length: number;
  /** Figma index → UTF-16 offset (clamped to [0, string length]). */
  toU16(index: number): number;
}

export interface IndexEvidence {
  lastBaselineEnd?: number;
  styleIdsLength?: number;
  /** `firstCharacter` of the layout's glyphs. */
  glyphStarts?: readonly number[];
}

export function buildIndexMap(characters: string, evidence: IndexEvidence): IndexMap {
  const u16Length = characters.length;
  const offsets: number[] = [];
  for (let i = 0; i < u16Length; i++) {
    offsets.push(i);
    const code = characters.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < u16Length) {
      const next = characters.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  const cpLength = offsets.length;

  if (cpLength === u16Length) return utf16Map(u16Length);

  const lowSurrogate = (i: number): boolean => {
    const code = characters.charCodeAt(i);
    return code >= 0xdc00 && code <= 0xdfff && i > 0 && characters.charCodeAt(i - 1) >= 0xd800 && characters.charCodeAt(i - 1) <= 0xdbff;
  };
  const provesCodePoints = (evidence.glyphStarts ?? []).some((i) => Number.isInteger(i) && i > 0 && i < u16Length && lowSurrogate(i));

  const end = evidence.lastBaselineEnd;
  if (!provesCodePoints && end !== cpLength) {
    if (end === u16Length) return utf16Map(u16Length);
    if ((evidence.styleIdsLength ?? 0) > cpLength) return utf16Map(u16Length);
  }

  return {
    unit: 'code-point',
    length: cpLength,
    toU16(index) {
      if (!Number.isFinite(index) || index <= 0) return 0;
      if (index >= cpLength) return u16Length;
      return offsets[Math.floor(index)]!;
    },
  };
}

function utf16Map(length: number): IndexMap {
  return {
    unit: 'utf16',
    length,
    toU16(index) {
      if (!Number.isFinite(index) || index <= 0) return 0;
      return Math.min(Math.floor(index), length);
    },
  };
}
