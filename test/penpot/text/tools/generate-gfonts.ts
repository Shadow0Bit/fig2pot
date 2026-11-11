/**
 * Regenerates `src/penpot/text/gfonts-catalogue.ts` from Penpot's own Google
 * Fonts catalogue (the file Penpot bakes into its frontend at compile time).
 *
 *   curl -sL https://raw.githubusercontent.com/penpot/penpot/<sha>/common/resources/fonts/gfonts.<date>.json -o gfonts.json
 *   node test/penpot/text/tools/generate-gfonts.ts gfonts.json <penpot-sha> <date-fetched> > src/penpot/text/gfonts-catalogue.ts
 *
 * The output encodes, per family, two 9-bit masks (weights 100..900): bit
 * `w/100 - 1` is set when the upright / italic variant of weight `w` exists,
 * and the Google Fonts subsets Penpot serves for it (indices into
 * `GFONTS_SUBSETS`, base 36, `.`-separated).
 */
import { readFileSync } from 'node:fs';

const [, , path, sha = 'unknown', fetched = 'unknown'] = process.argv;
if (!path) {
  process.stderr.write('usage: generate-gfonts.ts <gfonts.json> [penpot-sha] [date]\n');
  process.exit(1);
}

const data = JSON.parse(readFileSync(path, 'utf8')) as { items: { family: string; variants: string[]; subsets: string[] }[] };
const subsets = [...new Set(data.items.flatMap((i) => i.subsets))].sort();
const rows: string[] = [];
for (const item of [...data.items].sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0))) {
  let upright = 0;
  let italic = 0;
  for (const v of item.variants) {
    const m = /^(\d+)?(italic)?$/.exec(v === 'regular' ? '400' : v === 'italic' ? '400italic' : v);
    if (!m || !m[1]) continue;
    const weight = Number(m[1]);
    if (weight % 100 !== 0 || weight < 100 || weight > 900) continue;
    const bit = 1 << (weight / 100 - 1);
    if (m[2]) italic |= bit;
    else upright |= bit;
  }
  if (item.family.includes(';') || item.family.includes('\n')) throw new Error(`bad family ${item.family}`);
  const subsetIds = item.subsets.map((n) => subsets.indexOf(n).toString(36)).join('.');
  rows.push(`${item.family};${upright.toString(36)};${italic.toString(36)};${subsetIds}`);
}

process.stdout.write(`/**
 * Google Fonts catalogue as known to Penpot — GENERATED, do not edit by hand
 * (see test/penpot/text/tools/generate-gfonts.ts).
 *
 * Source: penpot/penpot \`common/resources/fonts/${path.split('/').pop()}\` at commit ${sha},
 * fetched ${fetched}. That file is part of Penpot (MPL-2.0, Copyright (c) KALEIDOS
 * SUBSIDIARY SL) and lists the Google Fonts families/variants Penpot offers.
 * Only family names, available weights and subsets are kept here.
 *
 * Format: one family per line, \`Family;uprightMask;italicMask;subsets\`, masks in base 36,
 * bit (weight/100 - 1) set when that weight exists; subsets are \`.\`-separated base 36
 * indices into \`GFONTS_SUBSETS\`.
 */
export const GFONTS_SUBSETS: readonly string[] = ${JSON.stringify(subsets)};

export const GFONTS_CATALOGUE_DATA = \`
${rows.join('\n')}
\`;
`);
