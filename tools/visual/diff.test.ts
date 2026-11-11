/**
 * Unit tests for diff.ts (synthetic images, no Penpot needed):
 *
 *   node --test tools/visual/diff.test.ts
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import pixelmatch from 'pixelmatch';
import type { PenpotShape } from './penpot.ts';
import { exportBounds } from './run.ts';
import { buildAttacks, loadAttackBase } from './attacks.ts';
import { cropReferencePadding, decodePng, diffDecoded, diffImages, encodePng, flatten, MIN_LOCAL, NEUTRAL_BACKGROUND, register, VISUAL_ALLOWANCE, visualPasses, type DiffResult, type Image } from './diff.ts';

type Rgba = [number, number, number, number];

function mk(w: number, h: number, paint: (x: number, y: number) => Rgba): Image {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      data.set(c, (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

const CLEAR: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];

/** Area of pixel (x, y) covered by the rectangle [x0, x1) × [y0, y1) (box-filter anti-aliasing). */
function coverage(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const cx = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0));
  const cy = Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
  return cx * cy;
}

/** Black rect on white, coverage blended in sRGB (gamma = 1) or with a gamma ramp (≠ AA ramp of another renderer). */
function aaRect(w: number, h: number, r: [number, number, number, number], gamma = 1): Image {
  return mk(w, h, (x, y) => {
    const c = coverage(x, y, ...r) ** (1 / gamma);
    const v = Math.round(255 * (1 - c));
    return [v, v, v, 255];
  });
}

/** Pads an image with transparent pixels. */
function pad(img: Image, left: number, top: number, right: number, bottom: number): Image {
  const w = img.width + left + right;
  const h = img.height + top + bottom;
  return mk(w, h, (x, y) => {
    const sx = x - left;
    const sy = y - top;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) return CLEAR;
    const i = (sy * img.width + sx) * 4;
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
  });
}

const square = (c: Rgba, bg: Rgba = WHITE) => (x: number, y: number): Rgba => (x >= 40 && x < 60 && y >= 40 && y < 60 ? c : bg);

describe('metrics', () => {
  it('identical images score 1, a recoloured square scores 0 on content', () => {
    const a = mk(100, 100, square(BLACK));
    const same = diffImages(encodePng(a), encodePng(a)).result;
    assert.equal(same.accuracy, 1);
    assert.equal(same.contentAccuracy, 1);
    assert.deepEqual(same.offset, { x: 0, y: 0 });
    const other = diffDecoded(a, mk(100, 100, square([255, 0, 0, 255]))).result;
    assert.deepEqual(other.offset, { x: 0, y: 0 });
    assert.equal(other.mismatchedPixels, 400);
    assert.equal(other.accuracy, 1 - 400 / 10_000);
    assert.equal(other.contentPixels, 400);
    assert.equal(other.contentAccuracy, 0, 'content metric ignores the flat background');
  });

  it('transparent vs transparent is a match and not content', () => {
    const a = mk(100, 100, square(BLACK, CLEAR));
    const r = diffDecoded(a, a).result;
    assert.equal(r.reference.background, 'transparent');
    assert.equal(r.contentPixels, 400);
    assert.equal(r.contentAccuracy, 1);
  });

  it('white overflow on one side is a mismatch (composited over neutral grey, not white)', () => {
    assert.deepEqual([...NEUTRAL_BACKGROUND], [128, 128, 128]);
    // Reference: 20×20 black square. Candidate: same square with a 5 px white outside stroke, padded.
    const ref = mk(20, 20, () => BLACK);
    const cand = mk(50, 50, (x, y) => (x >= 15 && x < 35 && y >= 15 && y < 35 ? BLACK : x >= 10 && x < 40 && y >= 10 && y < 40 ? WHITE : CLEAR));
    const r = diffDecoded(ref, cand).result;
    assert.deepEqual(r.offset, { x: -15, y: -15 });
    assert.equal(r.contentPixels, 900);
    assert.equal(r.contentMismatchedPixels, 900 - 400);
    assert.equal(r.boundsMismatch, true);
    assert.deepEqual(r.boundsDelta, { left: 5, top: 5, right: 5, bottom: 5 });
    // Over white the stroke would have been invisible against the uncovered area.
    const flat = flatten({ data: new Uint8Array([0, 0, 0, 0]), width: 1, height: 1 });
    assert.deepEqual([...flat.data], [128, 128, 128, 255]);
  });
});

