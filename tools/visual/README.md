# Visual verification harness

Measures how closely Penpot's render of a converted file matches Figma's. The loop:

1. start a local Penpot in Docker,
2. import a `.penpot` file through Penpot's API,
3. render boards to PNG with Penpot's own exporter,
4. diff the renders against reference PNGs exported from Figma,
5. write a report with per-board accuracy and diff images.

No step needs a browser.

```sh
node tools/visual/run.ts --penpot out/file.penpot --refs refs/file/      # diff → report
node tools/visual/run.ts --penpot out/file.penpot --list                 # pages + top-level boards
node tools/visual/run.ts --penpot out/file.penpot --render-only          # export every board, no diff
node tools/visual/run.ts --penpot out/file.penpot --refs refs/file/ --renderer both   # svg + wasm side by side
node tools/visual/batch.ts f2s- grida-                                   # convert + measure fixtures with refs (see Batch)
node tools/visual/selftest.ts                                            # end-to-end self-test
node --test tools/visual/diff.test.ts                                    # unit tests of the diff maths
node tools/visual/attacks.ts                                             # injected-defect table of the acceptance rule
```

## Penpot version

The images are pinned to **Penpot 2.19.0** (`penpotapp/{frontend,backend,exporter}:2.19.0`,
released 2026-11-09, multi-arch). `@penpot/library@1.3.0`, which our writer uses, is built
against 2.19.0, so files it writes import here with no migration step. To try another release,
run `PENPOT_VERSION=2.18.7 docker compose -f tools/visual/docker-compose.yaml up -d`. Also
update `PENPOT_VERSION` in `penpot.ts`, which is written into the reports.

## Starting and stopping

```sh
docker compose -f tools/visual/docker-compose.yaml up -d     # or let run.ts / selftest.ts do it
docker compose -f tools/visual/docker-compose.yaml ps
docker compose -f tools/visual/docker-compose.yaml logs -f penpot-exporter
docker compose -f tools/visual/docker-compose.yaml down      # keeps data; add --volumes to wipe it
```

- The compose project is `fig2pot-penpot`. The volumes are `fig2pot-penpot_postgres` and
  `fig2pot-penpot_assets`. Only `127.0.0.1:9001` is published (set `PENPOT_PORT` to change it).
- Services: frontend (nginx + SPA), backend, exporter, postgres 15, valkey 8.1. The mail,
  admin-console and MCP services from the upstream compose file are left out.
- On first start the backend runs its migrations, which takes 1–4 minutes. `up()` polls until
  the frontend, backend and exporter all answer. Later starts take seconds.
- Flags (`PENPOT_FLAGS`): `enable-registration enable-login-with-password
  disable-email-verification disable-secure-session-cookies disable-telemetry
  disable-onboarding disable-admin-console enable-access-tokens`.
  - Penpot appends these to its built-in defaults.
  - `disable-admin-console` is required on 2.19. The admin console is on by default, and
    without that service every `get-profile` fails with `nitrate-not-configured`.
  - Set `PENPOT_EXTRA_FLAGS="…"` to append more flags without editing the file.
- Leave the stack running between runs. Every run imports a fresh file and deletes it
  afterwards, so the stack stays clean.

## Local test user

| | |
| --- | --- |
| URL | http://localhost:9001 |
| email | `fig2pot@example.com` |
| password | `Fig2pot-local-1!` |

Override these with `PENPOT_EMAIL` / `PENPOT_PASSWORD` / `PENPOT_URL`.

`ensureUser()` tries `login-with-password` first. If that returns HTTP 400 (no such user), it
calls `prepare-register-profile` (fullname, email, password), then `register-profile` with the
returned token, then logs in. Because email verification is off, the profile is active right
away. Penpot 2.19 rejects weak passwords: the password needs a lowercase letter, an uppercase
letter, a digit and a symbol.

## Inspecting a file in the browser

Run with `--keep` and the file stays in Penpot; the run prints its workspace URL. Log in as the
test user and open:

```
http://localhost:9001/#/workspace?team-id=<team>&file-id=<file>&page-id=<page>
http://localhost:9001/#/workspace?team-id=<team>&file-id=<file>&page-id=<page>&board-id=<board>   # selects + zooms to a board
…&wasm=true    # force the WASM renderer (…&wasm=false forces the classic SVG one)
```

`report.json` records `fileId` and `workspaceUrl`. Board ids are the Penpot shape ids
(`penpotId('<figma id>')`). Kept files collect in the test user's Drafts project; delete them in
the UI, or wipe everything with `down --volumes`.

## Commands

`node tools/visual/run.ts --penpot <file.penpot> --refs <dir> [options]`

