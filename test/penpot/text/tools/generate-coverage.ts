/**
 * Regenerates `src/penpot/text/coverage-data.ts`: which characters the fonts
 * Penpot 2.19 serves contain, per renderer (`editability.ts`).
 *
 *   node test/penpot/text/tools/generate-coverage.ts <gfonts.json> [penpot-url] > src/penpot/text/coverage-data.ts
 *
 * - `SUBSET_RANGES`: the `unicode-range` of every named Google Fonts subset,
 *   read from Penpot's `/internal/gfonts/css` for the first catalogue family
 *   that has the subset (`<gfonts.json>`: Penpot's catalogue, as for
 *   generate-gfonts.ts). Sliced subsets (CJK: `[0]`, `[1]`, …) have no name
 *   and are left out.
 * - `MEASURED`: for the families of `metrics.ts` and the built-in Source Sans
 *   Pro, the code points actually present (regular weight):
 *   - `svg`: in the subset `woff2` files the CSS points at, each within its
 *     `unicode-range` (what Chromium gets in the SVG renderer);
 *   - `wasm`: in the full `ttf` of the catalogue (`files.regular`, which
 *     render-wasm loads through `/internal/gfonts/font`).
 *   Encoded as ranges `start+length`, base 36, delta-coded from the previous
 *   range's end, separated by `,`.
 * - `COMMONLY_ABSENT`: `latin` / `latin-ext` code points that at least half
 *   of the measured families lack (most of latin-ext beyond the common
 *   accented letters, U+2010–2012, U+2015, U+2021, U+2030, ↑ ↓, …).
 */
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

const [, , catalogue, BASE = 'http://localhost:9001'] = process.argv;
if (!catalogue) {
  process.stderr.write('usage: generate-coverage.ts <gfonts.json> [penpot-url]\n');
  process.exit(1);
}
const items = (JSON.parse(readFileSync(catalogue, 'utf8')) as { items: { family: string; subsets: string[]; files: Record<string, string> }[] }).items;

const TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** The `cmap` table of a woff2 (only that table is needed: untransformed in every woff2). */
function woff2Cmap(b: Buffer): Buffer {
  const n = b.readUInt16BE(12);
  let p = 48;
  const b128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const x = b[p++]!;
      v = (v << 7) | (x & 0x7f);
      if (!(x & 0x80)) return v >>> 0;
    }
    return v;
  };
  const tables: { tag: string; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const flags = b[p++]!;
    let tag: string;
    if ((flags & 63) === 63) {
      tag = b.toString('latin1', p, p + 4);
      p += 4;
    } else tag = TAGS[flags & 63]!;
    const orig = b128();
    const xf = (flags >> 6) & 3;
    const transformed = tag === 'glyf' || tag === 'loca' ? xf === 0 : xf !== 0;
    tables.push({ tag, len: transformed ? b128() : orig });
  }
  const data = brotliDecompressSync(b.subarray(p, p + b.readUInt32BE(20)));
  let off = 0;
  for (const t of tables) {
    if (t.tag === 'cmap') return data.subarray(off, off + t.len);
    off += t.len;
  }
  throw new Error('no cmap');
}

/** The `cmap` table of a TrueType / OpenType file. */
function sfntCmap(b: Buffer): Buffer {
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + 16 * i;
    if (b.toString('latin1', rec, rec + 4) === 'cmap') return b.subarray(b.readUInt32BE(rec + 8), b.readUInt32BE(rec + 8) + b.readUInt32BE(rec + 12));
  }
  throw new Error('no cmap');
}

function codePoints(t: Buffer): Set<number> {
  const out = new Set<number>();
  const count = t.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const o = t.readUInt32BE(4 + 8 * i + 4);
    const format = t.readUInt16BE(o);
    if (format === 4) {
      const segs = t.readUInt16BE(o + 6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = t.readUInt16BE(o + 14 + 2 * s);
        const start = t.readUInt16BE(o + 16 + 2 * segs + 2 * s);
        const delta = t.readInt16BE(o + 16 + 4 * segs + 2 * s);
        const ro = o + 16 + 6 * segs + 2 * s;
        const range = t.readUInt16BE(ro);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g = range === 0 ? (c + delta) & 0xffff : t.readUInt16BE(ro + range + 2 * (c - start));
          if (range !== 0 && g) g = (g + delta) & 0xffff;
          if (g) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = t.readUInt32BE(o + 12);
      for (let k = 0; k < groups; k++) {
        const s = t.readUInt32BE(o + 16 + 12 * k);
        const e = t.readUInt32BE(o + 20 + 12 * k);
        for (let c = s; c <= e; c++) out.add(c);
      }
    }
  }
  return out;
}

type Ranges = [number, number][];
const parseRanges = (spec: string): Ranges =>
  spec.split(',').map((r) => {
    const [a, b] = r.trim().replace(/^U\+/, '').split('-');
    return [parseInt(a!, 16), parseInt(b ?? a!, 16)];
  });
const inRanges = (ranges: Ranges, c: number): boolean => ranges.some(([a, b]) => c >= a && c <= b);