describe('registration', () => {
  it('finds asymmetric export padding exactly', () => {
    const ref = mk(100, 80, (x, y) => (x > 10 && x < 70 && y > 5 && y < 60 ? [200, 30, 30, 255] : x > 50 && y > 50 ? [20, 20, 200, 255] : CLEAR));
    const cand = pad(ref, 7, 3, 12, 5);
    const r = diffDecoded(ref, cand).result;
    assert.deepEqual(r.offset, { x: -7, y: -3 });
    assert.equal(r.accuracy, 1);
    assert.equal(r.contentAccuracy, 1);
    assert.equal(r.boundsMismatch, false);
    assert.deepEqual(r.sizeDelta, { width: 19, height: 8 });
    assert.equal(r.width, 119);
    assert.equal(r.height, 88);
  });

  it('opaque board vs the same board with transparent padding', () => {
    const ref = mk(100, 100, square(BLACK));
    const cand = pad(ref, 10, 10, 10, 10);
    const r = diffDecoded(ref, cand).result;
    assert.deepEqual(r.offset, { x: -10, y: -10 });
    assert.equal(r.contentAccuracy, 1);
    assert.equal(r.accuracy, 1);
    assert.equal(r.boundsMismatch, false);
  });

  it('new-format reference (render bounds) vs a Penpot export with its own padding', () => {
    // Node box 20×20 with a 10 px outside stroke: Figma's PNG covers 40×40, box at (10, 10).
    const ref = mk(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? [255, 0, 0, 255] : BLACK));
    const cand = pad(ref, 15, 15, 15, 15); // 70×70, like the Penpot SVG exporter
    const r = diffDecoded(ref, cand, { referenceBox: { x: 10, y: 10, width: 20, height: 20 }, candidateBox: { x: 10, y: 10, width: 20, height: 20 } }).result;
    assert.deepEqual(r.registration.prior, { x: -15, y: -15 });
    assert.equal(r.registration.priorSource, 'selrect');
    assert.deepEqual(r.offset, { x: -15, y: -15 });
    assert.deepEqual(r.candidateBox, { x: 25, y: 25, width: 20, height: 20 });
    assert.equal(r.contentAccuracy, 1);
  });

  it('old-format reference (box only, outside stroke clipped) shows the overflow as mismatch', () => {
    const ref = mk(20, 20, () => [255, 0, 0, 255]);
    const cand = pad(mk(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? [255, 0, 0, 255] : BLACK)), 15, 15, 15, 15);
    const r = diffDecoded(ref, cand).result;
    assert.deepEqual(r.offset, { x: -25, y: -25 });
    assert.equal(r.contentPixels, 1600);
    assert.equal(r.contentMismatchedPixels, 1200);
    assert.equal(r.boundsMismatch, true);
  });

  it('featureless images fall back to the prior (centring), deterministically', () => {
    const ref = mk(30, 30, () => CLEAR);
    const cand = mk(40, 36, () => CLEAR);
    const a = register(ref, cand);
    const b = register(ref, cand);
    assert.deepEqual(a.offset, { x: -5, y: -3 });
    assert.deepEqual(a, b);
  });

  it('selrect prior: Penpot path bounds differ from the Figma node box', () => {
    // Figma VECTOR box 82×86 at page (-58, 229); its path (= Penpot selrect = render bounds) is
    // 74×74 at (-50, 235): the PNG covers the path only and the box sits at (-8, -6) in it.
    const ref = mk(75, 75, (x, y) => (x === 0 || y === 0 || x === 73 || y === 73 ? BLACK : CLEAR));
    const cand = pad(ref, 4, 4, 4, 4);
    const reg = register(ref, cand, { referenceBox: { x: -8, y: -6, width: 82, height: 86 }, candidateBox: { x: 0, y: 0, width: 74, height: 74 } });
    assert.deepEqual(reg.prior, { x: -4, y: -4 });
    assert.deepEqual(reg.offset, { x: -4, y: -4 });
    // Without the selrect the prior centres the Figma box, 4 px off; the search still wins.
    const centre = register(ref, cand, { referenceBox: { x: -8, y: -6, width: 82, height: 86 } });
    assert.deepEqual(centre.prior, { x: -8, y: -4 });
    assert.deepEqual(centre.offset, { x: -4, y: -4 });
  });

  it('ties go to the prior: a uniform opaque square inside a larger one', () => {
    // Every placement of the 10×10 candidate fully inside the 20×20 reference scores the same.
    const ref = mk(20, 20, () => BLACK);
    const cand = mk(10, 10, () => BLACK);
    assert.deepEqual(register(ref, cand).offset, { x: 5, y: 5 });
    assert.deepEqual(register(ref, cand, { referenceBox: { x: 2, y: 3, width: 10, height: 10 } }).offset, { x: 2, y: 3 });
  });

  it('2500×2500 pair: exact offset, bounded cost', () => {
    const ref = mk(2500, 2500, (x, y) => {
      if (((x >> 6) + (y >> 6)) % 3 === 0) return [(x * 7) & 255, (y * 3) & 255, 90, 255];
      return x > 1200 && y < 400 ? CLEAR : WHITE;
    });
    const cand = pad(ref, 37, 12, 21, 50);
    const t0 = performance.now();
    const reg = register(ref, cand);
    const ms = performance.now() - t0;
    assert.deepEqual(reg.offset, { x: -37, y: -12 });
    console.log(`      register 2500×2500 vs ${cand.width}×${cand.height}: ${ms.toFixed(0)} ms, ${reg.evaluated} offsets over ${reg.levels} levels`);
    const t1 = performance.now();
    const r = diffDecoded(ref, cand).result;
    console.log(`      full diff: ${(performance.now() - t1).toFixed(0)} ms`);
    assert.equal(r.contentAccuracy, 1);
  });
});

describe('sub-pixel tolerance', () => {
  // Explicit offset 0: registration would otherwise undo a global shift. (Real boards have
  // many features, so a shift of one part relative to the rest survives registration.)
  const at0 = { offset: { x: 0, y: 0 } };
  const raw = (a: Image, b: Image): number =>
    pixelmatch(flatten(a).data, flatten(b).data, null, a.width, a.height, { threshold: 0.1, includeAA: false });

  it('hard-edged rect shifted by 1 px → mismatch along the two vertical edges', () => {
    const a = aaRect(60, 40, [10, 10, 40, 30]);
    const b = aaRect(60, 40, [11, 10, 41, 30]);
    const r = diffDecoded(a, b, at0).result;
    assert.equal(r.mismatchedPixels, 2 * 20);
  });

  it('anti-aliased rect shifted by 1 px → mismatch (pixelmatch alone forgives it as AA)', () => {
    const a = aaRect(60, 40, [10.5, 10, 40.5, 30]);
    const b = aaRect(60, 40, [11.5, 10, 41.5, 30]);
    assert.equal(raw(a, b), 0, 'pixelmatch includeAA:false classifies the whole 1-px shift as anti-aliasing');
    const r = diffDecoded(a, b, at0).result;
    assert.ok(r.mismatchedPixels >= 2 * 2 * 20 - 8, `mismatched ${r.mismatchedPixels}`);
    assert.ok(r.shiftedPixels > 0);
  });

  it('thin anti-aliased line shifted by 1 px → mismatch', () => {
    const a = aaRect(40, 40, [10.5, 5, 11.5, 35]);
    const b = aaRect(40, 40, [11.5, 5, 12.5, 35]);
    const r = diffDecoded(a, b, at0).result;
    assert.ok(r.mismatchedPixels >= 2 * 30, `mismatched ${r.mismatchedPixels}`);
  });

  it('same rect, different anti-aliasing ramp (gamma 1 vs 2.2) → match', () => {
    const a = aaRect(60, 40, [10.3, 10.7, 40.6, 30.2]);
    const b = aaRect(60, 40, [10.3, 10.7, 40.6, 30.2], 2.2);
    const r = diffDecoded(a, b, at0).result;
    assert.equal(r.mismatchedPixels, 0);
    assert.ok(r.antialiasedPixels > 0, 'the ramps do differ beyond the colour threshold');
  });

  it('half-pixel shift of an edge → match', () => {
    const a = aaRect(60, 40, [10.5, 10, 40, 30]);
    const b = aaRect(60, 40, [11, 10, 40, 30]);
    assert.equal(diffDecoded(a, b, at0).result.mismatchedPixels, 0);
  });

  it('one part shifted by 1 px relative to the rest survives registration', () => {
    const paint = (dx: number) => (x: number, y: number): Rgba => {
      if (x >= 5 && x < 95 && y >= 5 && y < 40) return [30, 30, 160, 255];
      const c = coverage(x, y, 20.5 + dx, 50, 60.5 + dx, 90);
      const v = Math.round(255 * (1 - c));
      return [v, v, v, 255];
    };
    const r = diffDecoded(mk(100, 100, paint(0)), mk(100, 100, paint(1))).result;
    assert.deepEqual(r.offset, { x: 0, y: 0 });
    assert.ok(r.contentMismatchedPixels >= 2 * 2 * 40 - 8, `mismatched ${r.contentMismatchedPixels}`);
  });
});

