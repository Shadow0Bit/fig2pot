/**
 * Image comparison for the visual harness (reference = Figma render,
 * candidate = Penpot render). Metric definitions are documented in README.md;
 * keep the two in sync.
 *
 * The two PNGs generally cover different areas: Figma's covers the node's
 * render bounds (its box plus outside strokes, shadows, overflowing children),
 * Penpot's exporter adds its own padding around the shape. So the pipeline is:
 *
 *   1. register: find the integer offset that places the candidate on the
 *      reference (`register`, a coarse-to-fine search over translations);
 *   2. compose: paste both onto one shared union canvas, transparent where an
 *      image does not reach, and composite each over NEUTRAL_BACKGROUND;
 *   3. compare every union pixel (pixelmatch + a half-pixel shift check) = the strict metrics;
 *   4. re-test each strict mismatch against the other image's neighbourhood = the perceptual one;
 *   5. the acceptance metric (`visualMetric`, README "Acceptance"): salient pixels (edge zone ∪
 *      flat mismatches), a tighter neighbourhood test, an ink test, and board / regional / local
 *      ratios; `visualPasses` is the pass rule.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** pixelmatch threshold (OKLab HyAB distance, 0..1, black vs white = 1). */
export const PIXELMATCH_THRESHOLD = 0.1;
/** A pixel is "background" when every RGB channel is within this of the image's background colour. */
export const BACKGROUND_TOLERANCE = 8;
/** Rendered extents (after registration) may differ by this many px per side before `boundsMismatch`. */
export const BOUNDS_TOLERANCE = 2;
/** Alpha (0..255) above which a pixel counts towards an image's rendered extent. */
export const EXTENT_ALPHA = 8;
/** Extra translations searched beyond every plausible placement of the node box, px per side. */
export const SEARCH_MARGIN = 3;
/**
 * Registration candidates scoring more than this factor worse than the best one are not refined
 * at the two finest pyramid levels (they dominate the cost). Every prior is still scored at
 * full resolution afterwards; one within this factor of the winner is refined there.
 */
export const PRUNE_RATIO = 1.5;
/**
 * Both images are composited over this colour before comparing. Mid grey, not white: a
 * white board edge or white overflow must not be indistinguishable from "nothing there".
 * Its own collision (a #808080 pixel vs transparent) is far rarer in designs than white.
 */
export const NEUTRAL_BACKGROUND: readonly [number, number, number] = [128, 128, 128];
/**
 * Half-pixel shift check: per-channel slack (0..255) on the interpolated range. Absorbs the
 * ±1 rounding of each renderer and of the averages themselves.
 */
export const SHIFT_TOLERANCE = 4;
/**
 * Perceptual metric: a strict mismatch is forgiven when, in the OTHER image, some pixel within
 * this Chebyshev distance (px) has a colour within PIXELMATCH_THRESHOLD of it, in both
 * directions. 1 = the 3×3 neighbourhood. 0 makes `perceptualAccuracy` equal `contentAccuracy`.
 */
export const PERCEPTUAL_RADIUS = 1;
/**
 * Perceptual metric: how far (as a fraction of the segment) the line between two adjacent
 * pixels of the other image may be continued beyond either end. Lets a stem rendered a fraction
 * of a pixel thicker reach full ink where the other renderer's thinner stem peaks at ~80–90 %
 * coverage. Zero on flat areas (no contrast, no slack). 0.25 is the smallest value that keeps
 * the audited text boards ≥ 99 % (at 0, Penpot's slightly bolder hinting fails a 14 px "Button"
 * at 97.9 %); 0.5 would also forgive a #5f5f5f hairline drawn as #000 (README, leniency table).
 */
export const PERCEPTUAL_OVERSHOOT = 0.25;

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Point, Size {}

/** Straight (non-premultiplied) RGBA. */
export interface Image {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Pixels per side. */
export interface Padding {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ImageInfo {
  /** Size of the image as compared (the reference after `croppedPadding` was removed). */
  width: number;
  height: number;
  /**
   * Reference only: padding cropped off the PNG before comparing (Figma's 40 px a side around
   * SECTION exports, which shows the rest of the page). null: nothing cropped.
   */
  croppedPadding?: Padding | null;
  /** Dominant colour as #rrggbb (composited over NEUTRAL_BACKGROUND), or "transparent". */
  background: string;
  /** Top-left of this image on the union canvas. */
  origin: Point;
  /** Bounding box of the pixels with alpha > EXTENT_ALPHA, on the union canvas (null: nothing visible). */
  extent: Rect | null;
}

export interface DiffResult {
  /** Union canvas = the area covered by either image after registration. Every metric is over it. */
  width: number;
  height: number;
  reference: ImageInfo;
  candidate: ImageInfo;
  /** Candidate top-left relative to the reference top-left, px (the registration result). */
  offset: Point;
  registration: {
    /** The primary prior: tie-breaker, and where featureless pairs land (see `Registration.prior`). */
    prior: Point;
    priorSource: PriorSource;
    /** Every starting candidate, deduplicated (name → offset). */
    priors: Prior[];
    /** Which candidates ended on the chosen offset: 'search' (the exhaustive coarse search) and/or prior names. */
    winner: string[];
    /** Registration phase that found it (see `Registration.phase`). */
    phase: Registration['phase'];
    /** Offsets searched at full resolution, inclusive, per axis. */
    window: { x: [number, number]; y: [number, number] };
    /** Pyramid levels (1 = full resolution only). */
    levels: number;
    /** Translations scored, over all pyramid levels. */
    evaluated: number;
    ms: number;
  };
  /** Where the Penpot shape's box (else the Figma box) lands in the candidate image: Penpot's export padding. */
  candidateBox: Rect | null;
  /** candidate − reference image size, px. Informational: Penpot pads its exports. */
  sizeDelta: { width: number; height: number };
  /**
   * How far the candidate's rendered extent sticks out beyond the reference's on each side
   * (negative = the reference sticks out). 0s when either image is fully transparent.
   */
  boundsDelta: { left: number; top: number; right: number; bottom: number };
  /** Some |boundsDelta| > BOUNDS_TOLERANCE. Informational; does not affect pass/fail. */
  boundsMismatch: boolean;
  /**
   * The reference PNG is larger than its render bounds, but not by a uniform margin (± 1 px):
   * it was compared uncropped, with its box shifted by half the surplus.
   */
  referencePaddingIrregular: boolean;
  /** The two images' dominant backgrounds differ (then every non-transparent pixel counts as content). */
  backgroundMismatch: boolean;
  totalPixels: number;
  mismatchedPixels: number;
  /** 1 − mismatched / total, over the union canvas. */
  accuracy: number;
  contentPixels: number;
  contentMismatchedPixels: number;
  /** 1 − mismatched / total, over content pixels only (1 when there is no content at all). */
  contentAccuracy: number;
  /**
   * Content pixels that are a strict mismatch AND fail the neighbourhood test (see
   * PERCEPTUAL_RADIUS) in at least one direction. Always ≤ contentMismatchedPixels.
   */
  perceptualMismatchedPixels: number;
  /** 1 − perceptualMismatched / contentPixels (1 when there is no content). The acceptance metric. */
  perceptualAccuracy: number;
  /** The neighbourhood radius used for `perceptualAccuracy`, px. */
  perceptualRadius: number;
  /** Pixels forgiven as anti-aliasing differences (pixelmatch AA + half-pixel check), union-wide. */
  antialiasedPixels: number;
  /** pixelmatch-AA pixels that the half-pixel check turned back into mismatches (≥ 1 px shifts). */
  shiftedPixels: number;
  /** Mean SSIM of luminance over 8×8 blocks of the union canvas. */
  ssim: number;
  /**
   * The acceptance metric (README "Acceptance"): salient = edge zone ∪ flat mismatches;
   * `visualAccuracy` = 1 − mismatched salient / salient; `localAccuracy` = its worst window.
   */
  salientPixels: number;
  edgePixels: number;
  edgeMismatchedPixels: number;
  flatMismatchedPixels: number;
  inkMismatchedPixels: number;
  visualMismatchedPixels: number;
  visualAccuracy: number;
  localAccuracy: number;
  localWorst: LocalWindow | null;
  localWindows: number;
  localWindowsBelow: number;
  regionalAccuracy: number;
  regionalWorst: LocalWindow | null;
  trivial: boolean;
  /** Visual-metric time, ms. */
  visualMs: number;
}

export interface DiffOptions {
  /** Where the node's own box sits inside the reference image, in reference px. Default: the whole image. */
  referenceBox?: Rect;
  /**
   * The size the reference PNG should have (render bounds × scale), which `referenceBox` is
   * relative to. When the PNG is larger by a uniform margin (Figma pads SECTION exports by
   * 40 px a side beyond their render bounds), `diffDecoded` crops the margin off
   * (`cropReferencePadding`); `register` alone shifts the box by half the surplus.
   */
  referenceRenderSize?: Size;
  /**
   * The Penpot shape's bounding box mapped into reference px (page-space selrect − render
   * bounds origin, × scale), in the same frame as `referenceBox`. The registration priors
   * place this box in the candidate (centred, top/left- or bottom/right-anchored); without it
   * they place the reference box.
   */
  candidateBox?: Rect;
  /**
   * The predicted area of Penpot's export, same frame: the union of the shape's and its
   * descendants' boxes when the shape does not clip (run.ts `exportBounds`), without stroke or
   * shadow padding. Gives the 'bounds' prior: this area centred in the candidate.
   */
  candidateExtent?: Rect;
  /** Override SEARCH_MARGIN. */
  margin?: number;
  /** Skip the search and use this offset (tests). */
  offset?: Point;
  /** Override PERCEPTUAL_RADIUS (px, integer ≥ 0). */
  perceptualRadius?: number;
  /** Override PERCEPTUAL_OVERSHOOT (experiments). */
  perceptualOvershoot?: number;
  /** Override the visual metric's tunables (experiments, calibration). */
  visual?: Partial<VisualParams>;
}

export interface DiffOutput {
  result: DiffResult;
  /**
   * Side-by-side PNG on the registered union canvas: reference | candidate | highlighted diff
   * (red = perceptual mismatch, blue = strict-only mismatch, yellow = forgiven anti-aliasing).
   */
  diffPng: Uint8Array;
}

// --- decoding ------------------------------------------------------------------

export function decodePng(bytes: Uint8Array): Image {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), width: png.width, height: png.height };
}

