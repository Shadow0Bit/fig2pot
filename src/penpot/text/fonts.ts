/**
 * Font resolution: IR family/weight/italic → Penpot `fontId` / `fontFamily` /
 * `fontVariantId` / `fontWeight` / `fontStyle`.
 *
 * Penpot knows three font backends (see penpot `common/src/app/common/fonts.cljs`
 * and `frontend/src/app/main/fonts.cljs`):
 *   - builtin: only "Source Sans Pro", id `sourcesanspro`, family `sourcesanspro`;
 *   - google:  id `gfont-<slug(family)>`, family = Google family name, variant ids
 *              `regular` | `italic` | `<weight>` | `<weight>italic`;
 *   - custom (team uploads): id `custom-<uuid>`, variant ids `<style>-<weight>`.
 * Fonts we cannot map get `fontId: ''` plus the original family name; Penpot's
 * `fix-deleted-fonts` pass re-points such text to a team font whose family
 * matches exactly, so uploading the font to the team fixes the file.
 */
import { GFONTS_CATALOGUE_DATA, GFONTS_SUBSETS } from './gfonts-catalogue.ts';

export interface FontVariant {
  id: string;
  weight: number;
  italic: boolean;
}

export interface ResolvedFont {
  backend: 'builtin' | 'google' | 'unavailable';
  fontId: string;
  fontFamily: string;
  fontVariantId: string;
  fontWeight: string;
  fontStyle: 'normal' | 'italic';
  /** True when the requested weight+italic exists exactly in the resolved family. */
  exact: boolean;
  /** The variant actually used (differs from the request when `exact` is false). */
  variant: FontVariant;
}

interface Family {
  backend: 'builtin' | 'google';
  id: string;
  family: string;
  variants: FontVariant[];
  /** Google Fonts subsets Penpot serves for the family (empty for the built-in font). */
  subsets: readonly string[];
}

/** Case-, space-, hyphen- and underscore-insensitive family key. */
export function familyKey(family: string): string {
  return family.normalize('NFKC').toLowerCase().replace(/[\s_\-]+/g, '');
}

/** cuerdas `str/slug` as applied to Google family names (all alphanumeric + spaces). */
function slug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

function googleVariantId(weight: number, italic: boolean): string {
  if (weight === 400) return italic ? 'italic' : 'regular';
  return italic ? `${weight}italic` : String(weight);
}

// Penpot `common/src/app/common/fonts.cljs` `local-fonts`.
const BUILTIN: Family = {
  backend: 'builtin',
  id: 'sourcesanspro',
  family: 'sourcesanspro',
  variants: [
    { id: '200', weight: 200, italic: false },
    { id: '200italic', weight: 200, italic: true },
    { id: '300', weight: 300, italic: false },
    { id: '300italic', weight: 300, italic: true },
    { id: 'regular', weight: 400, italic: false },
    { id: 'italic', weight: 400, italic: true },
    { id: '600', weight: 600, italic: false },
    { id: '600italic', weight: 600, italic: true },
    { id: 'bold', weight: 700, italic: false },
    { id: 'bolditalic', weight: 700, italic: true },
    { id: 'black', weight: 900, italic: false },
    { id: 'blackitalic', weight: 900, italic: true },
  ],
  subsets: [],
};

let catalogue: Map<string, Family> | undefined;

function getCatalogue(): Map<string, Family> {
  if (catalogue) return catalogue;
  const map = new Map<string, Family>();
  for (const line of GFONTS_CATALOGUE_DATA.split('\n')) {
    if (!line) continue;
    const [family, uprightMask, italicMask, subsetIds = ''] = line.split(';');
    if (!family || uprightMask === undefined || italicMask === undefined) continue;
    const upright = parseInt(uprightMask, 36);
    const italic = parseInt(italicMask, 36);
    const variants: FontVariant[] = [];
    for (let i = 0; i < 9; i++) {
      const weight = (i + 1) * 100;
      if (upright & (1 << i)) variants.push({ id: googleVariantId(weight, false), weight, italic: false });
      if (italic & (1 << i)) variants.push({ id: googleVariantId(weight, true), weight, italic: true });
    }
    if (variants.length === 0) continue;
    const key = familyKey(family);
    const subsets = subsetIds === '' ? [] : subsetIds.split('.').map((i) => GFONTS_SUBSETS[parseInt(i, 36)]!);
    if (!map.has(key)) map.set(key, { backend: 'google', id: `gfont-${slug(family)}`, family, variants, subsets });
  }
  // The builtin family wins over a same-named Google family (there is none today).
  map.set(familyKey('Source Sans Pro'), BUILTIN);
  catalogue = map;
  return map;
}

export function findFamily(family: string): Family | undefined {
  return getCatalogue().get(familyKey(family));
}

/**
 * Penpot's own nearest-variant rule (`app.common.fonts/closest-variant`):
 * smallest weight distance; on a tie the heavier weight; at equal weight the
 * variant whose style matches.
 */
export function closestVariant(variants: FontVariant[], weight: number, italic: boolean): FontVariant | undefined {
  let best: { v: FontVariant; distance: number } | undefined;
  for (const v of variants) {
    const distance = Math.abs(weight - v.weight);
    if (distance === 0 && v.italic === italic) return v;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && v.weight > best.v.weight) ||
      (v.weight === best.v.weight && v.italic === italic && best.v.italic !== italic)
    ) {
      best = { v, distance };
    }
  }
  return best?.v;
}

/** Normalises a CSS weight: finite, clamped to 1..1000, rounded. */
export function normalWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 400;
  return Math.min(1000, Math.max(1, Math.round(weight)));
}

export function resolveFont(familyName: string, weight: number, italic: boolean): ResolvedFont {
  const w = normalWeight(weight);
  const family = findFamily(familyName);
  if (family) {
    const variant = closestVariant(family.variants, w, italic);
    if (variant) {
      return {
        backend: family.backend,
        fontId: family.id,
        fontFamily: family.family,
        fontVariantId: variant.id,
        fontWeight: String(variant.weight),
        fontStyle: variant.italic ? 'italic' : 'normal',
        exact: variant.weight === w && variant.italic === italic,
        variant,
      };
    }
  }
  const trimmed = familyName.trim();
  const fontStyle = italic ? 'italic' : 'normal';
  return {
    backend: 'unavailable',
    fontId: '',
    // Penpot rejects blank font families; keep the original name otherwise.
    fontFamily: trimmed === '' ? BUILTIN.family : trimmed,
    // Same shape as a Penpot custom-font variant id, so a later team upload matches.
    fontVariantId: `${fontStyle}-${w}`,
    fontWeight: String(w),
    fontStyle,
    exact: false,
    variant: { id: `${fontStyle}-${w}`, weight: w, italic },
  };
}