describe('reference padding beyond render bounds', () => {
  it('a section PNG padded by 40 px is cropped to its render bounds', () => {
    const inner = mk(60, 50, (x, y) => (x > 10 && y > 10 && x < 30 ? BLACK : WHITE));
    const ref = pad(inner, 40, 40, 40, 40);
    const r = diffDecoded(ref, inner, { referenceBox: { x: 0, y: 0, width: 60, height: 50 }, referenceRenderSize: { width: 60, height: 50 }, candidateBox: { x: 0, y: 0, width: 60, height: 50 } }).result;
    assert.deepEqual(r.reference.croppedPadding, { left: 40, top: 40, right: 40, bottom: 40 });
    assert.equal(r.referencePaddingIrregular, false);
    assert.equal(r.reference.width, 60);
    assert.equal(r.reference.height, 50);
    assert.deepEqual(r.registration.prior, { x: 0, y: 0 });
    assert.deepEqual(r.offset, { x: 0, y: 0 });
    assert.deepEqual(r.candidateBox, { x: 0, y: 0, width: 60, height: 50 });
    assert.equal(r.contentAccuracy, 1);
  });

  it("neighbouring frames visible in the margin are not the section's content", () => {
    // f2s-prototyping 22:44: blocks of other top-level frames show in the reference's margin.
    const section = mk(120, 100, (x, y) => (x > 20 && x < 60 && y > 30 && y < 50 ? [30, 90, 200, 255] : WHITE));
    const ref = mk(200, 180, (x, y) => {
      if (x >= 40 && x < 160 && y >= 40 && y < 140) {
        const i = ((y - 40) * 120 + (x - 40)) * 4;
        return [section.data[i]!, section.data[i + 1]!, section.data[i + 2]!, 255];
      }
      return y >= 150 && (x >> 4) % 2 === 0 ? [240, 120, 0, 255] : CLEAR; // neighbours below
    });
    const opts = { referenceBox: { x: 0, y: 0, width: 120, height: 100 }, referenceRenderSize: { width: 120, height: 100 }, candidateBox: { x: 0, y: 0, width: 120, height: 100 } };
    const r = diffDecoded(ref, section, opts).result;
    assert.deepEqual(r.offset, { x: 0, y: 0 });
    assert.equal(r.perceptualAccuracy, 1);
    assert.equal(r.boundsMismatch, false);
  });

  it("a section's own overflowing children (inside renderBounds) are still compared", () => {
    // Box 100×80; a child sticks out 30 px to the right, so renderBounds is 130×80, and Figma
    // adds its 40 px margin around that: a 210×160 PNG with the box at (0, 0) of the render bounds.
    const board = (x: number, y: number): Rgba => (x < 100 ? (x > 10 && x < 40 && y > 10 && y < 30 ? BLACK : WHITE) : y > 20 && y < 60 ? [200, 0, 0, 255] : CLEAR);
    const rendered = mk(130, 80, board);
    const ref = pad(rendered, 40, 40, 40, 40);
    const { image, padding, irregular } = cropReferencePadding(ref, { width: 130, height: 80 });
    assert.deepEqual(padding, { left: 40, top: 40, right: 40, bottom: 40 });
    assert.equal(irregular, false);
    assert.equal(image.width, 130);
    assert.deepEqual([...image.data.subarray((40 * 130 + 120) * 4, (40 * 130 + 121) * 4)], [200, 0, 0, 255], 'the overflowing child survives the crop');
    const opts = { referenceBox: { x: 0, y: 0, width: 100, height: 80 }, referenceRenderSize: { width: 130, height: 80 }, candidateBox: { x: 0, y: 0, width: 100, height: 80 } };
    assert.equal(diffDecoded(ref, rendered, opts).result.perceptualAccuracy, 1);
    // A Penpot render that clips the child: the missing overflow is a mismatch.
    const clipped = mk(100, 80, board);
    const r = diffDecoded(ref, clipped, opts).result;
    assert.deepEqual(r.offset, { x: 0, y: 0 });
    assert.ok(r.perceptualMismatchedPixels >= 30 * 39, `mismatched ${r.perceptualMismatchedPixels}`);
    assert.equal(r.boundsMismatch, true);
    assert.equal(r.boundsDelta.right, -30);
  });

  it('a non-uniform surplus is left alone and flagged', () => {
    const img = mk(140, 50, () => WHITE);
    for (const size of [{ width: 60, height: 50 }, { width: 60, height: 10 }]) {
      const { image, padding, irregular } = cropReferencePadding(img, size);
      assert.equal(image, img);
      assert.equal(padding, null);
      assert.equal(irregular, true);
    }
    // ≤ 1 px is rounding, not padding; 1 px of asymmetry is tolerated.
    assert.deepEqual(cropReferencePadding(img, { width: 139, height: 50 }), { image: img, padding: null, irregular: false });
    assert.deepEqual(cropReferencePadding(mk(81, 80, () => WHITE), { width: 1, height: 1 }).padding, { left: 40, top: 39, right: 40, bottom: 40 });
    const r = diffDecoded(img, mk(60, 50, () => WHITE), { referenceRenderSize: { width: 60, height: 10 } }).result;
    assert.equal(r.referencePaddingIrregular, true);
    assert.equal(r.reference.croppedPadding, null);
  });
});

