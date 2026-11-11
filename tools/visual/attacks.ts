/**
 * Injected-defect fixtures for the acceptance metric (README "Acceptance", calibration table).
 * Each attack takes a real, perfect board (by default the auto-layout-playground "Flexible
 * resizing" reference, 1280×720) and produces a reference / candidate pair with one defect —
 * or with a difference that must be forgiven. Ported from the metric audit's `attack.ts`.
 *
 *   node tools/visual/attacks.ts [base.png]      # prints the table (old perceptual vs new visual / local)
 *
 * diff.test.ts runs the same list as regression tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cropReferencePadding, decodePng, diffDecoded, visualPasses, type DiffResult, type Image } from './diff.ts';

/** The default base board: a section, 1280×720 after Figma's 40 px margin is cropped. */
export const ATTACK_BASE = join(import.meta.dirname, '..', '..', 'test', 'refs', 'auto-layout-playground', '2411-12302.png');

export function loadAttackBase(path = ATTACK_BASE): Image | null {
  if (!existsSync(path)) return null;
  return cropReferencePadding(decodePng(new Uint8Array(readFileSync(path))), { width: 1280, height: 720 }).image;
}

export interface Attack {
  name: string;
  /**
   * What the acceptance rule must say: 'fail' (a defect), 'pass' (a difference to forgive), or
   * 'limit' (a defect the rule is known not to catch, README "Blind spots"; not asserted).
   */
  expect: 'fail' | 'pass' | 'limit';
  ref: Image;
  cand: Image;
}

type Rgb = number[];