export function encodePng(img: Image): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  // One fixed filter: pngjs otherwise tries all five per row, which dominates on big boards.
  return new Uint8Array(PNG.sync.write(png, { filterType: 1, deflateLevel: 6 }));
}

// --- registration --------------------------------------------------------------

/** Premultiplied luminance and alpha, interleaved: [l0, a0, l1, a1, …]. */
interface Plane {
  w: number;
  h: number;
  v: Float32Array;
  /** Σ of all values (l + a). */
  mass: number;
}

function toPlane(img: Image): Plane {
  const n = img.width * img.height;
  const v = new Float32Array(n * 2);
  const d = img.data;
  let mass = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = d[i + 3]!;
    const l = ((0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) * a) / 255;
    v[p * 2] = l;
    v[p * 2 + 1] = a;
    mass += l + a;
  }
  return { w: img.width, h: img.height, v, mass };
}

/** 2× box downsample; pixels beyond an odd edge count as transparent (consistent with the union rule). */
function half(p: Plane): Plane {
  const w = Math.ceil(p.w / 2);
  const h = Math.ceil(p.h / 2);
  const v = new Float32Array(w * h * 2);
  let mass = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let l = 0;
      let a = 0;
      for (let yy = 2 * y; yy < Math.min(2 * y + 2, p.h); yy++) {
        for (let xx = 2 * x; xx < Math.min(2 * x + 2, p.w); xx++) {
          const k = (yy * p.w + xx) * 2;
          l += p.v[k]!;
          a += p.v[k + 1]!;
        }
      }
      const k = (y * w + x) * 2;
      v[k] = l / 4;
      v[k + 1] = a / 4;
      mass += (l + a) / 4;
    }
  }
  return { w, h, v, mass };
}

/**
 * L1 distance between the two planes over their union when `b` is placed at (dx, dy) on `a`,
 * pixels covered by one plane only being compared against transparent (0). Since
 * |x − y| = x + y − 2·min(x, y), that is massA + massB − 2·Σ_overlap min(a, b).
 */
function unionL1(a: Plane, b: Plane, dx: number, dy: number): number {
  const x0 = Math.max(0, dx);
  const x1 = Math.min(a.w, dx + b.w);
  const y0 = Math.max(0, dy);
  const y1 = Math.min(a.h, dy + b.h);
  let s = 0;
  if (x1 > x0) {
    const n = (x1 - x0) * 2;
    const av = a.v;
    const bv = b.v;
    for (let y = y0; y < y1; y++) {
      let ia = (y * a.w + x0) * 2;
      let ib = ((y - dy) * b.w + (x0 - dx)) * 2;
      const end = ia + n;
      for (; ia < end; ia++, ib++) {
        const p = av[ia]!;
        const q = bv[ib]!;
        s += p < q ? p : q;
      }
    }
  }
  return a.mass + b.mass - 2 * s;
}

interface Scored extends Point {
  score: number;
}

/** Where a prior's box placement comes from: the export-bounds prediction, the Penpot selrect, or the Figma box. */
export type PriorSource = 'bounds' | 'selrect' | 'centre';

/** A starting candidate of the registration. */
export interface Prior extends Point {
  /**
   * 'bounds': the predicted export area centred in the candidate. Otherwise `<x>/<y>` anchors of
   * the node box in the candidate, one word when both agree: 'centre' (symmetric export
   * padding), 'start' (box at the candidate's top/left: overflow only right/bottom), 'end' (box
   * at its bottom/right: overflow only left/top).
   */
  name: string;
}

export interface Registration {
  offset: Point;
  /** The primary prior (the first of `priors`): the tie-breaker, and where featureless pairs land. */
  prior: Point;
  priorSource: PriorSource;
  priors: Prior[];
  /** Labels of the candidates that ended on `offset`: 'search' and/or prior names. */
  winner: string[];
  /**
   * Where the winner was found: 'exhaustive' (the whole window at full resolution: small pairs),
   * 'pyramid' (coarse search + refinement), 'prior-check' (a prior scored at full resolution
   * after the pyramid beat it), 'fixed' (`options.offset`).
   */
  phase: 'exhaustive' | 'pyramid' | 'prior-check' | 'fixed';
  /** Searched offsets at full resolution, inclusive. */
  window: { x: [number, number]; y: [number, number] };
  evaluated: number;
  levels: number;
}

/** Pixel-operations budget for the exhaustive search at the coarsest pyramid level. */
const COARSE_BUDGET = 1 << 22;
/** Distinct local optima of the coarse search carried down the pyramid (besides the priors). */
const SURVIVORS = 3;

/**
 * `referenceBox`, `candidateBox` and `candidateExtent` in reference px, corrected for padding
 * beyond `referenceRenderSize` (shifted by half the surplus: symmetric padding assumed).
 */
export function effectiveBoxes(ref: Size, options: DiffOptions): { reference: Rect; candidate: Rect | null; extent: Rect | null } {
  const box = options.referenceBox ?? { x: 0, y: 0, width: ref.width, height: ref.height };
  const covers = options.referenceRenderSize;
  const extra = (have: number, want: number | undefined): number => (want !== undefined && have - want > 1 ? Math.round((have - want) / 2) : 0);
  const ex = extra(ref.width, covers?.width);
  const ey = extra(ref.height, covers?.height);
  const shift = (r: Rect | undefined): Rect | null => (r ? { ...r, x: r.x + ex, y: r.y + ey } : null);
  return { reference: shift(box)!, candidate: shift(options.candidateBox), extent: shift(options.candidateExtent) };
}

/** Math.round without −0. */
const round = (v: number): number => Math.round(v) || 0;

/**
 * Finds the integer offset (candidate top-left relative to reference top-left) that minimises
 * the union L1 distance of premultiplied luminance + alpha. Correct whenever the two renders
 * show the same content, however each side pads it; README "Registration" has the details.
 *
 * - Priors (starting candidates, never limits): the node box (`candidateBox`, else
 *   `referenceBox`) centred in the candidate, or anchored at its top/left or bottom/right, each
 *   axis independently (9 combinations); first, when given, the predicted export area
 *   (`candidateExtent`) centred in the candidate. The first prior is the tie-breaker.
 * - Window per axis: the box lies somewhere inside the candidate, so the offset lies in
 *   [box − (candSize − boxSize), box] (also for the extent), unioned with "one image inside the
 *   other" ([min(0, Δ), max(0, Δ)], Δ = refSize − candSize) and the priors, ± margin.
 * - Coarse to fine: 2× box pyramids; exhaustive search at the coarsest level whose
 *   (#offsets × #pixels) fits COARSE_BUDGET. Its SURVIVORS best distinct local optima and every
 *   prior are each refined independently down the pyramid (3×3 neighbourhood of the doubled
 *   position, plus the prior's own position); candidates that converge are merged. Before each
 *   of the two finest levels, candidates scoring worse than PRUNE_RATIO × the best are dropped.
 * - Prior check: afterwards every prior is scored at full resolution, whether or not it was
 *   dropped; one within PRUNE_RATIO of the winner is refined by steepest descent, and the best
 *   of all wins. Coarse levels alias periodic content (text lines, grids), so the pyramid can
 *   settle a period off; any prior near the right period corrects that.
 * - Ties (equal score): closest to the first prior (L1), then smallest |dx| + |dy|, then dy, then dx.
 */