describe('registration: one-sided overflow and periodic content', () => {
  /** Text-like rows: 1.6 px stems every 6 px, 4 rows 20 px apart, on `bg`. */
  const glyphs = (w: number, h: number, bg: Rgba) =>
    mk(w, h, (x, y) => {
      const row = Math.floor((y - 10) / 20);
      if (row < 0 || row > 3 || (y - 10) % 20 >= 12 || x < 12 || x >= w - 12) return bg;
      const c = coverage(x, 0, Math.floor(x / 6) * 6 + 1.2, 0, Math.floor(x / 6) * 6 + 2.8, 1);
      const v = Math.round(255 * (1 - c));
      return bg[3] === 0 ? [0, 0, 0, Math.round(255 * c)] : [v, v, v, 255];
    });

  it('Contents case: candidate with invisible overflow on the right only, reference with a 40 px margin', () => {
    // auto-layout-playground 2411:13148: box 1280×720, PNG 1360×800, Penpot export 1333×720.
    const board = glyphs(320, 100, WHITE);
    const ref = pad(board, 40, 40, 40, 40);
    const cand = pad(board, 0, 0, 53, 0);
    const opts = { referenceBox: { x: 0, y: 0, width: 320, height: 100 }, referenceRenderSize: { width: 320, height: 100 }, candidateBox: { x: 0, y: 0, width: 320, height: 100 } };
    // register alone (uncropped): the box is 40 px into the PNG, at the candidate's left edge.
    const reg = register(ref, cand, opts);
    assert.deepEqual(reg.offset, { x: 40, y: 40 });
    assert.ok(reg.window.x[0] <= -13 && reg.window.x[1] >= 40, `window ${JSON.stringify(reg.window)}`);
    assert.ok(reg.priors.some((p) => p.name === 'start' && p.x === 40 && p.y === 40));
    const r = diffDecoded(ref, cand, opts).result;
    assert.deepEqual(r.offset, { x: 0, y: 0 });
    assert.equal(r.perceptualAccuracy, 1);
    assert.equal(r.contentAccuracy, 1);
    assert.equal(r.boundsMismatch, false);
    // With the predicted export area (box + the invisible overflow) the first prior is exact.
    const exact = diffDecoded(ref, cand, { ...opts, candidateExtent: { x: 0, y: 0, width: 373, height: 100 } }).result;
    assert.equal(exact.registration.priorSource, 'bounds');
    assert.deepEqual(exact.registration.prior, { x: 0, y: 0 });
    assert.ok(exact.registration.winner.includes('bounds'));
  });

  it('periodic rows with one-sided padding land on the right period', () => {
    // Transparent board: shifting by whole periods only loses the row ends. Padding 120 px on the
    // left (Penpot overflow there): the centred prior is 10 periods off, the 'end' prior is exact.
    const board = glyphs(600, 100, CLEAR);
    for (const [l, t, rr, b] of [
      [120, 0, 0, 0],
      [0, 0, 120, 0],
      [0, 36, 90, 0],
    ] as const) {
      const cand = pad(board, l, t, rr, b);
      const reg = register(board, cand, { referenceBox: { x: 0, y: 0, width: 600, height: 100 }, candidateBox: { x: 0, y: 0, width: 600, height: 100 } });
      assert.deepEqual(reg.offset, { x: -l || 0, y: -t || 0 }, `padding ${[l, t, rr, b]}: ${JSON.stringify(reg)}`);
      const r = diffDecoded(board, cand, { referenceBox: { x: 0, y: 0, width: 600, height: 100 }, candidateBox: { x: 0, y: 0, width: 600, height: 100 } }).result;
      assert.equal(r.perceptualAccuracy, 1);
      assert.equal(r.boundsMismatch, false);
    }
  });

  it('a wrong period found by the coarse search loses to a prior at full resolution', () => {
    // Rows of stems with period P on a transparent board; the candidate's stems are 1 px bolder
    // (another rasteriser) and it has 333 px of invisible overflow on the left. The coarse
    // levels alias the stems, the pyramid settles one or two periods off (the previous
    // registration returned −327 / −319 / −323), the exact 'end' prior wins at full resolution.
    for (const [P, on, W] of [
      [6, 2, 300],
      [7, 1, 700],
      [10, 2, 300],
    ] as const) {
      const rows = (stem: number) => mk(W, 120, (x, y) => (y % (2 * P) < P && x % P < stem && x > 3 && x < W - 4 && y > 2 && y < 117 ? BLACK : CLEAR));
      const ref = rows(on);
      const cand = pad(rows(on + 1), 333, 0, 0, 0);
      const opts = { referenceBox: { x: 0, y: 0, width: W, height: 120 }, candidateBox: { x: 0, y: 0, width: W, height: 120 } };
      const reg = register(ref, cand, opts);
      assert.deepEqual(reg.offset, { x: -333, y: 0 }, `period ${P}: ${JSON.stringify(reg)}`);
      assert.ok(reg.winner.includes('end'), `winner ${reg.winner}`);
      assert.deepEqual(register(ref, cand, opts), reg, 'deterministic');
      assert.equal(diffDecoded(ref, cand, opts).result.perceptualAccuracy, 1);
    }
  });
});

describe('exportBounds (the bounds prior)', () => {
  const shape = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<PenpotShape> = {}): PenpotShape => ({
    id,
    name: id,
    type,
    x,
    y,
    width: w,
    height: h,
    parentId: '',
    frameId: '',
    selrect: { x, y, width: w, height: h },
    ...extra,
  });
  it('a non-clipping board reaches its overflowing descendants, but not into clipping children', () => {
    // auto-layout-playground "Contents": a 1280 px section, an unfilled 613 px rect sticking out 53 px.
    const objects: Record<string, PenpotShape> = {
      s: shape('s', 'frame', 0, 0, 1280, 720, { showContent: true, shapes: ['g', 'c'] }),
      g: shape('g', 'group', 700, 200, 200, 100, { shapes: ['r'] }),
      r: shape('r', 'rect', 720, 217, 613, 292),
      c: shape('c', 'frame', 100, 100, 50, 50, { shapes: ['far'] }), // clips: showContent absent
      far: shape('far', 'rect', -500, -500, 10, 10),
    };
    assert.deepEqual(exportBounds(objects, objects.s!), { x: 0, y: 0, width: 1333, height: 720 });
    assert.deepEqual(exportBounds(objects, { ...objects.s!, showContent: false }), { x: 0, y: 0, width: 1280, height: 720 });
    assert.deepEqual(exportBounds(objects, objects.c!), { x: 100, y: 100, width: 50, height: 50 });
  });
});

