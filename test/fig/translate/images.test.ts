import { describe, expect, it } from 'vitest';
import { collectImages } from '../../../src/fig/translate/images.ts';
import type { FigDocument } from '../../../src/fig/types.ts';
import { fixture } from './helpers.ts';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 2]);

/** The smallest FigDocument `collectImages` reads: one image, a DOCUMENT node with `documentColorProfile`. */
function figDoc(documentColorProfile?: string): FigDocument {
  const change = documentColorProfile === undefined ? {} : { documentColorProfile };
  return { file: { images: new Map([['img', PNG_HEADER]]), blobs: [] }, root: { change }, byId: new Map() } as unknown as FigDocument;
}

describe('image assets', () => {
  it('marks images of files without a colour profile as drawn ignoring their embedded profile', () => {
    expect(collectImages(figDoc(), ['img'])['img']).toMatchObject({ mimeType: 'image/png', width: 4, height: 2, ignoresEmbeddedProfile: true });
    expect(collectImages(figDoc('LEGACY'), ['img'])['img']!.ignoresEmbeddedProfile).toBe(true);
  });

  it('leaves colour-managed files to the standard (embedded profiles applied)', () => {
    expect(collectImages(figDoc('SRGB'), ['img'])['img']!.ignoresEmbeddedProfile).toBeUndefined();
    expect(collectImages(figDoc('DISPLAY_P3'), ['img'])['img']!.ignoresEmbeddedProfile).toBeUndefined();
  });

  it('reads the profile of a real file', () => {
    const t = fixture('f2s-broken-images.fig');
    const assets = Object.values(t.ir.images);
    expect(assets.length).toBeGreaterThan(0);
    const legacy = (t.doc.root.change.documentColorProfile ?? 'LEGACY') === 'LEGACY';
    expect(assets.every((a) => (a.ignoresEmbeddedProfile === true) === legacy)).toBe(true);
  });
});