| option | default | |
| --- | --- | --- |
| `--out <dir>` | `tools/visual/.work/<input file stem>` | cleared at the start of each run |
| `--scale <n>` | `1` | export scale when the manifest gives none |
| `--metric visual\|perceptual\|content\|full` | `visual` | the pass rule. `visual` = the [acceptance rule](#acceptance-the-visual-metric): `visualAccuracy ≥ --min` (or ≤ 16 mismatched salient px) and `regionalAccuracy ≥ --min-regional` and `localAccuracy ≥ --min-local`. The others: that one ratio (`perceptualAccuracy`, `contentAccuracy`, `accuracy`) `≥ --min`, as before. Also the sort order of the report |
| `--min <ratio>` | `0.98` | threshold of `visualAccuracy` (or of the selected ratio) |
| `--min-local <ratio>` | `0.85` | visual rule: threshold of `localAccuracy` |
| `--min-regional <ratio>` | `0.92` | visual rule: threshold of `regionalAccuracy` |
| `--tolerance-px <n>` | `1` | neighbourhood radius of `perceptualAccuracy` (`PERCEPTUAL_RADIUS`), for experiments; `0` makes it equal `contentAccuracy`. Recorded as `report.tolerancePx` |
| `--renderer svg\|wasm\|both` | `svg` | see [Renderers](#renderers). `both` exports every board with each engine; pass/fail stays on svg |
| `--concurrency <n>` | 4 (svg) / 2 (wasm, both) | boards exported in parallel |
| `--keep` | off | keep the imported file and print its workspace URL |
| `--no-up` | off | fail (exit 3) instead of starting the stack |
| `--list` | | import, print pages and top-level boards (id, size, name), delete the file |
| `--render-only` | | export every top-level board into `<out>/candidate/` |

**Reference directory.** `<dir>` holds one PNG per Figma node, named by the node id with `:`
replaced by `-` (`12-34.png`, and `I1-2;3-4.png` for instance sublayers). It may also hold an
optional `manifest.json`:

```json
[{
  "nodeId": "12:34", "name": "Login", "page": "Screens", "type": "FRAME", "scale": 2,
  "width": 360, "height": 240,
  "box":          { "x": 100, "y": 50, "width": 360, "height": 240 },
  "renderBounds": { "x":  90, "y": 44, "width": 384, "height": 262 }
}]
```

The manifest supplies the export scale for each board, and a name/page to fall back on.
`box` (the node's own bounding box) and `renderBounds` (the area the PNG covers: box plus
outside strokes, shadows, overflowing children) are page-space rectangles written by
`tools/figma-refs/capture.js`. They tell the diff where the node's box sits inside the PNG
(`(box − renderBounds) × scale`). Every field except `nodeId` is optional. With an old manifest
that has no `box`/`renderBounds`, the PNG is taken to cover the box (`width × height`) at the
origin. A manifest entry without a PNG is reported as missing.

**Board lookup.** Each reference maps to the Penpot shape with id `penpotId(nodeId)`, searched
on every page. If no shape has that id, the harness falls back to the single top-level board
whose name matches the manifest `name` (and `page`, when given). The report notes such boards
as `matchedBy: "name"`. Fix those, because they mean the derived ids did not survive.

**Output.**
- `<out>/report.json`: the full data.
- `<out>/report.html`: one row per board with visual, local (and where its worst window is),
  perceptual, strict content and full, sorted worst-first under the pass rule (failing boards
  first, by local, then visual). Click a metric header to re-sort. Thumbnails of the
  reference, candidate and diff, plus summary totals.
- `<out>/{reference,candidate,diff}/<node>.png`. With `--renderer both`, the wasm files are
  `candidate/<node>.wasm.png` and `diff/<node>.wasm.png`.
- `report.json` per board: `metrics` (primary renderer, as before) plus `metricsByRenderer`,
  `filesByRenderer`, `errorsByRenderer`. Top level: `renderer` (primary), `renderers`, `metric`,
  `min`, `minLocal`, `minRegional`, `tolerancePx`, `summary` (primary) and `summaryByRenderer`.
- A summary table on stdout.

The totals (`summary.{visualAccuracy, localAccuracy, regionalAccuracy, perceptualAccuracy,
contentAccuracy, accuracy}`) have `mean`, `median`, `min`, `shareAtLeastMin` (share at or
above that metric's threshold) and the older `shareAtLeast98`; `summary.passed` counts the
boards passing the rule, `summary.trivial` the trivial ones. Missing boards and failed exports
count as 0. Trivial boards are left out of the visual, local and regional totals.

**Exit codes.**

| code | meaning |
| --- | --- |
| 0 | every board passes the rule (default: the visual rule) on the primary renderer |
| 1 | some board fails the rule, is missing, or failed to export (primary renderer) |
| 2 | **import failure**; Penpot's error payload is printed verbatim |
| 3 | usage or infrastructure error (e.g. Penpot unreachable) |

## Metrics (`diff.ts`)

The two PNGs generally cover different areas:
- Figma's covers the node's `renderBounds`.
- Penpot's exporter adds its own padding around the shape (see
  [Export padding](#export-padding)).
- Top-level bare shapes (vectors, groups, sections) are export targets too.

So the diff first **crops** Figma's section margin (below), then **registers** the images, then
compares them on one shared canvas.

### Section padding

Figma pads SECTION exports by **40 px a side beyond `renderBounds`**, and that margin shows
whatever else is on the page there (f2s-prototyping 22:44: blocks of other top-level frames in
the bottom margin). It is not the node's content, so it is not compared:
`cropReferencePadding` crops a PNG that is more than 1 px larger than `renderBounds × scale`
back to that size, centred.
- Only a **uniform margin** is cropped: left = ⌊surplus x / 2⌋, right = the rest, likewise top
  and bottom, all four within 1 px of each other. All 57 sections of the corpus have exactly
  80/80 (40 px a side). Anything else is left alone, compared as before with the box shifted by
  half the surplus, and flagged `referencePaddingIrregular`.
- A surplus of ≤ 1 px is rounding of fractional bounds, not padding.
- Overflow of the section's own children is part of `renderBounds`, so the crop keeps it and
  it is compared (unit test; no section in the corpus has visible overflow).
- Reported as `reference.croppedPadding` (`{left, top, right, bottom}` or null);
  `reference.width/height` are the size after cropping. The diff image shows the cropped PNG.

### Registration

`register(ref, cand, options)` finds the integer offset of the candidate's top-left relative
to the reference's top-left. It must be right whenever the two renders show the same content,
however each side pads it, so it assumes neither containment nor symmetric padding.
- **Agreement measure**: L1 distance of premultiplied luminance + alpha over the **union** of
  the two placements. A pixel covered by one image only is compared against transparent. That
  is `mass(ref) + mass(cand) − 2·Σ_overlap min(ref, cand)`, so only the overlap is iterated.
- **Priors** are starting candidates, never limits. The node box in reference px is known: the
  Penpot shape's page-space box (`candidateBox`: `points`, else `selrect`, from `get-file`; the
  converter keeps page coordinates, so it is placed via `renderBounds`), else the Figma box.
  Where it sits in the candidate is not known. The priors place it:
  - `bounds` (first, when known): the **predicted export area** centred in the candidate.
    `exportBounds` (run.ts) unions the shape's box with every descendant's, unless the shape
    clips (a board without `showContent`, a masked group, a boolean); clipping children
    contribute their own box only. Invisible shapes count, as in Penpot's exporter. Without
    strokes, shadows or blurs it is exact: auto-layout-playground "Contents" is a 1280 px
    section whose unfilled 613 px rect sticks out 53 px to the right, and Penpot exports
    1333 px. Strokes and shadows pad roughly symmetrically, hence "centred".
  - per axis `centre` (symmetric padding), `start` (box at the candidate's top/left: overflow
    only right/bottom) and `end` (box at its bottom/right), all 9 combinations, named `x/y`
    (`start/centre`) or one word when both axes agree or one axis has no padding.
  - Duplicates are dropped. The first prior is the tie-breaker.
- **Window** per axis: the box lies somewhere in the candidate, so the offset lies in
  `[box − (candSize − boxSize), box]`, the same for the predicted export area, unioned with
  "one image inside the other" (`[min(0, Δ), max(0, Δ)]`, `Δ = refSize − candSize`) and with
  every prior, ± `SEARCH_MARGIN` = 3 px. On large boards with one-sided overflow this is
  hundreds of px. (The previous window, containment ± 3 px around a centred prior, did not
  contain the true offset of "Contents": it registered 25 px off and scored 37 %.)
- **Coarse to fine**:
  - build 2× box-filter pyramids of both images;
  - search exhaustively at the coarsest level whose offsets × pixels fit 4 M;
  - refine its 3 best *distinct* local optima (≥ 2 coarse px apart) and every prior
    independently: at each finer level, the 3×3 neighbourhood of the doubled position plus the
    prior's own position; candidates that meet are merged;
  - before each of the two finest levels (which dominate the cost), drop candidates scoring
    worse than `PRUNE_RATIO` = 1.5 × the best.
- **Prior check** (guard against periodic content): coarse levels alias text lines and grids,
  so the pyramid can settle one or more periods off. Afterwards every prior is scored at full
  resolution, dropped or not; one within `PRUNE_RATIO` of the winner is refined by steepest
  descent over its 8 neighbours; the best of all wins. Unit test: stems with a period of 6–10 px,
  1 px bolder in the candidate, 333 px of invisible overflow on one side. The previous
  registration was one or two periods off; now the `end` prior wins.
- **Ties** (equal score): closest to the first prior, then smallest `|dx| + |dy|`, then `dy`,
  then `dx`. Featureless pairs (e.g. both transparent) therefore land on the first prior. The
  result is deterministic.
- **Cost** on a 2500×2500 vs 2558×2562 pair (Apple Silicon): ~0.3–0.45 s for registration,
  ~280 offsets over 5 levels (10 priors). The whole diff, including the PNG encode, takes ~1 s.
  Corpus (361 boards): median 13 ms, p95 37 ms, max ~0.3 s per board; ~6 s in total.
- Reported as:
  - `offset`;
  - `registration.{prior, priorSource: bounds|selrect|centre, priors[], winner[], phase, window, levels, evaluated, ms}`:
    `winner` lists which candidates ended on the offset (`search` = the coarse search, or prior
    names); `phase` is `exhaustive` (small pairs: the whole window at full resolution),
    `pyramid`, `prior-check` (a prior beat the pyramid at full resolution) or `fixed`;
  - `candidateBox`: where the Penpot box landed in the candidate, i.e. the export padding.

### Comparison

- **Canvas**: the union of both registered images (`width` × `height`). Each image is pasted
  onto it, transparent where it does not reach. Both are composited over the same
  **`NEUTRAL_BACKGROUND` = #808080**.
  - Mid grey rather than white, so that white overflow or a white board edge present in only
    one render is a mismatch.
  - The flip side: a #808080-ish pixel against nothing goes unnoticed, which is far rarer in
    designs.
  - Overflow that only one render has counts as a mismatch. Identical overflow is free.
- **`accuracy`** = 1 − mismatched / total pixels, over the whole union canvas.
- **`contentAccuracy`** ("strict") = the same ratio, restricted to *content* pixels. Before the
  perceptual metric existed this was the bar; it is now the secondary number (`--metric content`).
  - A pixel is background in an image when it is fully transparent there, or when every RGB
    channel of its composited colour is within 8/255 of that image's dominant background.
  - The dominant background comes from each image's own pixels:
    - fully transparent pixels form one bucket;
    - the others go into a 5-bit-per-channel histogram;
    - the biggest bucket wins, transparency winning ties, and the colour is the bucket's mean;
    - fully transparent pixels **outside the other image's footprint do not vote**: transparent
      export padding or invisible overflow that only one render has must not turn its
      background "transparent" (which would set `backgroundMismatch` and count every opaque
      pixel as content). Visible pixels always vote.
  - It is reported as `#rrggbb` or `transparent`. For a transparent background the colour is
    the neutral grey, so faint anti-aliasing tails also count as background.
  - Content = pixels that are background in neither image. Transparent vs transparent is never
    content.
  - If the two dominant backgrounds differ (`backgroundMismatch`), every pixel that is not
    transparent in both counts as content.
  - A board with no content pixels scores 1.
- **Per-pixel decision**: there are two tests.
  1. `pixelmatch` v8 with `threshold: 0.1` (OKLab HyAB distance; black vs white = 1). Pixels
     within the threshold match.
  2. Pixels over it that pixelmatch classifies as anti-aliasing (`includeAA: false`) are
     forgiven only if they also pass a **half-pixel shift check**. One image's pixel must lie
     within the other image's bilinear interpolation range over ±0.5 px around it (min/max of
     the centre, 4 axis half-points and 4 diagonal quarter-points), ± `SHIFT_TOLERANCE` = 4/255
     per channel, in either direction.

  The rest are mismatches. `antialiasedPixels` and `shiftedPixels` (AA-classified but ≥ 1 px
  away) are reported. See [Sub-pixel tolerance](#sub-pixel-tolerance).
- **Bounds**: `extent` is each image's bounding box of pixels with alpha > 8 on the union
  canvas.
  - `boundsDelta` is how far the candidate's extent sticks out beyond the reference's on each
    side (negative = the reference sticks out).
  - `boundsMismatch` is set when some |Δ| > 2 px. It is informational and does not affect
    pass/fail.
  - Judged on visible pixels only, so a candidate that is merely *larger* because of fully
    transparent overflow (an invisible text box or unfilled rect sticking out of a non-clipping
    parent) is not flagged and costs nothing: outside the reference both sides are
    transparent, which is a match and not content. Visible extra content is a mismatch and sets
    it (unit tests for both).
  - `sizeDelta` is the raw image size difference, which is normal since Penpot pads.
  - The old `sizeMismatch` is gone.
- **`ssim`**: an informational extra, the mean SSIM of luminance over 8×8 blocks of the union
  canvas. It ignores hue: a red-to-green swap scores ≈ 1.0.
- **`perceptualAccuracy`**: see [Perceptual accuracy](#perceptual-accuracy-the-previous-acceptance-metric).
- **`visualAccuracy`, `regionalAccuracy`, `localAccuracy`**: see [Acceptance](#acceptance-the-visual-metric).
- **Diff image**: four panels on the registered union canvas, so they line up:
  *reference | candidate | highlight | salience*.
  - Reference and candidate are drawn composited over the neutral grey.
  - In the highlight panel:
    - **red** = perceptual mismatch (real);
    - **blue** = strict-only mismatch, forgiven by the perceptual metric (rasteriser-level, ≤ 1 px);
    - **yellow** = anti-aliasing forgiven by both metrics;
    - matching pixels are a faded greyscale copy.
  - The salience panel shows what the visual metric looked at: **cyan** = matched edge-zone
    pixel, **red** = edge mismatch, **magenta** = flat mismatch, **orange** = ink mismatch, and
    a faded copy of the reference where nothing is salient. The worst `localAccuracy` window is
    outlined in **green** on the highlight and salience panels.

### Sub-pixel tolerance

Figma and Penpot (Chromium/Skia) anti-alias differently, and they also round sub-pixel
geometry differently. `diff.test.ts` pins down what counts as a match:

| synthetic case | pixelmatch alone (`includeAA: false`) | this diff |
| --- | --- | --- |
| hard-edged rect shifted 1 px | mismatch at both edges | mismatch (40/40 edge px) |
| **anti-aliased** rect (edges at .5) shifted 1 px | **0 mismatches**: every changed pixel looks like AA | mismatch (half-pixel check) |
| 1-px anti-aliased line shifted 1 px | 0 | mismatch |
| same rect, AA ramp gamma 1 vs 2.2 | match (AA) | match |
| edge shifted by 0.5 px | match (AA) | match |
| part of a board shifted 1 px vs the rest | — | mismatch; registration aligns the rest |

- **Why the extra check.** pixelmatch's AA detector forgives any pixel whose darkest or
  brightest neighbour sits in a flat area in both images, and a 1-px shift of an anti-aliased
  edge satisfies that.
- **It only tightens.** It runs on pixels pixelmatch already forgave, so it can turn matches
  into mismatches and never the reverse. Threshold 0.1 is kept: the AA-ramp case exceeds it
  (needs the AA path), and nothing above justified loosening it.
- **Known edge case.** A near-tangent arc that differs by ~0.1 px normal to the edge shifts the
  AA ramp along the edge by ~1 px, and is flagged. On f2s-corners this was one pixel.
- **Registration absorbs global shifts.** A whole render offset by 1 px is aligned away. Only
  shifts of one part relative to the rest are measured.

In the self-test, rendering the text in Roboto instead of Inter scores **96.6 – 97.3 %
`accuracy`** (svg and wasm) but **89.7 – 95.7 % `contentAccuracy`**. Before the half-pixel check
those were 95.0 – 97.9 %. The glyph-edge shifts pixelmatch used to forgive as anti-aliasing now
count.

### Acceptance (the visual metric)

**Why it replaced `perceptualAccuracy ≥ 98 %`.** An audit (2026-11-11) showed that the old rule
does not mean "looks the same":
- **Dilution.** Its denominator is every pixel that is not the one dominant background colour,
  so a large flat panel that matches trivially (a 390×720 side panel is 70 % of "content") hides
  real errors next to it. A 1280×720 board could carry ~8,000 wrong pixels and pass: a removed
  16 px icon, a swapped icon, a replaced word, a removed text line, a missing divider, a removed
  soft shadow all passed (table below).
- **Colour slack.** pixelmatch's 0.1 (HyAB) tolerates ±24–32 grey levels on edges, and the
  neighbourhood interpolation forgives any colour between ink and background: #1e1e1e text drawn
  as #555555 scored 100 %. A selected-row blue (69,151,247) vs (11,153,254) is 0.027 apart: a
  match even at 0.03.
- **Small boards** failed on noise (49 wrong pixels are the whole budget of a 2,500-pixel
  "Button" board), and **19 empty boards** passed vacuously at 100 %.

**Definition** (`diff.ts`, `visualMetric`; same registered, composited union canvas as the other
metrics).
1. **Edge zone.** A pixel is an edge seed when its 3×3 neighbourhood spans more than
   `EDGE_CONTRAST` = 12 levels (max over R, G, B) in *either* image. The seeds dilated by
   `EDGE_RADIUS` = 1 px are the edge zone, i.e. everything within 2 px of a contrast step: text,
   strokes, icon outlines, dividers ≥ #f3f3f3 on white, image detail. Flat fills and smooth
   gradients (≤ 3 levels/px; banding of 1–2 levels) are not edges.
2. **Edge mismatch.** An edge-zone pixel matches when the ≤ 1 px bilinear neighbourhood test
   (`neighbourMatch`, as for `perceptualAccuracy`) passes in both directions at a tighter colour
   slack, `EDGE_THRESHOLD` = 0.05 HyAB instead of 0.1. The neighbourhood search is now complete
   enough to afford that: besides pixels, segments (with `PERCEPTUAL_OVERSHOOT` = 0.25) and cell
   centres, it tests the closest point of every 2×2 cell's bilinear patch (a displacement in x
   *and* y blends four pixels) and every neighbour extrapolated (by the overshoot only) away
   from its outer neighbour (a stem displaced by ¼ px moves its peak-ink pixel by one column).
3. **Flat mismatch.** A pixel outside the edge zone is a mismatch when the two colours differ by
   more than `FLAT_TOLERANCE` = 0.02 HyAB (≈ 5 grey levels; 3 levels pass, 6 fail; the audit's
   blue rows, 0.027, fail) and the other image has no colour within that tolerance in its 3×3
   neighbourhood, in both directions (a smooth gradient displaced by 1 px passes).
4. **Ink test.** The neighbourhood test cannot tell lighter ink from less coverage (60 % of
   #1e1e1e is 100 % of #555555), so lighter text only failed at its stem cores. A window's
   extremes can: a sub-pixel shift or a bolder stem keeps the darkest ink, a recolour moves it.
   Per `INK_WINDOW` = 64 px window (stride 32, ≥ 256 edge pixels) the darkest and lightest
   edge-zone lightness (OKLab Lr) of each image are compared with the other image's over the
   window grown by `INK_MARGIN` = 2 px (so a feature displaced across the window border is not a
   different ink). Where one differs by more than `INK_TOLERANCE` = 0.15 (#1e1e1e → #555555 is
   0.23, → #3a3a3a 0.12), every edge pixel on that side of the window's mid-lightness is an
   **ink mismatch**. With 32 px windows at 0.1 the test flagged 29 extra outline boards, with
   64 px windows at 0.1 seven, at 0.15 one (a labelled ⇧ board): over part of one thin stroke the
   darkest pixel is the rasteriser's peak coverage, which differs legitimately.
5. **Salient** = edge zone ∪ flat mismatches. Flat pixels that match are in neither numerator nor
   denominator, so matching fills dilute nothing, and every wrongly coloured area counts in full.
   - **`visualAccuracy`** = 1 − (edge + flat + ink mismatches) / salient (1 with no salient pixel).
   - **`localAccuracy`** = the same ratio in the worst `LOCAL_WINDOW` = 32 px window (stride
     `LOCAL_STRIDE` = 16, windows with ≥ `LOCAL_MIN_SALIENT` = 32 salient pixels; boards smaller
     than a window use the whole extent). Reported with `localWorst` ({x, y, width, height,
     salient, mismatched, accuracy}), `localWindows` and `localWindowsBelow` (below `MIN_LOCAL`).
     32 px, not 64: compact defects (an icon, a corner) are diluted by a 64 px window
     (removed 16 px icon 89 %, radius 16 → 8 91 %), while 1-px-row artefacts score the same
     at any window size, so the smaller window separates them better.
   - **`regionalAccuracy`** = the same in the worst `REGION_WINDOW` = 128 px window (stride 64,
     ≥ 512 salient pixels), with `regionalWorst`. It catches spread-out defects that are mild in
     every 32 px window: a paragraph displaced by 2 px (86 % local, 90.8 % regional).
   - **`trivial`**: no salient pixel and both images one flat colour (within `EDGE_CONTRAST`).
     Passes; excluded from means and minima, counted separately in summaries.
   - Counts: `salientPixels`, `edgePixels`, `edgeMismatchedPixels`, `flatMismatchedPixels`,
     `inkMismatchedPixels`, `visualMismatchedPixels`; `visualMs` is its time.
6. **Pass rule** (`visualPasses`, `--metric visual`, the default):
   `(visualAccuracy ≥ MIN_VISUAL = 0.98  or  visualMismatchedPixels ≤ VISUAL_ALLOWANCE = 16)`
   `and regionalAccuracy ≥ MIN_REGIONAL = 0.92  and localAccuracy ≥ MIN_LOCAL = 0.85`.
   - The **allowance** matters below ~800 salient pixels (16 px = 2 % of 800). On all three
     corpus runs no small board (< 3,000 salient px) that looks right has more than 15
     mismatched pixels (wasm "Button" f2s-prototyping-components 1:30); the 8 px chevron removal
     (13 px) is still caught by the local rule (80 %).
   - `--min`, `--min-local`, `--min-regional` override the thresholds; `--metric
     perceptual|content|full` restores a single-ratio rule. `accuracy`, `contentAccuracy` and
     `perceptualAccuracy` keep their definitions.
   - The tunables are `VisualParams` (`DEFAULT_VISUAL`; `DiffOptions.visual` overrides them).

**Calibration: injected defects** (`node tools/visual/attacks.ts`; `diff.test.ts` asserts the
`fail`/`pass` rows). Base: auto-layout-playground 2411:12302 "Flexible resizing" (Figma
reference, 1280×720), defects injected into a copy (the audit's fixtures, plus pass cases).

| change | expect | old perceptual | visual | regional | local | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| remove 16 px icon | fail | 99.98 % | 99.94 % | 97.28 % | **69.44 %** | fail ✓ |
| swap a 24 px icon | fail | 99.97 % | 99.69 % | 87.86 % | **33.63 %** | fail ✓ |
| replace a word | fail | 99.92 % | 99.77 % | 91.12 % | **56.69 %** | fail ✓ |
| remove one text line | fail | 99.17 % | 97.26 % | 66.19 % | **14.29 %** | fail ✓ |
| remove a 60×16 arrow | fail | 99.93 % | 99.81 % | 82.28 % | **50.00 %** | fail ✓ |
| remove an 8 px chevron | fail | 100 % | 99.99 % | 99.69 % | **80.00 %** | fail ✓ |
| text #1e1e1e → #555555 | fail | 100 % | 97.77 % | 83.57 % | **73.18 %** | fail ✓ |
| text #1e1e1e → #808080 | fail | 99.56 % | 97.77 % | 83.57 % | **73.18 %** | fail ✓ |
| paragraph displaced 2 px | fail | 99.57 % | 98.65 % | **90.83 %** | 86.41 % | fail ✓ |
| missing 1 px divider #808080 / #d0d0d0 / #e5e5e5 | fail | 99.91 / 99.91 / 99.97 % | 99.75 % | 92.24 % | **80.00 %** | fail ✓ |
| corner radius 16 → 8 | fail | 99.94 % | 99.81 % | 95.92 % | **80.06 %** | fail ✓ |
| soft shadow (0 4 12 12 %) removed | fail | 100 % | 97.75 % | 76.32 % | **38.46 %** | fail ✓ |
| 316×158 block fill 5 % darker | fail | 100 % | **75.86 %** | 5.74 % | 0.00 % | fail ✓ |
| paragraph displaced 1 px | pass | 100 % | 100 % | 100 % | 100 % | pass ✓ |
| paragraph emboldened 0.35 px | pass | 99.98 % | 99.93 % | 99.37 % | 96.68 % | pass ✓ |
| whole board emboldened 0.5 px | pass | 99.72 % | 99.04 % | 96.97 % | 90.04 % | pass ✓ |
| whole board resampled 0.5 px right (hairlines → 2 × 50 %) | pass | 99.63 % | 98.42 % | 95.60 % | 92.02 % | pass ✓ |
| rounded card re-rendered at (+0.4, +0.3) px / +0.5 px | pass | 100 % | 100 % | 100 % | 100 % | pass ✓ |
| anti-aliasing ramp gamma 0.6 / 1.6 | pass | 100 % | 100 % | 99.91 % | 99.15 % | pass ✓ |
| text #1e1e1e → #262626 | pass | 100 % | 100 % | 100 % | 100 % | pass ✓ |
| ⚠ border 3 → 5 px (1 px per side) | fail | 99.99 % | 99.97 % | 99.29 % | 95.64 % | **passes** (blind spot) |
| ⚠ corner radius 8 → 0 | fail | 99.99 % | 99.97 % | 98.86 % | 96.20 % | **passes** (blind spot) |
| ⚠ corner radius 8 → 4 | — | 100 % | 99.99 % | 99.79 % | 99.05 % | passes |
| ⚠ text #1e1e1e → #3a3a3a | — | 100 % | 100 % | 100 % | 100 % | passes (below the ink tolerance) |
| ⚠ whole board bilinear-resampled (0.3, 0.3) px | — | 99.81 % | 97.97 % | 92.10 % | 70.31 % | fails (it blurs: a 1 px line loses ink) |

**Calibration: the audit's labelled boards** (auto-layout-playground; `.work-main` = editable
text, `.work-outline` = text as outlines, `.work-wasm`; old = perceptual ≥ 98 %):

| board | label | main: old → visual / regional / local | outline: visual / regional / local | wasm: visual / regional / local |
| --- | --- | --- | --- | --- |
| 2411:10315 tiles inset, sharp corners | wrong | 98.15 % pass → 95.2 / 58.2 / 20.0 **fail** | 95.6 / 58.2 / 20.0 fail | 95.0 / 58.2 / 20.0 fail |
| 2411:13171 cut-out stroke 5 px vs 2 px | wrong | 98.47 % pass → 95.7 / 61.5 / 41.9 **fail** | fail | 99.95 / 99.5 / 98.9 pass (wasm draws it right) |
| 2411:13170 same | wrong | 98.25 % pass → 95.4 / 61.1 / 33.3 **fail** | fail | 98.8 / 79.9 / 63.9 fail |
| 2411:12965 ⇧ drawn as a thin ↑ | wrong | 99.26 % pass → 97.7 / 83.8 / 55.9 **fail** | 99.8 / 94.0 / 83.0 fail | fail |
| 2412:2238 same | wrong | 99.29 % pass → 97.3 / 82.0 / 56.0 **fail** | 99.4 / 95.9 / 66.7 fail (a 1-px edge row, see below) | fail |
| 2411:13020 same | wrong | 99.72 % pass → 99.0 / 84.5 / 42.7 **fail** | 99.95 / 99.5 / 95.7 pass (text-related) | 98.9 / 96.9 / 86.6 pass |
| 2412:2241 same | wrong | 99.72 % pass → 98.7 / 82.2 / 42.7 **fail** | 99.7 / 95.3 / 81.5 fail | fail |
| 2411:13036 same | wrong | 98.29 % pass → 98.5 / 89.1 / 44.8 **fail** | 100 / 100 / 100 pass (text-related) | 99.4 / 96.8 / 86.8 pass |
| 2411:12973 same | wrong | 98.18 % pass → 97.3 / 90.3 / 51.1 **fail** | 99.8 / 97.8 / 94.7 pass (text-related) | fail |
| 1620:2551 wrong truncated text | wrong | 98.40 % pass → 95.3 / 77.6 / 59.6 **fail** | fail | fail |
| 2411:10435 same | wrong | 98.60 % pass → 98.4 / 85.4 / 63.0 **fail** | 100 / 100 / 100 pass (text-related) | fail |
| 1620:1478 dashed outline corner / phase | wrong | 98.74 % pass → 94.1 / 53.5 / 20.8 **fail** | fail | fail |
| 2411:12784 selected-row blue | wrong | 99.71 % pass → 98.7 / 81.9 / 67.3 **fail** | 99.75 / 96.7 / 72.7 fail | fail |
| 2411:12859 same | wrong | 98.04 % pass → 97.3 / 89.8 / 63.3 **fail** | 99.3 / 94.9 / 63.3 fail | fail |
| 2411:12955–12963 "Button 01–05" | same | 92.9–94.5 % fail → 96.2–96.9 / 95.5–96.4 / 75.6–79.2 **fail** | 100 / 100 / 100 **pass** | fail |
| 2411:12953 | same | 95.63 % fail → 96.7 / 93.4 / 78.0 **fail** | 100 / 100 / 100 **pass** | fail |

- All 14 false passes fail on `.work-main`. On `.work-outline` the five that still pass are
  all text-related (⇧ / truncation drawn correctly once the text is outlined); the non-text ones
  (tiles, cut-out strokes, dashes, blue rows) fail there too.
- **Conflict: the six "identical" boards fail on `.work-main` and `.work-wasm`.** They are
  identical when the text is outlined (100 % on every number), but editable text currently lands
  1.5–2 px left of Figma's (the baseline/placement fix is in progress), and a 2 px text
  displacement is exactly what the rule must catch. Catching the defect won: they fail until the
  text placement is fixed. (Their old 93–94 % failures were the same drift, diluted.)

**Calibration: corpus** (361 boards each, re-scored with `rediff.ts`, no re-rendering):

| run | old rule passes | new rule passes | pass → fail | fail → pass | trivial | visual median / mean | regional median | local median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.work-outline` | 331 | 256 | 75 | 0 | 19 | 99.91 / 98.56 % | 99.47 % | 96.30 % |
| `.work-main` | 295 | 136 | 159 | 0 | 19 | 98.82 / 97.46 % | 92.86 % | 78.70 % |
| `.work-wasm` | 292 | 132 | 160 | 0 | 19 | 98.44 / 97.29 % | 92.64 % | 78.75 % |

Most of main's and wasm's extra failures are the editable-text drift. Of 25 new failures checked
by eye (the 10 with the lowest local score on main, 15 spread over the three runs) 24 are real:
blue fills and rows in a different blue, strokes ~2 px thicker, dashed outlines with another
phase, ⇧ glyphs, a 1-px selection line drawn grey instead of blue, divider colours, text drift.
One is an artefact (2412:2238 on outline fails on a 1-px AA row at a key's edge). Reading all 75
outline failures, about 10 (13 %) are that artefact class: see below.

**Blind spots** (what the rule still cannot see, or sees too much of):
- **Geometry changes of ≤ 1 px per edge** are forgiven by design (the neighbourhood is 1 px, so
  that a 1-px displacement or a ½-px embolden passes): a stroke 3 → 5 px (1 px per side), a corner
  radius 8 → 0 or 8 → 4 on a small corner, a 1 → 3 px hairline. Telling "both edges of a stroke
  moved out by 1 px" from "the stroke moved by 1 px" needs a displacement-consistency check,
  which this rule does not have. The strict `contentAccuracy` and the blue pixels of the
  highlight panel still show them.
- **Ink lighter or darker by less than 0.15 Lr** (#1e1e1e → #3a3a3a) and hue changes of thin
  text that stay on the ink–background line.
- **Colour changes of ≤ 5 grey levels** on flat areas (`FLAT_TOLERANCE`), ≤ 0.05 HyAB on edges.
- **Spread-out defects milder than 8 %** of a 128 px region (e.g. text 1 px bolder everywhere).
- **Sub-pixel AA-row artefacts fail** (the main source of false failures, ≈ 13 % of the new
  outline failures): one pixel row along a long edge blended against a different neighbour, e.g. a
  frame's fill bleeding ½ px under its stroke (`#596045` vs `#404040`), a blue selection line
  over a black stroke (`#5498c6` vs `#1d618f`), a badge outline ~½ px heavier, the SVG exporter's
  ¼-px stroke clip (f2s-corners 2051:15). Invisible at 1×; such a row is 1 in 3–5 edge-zone
  rows, so it lands at 67–80 % local in an otherwise empty window. Look at the salience panel: a
  single red row along an edge is this class.

**Cost.** Corpus medians 23–29 ms per board, p95 ≤ 150 ms, max 784 ms (2276×2481); ~15 s over
361 boards. Worst case (synthetic 2500×2500 dense text, every edge pixel different, 3.7 M
salient px): ~1.0 s (`diff.test.ts`). A full `rediff.ts` of the corpus now takes 50–65 s.

### Perceptual accuracy (the previous acceptance metric)

Kept unchanged in `report.json` and selectable with `--metric perceptual`. It is no longer the
acceptance metric: an audit showed that 98 % of it does not mean "looks the same" (see
[Acceptance](#acceptance-the-visual-metric)). The text below is its original description.

**Why a third metric.** `contentAccuracy` is right to be strict, but on text it mostly measures
the difference between two rasterisers: Figma's own versus Chromium/FreeType inside Penpot's
exporter. Glyph stems come out a fraction of a pixel thicker or thinner and at other sub-pixel
offsets, while the text is in the same place and looks the same. The *Button* board below (one
word of 14 px text) scores 71.7 % strict although nothing is wrong. `perceptualAccuracy` forgives
exactly that class of difference (`--metric perceptual`, `--min 0.98`). Report the strict number next to it.

**Definition** (`diff.ts`, `neighbourMatch`). Same registered union canvas, same composited
colours (alpha included, over `NEUTRAL_BACKGROUND`) and same content mask as `contentAccuracy`.

- A content pixel is a **perceptual mismatch** when it is a strict mismatch (as in
  `contentAccuracy`) **and** the neighbourhood test fails in at least one direction.
- Strict matches stay matches (forgiven anti-aliasing included), so
  `perceptualAccuracy ≥ contentAccuracy` always.
- **Neighbourhood test**, *x → y* at pixel *p*: the colour *x(p)* must occur, within the
  pixelmatch threshold (0.1, OKLab HyAB, as pixelmatch v8 computes it), in image *y* displaced
  by at most `PERCEPTUAL_RADIUS` = 1 px in x and y.
  - *y* is sampled **continuously**, i.e. bilinearly interpolated, because a sub-pixel shift
    re-blends an edge into intermediate colours that neither image contains as such.
  - Tested conservatively, in increasing cost, over the 3×3 neighbourhood of *p* in *y*:
    1. its 9 pixels;
    2. the closest point (sRGB) to *x(p)* on each segment between two 4- or 8-adjacent pixels;
    3. the centre of each 2×2 cell.
  - Each segment may be continued beyond its ends by `PERCEPTUAL_OVERSHOOT` = 0.25 of its
    length. A stem a fraction of a pixel thicker reaches full ink where the other renderer's
    thinner stem peaks at 80–90 % coverage. Flat areas have no contrast and get no slack.
    - At 0, the 14 px *Button* board drops to 97.9 %.
    - At 0.5, a #5f5f5f hairline would pass as #000.
- Both directions, ref → cand and cand → ref, must pass.
- The search reads **only the other image**, never the pixel's own, so a busy image cannot match
  itself (tested).
- `perceptualMismatchedPixels` is the count; `perceptualAccuracy` = 1 − that / `contentPixels`
  (1 without content); `perceptualRadius` records the radius used.
- `--tolerance-px` changes the radius. 0 makes it identical to `contentAccuracy`.
- **Cost**: the test only runs on strict mismatches, with typed arrays and no per-pixel
  allocation. Real 2276×2481 boards: +20–40 ms. A synthetic 2500×2500 board with 1.03 M strict
  mismatches: +345 ms.

**What it catches and what it forgives.** All rows are unit tests in `diff.test.ts` (synthetic,
black on white) unless marked *self-test*. Values are perceptual / strict content.

| change | perceptual | strict | verdict |
| --- | --- | --- | --- |
| rect displaced 1 px (hard or anti-aliased edge, also diagonal) | 100 % | edges flagged | forgiven |
| rect displaced 2 px | 2 columns per edge flagged | 2 columns | caught |
| 1-px line displaced 1 px / 2 px / missing | 100 % / 0 % / 0 % | 0 % / 0 % / 0 % | forgiven / caught / caught |
| text-like glyph pattern (1.6-px stems, 3 rows of 12 glyphs), sub-pixel offset 0.25 / 0.5 px | 100 % | 94 % / 64 % | forgiven |
| same, displaced 1.5 px / 2 px | 59 % / 41 % | 20 % / 13 % | caught |
| stems (1.6 px) thickened by 0.1 – 1 px, one side | 100 % | 49–92 % | forgiven |
| same, thickened by 1.5 / 2 / 3 px | 60 % / 48 % / 38 % | 47 % / 37 % / 30 % | caught |
| hairline stems (1.2 px) thickened by 0.25 / 0.5 / 1 px | 97 % / 94 % / 90 % | | partly caught: the peak darkness of a hairline changes visibly |
| text re-wrapped (last word on the next line) | < 60 % | | caught |
| recolour of a 10×10 area or a 3-px strip (also grey → black, light → dark red, red → blue) | 0 % | 0 % | caught, edges included |
| colour within the pixelmatch threshold | 100 % | 100 % | forgiven by both |
| different anti-aliasing gamma (1 vs 2.2) | 100 % | 100 % | forgiven by both |
| **⚠ 1-px stroke thickened to 3 px symmetrically (each edge +1 px)** | **100 %** | 0 % of the extra px | **forgiven.** Each edge moved by only 1 px. One-sided +2 px is caught |
| **⚠ 1–2 px line #414141 drawn as #000 (≈ 75 % vs 100 % ink)** | **100 %** | 0 % | **forgiven** (the overshoot). #464646 is caught; 3-px lines are caught in the middle |
| **⚠ uniform 1-px shift of the whole board** (offset forced to 0) | **100 %** | 22 % | **forgiven by design.** Registration aligns it anyway |
| **⚠ SVG exporter clips the outer ¼ px of a 1-px stroke** (f2s-corners `smoothing=1.0`, alpha 64 column missing) | **100 %** | 91.4 % | **forgiven.** A real renderer defect, but sub-pixel. Only the strict metric (blue in the diff) shows it |
| Inter → Roboto, 360×240 board, *self-test*, svg / wasm | 92.8 % / 92.8 % | 89.7 % / 89.8 % | caught |
| Inter → Roboto, 320×200 board, *self-test*, svg / wasm | 96.8 % / 96.9 % | 95.4 % / 95.7 % | caught, but only ~1 point below the bar |

What the ⚠ rows mean in practice:
- The metric cannot see a sub-pixel stroke-weight defect, or a symmetric weight change of one
  pixel per edge. Check those with the strict number and the blue pixels.
- A font swap costs only 3–7 points on a text-only board. On a board where text is a small share
  of the content, a wrong font face could pass at 0.98 perceptual. The strict number (or reading
  the diff) still exposes it.
- A wrong font *fallback* (see [Fonts](#fonts)) changes letterforms more than Inter → Roboto,
  and so scores lower.

## Batch

`node tools/visual/batch.ts [name-filter…] [options] [-- <convert options>]` converts every
fixture that has `test/refs/<fixture>/manifest.json` and a `.fig` in `test/fixtures` or
`test/fixtures-large`, then runs `run.ts` on it.

| option | default | |
| --- | --- | --- |
| `--metric`, `--min`, `--min-local`, `--min-regional`, `--tolerance-px`, `--renderer` | as `run.ts` | passed through |
| `--only-failed` | off | re-run only the fixtures that had an error or a board failing the pass rule in the last `.work/summary.json`. The other fixtures' rows are carried over (`carried: true`) and not counted |
| `--jobs <n>` | `1` | fixtures in parallel |
| `-- <convert options>` | | converter options: `--text <mode>`, `--booleans <mode>`, `--line-breaks <mode>`, `--no-components`, `--no-bake`, `--bake-scale <n>`, `--no-image-profiles`, `--no-downsample`, `--pixel-exact`, `--text-spacing line\|glyph\|none` (the CLI's; `--renderer` is the batch's own) |

**Output.**
- One line per fixture: boards, pass (on the rule), trivial, visual mean and min, local min,
  perceptual mean, strict content mean, converter warnings, time. Visual means and minima leave
  trivial boards out.
- The failing boards (up to 25), worst first under the rule (`compareBoards`: by local, then
  visual), with local, regional, visual, perceptual and strict numbers and where the worst
  local window is.
- A final line in a stable format, for grep (the old fields are kept, `pass` is on the rule):
  ```
  SUMMARY boards=361 pass=136 visual_mean=97.62 visual_min=55.25 local_min=0.00 trivial=19 perceptual_mean=98.77 perceptual_min=49.59 content_mean=97.35 full_mean=99.70
  ```
- `.work/summary.json`:
  - `{ renderer, metric, min, minLocal, minRegional, tolerancePx, jobs, rows, boards }`;
  - `rows[]` has `passed`, `trivial`, `meanVisual`, `minVisual`, `minLocal`, `meanPerceptual`,
    `minPerceptual`, `meanContent`, `minContent`, `meanFull`, `ms`;
  - `boards[]` holds each board's report entry, all metrics included.

**`--jobs`** (f2s- + grida-, 13 fixtures / 76 boards, svg):

| jobs | wall time |
| --- | --- |
| 1 | 67.4 s |
| 2 | 46.2 s |
| 3 | 44.3 s |

- Every board's metrics were identical across the three runs. The exporter's Chromium pool is the
  limit beyond 2.
- The default stays 1 for one reason: `report.warnings` collects exporter log lines by time
  window, so with `--jobs > 1` a fixture's report also lists warnings from the fixtures running
  next to it. Use `--jobs 2` for speed and `--jobs 1` when you read warnings.

## Re-scoring (`rediff.ts`)

`node tools/visual/rediff.ts <work-dir> [fixture-filter…] [--out <dir>] [--refs <dir>] [--delta 1] [--no-png] [--metric visual] [--min 0.98] [--min-local 0.85] [--min-regional 0.92]`
recomputes every board's metrics from an existing work directory, **without re-rendering**:
the reference and candidate PNGs on disk, the refs manifest (`test/refs/<fixture>/` or
`--refs`) and the shapes of the `.penpot` that was rendered (`report.input`, else
`out/<fixture>.penpot`; read straight from the archive, which has the same ids and fields as
`get-file`). Use it after changing `diff.ts` or the geometry in `run.ts` (`boardGeometry`).
The 361-board corpus takes ~30 s instead of a full batch run.

- `<work-dir>`: a batch directory (as written by batch.ts, also with `FIG2POT_VISUAL_WORK`) or a
  single run.ts `--out` directory.
- Output goes to `--out` (default: in place) in the same layout: `<fixture>/report.{json,html}`,
  `<fixture>/diff/`, and `summary.json` for a batch directory (warnings and times carried over).
  Image paths in the new reports point at the original PNGs. `--no-png` skips the diff images.
- Every board is judged again with the rule given on the command line (default: the visual
  rule), whatever rule the old run used; the new reports record it.
- Prints every board whose `perceptualAccuracy` moved by more than `--delta` points, with what
  changed (reference margin cropped, registration offset, background, `boundsMismatch`); every
  board whose **verdict** changed between the old report's rule and this one (`pass → FAIL` /
  `fail → pass`, with old perceptual and new visual / regional / local); every remaining
  `boundsMismatch` board; then the batch table, worst boards and `SUMMARY …` line, as batch.ts.
- Run with the previous `diff.ts`, it reproduces the batch's metrics exactly (checked on all
  361 boards), so its deltas are the diff change and nothing else. The visual metric adds no
  input: a work directory from before it existed is re-scored completely.

```sh
FIG2POT_VISUAL_WORK=tools/visual/.work-x node tools/visual/batch.ts          # render once
node tools/visual/rediff.ts tools/visual/.work-x --out tools/visual/.work-y   # re-score after a diff.ts change
```

## How it talks to Penpot (`penpot.ts`)

All requests go through the frontend's nginx at `http://localhost:9001`, as the browser's do.

**Backend RPC.**
- Calls are `POST /api/rpc/command/<name>` with a JSON body (kebab- or camelCase keys) and
  `Accept: application/json`; responses use camelCase keys.
- Authentication is the `auth-token` session cookie that `login-with-password` sets. The
  exporter only accepts this cookie, not access tokens.
- `get-profile` returns `defaultTeamId` and `defaultProjectId` (the Drafts project).

**Import.**
- `POST /api/rpc/command/import-binfile` as `multipart/form-data` with the fields `name`,
  `project-id` and `file` (the `.penpot` zip).
- The binfile version (v1 or v3) is detected from the file.
- The response is Server-Sent Events, with each event's `data:` in transit json-verbose:
  - `progress` events while the import runs;
  - `end` with `{ "file-ids": [<new file id>] }` on success;
  - `error` with Penpot's error map on failure.
- A malformed zip fails at the HTTP layer instead (HTTP 500 `{type: server-error, code: io-exception}`).
- Both kinds of failure surface as `PenpotImportError`, with the payload in `.detail`, and
  make the run exit with code 2.

**Ids after import.**
- **The file id is remapped**: the import gives it a fresh UUID.
- **Page ids and shape ids are preserved**. The v3 importer only re-indexes file and media ids
  (`backend/src/app/binfile/v3.clj`: `update-index` over `(:files manifest)` and media). The
  self-test checks this on every run.
- So `penpotId(figmaNodeId)` finds boards directly. The match-by-name fallback exists only as a
  safety net.

**Reading the file.**
- `get-file {id}` returns `data.pages` (ordered ids) and `data.pagesIndex[pageId].objects`.
- If a page arrives without inline objects, it is fetched with `get-page {fileId, pageId}`.
- Top-level boards are the `type: "frame"` objects whose `parentId` is the root frame
  `00000000-0000-0000-0000-000000000000`, in root `shapes` order.

**Export.**
- `POST /api/export`. nginx forwards it to the exporter, which only parses
  `application/transit+json` bodies, so `transit.ts` encodes the payload:
  ```
  { cmd: :export-shapes, wait: true, profile-id: #uuid, is-wasm: <bool>,
    exports: [{ file-id, page-id, object-id, type: :png, suffix: "", scale, name }] }
  ```
  `profile-id` is required by the request schema, even though the exporter also resolves the
  session.
- With `wait: true`, the exporter answers only after it has rendered and uploaded the PNG. The
  answer is `{ id, name, filename, mtype, uri }`, where `uri` points to a temporary asset
  `/assets/by-id/<id>`. The harness downloads it with the same cookie.
- `name` only affects the download file name.
- What the exporter does before answering depends on the renderer:
  - **svg** (`is-wasm: false`):
    - headless Chromium opens `render.html?file-id&page-id&object-id&route=objects`;
    - it waits 1 s, then waits until every declared font face has loaded (15 s cap, then a
      `WRN … wait-for-fonts timed out`);
    - it screenshots `#screenshot-<id>` at `deviceScaleFactor = scale`.
  - **wasm** (`is-wasm: true`):
    - a Node worker pool runs `render-wasm`;
    - it fetches the page with `get-page`, fetches the fonts as TTF, lays out the text and
      renders with Skia.
- Each run collects the exporter's `WRN`/`ERR` log lines (via `docker compose logs`) into
  `report.warnings`.

**Delete.** `delete-file {id}` moves the file to the trash, then
`permanently-delete-team-files {teamId, ids}` removes it. Without `--keep`, every run deletes
the file it imported, and Drafts stays empty.

**Robustness.**
- Every request has a timeout: RPC 60 s, `get-file` 120 s, import 10 min, export 180 s,
  download 60 s.
- Exports run with limited parallelism. Transient failures (network errors, timeouts, HTTP 429
  or 5xx) are retried up to 3 times with linear backoff.
- The number of attempts is recorded per board.

## Renderers

Penpot 2.19 ships two rendering engines:
- the classic **SVG/DOM** renderer;
- the new **render-wasm** (Skia) engine.

Both `feature-render-wasm` and `render-switch` are on by default. With `render-switch` on, the
renderer comes from the user's profile setting, which **defaults to `:svg`**
(`frontend/src/app/main/features.cljs`, `setup-wasm-features`). So a user who has never touched
the setting sees the classic SVG renderer, and the harness defaults to `--renderer svg`.

Use `--renderer wasm` to measure the engine a user gets after switching. The workspace URL
parameter `?wasm=true|false` overrides the setting.

Findings:
- **The two engines do not render everything the same.**
  - The self-test's board B has a linear gradient from (0,0) to (1,1) on a 320×200 board.
  - The SVG renderer runs it corner to corner; WASM runs it at 45°.
  - WASM against SVG scores 84.7 % content accuracy on that board, and 99.9 % on the board
    without a gradient.
- **A fixed-height text box overflowed differently.** In an early sample, the SVG renderer
  clipped the wrapped second line; WASM did not.
- **Measure with the renderer you care about.** When fixing a fidelity bug, check both
  (`--renderer both`).
- **The SVG exporter can clip a path's stroke at its viewport.** f2s-corners
  `shape radius=12, smoothing=1.0`, a 74.3 px path with a 1 px centre stroke:
  - SVG clips the outer half of the stroke on the right edge (alpha 0 where Figma has ~64), and
    scores 91.4 % content accuracy;
  - WASM renders it and scores 100 %.

### Export padding

What the exporters add around a shape. Measured with the registration's `candidateBox`, the
Penpot box inside the candidate PNG:

| shape | Figma PNG (render bounds) | svg export | wasm export |
| --- | --- | --- | --- |
| 20×20 path, 10 px **outer** stroke | 40×40 | 70×70 (25 px a side) | 60×60 (20 px) |
| 20×20 path, 10 px **center** stroke | 30×30 | 46×46 (13 px) | 40×40 (10 px) |
| 20×20 path, 10 px **inner** stroke | 20×20 | 20×20 | 20×20 |
| 317×574 frame, 13 px outer dashed stroke | 343×600 | 355×612 (19 px) | 343×600 (13 px) |
| 1144×966 section, 1 px inner stroke | **1224×1046** (40 px padding beyond `renderBounds`, cropped before comparing: [Section padding](#section-padding)) | 1144×966 | 1144×966 |
| 1280×720 section, child sticking out 53 px right (invisible) | 1360×800 (box + 40 px margin) | 1333×720 (overflow on the right only) | |
| boards without overflow | box | box | box |

- **SVG** pads by roughly 2.5× the stroke's outward extent for paths, and 1.5× for frames.
- **WASM** pads by about 2× for paths and exactly the overflow for frames.
- Padding from strokes and shadows has been symmetric in every case so far; overflowing
  children make it one-sided (the row above). The registration relies on neither.
- For **paths**, Penpot's `selrect` is the path geometry's bounds. It equals Figma's
  `renderBounds` minus strokes, and can be smaller than Figma's node `box`: e.g. 74.3×74.3 vs a
  VECTOR box of 82×86. That is why the prior uses the selrect's page position, not its size alone.

## Fonts

- Google Fonts are not bundled.
  - The frontend's nginx proxies `/internal/gfonts/css` to fonts.googleapis.com and
    `/internal/gfonts/font/*` to fonts.gstatic.com, and caches the files.
  - Both renderers fetch fonts through that proxy, so the **frontend container needs internet
    access**. Docker's default bridge network provides it. Offline, text falls back.
- `fontId: 'gfont-inter'` renders in real Inter with both renderers. The self-test checks this:
  - the proxy logged a `200` for an `inter/…` font file;
  - the exporter logged no font warnings;
  - the same text in Roboto scores clearly below 100 % against the Inter render.
- Penpot's bundled fonts (e.g. Source Sans Pro) are served from the frontend's `/fonts/`.
- ⚠️ **A font Penpot cannot resolve falls back silently.**
  - Example: a wrong `fontId`, or a variant that does not exist.
  - The SVG renderer used the browser's default serif. The exporter logged no warning.
  - Seen with `fontId: 'sourcesanspro'` + variant `700` while building the self-test: the
    board scored 98.2 % `accuracy` and 94.4 % `contentAccuracy` against the Inter render.
  - Only the diff shows the problem.
  - For fonts the exporter does fail to fetch, look for exporter `WRN` lines in
    `report.warnings`.

## Timing

Measured on an Apple Silicon Mac with Docker Desktop, Penpot 2.19.0:

| | svg | wasm |
| --- | --- | --- |
| import, 9 KiB sample | 30–70 ms | |
| import, 40 boards / 2 pages | ~0.3 s | |
| one board export | 2.5–4 s (1 s fixed sleep + font wait + screenshot) | 0.05–0.5 s |
| 40 boards (800×600, 10 rects + text each) | 28 s at concurrency 4 | 2.2–2.4 s |
| `selftest.ts`, both renderers | ~16 s total | |

The first SVG export after a restart takes about a second longer while the Chromium pool warms up.

## Troubleshooting

- **`not ready after …`**:
  - check `docker compose -f tools/visual/docker-compose.yaml logs penpot-backend`;
  - the first start runs migrations, so wait for them;
  - if port 9001 is taken, set `PENPOT_PORT`.
- **`nitrate-not-configured`** from `get-profile`: `disable-admin-console` is missing from
  `PENPOT_FLAGS`.
- **`weak-password`** when registering: the password policy described under
  [Local test user](#local-test-user).
- **Import fails (exit 2)**: the printed payload is Penpot's. Typical codes:
  - `io-exception`: not a valid zip;
  - `unsupported-version`;
  - validation errors listing the offending shape.

  Penpot may log more details in the backend log.
- **`ERR … ENOENT … penpot.resource.png.*`** in the exporter log (WASM renderer): an
  occasional temp-file race inside the exporter when several WASM jobs run at once.
  - The request fails with HTTP 500 and the retry succeeds.
  - In 3 × 40 concurrent exports, every image matched the serial render byte for byte.
  - It is the reason WASM defaults to `--concurrency 2`.
- **Text in a fallback font**: see [Fonts](#fonts). Check internet access from the frontend
  container (`docker exec fig2pot-penpot-penpot-frontend-1 nginx -T` shows the proxy config).
- **Exports time out**: lower `--concurrency`, check `docker stats`. The stack uses about
  2–3 GB of RAM under load.

## Files

| file | |
| --- | --- |
| `docker-compose.yaml` | the pinned local stack |
| `penpot.ts` | typed client: `up`, `down`, `isReady`, `PenpotClient` (`ensureUser`, `login`, `importPenpotFile`, `getFile`, `exportShape`, `deleteFile`, `workspaceUrl`), `topLevelBoards` |
| `transit.ts` | minimal Transit-JSON encode/decode for the exporter and the SSE events |
| `diff.ts` | `diffImages(refPng, candPng, { referenceBox, referenceRenderSize, candidateBox, candidateExtent })` → section-margin crop + registration + metrics (strict, perceptual, visual) + side-by-side diff PNG; `visualPasses` = the acceptance rule |
| `attacks.ts` | injected-defect fixtures on a real board (the calibration table; also run by `diff.test.ts`) |
| `summary.ts` | batch rows, worst-board list and `SUMMARY` line (shared by `batch.ts` and `rediff.ts`) |
| `diff.test.ts` | unit tests for registration, metrics, sub-pixel tolerance and the perceptual metric (`node --test tools/visual/diff.test.ts`; the Inter-vs-Roboto case reads the self-test's renders and is skipped until `selftest.ts` has run) |
| `run.ts` | the CLI |
| `report.ts` | HTML report |
| `sample.ts` | builds the self-test `.penpot` with `@penpot/library` (ids from `penpotId`) |
| `selftest.ts` | end-to-end self-test, both renderers (`--renderer svg\|wasm\|both`) |
| `batch.ts` | convert + measure every fixture with refs (see [Batch](#batch)); ` BOUNDS` marks `boundsMismatch` boards |
| `rediff.ts` | re-score an existing work directory without re-rendering (see [Re-scoring](#re-scoring-rediffts)) |
| `.work/` | run outputs (gitignored) |