export function register(ref: Image, cand: Image, options: DiffOptions = {}): Registration {
  const margin = options.margin ?? SEARCH_MARGIN;
  const boxes = effectiveBoxes(ref, options);
  const box = boxes.candidate ?? boxes.reference;
  const priorSource: PriorSource = boxes.extent ? 'bounds' : boxes.candidate ? 'selrect' : 'centre';

  const priors: Prior[] = [];
  const addPrior = (name: string, fx: number, fy: number): void => {
    const x = round(fx);
    const y = round(fy);
    if (!priors.some((p) => p.x === x && p.y === y)) priors.push({ name, x, y });
  };
  const e = boxes.extent;
  if (e) addPrior('bounds', e.x + e.width / 2 - cand.width / 2, e.y + e.height / 2 - cand.height / 2);
  const anchors = (pos: number, size: number, candSize: number): [string, number][] => [
    ['centre', pos + size / 2 - candSize / 2],
    ['start', pos],
    ['end', pos + size - candSize],
  ];
  const xs = anchors(box.x, box.width, cand.width);
  const ys = anchors(box.y, box.height, cand.height);
  // An axis without padding has a single placement: name the prior after the other axis only.
  const fixed = (list: [string, number][]): boolean => list.every(([, v]) => round(v) === round(list[0]![1]));
  for (const [ny, vy] of ys) {
    for (const [nx, vx] of xs) addPrior(nx === ny || fixed(ys) ? nx : fixed(xs) ? ny : `${nx}/${ny}`, vx, vy);
  }
  const prior = { x: priors[0]!.x, y: priors[0]!.y };

  // Padding beyond the render bounds that `register` was not told how to split: widen by half of it.
  const slack = (have: number, want: number | undefined): number => (want !== undefined && have - want > 1 ? Math.ceil((have - want) / 2) : 0);
  const axisWindow = (refSize: number, candSize: number, spans: [number, number][], values: number[], extra: number): [number, number] => {
    let lo = Math.min(0, refSize - candSize);
    let hi = Math.max(0, refSize - candSize);
    for (const [pos, size] of spans) {
      lo = Math.min(lo, pos, pos + size - candSize);
      hi = Math.max(hi, pos, pos + size - candSize);
    }
    for (const v of values) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return [Math.floor(lo) - margin - extra, Math.ceil(hi) + margin + extra];
  };
  const spanBoxes = [box, ...(e ? [e] : [])];
  const window = {
    x: axisWindow(ref.width, cand.width, spanBoxes.map((b) => [b.x, b.width]), priors.map((p) => p.x), slack(ref.width, options.referenceRenderSize?.width)),
    y: axisWindow(ref.height, cand.height, spanBoxes.map((b) => [b.y, b.height]), priors.map((p) => p.y), slack(ref.height, options.referenceRenderSize?.height)),
  };
  const result = (offset: Point, winner: string[], phase: Registration['phase'], evaluated: number, levels: number): Registration => ({
    offset,
    prior,
    priorSource,
    priors,
    winner,
    phase,
    window,
    evaluated,
    levels,
  });
  if (options.offset) return result(options.offset, [], 'fixed', 0, 0);

  const pyrA = [toPlane(ref)];
  const pyrB = [toPlane(cand)];
  const windowAt = (level: number): { x: [number, number]; y: [number, number] } => {
    if (level === 0) return window;
    const f = 2 ** level;
    return {
      x: [Math.floor(window.x[0] / f) - 1, Math.ceil(window.x[1] / f) + 1],
      y: [Math.floor(window.y[0] / f) - 1, Math.ceil(window.y[1] / f) + 1],
    };
  };
  const cost = (level: number): number => {
    const r = windowAt(level);
    const a = pyrA[level]!;
    const b = pyrB[level]!;
    return (r.x[1] - r.x[0] + 1) * (r.y[1] - r.y[0] + 1) * Math.min(a.w * a.h, b.w * b.h);
  };
  let top = 0;
  while (cost(top) > COARSE_BUDGET && Math.max(pyrA[top]!.w, pyrA[top]!.h, pyrB[top]!.w, pyrB[top]!.h) > 16) {
    pyrA.push(half(pyrA[top]!));
    pyrB.push(half(pyrB[top]!));
    top++;
  }

  let evaluated = 0;
  const order = (level: number) => {
    const f = 2 ** level;
    const px = prior.x / f;
    const py = prior.y / f;
    return (p: Scored, q: Scored): number =>
      p.score - q.score ||
      Math.abs(p.x - px) + Math.abs(p.y - py) - (Math.abs(q.x - px) + Math.abs(q.y - py)) ||
      Math.abs(p.x) + Math.abs(p.y) - (Math.abs(q.x) + Math.abs(q.y)) ||
      p.y - q.y ||
      p.x - q.x;
  };
  /** Scores at one level, memoised (candidates overlap). */
  const scorer = (level: number): ((x: number, y: number) => Scored) => {
    const a = pyrA[level]!;
    const b = pyrB[level]!;
    const memo = new Map<string, Scored>();
    return (x, y) => {
      const k = `${x},${y}`;
      let s = memo.get(k);
      if (!s) {
        evaluated++;
        s = { x, y, score: unionL1(a, b, x, y) };
        memo.set(k, s);
      }
      return s;
    };
  };

  // Exhaustive at the coarsest level.
  const r = windowAt(top);
  const scoreTop = scorer(top);
  const all: Scored[] = [];
  for (let y = r.y[0]; y <= r.y[1]; y++) for (let x = r.x[0]; x <= r.x[1]; x++) all.push(scoreTop(x, y));
  all.sort(order(top));
  const coincident = (o: Point): string[] => priors.filter((p) => p.x === o.x && p.y === o.y).map((p) => p.name);
  if (top === 0) {
    const best = all[0]!;
    return result({ x: best.x, y: best.y }, ['search', ...coincident(best)], 'exhaustive', evaluated, 1);
  }

  interface Track extends Scored {
    labels: string[];
    priors: Prior[];
  }
  let tracks: Track[] = [];
  for (const s of all) {
    if (tracks.length >= SURVIVORS) break;
    // Distinct local optima, not neighbours of the same one.
    if (tracks.every((t) => Math.max(Math.abs(t.x - s.x), Math.abs(t.y - s.y)) >= 2)) tracks.push({ ...s, labels: ['search'], priors: [] });
  }
  const clampTo = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v));
  const ft = 2 ** top;
  for (const p of priors) tracks.push({ ...scoreTop(clampTo(round(p.x / ft), r.x), clampTo(round(p.y / ft), r.y)), labels: [p.name], priors: [p] });
  const merge = (list: Track[]): Track[] => {
    const out: Track[] = [];
    for (const t of list) {
      const same = out.find((o) => o.x === t.x && o.y === t.y);
      if (same) {
        for (const l of t.labels) if (!same.labels.includes(l)) same.labels.push(l);
        same.priors.push(...t.priors);
      } else out.push({ ...t, labels: [...t.labels], priors: [...t.priors] });
    }
    return out;
  };
  const prune = (list: Track[], level: number): Track[] => {
    const best = [...list].sort(order(level))[0]!.score;
    return list.filter((t) => t.score <= best * PRUNE_RATIO + 1e-6);
  };
  tracks = merge(tracks);

  const scorers = pyrA.map((_, level) => (level === top ? scoreTop : scorer(level)));
  for (let level = top - 1; level >= 0; level--) {
    // The two finest levels dominate the cost: only candidates still in contention reach them.
    if (level <= 1) tracks = prune(tracks, level + 1);
    const lw = windowAt(level);
    const f = 2 ** level;
    const score = scorers[level]!;
    // Clamped, not dropped: a track at the edge of a coarse window may map just outside this one.
    const at = (x: number, y: number): Scored => score(clampTo(x, lw.x), clampTo(y, lw.y));
    tracks = merge(
      tracks.map((t) => {
        const cands: Scored[] = [];
        for (let ny = -1; ny <= 1; ny++) for (let nx = -1; nx <= 1; nx++) cands.push(at(2 * t.x + nx, 2 * t.y + ny));
        // Keep each prior's own position in play at every level (exactly, at full resolution).
        for (const p of t.priors) cands.push(at(round(p.x / f), round(p.y / f)));
        const best = cands.sort(order(level))[0]!;
        return { ...t, x: best.x, y: best.y, score: best.score };
      }),
    );
  }
  let best: Scored = [...tracks].sort(order(0))[0]!;
  let winner = [...tracks.find((t) => t.x === best.x && t.y === best.y)!.labels];
  let phase: Registration['phase'] = 'pyramid';

  // Full-resolution check of every prior, pruned or not: coarse levels alias periodic content
  // (text lines, grids), so a prior the pyramid dropped may still be the right period. A prior
  // within PRUNE_RATIO of the best is refined by steepest descent over its 8 neighbours.
  const s0 = scorers[0]!;
  const cmp = order(0);
  const descend = (start: Scored): Scored => {
    let c = start;
    for (let step = 0; step < 16; step++) {
      let next = c;
      for (let ny = -1; ny <= 1; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          const q = s0(clampTo(c.x + nx, window.x), clampTo(c.y + ny, window.y));
          if (cmp(q, next) < 0) next = q;
        }
      }
      if (next === c) break;
      c = next;
    }
    return c;
  };
  for (const p of priors) {
    let c = s0(p.x, p.y);
    if (c.score <= best.score * PRUNE_RATIO + 1e-6) c = descend(c);
    if (cmp(c, best) < 0) {
      best = c;
      winner = [p.name];
      phase = 'prior-check';
    }
  }
  for (const n of coincident(best)) if (!winner.includes(n)) winner.push(n);
  return result({ x: best.x, y: best.y }, winner, phase, evaluated, top + 1);
}

// --- reference padding -------------------------------------------------------------

/**
 * Figma pads SECTION exports by a uniform margin (40 px a side) beyond `renderBounds`, and that
 * margin shows whatever else is on the page there. When the PNG is larger than `renderSize`
 * (render bounds × scale) by more than 1 px, the surplus is cropped off centred, provided it is
 * a uniform margin: the four sides (left = ⌊surplusX / 2⌋, right = the rest, likewise top and
 * bottom) within 1 px of each other. Otherwise the image is returned as is with `irregular`.
 * Overflow of the section's own children is inside `renderBounds` and therefore kept.
 */
export function cropReferencePadding(ref: Image, renderSize: Size | undefined): { image: Image; padding: Padding | null; irregular: boolean } {
  const none = { image: ref, padding: null, irregular: false };
  if (!renderSize) return none;
  const sx = ref.width - Math.round(renderSize.width);
  const sy = ref.height - Math.round(renderSize.height);
  if (sx <= 1 && sy <= 1) return none; // rounding of fractional bounds, or a PNG smaller than expected
  const left = Math.floor(sx / 2);
  const top = Math.floor(sy / 2);
  const padding = { left, top, right: sx - left, bottom: sy - top };
  const sides = [padding.left, padding.top, padding.right, padding.bottom];
  if (Math.min(...sides) < 0 || Math.max(...sides) - Math.min(...sides) > 1) return { image: ref, padding: null, irregular: true };
  const w = ref.width - sx;
  const h = ref.height - sy;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(ref.data.subarray(((y + top) * ref.width + left) * 4, ((y + top) * ref.width + left + w) * 4), y * w * 4);
  return { image: { data, width: w, height: h }, padding, irregular: false };
}

// --- composition -----------------------------------------------------------------

/** Pastes `img` at `origin` on a transparent W×H canvas. */
function paste(img: Image, origin: Point, W: number, H: number): Image {
  if (origin.x === 0 && origin.y === 0 && img.width === W && img.height === H) return img;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + origin.y) * W + origin.x) * 4);
  }
  return { data, width: W, height: H };
}

