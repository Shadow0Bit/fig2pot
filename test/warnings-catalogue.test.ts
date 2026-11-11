/**
 * docs/WARNINGS.md lists every warning code the converter can emit, and nothing else. Codes are found in src/
 * as the first string argument of a `warn…(` call (after an optional reporter / context argument) and as
 * `code: '…'` properties. A code built from a template literal is listed explicitly in `DYNAMIC`. Codes have
 * at least one hyphen, which leaves out the plain de-duplication keys of `warnOnce` (`budget`, `cycle:…`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/** Template-literal codes (the whole literal between its backticks, as written in src/) → the codes they can produce. */
const DYNAMIC: Record<string, string[]> = {
  'text-paragraph-${what}-clamped': ['text-paragraph-spacing-clamped', 'text-paragraph-indent-clamped'],
};

const CODE = String.raw`[a-z][a-z0-9]*(?:-[a-z0-9]+)+`;
const PATTERNS = [new RegExp(String.raw`\bwarn\w*\(\s*(?:[\w.]+,\s*)?(['\x60])(${CODE})`, 'g'), new RegExp(String.raw`\bcode:\s*(['\x60])(${CODE})`, 'g')];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

function emitted(): { codes: Set<string>; unknownDynamic: string[] } {
  const codes = new Set<string>();
  const unknownDynamic: string[] = [];
  for (const file of sources(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const m of text.matchAll(pattern)) {
        const after = m.index + m[0].length;
        // A code that continues into a substitution (`text-paragraph-${what}-clamped`); `font-unavailable|${…}`
        // is a de-duplication key whose code is the part before the `|`.
        if (m[1] === '`' && /^-?\$\{/.test(text.slice(after, after + 3))) {
          const literal = text.slice(after - m[2]!.length, text.indexOf('`', after));
          const expanded = DYNAMIC[literal];
          if (expanded) expanded.forEach((c) => codes.add(c));
          else unknownDynamic.push(`${file.slice(ROOT.length + 1)}: ${literal}`);
        } else codes.add(m[2]!);
      }
    }
  }
  return { codes, unknownDynamic };
}

function documented(): string[] {
  const doc = readFileSync(join(ROOT, 'docs/WARNINGS.md'), 'utf8');
  return [...doc.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]!);
}

describe('docs/WARNINGS.md', () => {
  const { codes, unknownDynamic } = emitted();
  const listed = documented();

  it('finds the emitted codes (sanity check of the extraction)', () => {
    expect(codes.size).toBeGreaterThan(100);
    for (const code of ['paint-baked', 'text-outlined-list', 'instance-budget-exceeded', 'text-paragraph-indent-clamped']) expect(codes).toContain(code);
  });

  it('knows every code built from a template literal', () => {
    expect(unknownDynamic, 'add these to DYNAMIC in this test').toEqual([]);
  });

  it('lists every emitted code', () => {
    expect([...codes].filter((c) => !listed.includes(c)).sort()).toEqual([]);
  });

  it('lists only emitted codes, each once', () => {
    expect(listed.filter((c) => !codes.has(c)).sort()).toEqual([]);
    expect(listed.filter((c, i) => listed.indexOf(c) !== i)).toEqual([]);
  });
});