async function get(url: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt >= 3) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function css(family: string): Promise<{ subset: string; url: string; ranges: Ranges }[]> {
  const text = (await get(`${BASE}/internal/gfonts/css?family=${encodeURIComponent(family)}:regular&display=block`)).toString('utf8');
  const out: { subset: string; url: string; ranges: Ranges }[] = [];
  const re = /\/\* ([\w-]+) \*\/\s*@font-face \{[\s\S]*?url\(([^)]+)\)[\s\S]*?unicode-range: ([^;]+);/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) out.push({ subset: m[1]!, url: m[2]!, ranges: parseRanges(m[3]!) });
  return out;
}

function encode(points: Set<number>): string {
  const cps = [...points].sort((a, b) => a - b);
  const parts: string[] = [];
  let previous = 0;
  for (let i = 0; i < cps.length; ) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j]! + 1) j++;
    parts.push(`${(cps[i]! - previous).toString(36)}+${(j - i + 1).toString(36)}`);
    previous = cps[j]! + 1;
    i = j + 1;
  }
  return parts.join(',');
}

const formatRanges = (r: Ranges): string => r.map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`)).join(',');

// Subset ranges: first family (catalogue order) having each named subset.
const subsetRanges = new Map<string, Ranges>();
const wanted = new Set(items.flatMap((i) => i.subsets));
for (const item of items) {
  const missing = item.subsets.filter((s) => !subsetRanges.has(s) && !/^(japanese|korean|chinese-)/.test(s));
  if (missing.length === 0) continue;
  for (const face of await css(item.family)) if (!subsetRanges.has(face.subset) && wanted.has(face.subset)) subsetRanges.set(face.subset, face.ranges);
  if ([...wanted].every((s) => subsetRanges.has(s) || /^(japanese|korean|chinese-)/.test(s))) break;
}

const families = [...readFileSync(new URL('../../../../src/penpot/text/metrics.ts', import.meta.url), 'utf8').matchAll(/^ {2}\['([^']+)'/gm)].map((m) => m[1]!).filter((f) => f !== 'sourcesanspro');
const measured: string[] = [];
const svgSets: Set<number>[] = [];
for (const family of families) {
  const item = items.find((i) => i.family === family);
  if (!item) throw new Error(`not in the catalogue: ${family}`);
  const svg = new Set<number>();
  for (const face of await css(family)) for (const c of codePoints(woff2Cmap(await get(face.url)))) if (inRanges(face.ranges, c)) svg.add(c);
  const ttf = item.files.regular ?? Object.values(item.files)[0]!;
  const wasm = codePoints(sfntCmap(await get(ttf.replace('https://fonts.gstatic.com/s', `${BASE}/internal/gfonts/font`))));
  if (item.subsets.includes('latin') && item.subsets.includes('latin-ext')) svgSets.push(svg);
  measured.push(`  '${family}': { svg: '${encode(svg)}', wasm: '${encode(wasm)}' },`);
  process.stderr.write(`${family}: svg ${svg.size}, wasm ${wasm.size}\n`);
}
const builtin = codePoints(sfntCmap(await get(`${BASE}/fonts/sourcesanspro-regular.ttf`)));
measured.push(`  sourcesanspro: { svg: '${encode(builtin)}', wasm: '${encode(builtin)}' },`);

// Latin / latin-ext code points that at least half the measured families lack: not trusted for other families.
const latin = [...subsetRanges.get('latin')!, ...subsetRanges.get('latin-ext')!];
const commonlyAbsent = new Set<number>();
for (const [a, b] of latin) for (let c = a; c <= b; c++) if (svgSets.filter((set) => !set.has(c)).length * 2 >= svgSets.length) commonlyAbsent.add(c);

const names = [...subsetRanges.keys()].sort();
process.stdout.write(`/**
 * Character coverage of the fonts Penpot 2.19 serves — GENERATED, do not edit
 * by hand (test/penpot/text/tools/generate-coverage.ts). Google Fonts files
 * (SIL OFL) and \`unicode-range\`s as Penpot's /internal/gfonts proxy delivered
 * them; the built-in Source Sans Pro from /fonts.
 */

/** \`unicode-range\` of each named Google Fonts subset (hex, \`a-b\` or \`a\`). */
export const SUBSET_RANGES: Record<string, string> = {
${names.map((n) => `  '${n}': '${formatRanges(subsetRanges.get(n)!)}',`).join('\n')}
};

/**
 * Code points present in the files each renderer loads, regular weight:
 * \`svg\` the subset woff2 files within their ranges, \`wasm\` the full ttf.
 * Ranges \`gap+length\` (base 36), each gap from the previous range's end.
 */
export const MEASURED: Record<string, { svg: string; wasm: string }> = {
${measured.join('\n')}
};

/**
 * \`latin\` / \`latin-ext\` code points that at least half of the measured
 * families (${svgSets.length} with both subsets) lack in the files Penpot serves; same
 * encoding. Another family is not trusted to have them.
 */
export const COMMONLY_ABSENT = '${encode(commonlyAbsent)}';
`);