/** Opaque copy composited over NEUTRAL_BACKGROUND. */
export function flatten(img: Image): Image {
  const [br, bg, bb] = NEUTRAL_BACKGROUND;
  const src = img.data;
  const data = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === 255) {
      data[i] = src[i]!;
      data[i + 1] = src[i + 1]!;
      data[i + 2] = src[i + 2]!;
    } else {
      const t = a / 255;
      data[i] = Math.round(src[i]! * t + br * (1 - t));
      data[i + 1] = Math.round(src[i + 1]! * t + bg * (1 - t));
      data[i + 2] = Math.round(src[i + 2]! * t + bb * (1 - t));
    }
    data[i + 3] = 255;
  }
  return { data, width: img.width, height: img.height };
}

export interface Background {
  transparent: boolean;
  /** Composited colour (NEUTRAL_BACKGROUND when transparent). */
  color: [number, number, number];
}

/**
 * Dominant background of an image (its own pixels only): fully transparent pixels form one
 * bucket, every other pixel goes into a 5-bit-per-channel histogram of its composited colour;
 * the biggest bucket wins (transparency wins ties) and its colour is the mean of its pixels.
 * With `overlap` (this image's part covered by the other image), fully transparent pixels
 * outside it do not vote: transparent overflow or export padding that only this image has
 * must not turn its background "transparent". Visible pixels always vote.
 */
export function dominantBackground(img: Image, overlap?: Rect): Background {
  const flat = flatten(img);
  const counts = new Uint32Array(1 << 15);
  const d = flat.data;
  const s = img.data;
  let transparent = 0;
  const key = (i: number): number => ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
  const W = img.width;
  const inside = (p: number): boolean => {
    if (!overlap) return true;
    const x = p % W;
    const y = (p - x) / W;
    return x >= overlap.x && x < overlap.x + overlap.width && y >= overlap.y && y < overlap.y + overlap.height;
  };
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (s[i + 3] === 0) {
      if (inside(p)) transparent++;
    } else counts[key(i)]!++;
  }
  let best = 0;
  for (let k = 1; k < counts.length; k++) if (counts[k]! > counts[best]!) best = k;
  if (transparent >= counts[best]!) return { transparent: true, color: [...NEUTRAL_BACKGROUND] };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (s[i + 3] !== 0 && key(i) === best) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
      n++;
    }
  }
  return { transparent: false, color: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] };
}

const hex = (c: readonly number[]): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const nearRgb = (d: Uint8Array, i: number, c: readonly number[]): boolean =>
  Math.abs(d[i]! - c[0]!) <= BACKGROUND_TOLERANCE && Math.abs(d[i + 1]! - c[1]!) <= BACKGROUND_TOLERANCE && Math.abs(d[i + 2]! - c[2]!) <= BACKGROUND_TOLERANCE;

function extentOf(img: Image, origin: Point): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (d[(y * img.width + x) * 4 + 3]! > EXTENT_ALPHA) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0 + origin.x, y: y0 + origin.y, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// --- sub-pixel tolerance -------------------------------------------------------------

/**
 * Whether `yImg`'s pixel (px, py) can be produced by moving `x`'s image by at most half a pixel
 * in any direction: every RGB channel of y(p) lies (± SHIFT_TOLERANCE) within the range of `xImg`'s
 * bilinear interpolation over the square p ± 0.5 px, i.e. within min/max of x(p), the four
 * axis half-points and the four diagonal quarter-points. Beyond the union canvas everything
 * is transparent, i.e. NEUTRAL_BACKGROUND (not a clamped edge pixel).
 */
function withinHalfPixel(xImg: Uint8Array, yImg: Uint8Array, W: number, H: number, px: number, py: number): boolean {
  const i = (py * W + px) * 4;
  for (let c = 0; c < 3; c++) {
    const outside = NEUTRAL_BACKGROUND[c]!;
    const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? outside : xImg[(y * W + x) * 4 + c]!);
    const p = xImg[i + c]!;
    const l = at(px - 1, py);
    const r = at(px + 1, py);
    const t = at(px, py - 1);
    const b = at(px, py + 1);
    const tl = (p + l + t + at(px - 1, py - 1)) / 4;
    const tr = (p + r + t + at(px + 1, py - 1)) / 4;
    const bl = (p + l + b + at(px - 1, py + 1)) / 4;
    const br = (p + r + b + at(px + 1, py + 1)) / 4;
    const lo = Math.min(p, (p + l) / 2, (p + r) / 2, (p + t) / 2, (p + b) / 2, tl, tr, bl, br);
    const hi = Math.max(p, (p + l) / 2, (p + r) / 2, (p + t) / 2, (p + b) / 2, tl, tr, bl, br);
    const v = yImg[i + c]!;
    if (v < lo - SHIFT_TOLERANCE || v > hi + SHIFT_TOLERANCE) return false;
  }
  return true;
}

// --- perceptual neighbourhood test ---------------------------------------------------

// Colour distance = pixelmatch v8's (OKLab with toe-corrected lightness Lr, HyAB distance
// |ΔLr| + √(Δa² + Δb²), black vs white = 1), on the opaque composited colours. Re-implemented
// because pixelmatch does not export it. Integer colours go through a direct-mapped cache
// (designs use few distinct colours); interpolated ones are converted directly.
const LIN = new Float64Array(257);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
LIN[256] = LIN[255]!;
const OKLAB_BITS = 14;
const OKLAB_KEYS = new Int32Array(1 << OKLAB_BITS).fill(-1);
const OKLAB_VALUES = new Float64Array((1 << OKLAB_BITS) * 3);
const TOE_K1 = 0.206;
const TOE_K2 = 0.03;
const TOE_K3 = (1 + TOE_K1) / (1 + TOE_K2);
/** Scratch output of `oklab`: [Lr, a, b]. */
const LAB = new Float64Array(3);

const lin = (v: number): number => {
  const i = v | 0;
  return LIN[i]! + (LIN[i + 1]! - LIN[i]!) * (v - i);
};

/** OKLab [Lr, a, b] of an sRGB colour with fractional channels (0..255) into LAB. */
function oklab(r8: number, g8: number, b8: number): void {
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const x = TOE_K3 * L - TOE_K1;
  LAB[0] = 0.5 * (x + Math.sqrt(x * x + 4 * TOE_K2 * TOE_K3 * L));
  LAB[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  LAB[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** Index into OKLAB_VALUES of [Lr, a, b] for the integer colour at d[i..i+2] (valid until the next call). */
function oklabSlot(d: Uint8Array, i: number): number {
  const key = (d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!;
  const slot = Math.imul(key, 0x9e3779b1) >>> (32 - OKLAB_BITS);
  const o = slot * 3;
  if (OKLAB_KEYS[slot] !== key) {
    oklab(d[i]!, d[i + 1]!, d[i + 2]!);
    OKLAB_VALUES[o] = LAB[0]!;
    OKLAB_VALUES[o + 1] = LAB[1]!;
    OKLAB_VALUES[o + 2] = LAB[2]!;
    OKLAB_KEYS[slot] = key;
  }
  return o;
}

/** HyAB(LAB-like triple at `v[k..]`, (L, A, B)) ≤ `threshold`, folded as pixelmatch does (no sqrt). */
function close(v: Float64Array, k: number, L: number, A: number, B: number, threshold: number): boolean {
  const rest = threshold - Math.abs(v[k]! - L);
  if (rest < 0) return false;
  const da = v[k + 1]! - A;
  const db = v[k + 2]! - B;
  return da * da + db * db <= rest * rest;
}

/**
 * Whether the colour `self[p]` occurs, within `threshold` (default PIXELMATCH_THRESHOLD), in `other` displaced by at
 * most `radius` px in x and y, `other` being sampled continuously (bilinear interpolation of its
 * composited sRGB values, which is how a sub-pixel shift of a rendered edge re-blends it).
 * Evaluated conservatively, in increasing cost, over the (2r+1)² neighbourhood of p in `other`:
 *   1. its pixels;
 *   2. the closest point (sRGB Euclidean) on each segment between 4- or 8-adjacent pixels,
 *      the segment continued by PERCEPTUAL_OVERSHOOT of its length beyond either end (a
 *      slightly thicker / thinner stem changes its peak coverage, not just its position);
 *   3. the centre of each 2×2 cell (mean of its 4 pixels).
 * Apart from the overshoot, every point tested is a value the interpolation does take. The search only reads `other`, never `self`, so a busy image
 * cannot match itself. Pixels beyond the union canvas are skipped.
 */
function neighbourMatch(
  self: Uint8Array,
  self32: Uint32Array,
  other: Uint8Array,
  other32: Uint32Array,
  W: number,
  H: number,
  px: number,
  py: number,
  radius: number,
  overshoot: number,
  threshold: number = PIXELMATCH_THRESHOLD,
  patches = false,
): boolean {
  const p = py * W + px;
  const v = self32[p]!;
  const o = oklabSlot(self, p * 4);
  const L = OKLAB_VALUES[o]!;
  const A = OKLAB_VALUES[o + 1]!;
  const B = OKLAB_VALUES[o + 2]!;
  const y0 = Math.max(0, py - radius);
  const y1 = Math.min(H - 1, py + radius);
  const x0 = Math.max(0, px - radius);
  const x1 = Math.min(W - 1, px + radius);
  // 1. pixels
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const q = y * W + x;
      if (other32[q] === v) return true;
      if (close(OKLAB_VALUES, oklabSlot(other, q * 4), L, A, B, threshold)) return true;
    }
  }
  const pi = p * 4;
  const cr = self[pi]!;
  const cg = self[pi + 1]!;
  const cb = self[pi + 2]!;
  // Closest point to c on the segment other[i] → other[j], tested in OKLab.
  const segment = (i: number, j: number): boolean => {
    const r0 = other[i]!;
    const g0 = other[i + 1]!;
    const b0 = other[i + 2]!;
    const dr = other[j]! - r0;
    const dg = other[j + 1]! - g0;
    const db = other[j + 2]! - b0;
    const dd = dr * dr + dg * dg + db * db;
    if (dd === 0) return false;
    const t = Math.max(-overshoot, Math.min(1 + overshoot, ((cr - r0) * dr + (cg - g0) * dg + (cb - b0) * db) / dd));
    if (t === 0 || t === 1) return false; // endpoints were tested in step 1
    const clamp = (c: number): number => (c < 0 ? 0 : c > 255 ? 255 : c);
    oklab(clamp(r0 + t * dr), clamp(g0 + t * dg), clamp(b0 + t * db));
    return close(LAB, 0, L, A, B, threshold);
  };
  // 2. segments between adjacent pixels, 3. cell centres
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      const right = x < x1;
      const down = y < y1;
      if (right && segment(i, i + 4)) return true;
      if (down && segment(i, i + W * 4)) return true;
      if (right && down) {
        const j = i + 4;
        const k = i + W * 4;
        const l = k + 4;
        if (segment(i, l) || segment(j, k)) return true;
        oklab((other[i]! + other[j]! + other[k]! + other[l]!) / 4, (other[i + 1]! + other[j + 1]! + other[k + 1]! + other[l + 1]!) / 4, (other[i + 2]! + other[j + 2]! + other[k + 2]! + other[l + 2]!) / 4);
        if (close(LAB, 0, L, A, B, threshold)) return true;
      }
    }
  }
  // 4. (visual metric) each neighbourhood pixel extrapolated away from its outer neighbour (the
  // overshoot only, t ∈ (1, 1 + overshoot]): a stem displaced by a fraction of a pixel moves its
  // peak-ink pixel by one, and the ramp that reaches full ink then starts outside the 3×3.
  if (patches && overshoot > 0) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ox = x + dx;
            const oy = y + dy;
            if ((dx === 0 && dy === 0) || (ox >= x0 && ox <= x1 && oy >= y0 && oy <= y1) || ox < 0 || oy < 0 || ox >= W || oy >= H) continue;
            if (extrapolated(other, (oy * W + ox) * 4, (y * W + x) * 4, cr, cg, cb, overshoot) && close(LAB, 0, L, A, B, threshold)) return true;
          }
        }
      }
    }
  }
  // 5. (visual metric) the closest point on each cell's bilinear patch: a displacement by a
  // fraction of a pixel in x AND y blends four pixels, which no segment reaches.
  if (patches) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        if (patchClosest(other, i, i + 4, i + W * 4, i + W * 4 + 4, cr, cg, cb) && close(LAB, 0, L, A, B, threshold)) return true;
      }
    }
  }
  return false;
}