export function buildAttacks(base: Image): Attack[] {
  const W = base.width;
  const H = base.height;
  const clone = (i: Image): Image => ({ width: i.width, height: i.height, data: new Uint8Array(i.data) });
  const px = (i: Image, x: number, y: number): Rgb => {
    const o = (Math.min(H - 1, Math.max(0, y)) * i.width + Math.min(W - 1, Math.max(0, x))) * 4;
    return [i.data[o]!, i.data[o + 1]!, i.data[o + 2]!];
  };
  const set = (i: Image, x: number, y: number, c: Rgb): void => {
    const o = (y * i.width + x) * 4;
    i.data[o] = c[0]!;
    i.data[o + 1] = c[1]!;
    i.data[o + 2] = c[2]!;
    i.data[o + 3] = 255;
  };
  const lum = (c: Rgb): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  const fill = (i: Image, x0: number, y0: number, w: number, h: number, c: Rgb): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(i, x, y, c);
  };
  const copy = (src: Image, sx: number, sy: number, w: number, h: number, dst: Image, dx: number, dy: number): void => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(dst, dx + x, dy + y, px(src, sx + x, sy + y));
  };
  /** Recolours "ink" (darker than bg) from `from` to `to` inside a region, keeping its coverage. */
  const recolour = (i: Image, x0: number, y0: number, w: number, h: number, from: Rgb, to: Rgb, bg: Rgb): void => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const c = px(i, x, y);
        const t = Math.max(0, Math.min(1, (lum(bg) - lum(c)) / (lum(bg) - lum(from))));
        set(i, x, y, [0, 1, 2].map((k) => Math.round(bg[k]! * (1 - t) + to[k]! * t)));
      }
    }
  };
  /** Horizontal (or isotropic) dilation of ink by a fraction f of a pixel: blend towards the darkest neighbour. */
  const embolden = (i: Image, x0: number, y0: number, w: number, h: number, f: number, both = false): void => {
    const src = clone(i);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const c = px(src, x, y);
        let best = c;
        const nb = [px(src, x - 1, y), px(src, x + 1, y)];
        if (both) nb.push(px(src, x, y - 1), px(src, x, y + 1));
        for (const q of nb) if (lum(q) < lum(best)) best = q;
        set(i, x, y, [0, 1, 2].map((k) => Math.round(c[k]! * (1 - f) + best[k]! * f)));
      }
    }
  };
  const shiftRegion = (i: Image, x0: number, y0: number, w: number, h: number, dx: number, dy: number, bg: Rgb): void => {
    const src = clone(i);
    fill(i, x0, y0, w, h, bg);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = x0 + x + dx;
        const ty = y0 + y + dy;
        if (tx >= 0 && ty >= 0 && tx < W && ty < H) set(i, tx, ty, px(src, x0 + x, y0 + y));
      }
    }
  };
  /** Bilinear resample of the whole image displaced by (dx, dy) px (sub-pixel re-rasterisation). */
  const resample = (i: Image, dx: number, dy: number): Image => {
    const o = clone(i);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = x - dx;
        const sy = y - dy;
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const c00 = px(i, x0, y0);
        const c10 = px(i, x0 + 1, y0);
        const c01 = px(i, x0, y0 + 1);
        const c11 = px(i, x0 + 1, y0 + 1);
        set(o, x, y, [0, 1, 2].map((k) => Math.round(c00[k]! * (1 - fx) * (1 - fy) + c10[k]! * fx * (1 - fy) + c01[k]! * (1 - fx) * fy + c11[k]! * fx * fy)));
      }
    }
    return o;
  };
  /**
   * Different anti-aliasing ramp: every pixel between the lightest and darkest of its 3×3
   * neighbourhood is re-blended with coverage t → t^gamma (the extremes stay put).
   */
  const aaGamma = (i: Image, gamma: number): Image => {
    const o = clone(i);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let lo = px(i, x, y);
        let hi = lo;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = px(i, x + dx, y + dy);
            if (lum(q) < lum(lo)) lo = q;
            if (lum(q) > lum(hi)) hi = q;
          }
        }
        const span = lum(hi) - lum(lo);
        if (span < 24) continue;
        const c = px(i, x, y);
        const t = (lum(hi) - lum(c)) / span;
        const t2 = t ** gamma;
        set(o, x, y, [0, 1, 2].map((k) => Math.round(hi[k]! * (1 - t2) + lo[k]! * t2)));
      }
    }
    return o;
  };
  /** Supersampled rounded rect (fill + inside stroke). */
  const roundRect = (i: Image, rx: number, ry: number, rw: number, rh: number, r: number, fillC: Rgb, strokeC: Rgb, sw: number, bg: Rgb, pad = 3): void => {
    const S = 4;
    for (let y = Math.floor(ry - pad); y < Math.ceil(ry + rh + pad); y++) {
      for (let x = Math.floor(rx - pad); x < Math.ceil(rx + rw + pad); x++) {
        let fa = 0;
        let sa = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const X = x + (sx + 0.5) / S;
            const Y = y + (sy + 0.5) / S;
            const inside = (X0: number, Y0: number, w: number, h: number, rr: number): boolean => {
              if (X < X0 || X > X0 + w || Y < Y0 || Y > Y0 + h) return false;
              const cx = Math.max(X0 + rr, Math.min(X, X0 + w - rr));
              const cy = Math.max(Y0 + rr, Math.min(Y, Y0 + h - rr));
              return (X - cx) ** 2 + (Y - cy) ** 2 <= rr * rr;
            };
            if (inside(rx, ry, rw, rh, r)) {
              if (inside(rx + sw, ry + sw, rw - 2 * sw, rh - 2 * sw, Math.max(0, r - sw))) fa++;
              else sa++;
            }
          }
        }
        const nn = S * S;
        set(i, x, y, [0, 1, 2].map((k) => Math.round(bg[k]! * (1 - (fa + sa) / nn) + (fillC[k]! * fa + strokeC[k]! * sa) / nn)));
      }
    }
  };
  /** Soft drop shadow (0 4 12 12 % black) under a rounded 348×332 card, drawn into `i`. */
  const shadow = (i: Image): void => {
    const x0 = 824;
    const y0 = 120;
    const w = 348;
    const h = 332;
    const rad = 16;
    const m = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad));
        const cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad));
        m[y * W + x] = (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad && x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h ? 1 : 0;
      }
    }
    const blur = (src: Float32Array, r: number): Float32Array => {
      const o = new Float32Array(src.length);
      const t = new Float32Array(src.length);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let s = 0;
          let k = 0;
          for (let d = -r; d <= r; d++) if (x + d >= 0 && x + d < W) (s += src[y * W + x + d]!), k++;
          t[y * W + x] = s / k;
        }
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let s = 0;
          let k = 0;
          for (let d = -r; d <= r; d++) if (y + d >= 0 && y + d < H) (s += t[(y + d) * W + x]!), k++;
          o[y * W + x] = s / k;
        }
      }
      return o;
    };
    let sh: Float32Array = new Float32Array(W * H);
    for (let y = 4; y < H; y++) for (let x = 0; x < W; x++) sh[y * W + x] = m[(y - 4) * W + x]!;
    for (let k = 0; k < 3; k++) sh = blur(sh, 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (m[y * W + x]) continue;
        const al = sh[y * W + x]! * 0.12;
        if (al <= 0) continue;
        set(i, x, y, px(i, x, y).map((v) => Math.round(v * (1 - al))));
      }
    }
  };

  const WHITE = [255, 255, 255];
  const INK = [0x1e, 0x1e, 0x1e];
  const panel = px(base, 20, 20);
  const block = px(base, 900, 200);
  const out: Attack[] = [];
  const add = (name: string, expect: Attack['expect'], ref: Image, cand: Image): void => void out.push({ name, expect, ref, cand });
  const edit = (f: (c: Image) => void): Image => {
    const c = clone(base);
    f(c);
    return c;
  };
  const card = (rad: number, dx = 0, dy = 0): Image =>
    edit((i) => {
      fill(i, 836, 133, 324, 168, WHITE);
      roundRect(i, 840 + dx, 137 + dy, 316, 158, rad, block, INK, 3, WHITE);
    });
  const darker = (d: Rgb): Image =>
    edit((c) => {
      for (let y = 137; y < 295; y++) {
        for (let x = 840; x < 1156; x++) {
          const q = px(base, x, y);
          if (Math.abs(q[0]! - block[0]!) < 4 && Math.abs(q[1]! - block[1]!) < 4) set(c, x, y, [block[0]! - d[0]!, block[1]! - d[1]!, block[2]! - d[2]!]);
        }
      }
    });
  const divider = (c: Rgb): Image => edit((r) => { for (let x = 440; x < 820; x++) set(r, x, 250, c); });

  add('identical', 'pass', base, clone(base));
  add('remove 16 px icon', 'fail', base, edit((c) => fill(c, 267, 309, 18, 18, WHITE)));
  add('swap 24 px icon for another', 'fail', base, edit((c) => copy(base, 296, 306, 24, 24, c, 266, 308)));
  add('replace a word ("Hug" glyphs → "Fixed")', 'fail', base, edit((c) => copy(base, 64, 498, 43, 18, c, 64, 398)));
  add('remove one line of body text', 'fail', base, edit((c) => fill(c, 64, 596, 262, 16, px(base, 300, 600))));
  add('remove a 316×34 text pill', 'fail', base, edit((c) => fill(c, 840, 305, 316, 34, px(base, 700, 700))));
  add('remove the 60×16 arrow', 'fail', base, edit((c) => fill(c, 726, 288, 60, 16, WHITE)));
  add('remove 8 px chevron', 'fail', base, edit((c) => fill(c, 156, 347, 14, 14, [0xf0, 0xf0, 0xf0])));
  add('paragraph text #1e1e1e → #555555', 'fail', base, edit((c) => recolour(c, 62, 108, 266, 120, INK, [0x55, 0x55, 0x55], panel)));
  add('paragraph text #1e1e1e → #808080', 'fail', base, edit((c) => recolour(c, 62, 108, 266, 120, INK, [0x80, 0x80, 0x80], panel)));
  add('paragraph text #1e1e1e → #3a3a3a', 'limit', base, edit((c) => recolour(c, 62, 108, 266, 120, INK, [0x3a, 0x3a, 0x3a], panel)));
  add('paragraph shifted 2 px', 'fail', base, edit((c) => shiftRegion(c, 60, 104, 270, 124, 0, 2, panel)));
  add('missing 1 px divider #808080', 'fail', divider([0x80, 0x80, 0x80]), base);
  add('missing 1 px divider #d0d0d0', 'fail', divider([0xd0, 0xd0, 0xd0]), base);
  add('missing 1 px divider #e5e5e5', 'fail', divider([0xe5, 0xe5, 0xe5]), base);
  add('border 3 → 5 px (1 px per side)', 'limit', base, edit((c) => { for (const [x, y, w, h] of [[818, 140, 18, 300], [1158, 140, 18, 300], [840, 114, 300, 20], [840, 440, 300, 16]] as const) embolden(c, x, y, w, h, 1, true); }));
  add('corner radius 16 → 8', 'fail', card(16), card(8));
  add('corner radius 8 → 0', 'limit', card(8), card(0));
  add('corner radius 8 → 4', 'limit', card(8), card(4));
  add('soft shadow removed', 'fail', edit(shadow), base);
  add('large block fill 5 % darker', 'fail', base, darker([12, 12, 8]));
  add('large block fill 10 % darker', 'fail', base, darker([25, 25, 12]));
  add('paragraph shifted 1 px', 'pass', base, edit((c) => shiftRegion(c, 60, 104, 270, 124, 0, 1, panel)));
  add('paragraph emboldened 0.35 px', 'pass', base, edit((c) => embolden(c, 62, 108, 266, 120, 0.35)));
  add('whole board emboldened 0.5 px', 'pass', base, edit((c) => embolden(c, 0, 0, W, H, 0.5)));
  add('whole board re-rasterised 0.5 px right', 'pass', base, resample(base, 0.5, 0));
  // Bilinear resampling also blurs (a 1-px line loses peak ink), which a renderer re-rasterising at an offset does not.
  add('whole board resampled (0.3, 0.3) px (blurs)', 'limit', base, resample(base, 0.3, 0.3));
  add('anti-aliasing ramp gamma 0.6', 'pass', base, aaGamma(base, 0.6));
  add('anti-aliasing ramp gamma 1.6', 'pass', base, aaGamma(base, 1.6));
  add('16 px-radius card re-rendered at (+0.4, +0.3) px', 'pass', card(16), card(16, 0.4, 0.3));
  add('16 px-radius card re-rendered at +0.5 px', 'pass', card(16), card(16, 0.5, 0));
  add('paragraph text #1e1e1e → #262626', 'pass', base, edit((c) => recolour(c, 62, 108, 266, 120, INK, [0x26, 0x26, 0x26], panel)));
  return out;
}

