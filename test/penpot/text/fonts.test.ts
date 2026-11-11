import { describe, expect, it } from 'vitest';
import { closestVariant, familyKey, findFamily, resolveFont } from '../../../src/penpot/text/fonts.ts';
import { fontIsAvailable } from '../../../src/penpot/text/index.ts';
import { style } from './helpers.ts';

describe('font catalogue', () => {
  it('matches family names regardless of case, spaces, hyphens', () => {
    expect(familyKey('Open Sans')).toBe(familyKey('open-sans'));
    expect(findFamily('OPEN  sans')?.family).toBe('Open Sans');
    expect(findFamily('Noto_Sans_JP')?.id).toBe('gfont-noto-sans-jp');
    expect(findFamily('Source Sans 3')?.id).toBe('gfont-source-sans-3');
    expect(findFamily('SF Pro Display')).toBeUndefined();
  });

  it('maps Source Sans Pro to the built-in font', () => {
    const f = resolveFont('Source Sans Pro', 700, true);
    expect(f).toMatchObject({
      backend: 'builtin',
      fontId: 'sourcesanspro',
      fontFamily: 'sourcesanspro',
      fontVariantId: 'bolditalic',
      fontWeight: '700',
      fontStyle: 'italic',
      exact: true,
    });
    expect(resolveFont('sourcesanspro', 400, false).fontVariantId).toBe('regular');
    expect(resolveFont('Source Sans Pro', 600, false).fontVariantId).toBe('600');
  });

  it('builds Google font ids and variant ids like Penpot', () => {
    expect(resolveFont('Inter', 400, false)).toMatchObject({ fontId: 'gfont-inter', fontFamily: 'Inter', fontVariantId: 'regular', exact: true });
    expect(resolveFont('inter', 400, true).fontVariantId).toBe('italic');
    expect(resolveFont('Inter', 700, false).fontVariantId).toBe('700');
    expect(resolveFont('Inter', 600, true).fontVariantId).toBe('600italic');
    expect(resolveFont('Roboto Mono', 500, false)).toMatchObject({ fontId: 'gfont-roboto-mono', fontFamily: 'Roboto Mono' });
  });

  it('falls back to the nearest variant using Penpot\'s rule, flagged inexact', () => {
    // Abel only has regular.
    expect(resolveFont('Abel', 700, false)).toMatchObject({ fontVariantId: 'regular', fontWeight: '400', exact: false });
    // ABeeZee: regular + italic only. 700 italic → 400 italic.
    expect(resolveFont('ABeeZee', 700, true)).toMatchObject({ fontVariantId: 'italic', fontStyle: 'italic', exact: false });
    // Built-in has no 500: equal distance to 400 and 600 → heavier wins.
    expect(resolveFont('Source Sans Pro', 500, false)).toMatchObject({ fontVariantId: '600', exact: false });
    // Non-hundred weights are inexact.
    expect(resolveFont('Inter', 450, false).exact).toBe(false);
  });

  it('closestVariant prefers the matching style at equal weight', () => {
    const variants = [
      { id: 'regular', weight: 400, italic: false },
      { id: 'italic', weight: 400, italic: true },
      { id: '700', weight: 700, italic: false },
    ];
    expect(closestVariant(variants, 400, true)?.id).toBe('italic');
    expect(closestVariant(variants, 300, true)?.id).toBe('italic');
    expect(closestVariant(variants, 700, true)?.id).toBe('700');
    expect(closestVariant([], 400, false)).toBeUndefined();
  });

  it('keeps unknown families by name with custom-style variant ids', () => {
    expect(resolveFont('  Acme Grotesk ', 500, true)).toMatchObject({
      backend: 'unavailable',
      fontId: '',
      fontFamily: 'Acme Grotesk',
      fontVariantId: 'italic-500',
      fontWeight: '500',
      fontStyle: 'italic',
      exact: false,
    });
    expect(resolveFont('', 400, false).fontFamily).toBe('sourcesanspro');
  });

  it('fontIsAvailable requires family and exact variant', () => {
    expect(fontIsAvailable(style({ fontFamily: 'Inter', fontWeight: 700, italic: true }))).toBe(true);
    expect(fontIsAvailable(style({ fontFamily: 'Source Sans Pro', fontWeight: 900 }))).toBe(true);
    expect(fontIsAvailable(style({ fontFamily: 'Source Sans Pro', fontWeight: 800 }))).toBe(false);
    expect(fontIsAvailable(style({ fontFamily: 'Abel', fontWeight: 400, italic: true }))).toBe(false);
    expect(fontIsAvailable(style({ fontFamily: 'Helvetica Neue' }))).toBe(false);
    expect(fontIsAvailable(style({ fontFamily: 'Inter', fontWeight: Number.NaN }))).toBe(true); // NaN → 400
  });
});