/**
 * The point closest to c on the continuation of the segment img[i] → img[j] beyond j, by at
 * most `overshoot` of its length; its OKLab in LAB. False when that is j itself (tested).
 */
function extrapolated(img: Uint8Array, i: number, j: number, cr: number, cg: number, cb: number, overshoot: number): boolean {
  const r0 = img[i]!;
  const g0 = img[i + 1]!;
  const b0 = img[i + 2]!;
  const dr = img[j]! - r0;
  const dg = img[j + 1]! - g0;
  const db = img[j + 2]! - b0;
  const dd = dr * dr + dg * dg + db * db;
  if (dd === 0) return false;
  const t = Math.min(1 + overshoot, ((cr - r0) * dr + (cg - g0) * dg + (cb - b0) * db) / dd);
  if (t <= 1) return false;
  const clamp = (c: number): number => (c < 0 ? 0 : c > 255 ? 255 : c);
  oklab(clamp(r0 + t * dr), clamp(g0 + t * dg), clamp(b0 + t * db));
  return true;
}

/**
 * Closest point (sRGB Euclidean) to c on the bilinear patch over the 2×2 cell c00 c10 / c01 c11
 * (byte offsets into `img`): best of a 3×3 grid of (u, v), then a few clamped Gauss-Newton
 * steps. Leaves its OKLab in LAB; false when the cell is flat (nothing new to test).
 */
function patchClosest(img: Uint8Array, i00: number, i10: number, i01: number, i11: number, cr: number, cg: number, cb: number): boolean {
  const c = [cr, cg, cb];
  const p0 = [img[i00]!, img[i00 + 1]!, img[i00 + 2]!];
  const eu = [img[i10]! - p0[0]!, img[i10 + 1]! - p0[1]!, img[i10 + 2]! - p0[2]!];
  const ev = [img[i01]! - p0[0]!, img[i01 + 1]! - p0[1]!, img[i01 + 2]! - p0[2]!];
  const f = [img[i11]! - img[i10]! - img[i01]! + p0[0]!, img[i11 + 1]! - img[i10 + 1]! - img[i01 + 1]! + p0[1]!, img[i11 + 2]! - img[i10 + 2]! - img[i01 + 2]! + p0[2]!];
  if (!eu.some(Boolean) && !ev.some(Boolean) && !f.some(Boolean)) return false;
  const at = (u: number, v: number, k: number): number => p0[k]! + u * eu[k]! + v * ev[k]! + u * v * f[k]!;
  const err = (u: number, v: number): number => {
    let s = 0;
    for (let k = 0; k < 3; k++) s += (at(u, v, k) - c[k]!) ** 2;
    return s;
  };
  let u = 0.5;
  let v = 0.5;
  let best = Infinity;
  for (const gu of [0.25, 0.5, 0.75]) {
    for (const gv of [0.25, 0.5, 0.75]) {
      const e = err(gu, gv);
      if (e < best) [best, u, v] = [e, gu, gv];
    }
  }
  for (let step = 0; step < 4; step++) {
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let g1 = 0;
    let g2 = 0;
    for (let k = 0; k < 3; k++) {
      const ju = eu[k]! + v * f[k]!;
      const jv = ev[k]! + u * f[k]!;
      const r = at(u, v, k) - c[k]!;
      a11 += ju * ju;
      a12 += ju * jv;
      a22 += jv * jv;
      g1 += ju * r;
      g2 += jv * r;
    }
    const det = a11 * a22 - a12 * a12;
    let du: number;
    let dv: number;
    if (Math.abs(det) > 1e-9) {
      du = (-g1 * a22 + g2 * a12) / det;
      dv = (-g2 * a11 + g1 * a12) / det;
    } else {
      // Degenerate (rank 1): gradient step along the dominant direction.
      du = a11 > 0 ? -g1 / a11 : 0;
      dv = a22 > 0 ? -g2 / a22 : 0;
    }
    const nu = Math.min(1, Math.max(0, u + du));
    const nv = Math.min(1, Math.max(0, v + dv));
    if (Math.abs(nu - u) + Math.abs(nv - v) < 1e-3) break;
    u = nu;
    v = nv;
  }
  oklab(at(u, v, 0), at(u, v, 1), at(u, v, 2));
  return true;
}

// --- visual metric (saliency) ------------------------------------------------------------

/**
 * Tunables of `visualAccuracy` / `localAccuracy` (README "Acceptance"). Every field has a
 * named default below; `DiffOptions.visual` overrides them for experiments and calibration.
 */
export interface VisualParams {
  /** Edge seed: a pixel whose 3×3 neighbourhood spans more than this (0..255, max over R, G, B) in either image. */
  edgeContrast: number;
  /** Edge zone = seeds dilated by this many px (Chebyshev). */
  edgeRadius: number;
  /** Colour slack (HyAB) of the ≤ 1 px neighbourhood test on edge pixels. */
  edgeThreshold: number;
  /** Segment overshoot of that test (see PERCEPTUAL_OVERSHOOT). */
  edgeOvershoot: number;
  /** Non-edge pixels farther apart than this (HyAB) are a flat mismatch. */
  flatTolerance: number;
  /** Sliding window of `localAccuracy`, px, and its stride. */
  window: number;
  stride: number;
  /** Windows with fewer salient pixels are not scored. */
  windowMinSalient: number;
  /** Regional window, stride and minimum salient pixels (`regionalAccuracy`). */
  regionWindow: number;
  regionStride: number;
  regionMinSalient: number;
  /** Ink test: a window's darkest / lightest edge-zone lightness (OKLab Lr) may differ by this much between the images (0 = off). */
  inkTolerance: number;
  /** Ink test window (px), stride, and the edge pixels a window needs to be tested. */
  inkWindow: number;
  inkStride: number;
  inkMinEdge: number;
}

/** Edge seed contrast, 0..255. A 1–2 level banding step or a smooth gradient (≤ 3 levels/px) stays below it. */
export const EDGE_CONTRAST = 12;
/** Edge zone dilation of the seeds, px. */
export const EDGE_RADIUS = 1;
/** Colour slack of the edge test (HyAB; PIXELMATCH_THRESHOLD = 0.1 lets #1e1e1e text pass as #555555). */
export const EDGE_THRESHOLD = 0.05;
/** Segment overshoot of the edge test. */
export const EDGE_OVERSHOOT = PERCEPTUAL_OVERSHOOT;
/** Flat-mismatch tolerance (HyAB): ≈ 5 grey levels mid-range. */
export const FLAT_TOLERANCE = 0.02;
/** `localAccuracy` window (px) and stride. */
export const LOCAL_WINDOW = 32;
export const LOCAL_STRIDE = 16;
/** Windows with fewer salient pixels than this are not scored. */
export const LOCAL_MIN_SALIENT = 32;
/**
 * Ink test tolerance (OKLab toe-corrected lightness, = HyAB for greys): #1e1e1e text drawn as
 * #555555 moves the darkest ink by 0.23, as #3a3a3a by 0.12, as #262626 by 0.034.
 */