describe('transparent vs visible overflow', () => {
  const board = mk(100, 100, square(BLACK));

  it('fully transparent overflow (an invisible text box sticking out) is free', () => {
    for (const cand of [pad(board, 0, 0, 250, 0), pad(board, 0, 0, 40, 0), pad(board, 0, 300, 0, 0)]) {
      const r = diffDecoded(board, cand, { referenceBox: { x: 0, y: 0, width: 100, height: 100 }, candidateBox: { x: 0, y: 0, width: 100, height: 100 } }).result;
      assert.equal(r.perceptualAccuracy, 1);
      assert.equal(r.contentAccuracy, 1);
      assert.equal(r.accuracy, 1);
      assert.equal(r.contentPixels, 400, 'same content as without the overflow');
      assert.equal(r.boundsMismatch, false);
      assert.equal(r.backgroundMismatch, false);
      assert.equal(r.candidate.background, '#ffffff');
    }
  });

  it('visible extra content counts and sets boundsMismatch', () => {
    const cand = mk(130, 100, (x, y) => (x < 100 ? square(BLACK)(x, y) : y < 50 ? [0, 0, 255, 255] : CLEAR));
    const r = diffDecoded(board, cand, { referenceBox: { x: 0, y: 0, width: 100, height: 100 }, candidateBox: { x: 0, y: 0, width: 100, height: 100 } }).result;
    assert.deepEqual(r.offset, { x: 0, y: 0 });
    assert.equal(r.boundsMismatch, true);
    assert.equal(r.boundsDelta.right, 30);
    assert.equal(r.contentMismatchedPixels, 30 * 50);
    assert.ok(r.perceptualAccuracy < 0.25, `perceptual ${r.perceptualAccuracy}`);
  });
});

