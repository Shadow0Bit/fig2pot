/**
 * Vertical font metrics of the font files Penpot 2.19 serves (what both of its
 * renderers lay text out with), for the baseline model in `baseline.ts`.
 *
 * Read from the files themselves: the latin `woff2` subset that
 * `/internal/gfonts/css?family=<family>:400` points at (Google Fonts, as Penpot
 * proxies it) and, for the built-in Source Sans Pro, `/fonts/sourcesanspro-regular.ttf`.
 * Values are hhea ascender / |descender| / lineGap, or OS/2 typo metrics when
 * the font sets USE_TYPO_METRICS (for every family below they are equal). The
 * 700 instances have the same metrics as the 400 ones. Families not listed get
 * no baseline compensation.
 */
import { familyKey } from './fonts.ts';

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  /** Positive. */
  descender: number;
  lineGap: number;
}

/** [family, unitsPerEm, ascender, |descender|, lineGap]. */
const TABLE: readonly (readonly [string, number, number, number, number])[] = [
  ['Inter', 2048, 1984, 494, 0],
  ['Roboto', 2048, 1900, 500, 0],
  ['Roboto Mono', 2048, 2146, 555, 0],
  ['Open Sans', 2048, 2189, 600, 0],
  ['Lato', 2000, 1974, 426, 0],
  ['Montserrat', 1000, 968, 251, 0],
  ['Poppins', 1000, 1050, 350, 100],
  ['Noto Sans', 1000, 1069, 293, 0],
  ['Noto Serif', 1000, 1069, 293, 0],
  ['Geist', 1000, 1005, 295, 0],
  ['Merriweather', 2000, 1968, 546, 0],
  ['Playfair Display', 1000, 1082, 251, 0],
  ['DM Sans', 1000, 992, 310, 0],
  ['Manrope', 2000, 2132, 600, 0],
  ['IBM Plex Sans', 1000, 1025, 275, 0],
  ['Work Sans', 1000, 930, 243, 0],
  ['Nunito', 1000, 1011, 353, 0],
  ['Raleway', 1000, 940, 234, 0],
  ['Source Sans 3', 1000, 1024, 400, 0],
  ['Rubik', 1000, 935, 250, 0],
  ['Plus Jakarta Sans', 1000, 1038, 222, 0],
  ['Space Grotesk', 1000, 984, 292, 0],
  ['Roboto Slab', 2048, 2146, 555, 0],
  ['PT Sans', 1000, 1018, 276, 0],
  ['Oswald', 1000, 1193, 289, 0],
  ['Ubuntu', 1000, 932, 189, 28],
  ['Fira Sans', 1000, 935, 265, 0],
  ['Barlow', 1000, 1000, 200, 0],
  ['Mulish', 1000, 1005, 250, 0],
  ['Karla', 2000, 1834, 504, 0],
  ['Outfit', 1000, 1000, 260, 0],
  ['Figtree', 1000, 950, 250, 0],
  ['Lora', 1000, 1006, 274, 0],
  ['JetBrains Mono', 1000, 1020, 300, 0],
  ['Space Mono', 1000, 1120, 361, 0],
  ['Archivo', 1000, 878, 210, 0],
  ['Quicksand', 1000, 1000, 250, 0],
  ['Josefin Sans', 1000, 750, 250, 0],
  ['Libre Baskerville', 1000, 970, 270, 0],
  ['Crimson Text', 1024, 972, 359, 0],
  ['EB Garamond', 1000, 1007, 298, 0],
  ['Bebas Neue', 1000, 900, 300, 0],
  ['Noto Sans Mono', 1000, 1069, 293, 0],
  ['Source Code Pro', 1000, 984, 273, 0],
  ['Fira Code', 2000, 1980, 644, 0],
  ['IBM Plex Mono', 1000, 1025, 275, 0],
  ['Geist Mono', 1000, 1005, 295, 0],
  ['Libre Franklin', 1000, 966, 246, 0],
  ['Heebo', 2048, 2146, 862, 0],
  ['Hind', 1000, 1055, 546, 0],
  ['Cabin', 2000, 1930, 500, 0],
  ['Arimo', 2048, 1854, 434, 67],
  ['Titillium Web', 1000, 1133, 388, 0],
  ['Nunito Sans', 1000, 1011, 353, 0],
  ['Kanit', 1000, 1100, 395, 0],
  ['Exo 2', 1000, 999, 201, 0],
  ['Public Sans', 2000, 1900, 450, 0],
  ['Red Hat Display', 1000, 1018, 305, 0],
  ['Sora', 1000, 970, 290, 0],
  ['Lexend', 1000, 1000, 250, 0],
  ['Urbanist', 2000, 1900, 500, 0],
  // Built in: the leaf `fontFamily` is the font id.
  ['sourcesanspro', 2048, 1950, 702, 0],
];

const BY_KEY = new Map<string, FontMetrics>(
  TABLE.map(([family, unitsPerEm, ascender, descender, lineGap]) => [familyKey(family), { unitsPerEm, ascender, descender, lineGap }]),
);

/** Metrics of a Penpot leaf's `fontFamily` (the Google family name, or `sourcesanspro`); undefined when unknown. */
export function penpotFontMetrics(fontFamily: string): FontMetrics | undefined {
  return BY_KEY.get(familyKey(fontFamily));
}