export const INK_TOLERANCE = 0.15;
/** The ink test compares a window's extremes with the other image's over the window grown by this many px. */
export const INK_MARGIN = 2;
/**
 * Ink test window and stride, px, and the edge pixels a window needs. Larger than the local
 * window: the darkest pixel over several glyphs is robust, over part of one thin stroke it is
 * the rasteriser's peak coverage, which differs legitimately.
 */
export const INK_WINDOW = 64;
export const INK_STRIDE = 32;
export const INK_MIN_EDGE = 256;
/** Pass rule defaults: `visualAccuracy ≥ MIN_VISUAL` (or ≤ VISUAL_ALLOWANCE mismatched salient px) and `localAccuracy ≥ MIN_LOCAL`. */
export const MIN_VISUAL = 0.98;
export const MIN_LOCAL = 0.85;
/** Regional window (px), stride, minimum salient pixels, and its pass threshold. */
export const REGION_WINDOW = 128;
export const REGION_STRIDE = 64;
export const REGION_MIN_SALIENT = 512;
export const MIN_REGIONAL = 0.92;
/** Absolute allowance of the visual rule: a board with at most this many mismatched salient pixels passes it whatever its ratio. */
export const VISUAL_ALLOWANCE = 16;

export const DEFAULT_VISUAL: Readonly<VisualParams> = {
  edgeContrast: EDGE_CONTRAST,
  edgeRadius: EDGE_RADIUS,
  edgeThreshold: EDGE_THRESHOLD,
  edgeOvershoot: EDGE_OVERSHOOT,
  flatTolerance: FLAT_TOLERANCE,
  window: LOCAL_WINDOW,
  stride: LOCAL_STRIDE,
  windowMinSalient: LOCAL_MIN_SALIENT,
  regionWindow: REGION_WINDOW,
  regionStride: REGION_STRIDE,
  regionMinSalient: REGION_MIN_SALIENT,
  inkTolerance: INK_TOLERANCE,
  inkWindow: INK_WINDOW,
  inkStride: INK_STRIDE,
  inkMinEdge: INK_MIN_EDGE,
};

/** Per-pixel class of the visual metric (diff image, tests). */
export const Salience = { None: 0, EdgeMatch: 1, EdgeMismatch: 2, FlatMismatch: 3, InkMismatch: 4 } as const;

export interface LocalWindow extends Rect {
  salient: number;
  mismatched: number;
  accuracy: number;
}

export interface VisualMetrics {
  salientPixels: number;
  /** Salient pixels in the edge zone (the rest are flat mismatches). */
  edgePixels: number;
  edgeMismatchedPixels: number;
  flatMismatchedPixels: number;
  /** Edge-zone pixels that pass the neighbourhood test but are the ink of a window whose extremes differ (ink test). */
  inkMismatchedPixels: number;
  visualMismatchedPixels: number;
  /** 1 − visualMismatched / salient (1 without salient pixels). */
  visualAccuracy: number;
  /** Minimum window accuracy over the scored windows (1 when none is scored). */
  localAccuracy: number;
  /** The worst scored window (null when none is scored). */
  localWorst: LocalWindow | null;
  /** Scored windows, and how many of them are below MIN_LOCAL. */
  localWindows: number;
  localWindowsBelow: number;
  /** The same over the larger regional windows (spread-out defects: a shifted or recoloured paragraph). */
  regionalAccuracy: number;
  regionalWorst: LocalWindow | null;
  /** No salient pixel and both images one flat colour: passes, excluded from means. */
  trivial: boolean;
}

/** Max over R, G, B of the 3×3 range (max − min) of every pixel; beyond the canvas = clamped. */
function contrast3x3(img: Uint8Array, W: number, H: number, out: Uint8Array): void {
  const n = W * H;
  const hmax = new Uint8Array(n);
  const hmin = new Uint8Array(n);
  out.fill(0);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const l = x > 0 ? x - 1 : x;
        const r = x < W - 1 ? x + 1 : x;
        const v0 = img[(row + l) * 4 + c]!;
        const v1 = img[(row + x) * 4 + c]!;
        const v2 = img[(row + r) * 4 + c]!;
        hmax[row + x] = v0 > v1 ? (v0 > v2 ? v0 : v2) : v1 > v2 ? v1 : v2;
        hmin[row + x] = v0 < v1 ? (v0 < v2 ? v0 : v2) : v1 < v2 ? v1 : v2;
      }
    }
    for (let y = 0; y < H; y++) {
      const up = (y > 0 ? y - 1 : y) * W;
      const row = y * W;
      const dn = (y < H - 1 ? y + 1 : y) * W;
      for (let x = 0; x < W; x++) {
        const mx = Math.max(hmax[up + x]!, hmax[row + x]!, hmax[dn + x]!);
        const mn = Math.min(hmin[up + x]!, hmin[row + x]!, hmin[dn + x]!);
        const d = mx - mn;
        if (d > out[row + x]!) out[row + x] = d;
      }
    }
  }
}

/** Square (Chebyshev) dilation of a 0/1 mask by r px, in place. */
function dilate(mask: Uint8Array, W: number, H: number, r: number): void {
  if (r <= 0) return;
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let last = -Infinity;
    for (let x = 0; x < W; x++) {
      if (mask[row + x]) last = x;
      if (x - last <= r) tmp[row + x] = 1;
    }
    last = Infinity;
    for (let x = W - 1; x >= 0; x--) {
      if (mask[row + x]) last = x;
      if (last - x <= r) tmp[row + x] = 1;
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -Infinity;
    for (let y = 0; y < H; y++) {
      if (tmp[y * W + x]) last = y;
      if (y - last <= r) mask[y * W + x] = 1;
    }
    last = Infinity;
    for (let y = H - 1; y >= 0; y--) {
      if (tmp[y * W + x]) last = y;
      if (last - y <= r) mask[y * W + x] = 1;
    }
  }
}

/** HyAB distance of the integer colours x[i..] and y[j..] (no early exit). */
function hyab(x: Uint8Array, i: number, y: Uint8Array, j: number): number {
  const o = oklabSlot(x, i);
  const L = OKLAB_VALUES[o]!;
  const A = OKLAB_VALUES[o + 1]!;
  const B = OKLAB_VALUES[o + 2]!;
  const q = oklabSlot(y, j);
  return Math.abs(OKLAB_VALUES[q]! - L) + Math.hypot(OKLAB_VALUES[q + 1]! - A, OKLAB_VALUES[q + 2]! - B);
}

/** Whether some pixel of `other` within 1 px of p is within `tol` (HyAB) of `self[p]`. */
function flatNeighbour(self: Uint8Array, other: Uint8Array, W: number, H: number, px: number, py: number, tol: number): boolean {
  const i = (py * W + px) * 4;
  for (let y = Math.max(0, py - 1); y <= Math.min(H - 1, py + 1); y++) {
    for (let x = Math.max(0, px - 1); x <= Math.min(W - 1, px + 1); x++) if (hyab(self, i, other, (y * W + x) * 4) <= tol) return true;
  }
  return false;
}

/**
 * The visual metric on the registered, composited union canvas (`a` = reference, `b` =
 * candidate, opaque RGBA). Fills `cls` (one Salience per pixel). README "Acceptance".
 *
 *   salient = edge zone (either image)  ∪  flat pixels whose colours differ beyond flatTolerance
 *   edge pixel mismatch = the ≤ 1 px bilinear neighbourhood test fails in either direction at edgeThreshold
 *   visualAccuracy = 1 − mismatched salient / salient;  localAccuracy = worst sliding window of the same ratio
 */
