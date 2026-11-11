/**
 * Regenerates `src/penpot/text/advances-data.ts`: the horizontal advances of
 * the font files a local Penpot serves (tools/visual stack, Penpot 2.19), for
 * the families listed below, every weight and italic, the `latin` subset.
 *
 *   node test/penpot/text/tools/generate-advances.ts [penpot-url] > src/penpot/text/advances-data.ts
 *
 * Reads `/internal/gfonts/css?family=<family>:<variant>` (Penpot's Google
 * Fonts proxy) and the `latin` / `latin-ext` woff2 files it points at; parses
 * `cmap` and `hmtx`. Output: per family `unitsPerEm` and per variant id
 * (`regular`, `700italic`, …) contiguous code point ranges of advances in font
 * units, base 36: `start:a,b,c;start:…`.
 */
import { brotliDecompressSync } from 'node:zlib';

const FAMILIES = ['Inter'];
const BASE = process.argv[2] ?? 'http://localhost:9001';

const TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function woff2Tables(b: Buffer): Record<string, Buffer> {
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
  const tables: { tag: string; len: number; transformed: boolean }[] = [];
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
    tables.push({ tag, len: transformed ? b128() : orig, transformed });
  }
  const data = brotliDecompressSync(b.subarray(p, p + b.readUInt32BE(20)));
  const out: Record<string, Buffer> = {};
  let off = 0;
  for (const t of tables) {
    if (t.tag === 'hmtx' && t.transformed) throw new Error('transformed hmtx is not supported');
    out[t.tag] = data.subarray(off, off + t.len);
    off += t.len;
  }
  return out;
}

function cmap(t: Buffer): Map<number, number> {
  const map = new Map<number, number>();
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
          if (g) map.set(c, g);
        }
      }
    } else if (format === 12) {
      const groups = t.readUInt32BE(o + 12);
      for (let k = 0; k < groups; k++) {
        const s = t.readUInt32BE(o + 16 + 12 * k);
        const e = t.readUInt32BE(o + 20 + 12 * k);
        const g = t.readUInt32BE(o + 24 + 12 * k);
        for (let c = s; c <= e; c++) map.set(c, g + c - s);
      }
    }
  }
  return map;
}

async function variantAdvances(family: string, variant: string): Promise<{ upm: number; advances: Map<number, number> }> {
  const css = await (await fetch(`${BASE}/internal/gfonts/css?family=${encodeURIComponent(family)}:${variant}&display=block`)).text();
  const advances = new Map<number, number>();
  let upm = 0;
  for (const subset of ['latin']) {
    const m = new RegExp(`/\\* ${subset} \\*/[\\s\\S]*?url\\(([^)]+)\\)[\\s\\S]*?unicode-range: ([^;]+);`).exec(css);
    if (!m) continue;
    const t = woff2Tables(Buffer.from(await (await fetch(m[1]!)).arrayBuffer()));
    upm = t.head!.readUInt16BE(18);
    const metrics = t.hhea!.readUInt16BE(34);
    const ranges = m[2]!.split(',').map((r) => r.trim().replace(/^U\+/, '').split('-').map((x) => parseInt(x, 16)));
    const inRange = (c: number): boolean => ranges.some(([a, b]) => c >= a! && c <= (b ?? a)!);
    for (const [c, g] of cmap(t.cmap!)) if (inRange(c)) advances.set(c, t.hmtx!.readUInt16BE(4 * Math.min(g, metrics - 1)));
  }
  return { upm, advances };
}

function encode(advances: Map<number, number>): string {
  const cps = [...advances.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < cps.length) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j]! + 1) j++;
    parts.push(`${cps[i]!.toString(36)}:${cps.slice(i, j + 1).map((c) => advances.get(c)!.toString(36)).join(',')}`);
    i = j + 1;
  }
  return parts.join(';');
}

const lines: string[] = [];
for (const family of FAMILIES) {
  const variants: string[] = [];
  let upm = 0;
  for (const italic of [false, true]) {
    for (let w = 100; w <= 900; w += 100) {
      const id = w === 400 ? (italic ? 'italic' : 'regular') : `${w}${italic ? 'italic' : ''}`;
      const v = await variantAdvances(family, id);
      upm = v.upm;
      variants.push(`    '${id}': '${encode(v.advances)}',`);
    }
  }
  lines.push(`  '${family}': {\n    unitsPerEm: ${upm},\n    variants: {\n${variants.map((v) => '  ' + v).join('\n')}\n    },\n  },`);
}

process.stdout.write(`/**
 * Horizontal advances of the font files Penpot 2.19 serves — GENERATED, do not
 * edit by hand (test/penpot/text/tools/generate-advances.ts). Google Fonts
 * files (SIL OFL), \`latin\` subset, as Penpot's /internal/gfonts
 * proxy delivered them. Per variant: \`start:a,b,…\` runs of advances in font
 * units from code point \`start\`, base 36, separated by \`;\`.
 */
export const ADVANCES_DATA: Record<string, { unitsPerEm: number; variants: Record<string, string> }> = {
${lines.join('\n')}
};
`);