export interface AttackScore {
  name: string;
  expect: Attack['expect'];
  result: DiffResult;
  pass: boolean;
}

export function scoreAttacks(base: Image, options: Parameters<typeof diffDecoded>[2] = {}): AttackScore[] {
  return buildAttacks(base).map((a) => {
    const { result } = diffDecoded(a.ref, a.cand, { ...options, offset: { x: 0, y: 0 } });
    return { name: a.name, expect: a.expect, result, pass: visualPasses(result) };
  });
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const base = loadAttackBase(process.argv[2]);
  if (!base) throw new Error(`no base image at ${process.argv[2] ?? ATTACK_BASE}`);
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`.padStart(8);
  console.log(`${'attack'.padEnd(44)} expect  perceptual  visual   regional local    mism  salient  verdict`);
  for (const s of scoreAttacks(base)) {
    const r = s.result;
    const ok = s.expect === 'limit' || s.pass === (s.expect === 'pass');
    console.log(
      `${s.name.padEnd(44)} ${s.expect.padEnd(6)} ${pct(r.perceptualAccuracy)}  ${pct(r.visualAccuracy)} ${pct(r.regionalAccuracy)} ${pct(r.localAccuracy)} ${String(r.visualMismatchedPixels).padStart(7)} ${String(r.salientPixels).padStart(8)}  ${s.pass ? 'PASS' : 'FAIL'}${ok ? '' : '  ✗ WRONG'}`,
    );
  }
}