export function visualMetric(a: Uint8Array, b: Uint8Array, W: number, H: number, params: VisualParams, cls: Uint8Array): VisualMetrics {
  const n = W * H;
  const edge = new Uint8Array(n);
  {
    const ca = new Uint8Array(n);
    const cb = new Uint8Array(n);
    contrast3x3(a, W, H, ca);
    contrast3x3(b, W, H, cb);
    for (let p = 0; p < n; p++) if (ca[p]! > params.edgeContrast || cb[p]! > params.edgeContrast) edge[p] = 1;
  }
  dilate(edge, W, H, params.edgeRadius);

  const a32 = new Uint32Array(a.buffer, a.byteOffset, n);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, n);
  let salient = 0;
  let edgePixels = 0;
  let edgeMismatched = 0;
  let flatMismatched = 0;
  for (let p = 0; p < n; p++) {
    const same = a32[p] === b32[p];
    if (edge[p]) {
      salient++;
      edgePixels++;
      if (same) {
        cls[p] = Salience.EdgeMatch;
        continue;
      }
      const x = p % W;
      const y = (p - x) / W;
      const ok =
        neighbourMatch(a, a32, b, b32, W, H, x, y, 1, params.edgeOvershoot, params.edgeThreshold, true) &&
        neighbourMatch(b, b32, a, a32, W, H, x, y, 1, params.edgeOvershoot, params.edgeThreshold, true);
      cls[p] = ok ? Salience.EdgeMatch : Salience.EdgeMismatch;
      if (!ok) edgeMismatched++;
    } else if (!same && hyab(a, p * 4, b, p * 4) > params.flatTolerance) {
      // A smooth gradient displaced by ≤ 1 px is not a mismatch: look for the colour around p, both ways.
      const x = p % W;
      const y = (p - x) / W;
      if (flatNeighbour(a, b, W, H, x, y, params.flatTolerance) && flatNeighbour(b, a, W, H, x, y, params.flatTolerance)) continue;
      cls[p] = Salience.FlatMismatch;
      salient++;
      flatMismatched++;
    }
  }
  const positions = (size: number, window = params.window, stride = params.stride): number[] => {
    const win = Math.min(window, size);
    const out: number[] = [];
    for (let v = 0; v + win <= size; v += stride) out.push(v);
    if (out[out.length - 1] !== size - win) out.push(size - win);
    return out;
  };

  // Ink test. The neighbourhood test cannot tell lighter ink from less coverage (a 60 % pixel of
  // #1e1e1e is #555555's 100 %), so lighter text only fails at its cores. A window's extremes
  // can: a sub-pixel shift or a bolder stem keeps the darkest (lightest) ink, a recolour moves
  // it. Per window, over its edge-zone pixels, compare min and max lightness; where one differs
  // by more than inkTolerance, every edge pixel on that side of the window's mid-lightness (in
  // either image) is an ink mismatch.
  let inkMismatched = 0;
  if (params.inkTolerance > 0 && edgePixels > 0) {
    const la = new Float32Array(n);
    const lb = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      if (!edge[p]) continue;
      la[p] = OKLAB_VALUES[oklabSlot(a, p * 4)]!;
      lb[p] = OKLAB_VALUES[oklabSlot(b, p * 4)]!;
    }
    // Extremes over the window (inner) and over the window grown by INK_MARGIN (outer): an
    // image's inner extreme must be matched by the other's outer one, so that a feature
    // displaced by a pixel across the window border does not count as a different ink.
    const ext = new Float64Array(8);
    const scan = (x0: number, y0: number, x1: number, y1: number, o: number): number => {
      let count = 0;
      let loA = Infinity;
      let hiA = -Infinity;
      let loB = Infinity;
      let hiB = -Infinity;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let p = y * W + Math.max(0, x0), end = y * W + Math.min(W, x1); p < end; p++) {
          if (!edge[p]) continue;
          count++;
          const va = la[p]!;
          const vb = lb[p]!;
          if (va < loA) loA = va;
          if (va > hiA) hiA = va;
          if (vb < loB) loB = vb;
          if (vb > hiB) hiB = vb;
        }
      }
      ext[o] = loA;
      ext[o + 1] = hiA;
      ext[o + 2] = loB;
      ext[o + 3] = hiB;
      return count;
    };
    const tol = params.inkTolerance;
    const iw = Math.min(params.inkWindow, W);
    const ih = Math.min(params.inkWindow, H);
    for (const y0 of positions(H, params.inkWindow, params.inkStride)) {
      for (const x0 of positions(W, params.inkWindow, params.inkStride)) {
        if (scan(x0, y0, x0 + iw, y0 + ih, 0) < params.inkMinEdge) continue;
        scan(x0 - INK_MARGIN, y0 - INK_MARGIN, x0 + iw + INK_MARGIN, y0 + ih + INK_MARGIN, 4);
        const loA = ext[0]!;
        const hiA = ext[1]!;
        const loB = ext[2]!;
        const hiB = ext[3]!;
        const dark = loA < ext[6]! - tol || loB < ext[4]! - tol;
        const light = hiA > ext[7]! + tol || hiB > ext[5]! + tol;
        if (!dark && !light) continue;
        const midA = (loA + hiA) / 2;
        const midB = (loB + hiB) / 2;
        for (let y = y0; y < y0 + ih; y++) {
          for (let p = y * W + x0, end = p + iw; p < end; p++) {
            if (cls[p] !== Salience.EdgeMatch) continue;
            const ink = dark ? la[p]! < midA || lb[p]! < midB : false;
            if (ink || (light && (la[p]! > midA || lb[p]! > midB))) {
              cls[p] = Salience.InkMismatch;
              inkMismatched++;
            }
          }
        }
      }
    }
  }
  const mismatched = edgeMismatched + flatMismatched + inkMismatched;

  // Sliding windows over integral images of salient / mismatched counts.
  const W1 = W + 1;
  const IS = new Int32Array(W1 * (H + 1));
  const IM = new Int32Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let s = 0;
    let m = 0;
    for (let x = 0; x < W; x++) {
      const c = cls[y * W + x]!;
      if (c) s++;
      if (c >= Salience.EdgeMismatch) m++;
      IS[(y + 1) * W1 + x + 1] = IS[y * W1 + x + 1]! + s;
      IM[(y + 1) * W1 + x + 1] = IM[y * W1 + x + 1]! + m;
    }
  }
  const box = (I: Int32Array, x: number, y: number, w: number, h: number): number => I[(y + h) * W1 + x + w]! - I[y * W1 + x + w]! - I[(y + h) * W1 + x]! + I[y * W1 + x]!;
  /** Worst window of one size, the number scored and how many are below `below`. */
  const windows = (window: number, stride: number, minSalient: number, below: number): { worst: LocalWindow | null; count: number; below: number } => {
    const w = Math.min(window, W);
    const h = Math.min(window, H);
    let worst: LocalWindow | null = null;
    let count = 0;
    let under = 0;
    if (salient === 0) return { worst, count, below: under };
    for (const y of positions(H, window, stride)) {
      for (const x of positions(W, window, stride)) {
        const s = box(IS, x, y, w, h);
        if (s < minSalient) continue;
        const m = box(IM, x, y, w, h);
        const acc = 1 - m / s;
        count++;
        if (acc < below) under++;
        if (!worst || acc < worst.accuracy || (acc === worst.accuracy && m > worst.mismatched)) worst = { x, y, width: w, height: h, salient: s, mismatched: m, accuracy: acc };
      }
    }
    return { worst, count, below: under };
  };
  const local = windows(params.window, params.stride, params.windowMinSalient, MIN_LOCAL);
  const regional = windows(params.regionWindow, params.regionStride, params.regionMinSalient, MIN_REGIONAL);

  let trivial = false;
  if (salient === 0) {
    // Same flat colour: every pixel of both images within edgeContrast of the first one.
    trivial = true;
    for (let i = 0; i < n * 4 && trivial; i += 4) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(a[i + c]! - a[c]!) > params.edgeContrast || Math.abs(b[i + c]! - a[c]!) > params.edgeContrast) {
          trivial = false;
          break;
        }
      }
    }
  }
  return {
    salientPixels: salient,
    edgePixels,
    edgeMismatchedPixels: edgeMismatched,
    flatMismatchedPixels: flatMismatched,
    inkMismatchedPixels: inkMismatched,
    visualMismatchedPixels: mismatched,
    visualAccuracy: salient ? 1 - mismatched / salient : 1,
    localAccuracy: local.worst ? local.worst.accuracy : 1,
    localWorst: local.worst,
    localWindows: local.count,
    localWindowsBelow: local.below,
    regionalAccuracy: regional.worst ? regional.worst.accuracy : 1,
    regionalWorst: regional.worst,
    trivial,
  };
}

/** The default pass rule: visual (ratio, or the small-board allowance), regional and local. */
export function visualPasses(
  m: Pick<VisualMetrics, 'visualAccuracy' | 'visualMismatchedPixels' | 'localAccuracy' | 'regionalAccuracy'>,
  minVisual = MIN_VISUAL,
  minLocal = MIN_LOCAL,
  minRegional = MIN_REGIONAL,
): boolean {
  return (m.visualAccuracy >= minVisual || m.visualMismatchedPixels <= VISUAL_ALLOWANCE) && m.regionalAccuracy >= minRegional && m.localAccuracy >= minLocal;
}

// --- SSIM ------------------------------------------------------------------------------

function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const lum = (d: Uint8Array, i: number): number => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  const B = 8;
  let sum = 0;
  let blocks = 0;
  for (let by = 0; by + B <= height; by += B) {
    for (let bx = 0; bx + B <= width; bx += B) {
      let ma = 0;
      let mb = 0;
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const i = (y * width + x) * 4;
          ma += lum(a, i);
          mb += lum(b, i);
        }
      }
      const n = B * B;
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const i = (y * width + x) * 4;
          const da = lum(a, i) - ma;
          const db = lum(b, i) - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return blocks ? sum / blocks : 1;
}

// --- diff -------------------------------------------------------------------------------

/** Highlight colours. DIFF = perceptual mismatch (real); STRICT_ONLY = strict mismatch the perceptual test forgives. */
export const DIFF_COLOR: readonly [number, number, number] = [255, 0, 0];
export const STRICT_ONLY_COLOR: readonly [number, number, number] = [0, 120, 255];
export const AA_COLOR: readonly [number, number, number] = [255, 200, 0];

export function diffImages(referencePng: Uint8Array, candidatePng: Uint8Array, options: DiffOptions = {}): DiffOutput {
  return diffDecoded(decodePng(referencePng), decodePng(candidatePng), options);
}