describe('perceptual metric', () => {
  // Explicit offset 0 for the same reason as above. Black on white, all content is the shapes.
  const at0 = { offset: { x: 0, y: 0 } };
  const run = (a: Image, b: Image, radius?: number) => diffDecoded(a, b, { ...at0, perceptualRadius: radius }).result;
  /** Union of axis-aligned rects, box-filter anti-aliased. */
  const rects = (w: number, h: number, rs: [number, number, number, number][]): Image =>
    mk(w, h, (x, y) => {
      const c = Math.min(1, rs.reduce((s, r) => s + coverage(x, y, ...r), 0));
      const v = Math.round(255 * (1 - c));
      return [v, v, v, 255];
    });
  /** Text-like pattern: rows of 'glyphs' made of vertical stems and horizontal bars, `grow` px thicker (right/bottom). */
  const glyphs = (grow: number, dx = 0): Image => {
    const rs: [number, number, number, number][] = [];
    for (let row = 0; row < 3; row++) {
      const y = 10 + row * 24;
      for (let g = 0; g < 12; g++) {
        const x = 8 + g * 12 + dx + (g % 3) * 0.3;
        rs.push([x, y, x + 1.6 + grow, y + 14]); // stem
        rs.push([x, y + 6.4, x + 7, y + 7.8 + grow]); // bar
        if (g % 2) rs.push([x + 5.4, y, x + 7 + grow, y + 14]); // second stem
      }
    }
    return rects(170, 84, rs);
  };

  it('rect displaced by 1 px → match; strict flags the edges', () => {
    const r = run(aaRect(60, 40, [10, 10, 40, 30]), aaRect(60, 40, [11, 10, 41, 30]));
    assert.equal(r.contentMismatchedPixels, 40);
    assert.equal(r.perceptualMismatchedPixels, 0);
    assert.equal(r.perceptualAccuracy, 1);
  });

  it('anti-aliased rect displaced by 1 px diagonally → match', () => {
    const r = run(aaRect(60, 40, [10.5, 10.5, 40.5, 30.5]), aaRect(60, 40, [11.5, 11.5, 41.5, 31.5]));
    assert.ok(r.contentMismatchedPixels > 0);
    assert.equal(r.perceptualMismatchedPixels, 0);
  });

  it('rect displaced by 2 px → mismatch along both edges', () => {
    const r = run(aaRect(60, 40, [10, 10, 40, 30]), aaRect(60, 40, [12, 10, 42, 30]));
    // Per edge, two columns fail: at x = 10 the reference's black has no black within 1 px in
    // the candidate, at x = 11 the candidate's white has no white within 1 px in the reference
    // (same at the right edge). The corner pixels of the second column find white diagonally.
    assert.equal(r.perceptualMismatchedPixels, 2 * (2 * 20 - 2));
  });

  it('1-px-wide line displaced by 1 px → match; by 2 px → mismatch; missing → mismatch', () => {
    const line = (x: number) => rects(40, 40, [[x, 5, x + 1, 35]]);
    assert.equal(run(line(10), line(11)).perceptualMismatchedPixels, 0);
    assert.equal(run(line(10.5), line(11.5)).perceptualMismatchedPixels, 0, 'anti-aliased line');
    assert.equal(run(line(10), line(12)).perceptualMismatchedPixels, 2 * 30);
    const missing = run(line(10), rects(40, 40, []));
    assert.equal(missing.perceptualMismatchedPixels, 30);
    assert.equal(missing.perceptualAccuracy, 0);
  });

  it('colour change on a 10×10 area → mismatch everywhere', () => {
    const paint = (c: Rgba) => (x: number, y: number): Rgba => (x >= 20 && x < 30 && y >= 20 && y < 30 ? c : x >= 10 && x < 40 && y >= 10 && y < 40 ? [40, 90, 200, 255] : WHITE);
    const r = run(mk(50, 50, paint([200, 40, 40, 255])), mk(50, 50, paint([40, 160, 60, 255])));
    assert.equal(r.perceptualMismatchedPixels, 100);
    // A 3-px-wide strip in a colour beyond the threshold too.
    const strip = (c: Rgba) => mk(50, 50, (x, y) => (x >= 20 && x < 23 && y >= 5 && y < 45 ? c : WHITE));
    assert.equal(run(strip([200, 40, 40, 255]), strip([140, 40, 40, 255])).perceptualMismatchedPixels, 120);
  });

  it('a colour within the threshold everywhere is a match in both metrics', () => {
    const fill = (c: Rgba) => mk(30, 30, (x, y) => (x >= 5 && x < 25 && y >= 5 && y < 25 ? c : WHITE));
    const r = run(fill([200, 40, 40, 255]), fill([205, 42, 40, 255]));
    assert.equal(r.contentMismatchedPixels, 0);
    assert.equal(r.perceptualMismatchedPixels, 0);
  });

  it('text-like strokes: thickened by 1 px → match; by 2 px on one side or by 3 px → mismatch', () => {
    const base = glyphs(0);
    const plus1 = run(base, glyphs(1));
    assert.ok(plus1.contentAccuracy < 0.9, `strict ${plus1.contentAccuracy}`);
    assert.equal(plus1.perceptualMismatchedPixels, 0);
    const plus2 = run(base, glyphs(2));
    assert.ok(plus2.perceptualAccuracy < 0.9, `+2 one-sided: ${plus2.perceptualAccuracy}`);
    const plus3 = run(base, glyphs(3));
    assert.ok(plus3.perceptualAccuracy < 0.7, `+3: ${plus3.perceptualAccuracy}`);
    // Glyphs displaced by 1 px and 0.3 px sub-pixel offsets: forgiven. By 2 px: not.
    assert.equal(run(base, glyphs(0, 1)).perceptualMismatchedPixels, 0);
    assert.equal(run(base, glyphs(0, 0.4)).perceptualMismatchedPixels, 0);
    assert.ok(run(base, glyphs(0, 2)).perceptualAccuracy < 0.8);
  });

  it('LENIENCY: a stroke thickened symmetrically by 1 px per side (1 px → 3 px) is forgiven', () => {
    // Each edge moves by 1 px, which is exactly what the 3×3 neighbourhood forgives. Documented
    // in README (leniency table); the strict metric still flags it.
    const r = run(rects(40, 40, [[10, 5, 11, 35]]), rects(40, 40, [[9, 5, 12, 35]]));
    assert.equal(r.perceptualMismatchedPixels, 0);
    assert.equal(r.contentMismatchedPixels, 60);
  });

  it('LENIENCY: a uniform 1-px shift of the whole board is forgiven (registration aligns it anyway)', () => {
    const r = run(glyphs(0), glyphs(0, 1));
    assert.ok(r.contentAccuracy < 0.8, `strict ${r.contentAccuracy}`);
    assert.equal(r.perceptualAccuracy, 1);
  });

  it('the neighbourhood comes from the other image only (a busy image does not match itself)', () => {
    // Reference: checkerboard; candidate: the same checkerboard with one square inverted.
    // Every pixel of the inverted square has both colours in its own 3×3 neighbourhood but
    // the candidate's square interior has no matching colour within 1 px in the reference.
    const board = (flip: boolean) => mk(40, 40, (x, y) => {
      const odd = ((x >> 2) + (y >> 2)) & 1;
      const inSq = x >= 16 && x < 24 && y >= 16 && y < 24;
      return (odd ^ (flip && inSq ? 1 : 0)) ? BLACK : WHITE;
    });
    const r = run(board(false), board(true));
    assert.ok(r.perceptualMismatchedPixels > 0);
    // Hairline noise: 1-px dots alternating colours, shifted by 1 px → still matched (same colours nearby).
    assert.equal(run(rects(20, 20, []), rects(20, 20, [])).perceptualMismatchedPixels, 0);
  });

  it('text re-wrapped (last word moved to the next line) → mismatch', () => {
    const word = (x0: number, y0: number): [number, number, number, number][] =>
      [0, 1, 2, 3].flatMap((g) => [[x0 + g * 9, y0, x0 + g * 9 + 1.6, y0 + 12] as [number, number, number, number], [x0 + g * 9, y0 + 5.4, x0 + g * 9 + 6, y0 + 6.8] as [number, number, number, number]]);
    const a = rects(140, 50, [...word(5, 5), ...word(45, 5), ...word(85, 5)]);
    const b = rects(140, 50, [...word(5, 5), ...word(45, 5), ...word(5, 27)]);
    const r = run(a, b);
    assert.ok(r.perceptualAccuracy < 0.6, `perceptual ${r.perceptualAccuracy}`);
  });

  it('recolours are caught edge to edge (both directions must match)', () => {
    // Mid grey → black: the old grey lies on the black→white line of the new edge (A→B
    // forgives it), but the new black is not reachable from grey + white (B→A does not).
    const sq = (c: Rgba) => mk(30, 30, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? c : WHITE));
    assert.equal(run(sq([128, 128, 128, 255]), sq(BLACK)).perceptualMismatchedPixels, 100, 'grey → black');
    assert.equal(run(sq([240, 150, 150, 255]), sq([200, 40, 40, 255])).perceptualMismatchedPixels, 100, 'light → dark red');
    assert.equal(run(sq([200, 40, 40, 255]), sq([40, 40, 200, 255])).perceptualMismatchedPixels, 100, 'red → blue');
  });

  it('LENIENCY: a dark-grey hairline vs a black one is forgiven up to #414141 (≈ 75 % ink)', () => {
    // The overshoot that lets a slightly thicker stem reach full ink also lets a 1–2 px line
    // be up to ~25 % lighter. 3 px and wider: the interior pixel is caught.
    const line = (g: number, w = 1) => mk(30, 30, (x, y) => (x >= 15 && x < 15 + w && y >= 5 && y < 25 ? [g, g, g, 255] : WHITE));
    assert.equal(run(line(65), line(0)).perceptualMismatchedPixels, 0);
    assert.equal(run(line(65, 2), line(0, 2)).perceptualMismatchedPixels, 0);
    assert.equal(run(line(70), line(0)).perceptualAccuracy, 0);
    assert.equal(run(line(65, 3), line(0, 3)).perceptualMismatchedPixels, 18, 'middle column, minus its two end pixels');
  });

  // Uses the self-test's real renders (Inter vs Roboto, Penpot svg/wasm) when
  // `node tools/visual/selftest.ts` has been run; skipped otherwise.
  for (const renderer of ['svg', 'wasm']) {
    const work = process.env.FIG2POT_VISUAL_WORK ? resolve(process.env.FIG2POT_VISUAL_WORK) : join(import.meta.dirname, '.work');
    const dir = join(work, 'selftest', renderer, 'font-control');
    const have = existsSync(join(dir, 'report.json'));
    it(`font face: Roboto vs Inter (${renderer} self-test renders) stays below the 0.98 bar`, { skip: !have && 'run selftest.ts first' }, () => {
      for (const key of ['1-2', '1-3']) {
        const read = (sub: string): Uint8Array => new Uint8Array(readFileSync(join(dir, sub, `${key}.png`)));
        const r: DiffResult = diffImages(read('reference'), read('candidate')).result;
        console.log(`      ${renderer} ${key}: perceptual ${(r.perceptualAccuracy * 100).toFixed(2)} %, strict ${(r.contentAccuracy * 100).toFixed(2)} %, full ${(r.accuracy * 100).toFixed(2)} %`);
        assert.ok(r.perceptualAccuracy < 0.98, `${key}: ${r.perceptualAccuracy}`);
        assert.ok(r.perceptualAccuracy >= r.contentAccuracy);
      }
    });
  }

  it('radius 0 makes perceptual equal to strict content accuracy', () => {
    const r = run(aaRect(60, 40, [10, 10, 40, 30]), aaRect(60, 40, [11, 10, 41, 30]), 0);
    assert.equal(r.perceptualMismatchedPixels, r.contentMismatchedPixels);
    assert.equal(r.perceptualRadius, 0);
  });

  it('never stricter than the strict metric (forgiven AA stays forgiven)', () => {
    const a = aaRect(60, 40, [10.3, 10.7, 40.6, 30.2]);
    const b = aaRect(60, 40, [10.3, 10.7, 40.6, 30.2], 2.2);
    const r = run(a, b);
    assert.equal(r.perceptualMismatchedPixels, 0);
  });

  it('2500×2500 board: perceptual pass cost', () => {
    // Worse than any real board: dense text-like content everywhere, rendered 0.4 px thicker
    // and shifted 0.5 px (every edge pixel is a strict mismatch the pass has to forgive), plus
    // the left 10 % recoloured (glyphs red, background green: all wrong content).
    const paint = (grow: number, shift: number) => (x: number, y: number): Rgba => {
      const gx = x % 12;
      const gy = y % 24;
      const c = Math.min(1, coverage(gx, gy, 2 + shift, 4, 3.6 + shift + grow, 18) + coverage(gx, gy, 2 + shift, 10, 9 + shift, 11.4 + grow));
      const wrong = x < 250 && grow > 0;
      const v = Math.round(255 * (1 - c));
      return wrong ? [255 - v, v, 0, 255] : [v, v, v, 255];
    };
    const a = mk(2500, 2500, paint(0, 0));
    const b = mk(2500, 2500, paint(0.4, 0.5));
    const base = diffDecoded(a, b, { ...at0, perceptualRadius: 0 });
    const t0 = performance.now();
    const r = diffDecoded(a, b, at0).result;
    const ms = performance.now() - t0;
    const t1 = performance.now();
    diffDecoded(a, b, { ...at0, perceptualRadius: 0 });
    const ms0 = performance.now() - t1;
    console.log(`      2500×2500, ${r.contentMismatchedPixels} strict content mismatches: diff ${ms.toFixed(0)} ms with the perceptual pass, ${ms0.toFixed(0)} ms without (+${(ms - ms0).toFixed(0)} ms); perceptual ${(r.perceptualAccuracy * 100).toFixed(2)} %, strict ${(r.contentAccuracy * 100).toFixed(2)} %`);
    assert.equal(base.result.perceptualMismatchedPixels, base.result.contentMismatchedPixels);
    assert.ok(r.perceptualMismatchedPixels < r.contentMismatchedPixels);
    assert.ok(ms - ms0 < 500, `perceptual pass took ${(ms - ms0).toFixed(0)} ms`);
  });
});