export function diffDecoded(referenceImage: Image, cand: Image, givenOptions: DiffOptions = {}): DiffOutput {
  // Figma's margin beyond the render bounds is not the node's content: crop it off. The boxes
  // are relative to the render bounds, i.e. to the cropped image.
  const cropped = cropReferencePadding(referenceImage, givenOptions.referenceRenderSize);
  const ref = cropped.image;
  const options: DiffOptions = cropped.padding ? { ...givenOptions, referenceRenderSize: { width: ref.width, height: ref.height } } : givenOptions;
  const t0 = performance.now();
  const reg = register(ref, cand, options);
  const ms = performance.now() - t0;
  const { offset } = reg;

  // Union canvas.
  const minX = Math.min(0, offset.x);
  const minY = Math.min(0, offset.y);
  const W = Math.max(ref.width, offset.x + cand.width) - minX;
  const H = Math.max(ref.height, offset.y + cand.height) - minY;
  const refOrigin = { x: -minX, y: -minY };
  const candOrigin = { x: offset.x - minX, y: offset.y - minY };
  const refU = paste(ref, refOrigin, W, H);
  const candU = paste(cand, candOrigin, W, H);
  const a = flatten(refU).data;
  const b = flatten(candU).data;
  const n = W * H;

  // Content mask: background in an image = fully transparent, or near its dominant background.
  // Each image's part covered by the other one (its own coordinates).
  const ox0 = Math.max(0, offset.x);
  const oy0 = Math.max(0, offset.y);
  const ox1 = Math.min(ref.width, offset.x + cand.width);
  const oy1 = Math.min(ref.height, offset.y + cand.height);
  const overlap = ox1 > ox0 && oy1 > oy0 ? { x: ox0, y: oy0, width: ox1 - ox0, height: oy1 - oy0 } : undefined;
  const refBg = dominantBackground(ref, overlap);
  const candBg = dominantBackground(cand, overlap && { ...overlap, x: overlap.x - offset.x, y: overlap.y - offset.y });
  const backgroundMismatch =
    refBg.transparent !== candBg.transparent ||
    (!refBg.transparent && !nearRgb(new Uint8Array(refBg.color), 0, candBg.color));
  const ignore = new Uint8Array(n);
  let contentPixels = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const clearA = refU.data[i + 3] === 0;
    const clearB = candU.data[i + 3] === 0;
    const bgA = clearA || (!backgroundMismatch && nearRgb(a, i, refBg.color));
    const bgB = clearB || (!backgroundMismatch && nearRgb(b, i, candBg.color));
    if (bgA && bgB) ignore[p] = 1;
    else contentPixels++;
  }

  // One pixelmatch pass classifies every pixel (same / diff / AA); ignoreMask would not change
  // the classification of the others, so the content metric reuses it.
  const highlight = new Uint8Array(n * 4);
  pixelmatch(a, b, highlight, W, H, {
    threshold: PIXELMATCH_THRESHOLD,
    includeAA: false,
    checkerboard: false,
    alpha: 0.15,
    diffColor: [...DIFF_COLOR],
    aaColor: [...AA_COLOR],
  });
  const radius = Math.max(0, Math.floor(options.perceptualRadius ?? PERCEPTUAL_RADIUS));
  const overshoot = Math.max(0, options.perceptualOvershoot ?? PERCEPTUAL_OVERSHOOT);
  const a32 = new Uint32Array(a.buffer, a.byteOffset, n);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, n);
  let perceptualMismatchedPixels = 0;
  let mismatchedPixels = 0;
  let contentMismatchedPixels = 0;
  let antialiasedPixels = 0;
  let shiftedPixels = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let diff = highlight[i] === 255 && highlight[i + 1] === 0 && highlight[i + 2] === 0;
    if (!diff && highlight[i] === AA_COLOR[0] && highlight[i + 1] === AA_COLOR[1] && highlight[i + 2] === AA_COLOR[2]) {
      // pixelmatch calls it anti-aliasing; keep that only for sub-pixel (< 1 px) differences.
      const x = p % W;
      const y = (p - x) / W;
      if (withinHalfPixel(a, b, W, H, x, y) || withinHalfPixel(b, a, W, H, x, y)) {
        antialiasedPixels++;
      } else {
        diff = true;
        shiftedPixels++;
      }
    }
    if (diff) {
      mismatchedPixels++;
      if (!ignore[p]) contentMismatchedPixels++;
      // Perceptual: forgiven when each image's pixel has a close colour within `radius` px in the other.
      const x = p % W;
      const y = (p - x) / W;
      const real = radius === 0 || !neighbourMatch(a, a32, b, b32, W, H, x, y, radius, overshoot) || !neighbourMatch(b, b32, a, a32, W, H, x, y, radius, overshoot);
      if (real && !ignore[p]) perceptualMismatchedPixels++;
      const c = real ? DIFF_COLOR : STRICT_ONLY_COLOR;
      highlight[i] = c[0];
      highlight[i + 1] = c[1];
      highlight[i + 2] = c[2];
    }
  }

  const tv = performance.now();
  const salience = new Uint8Array(n);
  const visual = visualMetric(a, b, W, H, { ...DEFAULT_VISUAL, ...options.visual }, salience);
  const visualMs = performance.now() - tv;

  const refExtent = extentOf(ref, refOrigin);
  const candExtent = extentOf(cand, candOrigin);
  const boundsDelta =
    refExtent && candExtent
      ? {
          left: refExtent.x - candExtent.x,
          top: refExtent.y - candExtent.y,
          right: candExtent.x + candExtent.width - (refExtent.x + refExtent.width),
          bottom: candExtent.y + candExtent.height - (refExtent.y + refExtent.height),
        }
      : { left: 0, top: 0, right: 0, bottom: 0 };
  const boundsMismatch =
    Math.max(Math.abs(boundsDelta.left), Math.abs(boundsDelta.top), Math.abs(boundsDelta.right), Math.abs(boundsDelta.bottom)) > BOUNDS_TOLERANCE ||
    (refExtent === null) !== (candExtent === null);

  const boxes = options.referenceBox || options.candidateBox ? effectiveBoxes(ref, options) : null;
  const inCand = boxes?.candidate ?? boxes?.reference;
  const candidateBox = inCand ? { x: inCand.x - offset.x, y: inCand.y - offset.y, width: inCand.width, height: inCand.height } : null;

  const result: DiffResult = {
    width: W,
    height: H,
    reference: {
      width: ref.width,
      height: ref.height,
      croppedPadding: cropped.padding,
      background: refBg.transparent ? 'transparent' : hex(refBg.color),
      origin: refOrigin,
      extent: refExtent,
    },
    candidate: { width: cand.width, height: cand.height, background: candBg.transparent ? 'transparent' : hex(candBg.color), origin: candOrigin, extent: candExtent },
    offset,
    registration: {
      prior: reg.prior,
      priorSource: reg.priorSource,
      priors: reg.priors,
      winner: reg.winner,
      phase: reg.phase,
      window: reg.window,
      levels: reg.levels,
      evaluated: reg.evaluated,
      ms: Math.round(ms),
    },
    candidateBox,
    sizeDelta: { width: cand.width - ref.width, height: cand.height - ref.height },
    boundsDelta,
    boundsMismatch,
    referencePaddingIrregular: cropped.irregular,
    backgroundMismatch,
    totalPixels: n,
    mismatchedPixels,
    accuracy: n ? 1 - mismatchedPixels / n : 1,
    contentPixels,
    contentMismatchedPixels,
    contentAccuracy: contentPixels ? 1 - contentMismatchedPixels / contentPixels : 1,
    perceptualMismatchedPixels,
    perceptualAccuracy: contentPixels ? 1 - perceptualMismatchedPixels / contentPixels : 1,
    perceptualRadius: radius,
    antialiasedPixels,
    shiftedPixels,
    ssim: ssim(a, b, W, H),
    ...visual,
    visualMs: Math.round(visualMs),
  };
  return { result, diffPng: sideBySide(a, b, highlight, salience, visual.localWorst, W, H) };
}

/** Salience panel colours: matched edge-zone pixel, edge mismatch, flat mismatch, worst-window outline. */
export const SALIENT_COLOR: readonly [number, number, number] = [90, 200, 235];
export const EDGE_MISMATCH_COLOR: readonly [number, number, number] = [255, 0, 0];
export const FLAT_MISMATCH_COLOR: readonly [number, number, number] = [230, 0, 230];
export const INK_MISMATCH_COLOR: readonly [number, number, number] = [255, 120, 0];
export const WORST_WINDOW_COLOR: readonly [number, number, number] = [0, 170, 0];

/**
 * reference | candidate | highlight (perceptual) | salience (visual), all on the union canvas,
 * separated by 8 px gutters. The salience panel shows what the visual metric looked at: a faded
 * copy of the reference where nothing is salient, cyan = matched edge zone, red = edge
 * mismatch, magenta = flat mismatch; the worst `localAccuracy` window is outlined in orange on
 * the last two panels.
 */
function sideBySide(a: Uint8Array, b: Uint8Array, highlight: Uint8Array, salience: Uint8Array, worst: LocalWindow | null, w: number, h: number): Uint8Array {
  const gap = 8;
  const W = w * 4 + gap * 5;
  const H = h + gap * 2;
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 40;
    png.data[i + 1] = 40;
    png.data[i + 2] = 48;
    png.data[i + 3] = 255;
  }
  const blit = (src: Uint8Array, x0: number): void => {
    for (let y = 0; y < h; y++) png.data.set(src.subarray(y * w * 4, (y + 1) * w * 4), ((y + gap) * W + x0) * 4);
  };
  const panel = new Uint8Array(w * h * 4);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const c = salience[p]!;
    const col = c === Salience.EdgeMatch ? SALIENT_COLOR : c === Salience.EdgeMismatch ? EDGE_MISMATCH_COLOR : c === Salience.FlatMismatch ? FLAT_MISMATCH_COLOR : c === Salience.InkMismatch ? INK_MISMATCH_COLOR : null;
    if (col) {
      panel[i] = col[0];
      panel[i + 1] = col[1];
      panel[i + 2] = col[2];
    } else {
      const v = Math.round(255 - (255 - (0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!)) * 0.2);
      panel[i] = v;
      panel[i + 1] = v;
      panel[i + 2] = v;
    }
    panel[i + 3] = 255;
  }
  blit(a, gap);
  blit(b, gap * 2 + w);
  blit(highlight, gap * 3 + w * 2);
  blit(panel, gap * 4 + w * 3);
  if (worst) {
    const t = Math.max(1, Math.round(Math.min(w, h) / 400));
    for (const x0 of [gap * 3 + w * 2, gap * 4 + w * 3]) {
      // Drawn just inside the window, so that it stays visible at the canvas edge.
      for (let y = worst.y; y < worst.y + worst.height; y++) {
        for (let x = worst.x; x < worst.x + worst.width; x++) {
          const inner = x >= worst.x + t && x < worst.x + worst.width - t && y >= worst.y + t && y < worst.y + worst.height - t;
          if (inner) continue;
          const k = ((y + gap) * W + x0 + x) * 4;
          png.data[k] = WORST_WINDOW_COLOR[0];
          png.data[k + 1] = WORST_WINDOW_COLOR[1];
          png.data[k + 2] = WORST_WINDOW_COLOR[2];
        }
      }
    }
  }
  // One fixed filter: pngjs otherwise tries all five per row, which dominates on big boards.
  return new Uint8Array(PNG.sync.write(png, { filterType: 1, deflateLevel: 6 }));
}