describe('visual metric (acceptance)', () => {
  const at0 = { offset: { x: 0, y: 0 } };
  const run = (a: Image, b: Image): DiffResult => diffDecoded(a, b, at0).result;
  const grey = (v: number): Rgba => [v, v, v, 255];
  /** Text-like glyph rows (1.6-px stems) on a light background, inside [x0, x1) × [y0, y1). */
  const glyphs = (x0: number, y0: number, x1: number, y1: number, ink: Rgba = grey(30), bg: Rgba = grey(245), shift = 0) => (x: number, y: number): Rgba => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return bg;
    const gx = (x - x0) % 10;
    const gy = (y - y0) % 20;
    const c = Math.min(1, coverage(gx, gy, 2 + shift, 3, 3.6 + shift, 15) + coverage(gx, gy, 2 + shift, 8, 7.5 + shift, 9.4));
    return [0, 1, 2].map((k) => Math.round(bg[k]! * (1 - c) + ink[k]! * c)).concat(255) as Rgba;
  };

  it('identical boards score 1 with salient pixels; one flat colour is trivial', () => {
    const a = mk(200, 120, glyphs(20, 20, 180, 100));
    const r = run(a, a);
    assert.equal(r.visualAccuracy, 1);
    assert.equal(r.localAccuracy, 1);
    assert.ok(r.salientPixels > 0 && !r.trivial);
    const flat = mk(100, 60, () => grey(200));
    const t = run(flat, flat);
    assert.equal(t.salientPixels, 0);
    assert.ok(t.trivial, 'same flat colour = trivial');
    assert.ok(visualPasses(t));
    const clear = mk(50, 50, () => CLEAR);
    assert.ok(run(clear, clear).trivial, 'fully transparent = trivial');
  });

  it('matching flat fills are not salient: a big matching panel does not dilute an error next to it', () => {
    const scene = (panel: number, wrong: boolean) => (x: number, y: number): Rgba => {
      if (x < panel) return [200, 240, 200, 255];
      const g = glyphs(panel + 10, 10, panel + 110, 90)(x, y);
      return wrong && x >= panel + 10 && x < panel + 30 && y >= 10 && y < 30 ? grey(245) : g; // a removed "word"
    };
    const small = run(mk(140, 100, scene(20, false)), mk(140, 100, scene(20, true)));
    const big = run(mk(620, 100, scene(500, false)), mk(620, 100, scene(500, true)));
    assert.ok(small.visualMismatchedPixels > 0);
    assert.equal(big.visualMismatchedPixels, small.visualMismatchedPixels);
    assert.equal(big.salientPixels, small.salientPixels, 'the panel adds no salient pixels');
    // The old content metric is diluted by the panel; the visual one is not.
    assert.ok(big.perceptualAccuracy > small.perceptualAccuracy);
    assert.equal(big.visualAccuracy, small.visualAccuracy);
    assert.ok(!visualPasses(big), `removed word fails (local ${big.localAccuracy})`);
  });

  it('flat colour shifts beyond ~5 levels are mismatches in full; banding and gradients are not', () => {
    const w = 120;
    const h = 60;
    // the audit's selected-row blue (HyAB 0.027 apart; pixelmatch 0.1 calls it equal)
    const blue = run(mk(w, h, () => [69, 151, 247, 255]), mk(w, h, () => [11, 153, 254, 255]));
    assert.equal(blue.flatMismatchedPixels, w * h);
    assert.equal(blue.visualAccuracy, 0);
    const three = run(mk(w, h, () => grey(128)), mk(w, h, () => grey(131)));
    assert.equal(three.visualMismatchedPixels, 0, '3 grey levels are within FLAT_TOLERANCE');
    const six = run(mk(w, h, () => grey(128)), mk(w, h, () => grey(134)));
    assert.equal(six.visualAccuracy, 0, '6 grey levels are not');
    // a smooth gradient against the same gradient banded by ±2 levels, and displaced by 1 px
    const ramp = (dx: number, band: number) => (x: number): Rgba => grey(Math.round(40 + ((x + dx) * 150) / w) + (band && x % 7 < 3 ? band : 0));
    const banded = run(mk(w, h, ramp(0, 0)), mk(w, h, ramp(0, 2)));
    assert.equal(banded.visualMismatchedPixels, 0, `banding: ${banded.visualMismatchedPixels}`);
    assert.equal(banded.salientPixels, 0, 'a smooth gradient has no edges');
    assert.equal(run(mk(w, h, ramp(0, 0)), mk(w, h, ramp(1, 0))).visualMismatchedPixels, 0, 'gradient displaced by 1 px');
  });

  it('text: sub-pixel offsets pass; 2 px displacement and lighter ink fail', () => {
    const ref = mk(300, 200, glyphs(20, 20, 280, 180));
    assert.ok(visualPasses(run(ref, mk(300, 200, glyphs(20, 20, 280, 180, grey(30), grey(245), 0.25)))), '0.25 px');
    assert.ok(visualPasses(run(ref, mk(300, 200, glyphs(20, 20, 280, 180, grey(30), grey(245), 0.5)))), '0.5 px');
    assert.ok(visualPasses(run(ref, mk(300, 200, glyphs(21, 20, 281, 180)))), '1 px');
    const two = run(ref, mk(300, 200, glyphs(22, 20, 282, 180)));
    assert.ok(!visualPasses(two), `2 px: visual ${two.visualAccuracy} local ${two.localAccuracy}`);
    const light = run(ref, mk(300, 200, glyphs(20, 20, 280, 180, grey(0x55))));
    assert.ok(light.inkMismatchedPixels > 0, 'the ink test sees lighter ink');
    assert.ok(!visualPasses(light), `#1e → #55: local ${light.localAccuracy}`);
    assert.ok(visualPasses(run(ref, mk(300, 200, glyphs(20, 20, 280, 180, grey(36))))), '#1e → #24 is within the ink tolerance');
  });

  it('small boards: up to VISUAL_ALLOWANCE mismatched pixels pass the visual ratio; the local rule still applies', () => {
    // one glyph and six stray black pixels around it: below 98 %, within the allowance
    const tiny = mk(20, 20, glyphs(4, 2, 14, 18));
    const stray = mk(20, 20, glyphs(4, 2, 14, 18));
    for (const [x, y] of [[16, 4], [16, 15], [1, 10], [18, 10], [1, 3], [1, 16]] as const) stray.data.set(grey(0), (y * 20 + x) * 4);
    const r = run(tiny, stray);
    assert.equal(r.visualMismatchedPixels, 6);
    assert.ok(r.visualAccuracy < 0.98 && VISUAL_ALLOWANCE >= 6, `visual ${r.visualAccuracy}`);
    assert.ok(visualPasses(r), `visual ${r.visualAccuracy}, local ${r.localAccuracy}`);
    const c = mk(40, 20, (x, y) => (x >= 4 && x < 20 && y >= 2 && y < 18 ? grey(245) : glyphs(4, 2, 36, 18)(x, y))); // half the glyphs gone
    const gone = run(mk(40, 20, glyphs(4, 2, 36, 18)), c);
    assert.ok(gone.localAccuracy < MIN_LOCAL && !visualPasses(gone));
  });

  it('the diff image has a fourth (salience) panel', () => {
    const a = mk(50, 30, glyphs(5, 5, 45, 25));
    const png = decodePng(diffDecoded(a, a, at0).diffPng);
    assert.equal(png.width, 50 * 4 + 8 * 5);
    assert.equal(png.height, 30 + 16);
  });

  it('2500×2500 board: visual metric cost', () => {
    const paint = (grow: number, shift: number) => (x: number, y: number): Rgba => {
      const gx = x % 12;
      const gy = y % 24;
      const c = Math.min(1, coverage(gx, gy, 2 + shift, 4, 3.6 + shift + grow, 18) + coverage(gx, gy, 2 + shift, 10, 9 + shift, 11.4 + grow));
      const v = Math.round(255 * (1 - c));
      return x < 250 && grow > 0 ? [255 - v, v, 0, 255] : [v, v, v, 255];
    };
    const r = run(mk(2500, 2500, paint(0, 0)), mk(2500, 2500, paint(0.4, 0.5)));
    console.log(`      2500×2500: visual metric ${r.visualMs} ms, ${r.salientPixels} salient px, visual ${(r.visualAccuracy * 100).toFixed(2)} %, local ${(r.localAccuracy * 100).toFixed(2)} %`);
    assert.ok(r.visualMs < 1500, `${r.visualMs} ms`);
    assert.ok(!visualPasses(r), 'the recoloured strip fails');
  });

  // The metric audit's injected defects on a real 1280×720 board (test/refs; skipped without it).
  const base = loadAttackBase();
  describe('injected defects on a real board (attacks.ts)', { skip: !base && 'no test/refs/auto-layout-playground' }, () => {
    for (const attack of base ? buildAttacks(base) : []) {
      if (attack.expect === 'limit') continue;
      it(`${attack.expect === 'fail' ? 'caught' : 'forgiven'}: ${attack.name}`, () => {
        const r = run(attack.ref, attack.cand);
        const why = `visual ${(r.visualAccuracy * 100).toFixed(2)} %, regional ${(r.regionalAccuracy * 100).toFixed(2)} %, local ${(r.localAccuracy * 100).toFixed(2)} %`;
        assert.equal(visualPasses(r), attack.expect === 'pass', why);
      });
    }
  });
});
