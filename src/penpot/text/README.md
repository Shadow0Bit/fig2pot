# Penpot text (`src/penpot/text`)

`buildText(node, deps)` turns an IR `TextNode` into the text-only part of
`context.addText(...)` (`content`, `growType`) plus the Penpot box the text
needs (`box`, in the text's local space). `buildTextAttrs` returns only the
attributes. `penpotTextBox(node, lineBreaks)` computes the same box without
building, so the writer can place paints first. `fontIsAvailable(style)` tells
the writer whether Penpot can render a run's font as-is (otherwise
`textMode: 'auto'` outlines the text).

Penpot sources referred to below are from `penpot/penpot` at commit
`c9d3cbb3` (2026-11-10).

**How Penpot behaviour was verified.** Every claim below about what Penpot
*renders* was measured on Penpot 2.19.0 (tools/visual stack), in both
renderers (classic SVG and render-wasm), by exporting tiny files and measuring
ink rows/columns in the PNGs. Claims marked **[live]** are asserted by
`test/penpot/live/text.test.ts` (`PENPOT_LIVE=1 pnpm exec vitest run
test/penpot/live`); against the previous writer that suite fails exactly on
the defects listed here. Claims marked **[measured]** come from one-off
experiments described inline. Claims marked **[source]** are read from Penpot's
code and not measured.

## Content tree

```
root {verticalAlign}
└ paragraph-set
  └ paragraph {textAlign, <style of its first leaf>, lineHeight}
    └ leaf {text, fontId, fontFamily, fontVariantId, fontSize, fontWeight,
            fontStyle, lineHeight, letterSpacing, textTransform,
            textDecoration, fills}
```

- One paragraph per `\n`-separated segment of `characters`. U+2028 turns into
  `\n` inside a leaf: a soft break, as the official exporter does. Consecutive
  and leading soft breaks keep the full line pitch in both renderers **[live]**.
- Leaves are the runs clipped to the paragraph. Leaves next to each other that
  end up with the same Penpot style are merged. Gaps or overlaps in the runs are
  filled from the closest run that starts earlier. Run boundaries are moved off
  the middle of a surrogate pair: half a pair makes render-wasm's export fail
  (HTTP 500) **[live]**.
- **Empty lines are one U+200B leaf, never an empty leaf.** The SVG renderer
  gives an empty leaf no line box, so a blank line (and a paragraph-spacing
  spacer) collapsed to 0 px: `"H\n\nH"` at 40 px rendered with a 40 px pitch
  instead of 80 **[live]**. One zero-width space restores the exact height in
  SVG and changes nothing in WASM **[live]**. An empty leaf is styled like its
  own `\n` (the last `\n` for a trailing empty line).
- Paragraphs repeat the style of their first leaf.
- Numbers are plain decimal strings, as the schema requires.

## Line breaks (`textLineBreaks`, `breaks.ts`)

Penpot lays the text out again. Its line widths are not systematically wider
than Figma's: over 157 sampled Inter lines of auto-layout-playground (12–72 px,
weights 400–800, letter spacing 0 / −1 % / 2 %), rendered as single lines, the
ink width ratio Penpot / Figma (Figma's from the glyph outlines) is median
0.998, p5 0.990, p95 1.006, in SVG and in WASM alike; ink starts within ±0.5 px
**[measured]**. Penpot serves the same Inter as Figma uses (Google Fonts Inter
4.001; hhea 1984 / −494 / 0). It is per-line shaping jitter of ±0.6 %. Figma
fits a line without its trailing spaces and often leaves less than 1 % slack
(e.g. "This is great when you need to add␠" is 264.8 px with the space, about
260 px without it, in a 263 px box). So the jitter moves wraps: in a sample of
120 wrapping left-aligned texts, 28 % (SVG) and 7.5 % (WASM) of them got at
least one line that differs from Figma (20 % / 3 % of lines). Chromium also
breaks after a hyphen, which split Inter's `->` arrow over two lines in
2411:10907 **[measured]**.

- `source` (default): when `layout.lines` is consistent with `characters`
  (contiguous from 0, in reading order, no line end inside a line, covering the
  text, or a prefix of it for truncated text), each wrap Figma made inside a
  paragraph becomes a soft break (`\n` in the leaf, which keeps the runs
  intact). Then Penpot never needs to wrap (the box gets slack, see below).
  Same sample: 2.5 % (SVG) and 3.3 % (WASM) of the texts still differ. None of
  them is a wrap: two draw `↩` (U+21A9) in a fallback font, one is truncation
  **[measured]**.
- Spaces at a wrap are dropped. For centred and right-aligned text, spaces
  before *any* line end are dropped too. Figma aligns a line without its
  trailing spaces (centred corpus lines sit exactly half a space right of
  `(box − width)/2`); render-wasm ignores them as well, but Chromium counts a
  space before a forced break (a right-aligned `"HHH \nHH"` shifted 5.5 px left
  in SVG) **[live]**.
- Lines that do not match the text: warn `text-line-breaks-inconsistent` and
  reflow.
- Justified text always reflows: a forced break ends every line, and such lines
  are never justified.
- `reflow`: nothing is inserted; Penpot wraps the text itself, as it will after
  any edit.
- The cost of `source` is editability: the line breaks are real characters,
  so retyping a paragraph does not rewrap it.

## Text box (`box.ts`)

The SVG renderer clips a text shape to its stored box on both axes, also for
`auto-width`, and does not re-measure it. render-wasm does not clip, and it
wraps a fixed or auto-height box at its width, also inside a word **[live]**.
Figma never clips text. So the Penpot box is a superset of what Figma drew (its
glyph outline points; the line boxes of `layout` when there are no outlines) plus
2 px. It grows only where that
moves nothing, in the text's local space (so rotation and mirroring carry over).
Vertical alignment applies inside the stored box for every grow type, auto
ones included **[measured]**:

| alignment | grows |
| --- | --- |
| left (and justified) | to the right |
| right | to the left |
| centre | both sides equally |
| any, auto-width | to the right: both renderers lay auto-width lines out at their widest line, pinned to the box's left edge, whatever the box width; alignment only applies among the lines **[live]** |
| top | down |
| bottom | up |
| middle | both ways equally |

- **Width grows only when that cannot change wrapping.** That is auto-width text
  (Penpot does not wrap it), or `source` line breaks. In that case the box also
  gets 3 % of the widest line + 2 px of slack, about 4× the worst jitter
  measured above.
- In `reflow` mode a fixed or auto-height box keeps its width. Only its height
  grows.
- Text paints are re-expressed in the new box, so gradients do not move.
- Left-aligned ink to the left of the box, or top-aligned ink above it, cannot
  be uncovered without moving the text, and stays clipped in SVG.
- Over the whole corpus (5,725 texts with a layout), the box grows wider for
  3,613 texts (p50 3.3 px, p90 6.3 px, max 30 px) and taller for 2,119 (p90
  0.8 px, max 38 px) **[measured]**.
- The baseline compensation then shifts the box vertically by up to 2 px (see
  Vertical placement); component copies are compared with their main on the
  source box, so neither growth nor shift marks a copy's geometry as overridden
  (`components.ts`; simple-design-system had 66 such false overrides).
- **Flex children:** at import and render, a grown text in an auto-layout
  board does not move its siblings (measured: a 5.4 px wider fixed-width text
  left the next item at Figma's x in both renderers) **[measured]**. But Penpot
  stores the larger size, so the next time it recomputes that board's layout
  (any edit inside it), the siblings after the text shift by the growth.

- **Right-aligned and centred auto-width text** (`autoWidthAlignShift`): Figma
  aligns the lines inside its own box, which is as wide as the widest line
  rounded up ("Brand", 48.05 px, in a 49 px box: the line starts at 0.95).
  Penpot lays auto-width lines out inside a width of its own from the box's
  left edge **[live]**: SVG inside the widest line (the widest line starts at
  the box edge: 0.95 px left of Figma's), render-wasm inside `ceil(widest) +
  1` px (`text_layout_auto_width`; the 1 px is the HTML renderer's
  `.paragraph-set` right margin): the widest line starts `ceil(w) + 1 − w`
  (right) or half that (centre) from the edge, about 1 px right of Figma's.
  The box moves so that Penpot's widest line ends (right) or is centred
  (centre) where Figma's does; Penpot's width is Figma's minus the advance
  differences of its characters plus its `line` correction (advances.ts;
  equal with the `glyph` correction). The 70 right-aligned auto-width lines of the corpus: right edge
  editable − outline median −0.5 px (SVG, −1.0 for some) and +1.0 px (WASM)
  before, 0.00 in both after (range −0.5…+0.5 SVG, −1.0…+0.5 WASM); the 7
  centred ones: centre median 0.00, worst −0.5 (was −1.75 with the start
  matched) (`test/penpot/live/text-fidelity.test.ts` J11).

`growType` is unchanged: `width-and-height` → `auto-width`, `height` →
`auto-height`, `none` → `fixed`, `truncate` → `fixed` — except truncated text,
always `fixed` (see Truncated text). A grown auto-width/auto-height box is a stale
size Penpot recomputes on the next edit. That is harmless, because it then fits
Penpot's own layout.

## Vertical placement (`baseline.ts`, `metrics.ts`)

Figma's first baseline for a px or percent line height is
`lineTop + (LH − (ascender + |descender|)·size)/2 + ascender·size` (half
leading); for `auto` LH is the intrinsic height rounded to whole px (see Line
height). The target of every line is `layout.lines[k].baseline.y`.

**What the renderers do** — fitted on a live sweep **[live]**: "HHH" × 3 lines
in Inter, Roboto, Poppins and Noto Serif, 8…40 px (every integer) then 44, 48,
56, 64, 72, 80, 96 px, line heights auto / integer px / fractional px (x.37) /
150 %, top / middle / bottom, box y at .0 / .25 / .5 / .75, 4× export, baseline
read from the bottom edge of "H" with sub-pixel coverage (4 296 lines per
renderer):

- **SVG renderer** (Chromium, HTML in a foreignObject: `p {font-size: 0;
  line-height: r}`, spans inherit `r`, so a span's line is `r × its own size`;
  the leaf `lineHeight` is not used). **Exact for 4 296 / 4 296 lines:**
  - `L = floor64(size × r)` (LayoutUnit, 1/64 px);
  - ascent and descent of the font rounded to whole px; when the descent rounds
    *down*, 1 px moves from the ascent to the descent (Chromium's Linux
    subpixel-ascent/descent hack: Inter 9 px is 8.72 / 2.17 → 8 / 3);
  - half leading `floor(trunc64((L − A − D) / 2))` (LayoutUnit division truncates,
    then floor: `L` 1/64 px below `A + D` still gives 0);
  - a line is `max(above)` + `max(below)` over its spans; lines stack; the root is
    a flex box of the shape's height (2 decimals) aligning them top / centre /
    bottom;
  - the baseline is rounded to a whole px **in page space** (fractional box y
    included), also at a 4× export. So the error is −0.5…+0.5 px of rounding
    plus the rounded metrics: −1.64…+0.68 px before compensation (21 px on 28:
    Figma 22.14, Chromium 21).
- **render-wasm** (Skia paragraph): continuous half leading with `L = size ×
  max(paragraph r, span r)`, but each line height and the first baseline offset
  in its line are rounded to whole px, relative to the box (no page-space
  snapping). 85 % of the lines exact, the rest within 0.3 px, except x.5 px line
  heights, which round either way (±1 px on the third line).

Metrics are those of the files Penpot serves (`metrics.ts`: 60 Google families
+ the built-in Source Sans Pro, read from the woff2 / ttf; 700 = 400). A family
without metrics is not compensated.

**Compensation** (`penpotTextBox(node, lineBreaks, placement)`): the writer
models where the target renderer puts each rendered line (the content it will
emit, spacer paragraphs and indent spacers included) and moves the box
vertically by the shift that minimises the worst line's |error|, then the total,
then |shift|, within ±2 px. The box moves with its text, so nothing is clipped,
wrapping and source line breaks are unchanged, and the growth policy's
anchoring is kept (the shift is applied after it).
- SVG: only the rounding changes the result, so the candidates are the
  intervals between half-pixel crossings of every line; the middle of the best
  interval is used (no shift when the interval containing 0 is best). Needs the
  page y of the text: only for unscaled, unrotated texts.
- WASM: the shift centres the error range (continuous). Not when a rendered
  line is within 0.05 px of x.5 px high (`wasmHalfPixelLines`): render-wasm
  rounds such a pitch either way depending on family and size (14 of 36
  family × size pairs at 150 % are not `Math.round`), and compensating made
  multi-line text up to 2 px worse **[live]**. Sweep (Inter, Lato, Montserrat,
  Poppins; 9 odd sizes at x.5 px line heights; 1 / 3 / 6 lines; top / middle /
  bottom; 324 texts): compensation worse than none 75 / 324 before, 0 / 324
  after; with the same sizes at 150 % (now whole px, see Line height) 0 / 324
  worse and the worst line 3.5 → 1.5 px.
- Lines are matched one to one with `layout.lines` (source breaks, or one
  source line per paragraph); otherwise nothing is shifted.
- Line height strings are rounded *up* to 4 decimals when rounding to the
  nearest would lose a LayoutUnit (9 px × 1.4444 = 12.9996 → 12.984 px lines,
  −0.016 px per line); exact up to 156 px.

**Corpus** (auto-layout-playground, 802 distinct unrotated texts, 2 087
lines without decorations or fallback glyphs; editable render vs Penpot's
render of Figma's glyph outlines at the same place, vertical shift of the ink
profile per line, 2× export) **[measured]**:

| \|Δ baseline\| | SVG before | SVG after | WASM before | WASM after |
| --- | --- | --- | --- | --- |
| median | 0.17 | 0.17 | 0.00 | 0.00 |
| p90 | 0.67 | 0.37 | 0.25 | 0.33 |
| p99 | 1.15 | 0.48 | 0.70 | 0.40 |
| ≤ 0.5 px | 78.6 % | 99.2 % | 96.4 % | 99.3 % |
| ≤ 0.75 px | 96.0 % | 99.5 % | 99.3 % | 99.6 % |

The remaining > 0.5 px lines are texts Penpot wraps differently (WASM:
2411:10320 wraps "to" onto the second line) and 24 px text with a 0 px line
height (WASM, −4 px; Penpot's `"0"` line height is a special case in both
renderers). The constant +0.17 px in SVG is the measurement (Chromium's glyph
rasterisation vs the outline path), not placement.

## Horizontal placement

Same corpus measurement, first ink column of each line **[measured]**:
left-aligned lines start within 0.5 px of Figma for 99.8 % (SVG) / 99.6 %
(WASM), with or without letter spacing, auto-width or fixed. Centred lines
(spaces before line ends dropped, see Line breaks): the line centre is within
0.25 px (SVG) / 0.5 px (WASM) at p90, mean −0.03 / −0.22 px. No systematic
offset is left to correct.

**Line width: advance correction (`advances.ts`, `WriteOptions.textSpacing`).**
Figma's Inter and the Inter Penpot serves (Google Fonts static instances)
have different advances for some glyphs. Figma's `glyph.advance` is one value
per glyph over the whole corpus (kerning is in the positions), so it is the
font's own advance: "t" is 0.3636 / 0.3800 / 0.3885 em (Regular / Semi Bold /
Bold) in Figma and 0.3271 / 0.3530 / 0.3662 em in Penpot's files; most other
letters agree within 0.006 em. Before correction a line was ±0.6 % (p10–p90)
off, Inter 700 0.3–0.8 % short (median), in both renderers alike: 72 px
"settings" ended 4.5 px early, 35.6 px "Edit both padding sides" 2.5 px,
24 px "Button 5" 1.4 px **[measured]**.

The translator keeps each drawn glyph's origin and nominal advance
(`layout.glyphAdvances`). `advances-data.ts` holds the advances of the files
Penpot serves (generated from them by
`test/penpot/text/tools/generate-advances.ts`; Inter, 9 weights × upright /
italic, `latin` subset, 16 KB). A character's correction is `source advance
− Penpot advance` of the character as drawn: after the run's text case
(`displayedCodePoint`: "natural" upper-cased is corrected as "NATURAL"; Inter
700 ended +7 px in SVG and +24 px in WASM when looked up as lower case; title
case upper-cases the first letter of each word; a character the transform
maps to several (ß → SS) is not corrected). Families without an advance table
(and texts without `glyphAdvances`) are never corrected, nor is justified
text.

Three levels (`textSpacing`; CLI `--text-spacing`):

| level | what | leaves / text (alp · sds) | JSON alp · sds |
| --- | --- | --- | --- |
| `none` | the source's letter spacing | 1.43 · 1.36 | 23.83 · 49.31 MB |
| `line` (default) | one extra spacing per source line (a few lines split, below) | 2.30 · 1.44 | 24.32 · 49.46 MB |
| `glyph` (default with `pixelExact`) | per character, within 0.15 px | 12.33 · 3.74 | 29.87 · 53.15 MB |

(SVG renderer, `textMode: 'auto'`; alp = auto-layout-playground, sds =
simple-design-system; 1 461 and 4 051 editable texts.) Every corrected leaf
has a fractional letter spacing, which typing inside it inherits; warned once
per document (`text-spacing-corrected`, `pixel-exact-text-spacing`).

**`line`.** For every source line (`layout.lines`, consistent with the text;
with `source` line breaks each line is its own segment already), the
characters Penpot draws on it (dropped spaces and trailing white space left
out) get one extra letter spacing on top of the source's. What one spacing
`e` does was measured **[live]** ("HHHH" with 10 px letter spacing vs 0, in
fixed boxes): both renderers count the spacing of a line's **last**
character in its width (right-aligned: the line's right edge moves 10 px
left; centred: 5 px), and render-wasm also moves a left-aligned glyph by half
its own spacing (first ink +5 px; not for centred / right-aligned lines). So,
with δ the advance differences (`lineSpacing`):

| alignment | glyph k moves by (SVG) | (WASM) | uncorrected error of glyph k |
| --- | --- | --- | --- |
| left | `e × (spaced characters before k)` | `+ e/2` | `−Σδ before k` |
| right | `− e × (spaced characters from k on)` | same | `+Σδ from k on` |
| centre | half of left and right | same | half of both |

- A glyph's position is the centre of its advance (`− δk/2` above): with its
  origin exact, a last glyph whose advance differs by δ ended its ink about
  δ/2 off (30 single corpus lines, editable vs outlines, both renderers:
  Inter 3's wider "t" ended 1.1 px further at 72 px, "Button 5"'s "5"
  0.5 px at 24 px; the "1" of "Button 1", another design, not at all)
  **[measured]**. Targeting origins, "Button 5" ended 1 px short in both
  renderers; centres, 0.5 px (SVG) **[live]**.
- `e` minimises the worst error of the line's first and last ink glyphs and
  of its other glyphs ÷ 1.5 (`balancedSpacing`, `INNER_SLACK`): the ends
  decide alignment, but a glyph inside may not drift more than 1.5× as far
  (narrower and wider glyphs that cancel at the ends, e.g. "Resizing, min,"
  at 72 px: ends exact, "," 1.2 px off with the ends' optimum). While
  tuning (auto-layout-playground, SVG, glyph origins as targets, no split):
  ends only passed 202 boards, 1.5 → 214, inner glyphs counted alike also
  214 but with 4× more lines whose ends are > 0.5 px off.
- Lines whose ends and glyphs are within 0.25 px without correction
  (`MIN_LINE_ERROR`) get none. Consecutive lines share one value when it
  keeps each within 0.25 px (or its own best + 0.1 px) at its ends and
  inside, so a paragraph's lines usually stay one leaf (2.41 → 2.12 leaves
  per text on alp).
- A line whose glyphs still drift more than 1 px inside it
  (`REFINE_DRIFT`) is split into at most 3 leaves (`refinedLine`: the
  greedy `segments` with the smallest tolerance that needs ≤ 3), only when
  that brings its worst glyph ≥ 0.25 px closer, never inside a pair the
  source kerned, a grapheme cluster or a cluster / alternate's context. On
  alp: 214 → 219 boards, 2.18 → 2.31 leaves per text.
- Values are rounded to 0.01 px, or 0.001 px where 0.01 would cost more than
  0.05 px at the line's ends (long lines).
- Guards: a run piece of a line takes no extra spacing when its font has no
  advance table, or, **SVG renderer**, when its source spacing is 0 and the
  line draws a glyph of several characters (Inter's `->`) or a contextual
  alternate (the × of "5x5") in it: Chromium draws neither in a
  letter-spaced span (below). render-wasm keeps them, so there the line is
  corrected. Its advance differences still count.
- Right-aligned and centred auto-width texts: the box shift above uses
  Penpot's corrected width (Figma's − Σδ + the line's spacings).
  render-wasm sizes its auto-width box (`ceil(w) + 1`) without the last
  character's added spacing: right-aligned "Button 5" (100.06 px corrected,
  0.19 px of it after the "5") got 101 px, not 102, and ended 1.5 px short
  until that was modelled **[live]**.

**`glyph`** (`pixelExact`, or `textSpacing: 'glyph'`). Each character gets
its own correction. Consecutive characters share a leaf while every glyph in
it stays within 0.15 px of the exact per-character position (greedy
segments, in O(n log n): the extremes of the position errors are on two
convex hulls; 100 000 characters in < 200 ms, 10 000 took 8 s before).

Both levels keep what shaping does:

- A leaf boundary starts a new shaping run in Chromium (letter spacing is part
  of the font description), which drops kerning across it and, with letter
  spacing ≠ 0 (even 0.01 px), contextual alternates. So a pair the source
  kerned (its glyph does not start where the previous advance ends) is never
  split ("La|yout" at 72 px moved "yout" by 1–2 px), a glyph covering several
  characters (Inter's `->` arrow: one glyph at "-", none at ">") stays in a
  leaf with no extra spacing (otherwise the arrow broke apart and the line
  re-wrapped), and no leaf boundary falls inside a grapheme cluster (before a
  combining mark, a ZWJ, a variation selector; `Intl.Segmenter`).
- A glyph whose source advance differs from Penpot's for the character by
  more than 0.04 em is another glyph (Inter's "t", 0.3636 / 0.3271 em, is the
  largest same-glyph difference): a contextual alternate (Inter draws the "x"
  of "5x5" as ×). It gets no correction and shares an unspaced leaf with its
  neighbours, its context, so Chromium still applies the alternate (with
  spacing it drew "x"; render-wasm drew "5× 5") **[live]**. Except a
  character the document draws that way everywhere (`GlyphCensus`: at least 2
  occurrences in the family, all weights together, none with Penpot's
  advance; a "5x5" alone in a document does not qualify): that is the
  source's version of the font (Figma's Inter 3 curly quotes, see Glyphs
  Penpot draws differently), whose spacing is corrected.

**Result.** Live (`test/penpot/live/text-spacing.test.ts`): three real
auto-layout-playground texts ("Button 5" 24 px Bold auto-width, a 58-character
line and a 3-line paragraph at 16 px Medium), each left / centred /
right-aligned, editable vs Penpot's render of Figma's outlines, first / last
ink column per line (px, editable − outlines, 2× export, so 0.5 px steps):

| text | SVG `none` | SVG `line` | WASM `none` | WASM `line` |
| --- | --- | --- | --- | --- |
| label left | 0 / −2 | 0 / −0.5 | 0 / −2 | 0 / −1 |
| label centre | +1 / −1 | 0 / −0.5 | +1 / −1 | +0.5 / −0.5 |
| label right | +1.5 / −0.5 | 0 / −0.5 | +2 / 0 | +0.5 / −0.5 |
| 58 characters left | 0 / −1.5 | 0 / 0 | 0 / −1.5 | 0 / 0 |
| 58 characters centre | +1 / −1 | 0 / −0.5 | +1 / −1 | 0 / −0.5 |
| 58 characters right | +1.5 / −0.5 | +0.5 / −0.5 | +1.5 / −0.5 | +0.5 / −0.5 |
| paragraph left (3 lines) | 0/−1.5, 0/−1, 0/−0.5 | 0/+0.5, 0/0, 0/0 | same as SVG | same as SVG |
| paragraph centre | ±0.5 each | −0.5/+0.5, 0/0, 0/0 | same | same |
| paragraph right | +1.5/0, +1.5/+0.5, +0.5/0 | −0.5/−0.5, 0/0, 0/0 | +1.5/0, +1.5/0, +0.5/0 | −0.5/0, 0/0, 0/0 |

Every line's ink rows (baselines) stay within 0.5 px of the outlines'. Every
"Button N" of the corpus ends ~0.6 px shorter than its advance differences
explain, in both renderers (kerning Inter 4 does differently, which no
advance table shows): the WASM label's end stays 1 px short.

Corpus (361 boards, strict rule) **[measured]**:

| `textSpacing` | SVG strict | visual mean | visual ≥ 98 % | WASM strict | visual mean | visual ≥ 98 % |
| --- | --- | --- | --- | --- | --- | --- |
| `none` | 155 | 98.53 % | 302 | | | |
| `line` (default) | **292** | 99.11 % | 340 | **269** | 98.37 % | 335 |
| `glyph` | 295 | 99.23 % | 344 | 268 | 98.73 % | 337 |
| `pixelExact` (glyph + clips, strokes, glyph-shape outlines) | 308 | 99.37 % | 352 | | | |
| before: default (no correction, glyph shapes outlined) | 156 | 98.54 % | 304 | 140 | 97.96 % | 276 |
| before: per-glyph forced on (glyph shapes outlined) | 292 | 99.23 % | 344 | 266 | 98.74 % | 338 |

The 10 SVG boards (7 WASM) that pass with `glyph` but not `line` are
auto-layout-playground headings and paragraphs whose worst 32 px window
holds a glyph the line's one spacing leaves 0.9–1.4 px off inside the line
(72 px "padding, and" "i" −1.2 px, "Resizing, min," "," −1.4 px; 32 px
"Figma's new UI" "s" +1.2 px, "that ignore Auto" "i" −0.9 px; 16 px centred
lines "t" +0.9 px; WASM 16 px lines with Inter 3 quotes "“" −0.9 px).
Splitting from 0.75 px of drift instead of 1 px passed 3 more of them for
2.56 instead of 2.31 leaves per text.

Per-glyph result, previous per-glyph-corrected left-aligned line ends
(auto-layout-playground, end of the ink vs Figma's outlines) **[measured]**:

| \|Δ line end\| | SVG before | SVG after | WASM before | WASM after |
| --- | --- | --- | --- | --- |
| median | 0.53 | 0.14 | 0.56 | 0.20 |
| p90 | 1.54 | 0.50 | 1.57 | 0.56 |
| p99 | 2.72 | 1.00 | 2.76 | 1.14 |
| ≤ 0.5 px | 42.5 % | 89.0 % | 41.7 % | 83.0 % |
| ≤ 1 px | 71.9 % | 99.0 % | 70.7 % | 97.9 % |

## Line height

A Penpot line height multiplies the span's own font size. render-wasm lays each
span out at `fontSize × max(paragraph.lineHeight, span.lineHeight)` with half
leading and baseline alignment (`render-wasm/src/shapes/text.rs`) **[source]**.
The SVG renderer behaves as if only the paragraph value applies. A small span
with a 2.42 ratio next to a 40 px span grew the line in WASM (pitch 36 instead
of 29) but not in SVG **[live]**.

- `percent` → `round(fontSize × value / 100) / fontSize`: Figma lays a
  percent line height out at whole px. All 1 062 pairs of consecutive corpus
  lines with a percent line height (every one fractional in px, no mixed
  sizes) are `round()` apart (140 % × 16 = 22.4 → 22.00; 130 % → 20.8 → 21),
  and all 3 750 first baselines sit at the half leading of the rounded height.
  The exact ratio drifted 0.4 px per line in SVG (19 lines of
  simple-design-system `I715:12009;159:9768`: 5 px; 169 corpus texts, 122 of
  them ≥ 1 px on the last line) **[live]**. The rounding of an exact x.5 and of
  mixed sizes on one line are not in the corpus (round half up, per run).
  Library typographies use the same ratio.
- `px` → `px / fontSize`, as given: no corpus line height in px is
  fractional (1 686 pairs). When the source's own lines filled by the run
  are `round(px)` apart, that is used. Letter spacing is not rounded by Figma
  (452 corpus texts with a fractional px spacing: glyph gaps are exact).
- `auto` with `layout.lines`: Figma's `TextLine.lineHeight` is the intrinsic
  line height of the largest font on the line. Figma reports it even when the
  applied line height is px: Inter 32 px gives 38.73 on a 36 px line. Figma lays
  an auto line out at that height **rounded to whole px**: all 14 multi-line
  auto lines of the corpus are `round(lineHeight)` apart, and the first baseline
  sits half of `round − lineHeight` from the intrinsic ascent (Inter 32 px:
  39 px lines, baseline 31.136) **[measured]**. A run gets the smallest
  `round(line.lineHeight) / maxFontSize(line)` over the lines it touches, where
  `maxFontSize` is the largest run font size on that line.
  - On a line the run drives, this is its own intrinsic ratio.
  - On a line it shares with larger text, it is the larger font's ratio, so its
    WASM line box stays inside the larger one **[live]**.
- `auto` without lines: a small table of intrinsic line heights, (hhea ascender
  + |descender| + lineGap) / unitsPerEm. Inter 1.21, Roboto 1.172, Open Sans
  1.362, Lato 1.2, Montserrat 1.219, Poppins 1.5, Source Sans Pro 1.257, Noto
  Sans 1.362. Otherwise Penpot's default of 1.2 is used, with a
  `text-line-height-estimated` warning once per family.
- The paragraph value is the smallest of its leaves' values.

## Other attributes

| IR | Penpot |
| --- | --- |
| letterSpacing px / percent | px; percent × fontSize / 100. Clamped to ±200 |
| textCase upper/lower/title | `uppercase`/`lowercase`/`capitalize`. `small-caps` → `none` + `text-small-caps-unsupported` |
| textDecoration | `underline`, `line-through` |
| alignHorizontal | `left`/`center`/`right`/`justify` |
| alignVertical | root `verticalAlign` |
| fills | visible paints → `deps.fills`. With no visible paint, or none convertible: one fully transparent fill. `[]` draws black in SVG and nothing in WASM, while Figma draws nothing **[live]** |
| hyperlink | dropped: Penpot content has no links. Warns `text-hyperlink-unsupported` |
| paragraphSpacing | an invisible one-U+200B paragraph between paragraphs, exactly that many px tall (font size ≥ 3, line height = spacing / size). Exact in both renderers **[live]**. Warns `text-paragraph-spacing-emulated` |
| paragraphIndent | invisible Source Sans Pro em spaces (U+2003, 0.875 em per the font Penpot serves: 1792/2048) at letter spacing 0, at the start of each non-empty paragraph. The font size is at most the following text's and the paragraph line height is used, so the line keeps its height. Exact within 0.5 px in both renderers **[live]**. The previous letter-spacing spacer was exact in SVG but +50 % in WASM, which shifts a letter-spaced leaf by half its spacing **[measured]**. Warns `text-paragraph-indent-emulated` |
| paragraphSpacing / Indent > 4000 px | clamped to 4000, warns `text-paragraph-spacing-clamped` / `text-paragraph-indent-clamped` |

Like the official exporter, both emulations and the empty-line U+200B add
characters to the text.

### Inter's arrows

Inter draws `->`, `<-`, `<->`, `-->`… as arrows through contextual alternates
(`calt`). Penpot applies them in both renderers: `(->)` renders exactly like
`(→)` in WASM and identically in SVG **[live]**. So the text is left as typed.
Substituting U+2192 would be worse in SVG: Chromium draws it in a fallback font
(smaller and different), presumably because the Inter subset the browser gets
lacks it **[measured]**. The broken
arrow seen in the corpus (2411:10907) was a wrap between `-` and `>`, which
`source` line breaks fix. No `text-ligature-substituted` warning exists,
because nothing is substituted.

## Fonts

- Families match on case-folded names with spaces, `-` and `_` removed.
- Built-in: "Source Sans Pro" → `fontId`/`fontFamily` `sourcesanspro`, with
  Penpot's variant ids (`regular`, `italic`, `bold`, `bolditalic`, `black`,
  `200`, `300italic`, `600`, …; `common/src/app/common/fonts.cljs`).
- Google: `gfonts-catalogue.ts`, generated from Penpot's own
  `common/resources/fonts/gfonts.2025.11.28.json` (MPL-2.0, see the file
  header; regenerate with `test/penpot/text/tools/generate-gfonts.ts`), with
  each family's Google Fonts subsets (for the coverage rule above). Ids
  follow Penpot's `preload-gfonts`: `gfont-<slug(family)>`, variants
  `regular`, `italic`, `<w>`, `<w>italic`. `fontFamily` is the Google family
  name.
- Missing variant of a known family: the nearest variant by Penpot's own rule
  (`closest-variant`: smallest weight distance, heavier on a tie, matching
  style at equal weight). `fontWeight`/`fontStyle` are those of that variant.
  This warns `font-variant-unavailable`, and `fontIsAvailable` is false.
- Unknown family: `fontId: ''`, `fontFamily` = the original name,
  `fontVariantId: '<normal|italic>-<weight>'` (Penpot's custom-font variant id
  format). This is what the official exporter does. When the file opens,
  Penpot's `fix-deleted-fonts` points text whose `fontId` is not installed at a
  team font with exactly the same `fontFamily`, so uploading the font repairs
  the file. Warns `font-unavailable` once per family + style name.
- `fontIsAvailable` is true only when the family is built in or in the
  catalogue AND the exact weight (a multiple of 100) and italic exist.

Warnings that say "once per family" are deduplicated per `Reporter` instance,
in call order, so output stays deterministic.

## Truncated text

Figma truncates a `truncate` text (or a line-limited one) at
`layout.truncationStart` and draws an ellipsis after the shown text
(2411:10300: 147 of 293 characters on 5 lines; 2411:10447 "This is a text
field set to fill…"). Penpot cannot truncate. Writing the whole text was wrong
in both renderers: SVG clipped it at the box, mid-line and without ellipsis
("fillcontainer in both dimensions"), and render-wasm, which never clips,
drew the hidden tail 112 px below the box **[measured]**.

- `textMode: 'editable'` (and `auto` without outlines): only the shown text is
  written (`shownText`): the characters before the cut, trailing white space
  and line breaks removed, then U+2026 in the style of the last shown
  character, in a `fixed` box. Warns `text-truncation-emulated` (editing does
  not re-truncate), also for a line-limited text without the truncate flag
  (`autoResize` height / none with `truncationStart`), which used to be
  written silently as an `auto-height` box that Penpot regrows on the next
  edit. Without a layout the whole text is written,
  `text-truncation-unsupported`.
- `auto`: outlined (`text-outlined-truncated`): Figma's outlines contain exactly
  the shown glyphs and its ellipsis.

## When `auto` outlines text (`editability.ts`, `classes.ts`)

A text stays editable only when its editable render is expected to match
Figma's; otherwise the existing outline path draws Figma's glyph outlines (one
path per run) and warns once per node with the reason. `editable` never
outlines, `outline` always does. First matching reason:

| code | when | why |
| --- | --- | --- |
| `font-unavailable` | a run's family / exact weight + italic is neither built in nor in the Google catalogue | Penpot would substitute a font |
| `text-outlined-fallback-glyphs` | a shown character the font file the **renderer** loads lacks (`characterCovered`, below), or `layout.fallbackFonts` is set | the browser / Skia draws it with a fallback font of its own: other shape and advance (⇧ ⌥ ⌘ ended 3–4 px off in the corpus measurement) **[measured]** |
| `text-outlined-glyph-shapes` | **`pixelExact` only**: ≥ 10 % of the visible glyphs are drawn by Penpot's copy of the font as another design (`differentGlyphShare`, below) | Figma's Inter 3 vs Penpot's Inter 4 |
| `text-outlined-truncated` | `layout.truncationStart` | see Truncated text |
| `text-outlined-list` | a list Penpot cannot emulate (numbered, nested, wrapped item, not left-aligned) | see Lists |
| `text-outlined-decoration` | underline or strikethrough | Figma draws Inter's underline 0.21 em below the baseline (24 px: top +5.05 px, 1.64 px thick); Chromium and Skia use the font's post-table position, ~3 px higher at 24 px |
| `text-outlined-gradient-fill` | SVG renderer, a visible gradient or image fill | the SVG renderer paints the gradient as the whole text box's background, not clipped to the glyphs and in the box's direction; render-wasm draws it correctly **[measured]** |

**Character coverage** (`characterCovered`, data in `coverage-data.ts`,
generated by `test/penpot/text/tools/generate-coverage.ts` from the local
Penpot). The SVG renderer gets Penpot's Google Fonts CSS: one woff2 per
subset of the family (`latin`, `latin-ext`, `cyrillic`, `greek`, `vietnamese`,
…; the catalogue lists each family's subsets), each with a `unicode-range`.
render-wasm loads the family's full ttf (`ttf-url`, through
`/internal/gfonts/font`). So:

- the 60 families of `metrics.ts` and the built-in Source Sans Pro: the code
  points actually in those files, per renderer. Cyrillic, Greek and
  Vietnamese stay editable in families that have them (they were outlined by
  the old latin-only rule) **[live]**; Inter's full file has ⇧ ⌥ ⌘ ↩ ❖ → ←
  ✓ ≠, so in WASM they stay editable (58 of the 73 corpus instances the old
  rule outlined pass the strict rule editable in WASM) **[live]**, but not in
  SVG. The latin files lack U+2011, U+2012, U+2015, U+201B, U+2021, U+2030 in
  every measured family (and U+2010 in most, ↑ ↓ in 32 of 61): outlined, also
  though they are in the `latin` range;
- other catalogue families: the ranges of their subsets, minus the latin /
  latin-ext code points at least half the measured families lack
  (`COMMONLY_ABSENT`: most of latin-ext beyond the usual accented letters,
  the characters above). Sliced CJK subsets have no known ranges: outlined
  (conservative);
- invisible format characters (U+200B–U+200F, U+2028–U+202E, U+2060–U+2064,
  U+FEFF, U+00AD, tab, line feed) never count.

**Glyphs Penpot draws differently** (`differentGlyphShare`). Figma ships Inter
3.x, Penpot serves Google's Inter 4: several glyphs are other designs with
other advances (“ ” 0.381 / 0.440 em Regular, 0.42 / 0.54 Bold; ' 0.222 /
0.300; "1"; italic "a"). A glyph counts when its source advance differs from
Penpot's for the character (after the case transform) by more than 0.04 em,
unless the document draws the same character with Penpot's advance elsewhere
(then it is a contextual alternate Penpot draws too, the × of "5x5";
`GlyphCensus`). Penpot 2.19 text has no font feature setting (not in the
content schema, nor in either renderer's code), so another design cannot be
selected. Measured on every distinct corpus text that reaches 10 % (SVG,
editable render vs Figma's outlines, strict rule): 14 of 48 pass editable
("1": 8 of 38, mean visual 0.891; "“Quote”" 0.509 / local 0.36; italic "a"
0.81; ".", "N", "↓" pass); of the 89 distinct texts with curly quotes below
0.06, editable passes or fails on the rest of the text (line ends), not on the
quotes. Hence the 10 % threshold. The rule only applies with `pixelExact`:
by default such texts stay editable, their spacing corrected per line (the
other glyph *shapes* remain). With the per-glyph correction, keeping the 140
auto-layout-playground texts editable changed 222 → 225 passing boards
(SVG), so the outlines bought nothing visible on that corpus.

**Per component class** (`classes.ts`). A main text and every copy that
references it (`componentRef`) are decided together, so an outlined copy of
an editable main can no longer lose its links (copy shapes without a
`shapeRef`: simple-design-system 30 → 0, auto-layout-playground 2 → 0). A
class with a member outlined for an unavailable font, missing characters, a
list or an SVG gradient fill is outlined as a whole (other members warned
`text-outlined-component`); a class whose members are only partly off
(decoration, truncation, glyph shapes) stays editable when some member is fine
(simple-design-system: 110 "Description" texts and 4 underlined copies),
warned `text-kept-editable-component`. Outlined members get parallel shapes:
one path per run, or per fill list / one path when the members' run counts
differ (`text-outline-fills-merged` when that drops a fill).

Outlining a single line or run while keeping the rest editable was not done:
the editable part would still shift by the editable line-width jitter relative
to the outlined part (seams), and the affected texts are short (keyboard keys).

Texts written as outlines in `auto` (`kept` = kept editable with its class;
default options; with `pixelExact` glyph shapes are added: alp SVG 140 (kept
30), WASM 129 (kept 41); sds 53 (kept 78); f2s-prototyping-swaps-and-instances 5).
`texts` counts the IR's text nodes and `editable` those `auto` decides to keep
editable; 10 of auto-layout-playground's (`->` arrows) are boolean operands,
flattened with their boolean and never written as texts, so 1 461 editable
texts are written there with the SVG renderer:

| fixture | renderer | texts | editable | reasons |
| --- | --- | --- | --- | --- |
| auto-layout-playground | SVG | 1 587 | 1 471 | fallback glyphs 53 (+28 class), decoration 31, truncated 4 |
| auto-layout-playground | WASM | 1 587 | 1 552 | decoration 31, truncated 4 |
| simple-design-system | SVG | 4 104 | 4 051 | fallback glyphs 20 (+1 class), list 4 (+19 class), decoration 6 (kept 4), font unavailable 3; 134 emulated lists |
| simple-design-system | WASM | 4 104 | 4 066 | as SVG, fallback glyphs 5 |
| f2s-prototyping-swaps-and-instances | both | 16 | 16 | |
| radix-icons | both | 11 | 10 | font unavailable 1 |
| f2s-noise-and-grain | both | 2 | 0 | font unavailable 2 |
| other f2s-* (4 fixtures) | both | 7 | 7 | |

## Lists (`lists.ts`)

Figma's bulleted and numbered lists (`textData.lines[].lineType`) draw a
marker that is not part of the text (a synthesised glyph without
`firstCharacter`, `layout.markers`) and indent the text ("List item" of
simple-design-system, 134 instances: bullet at x = 7.5, 9 px wide, text at 24).
Penpot text has no lists; the editable output lost the bullet and sat 24 px
left. A bulleted item (level 1, left-aligned, no paragraph indent, a single
source line, a marker whose advance is Penpot's "•" in the item's font) is
emulated: invisible Source Sans Pro em-space spacers up to the marker
(as for paragraph indent), "•" in the item's own style without letter
spacing, spacers up to the text. Bullet and text land within 0.5 px of
Figma's in both renderers **[live]** (corpus "List item": bullet ink
identical, text start identical, end −1 px: Penpot's line width). Warned
`text-list-emulated` (the bullet is a character of the text). An empty item
(`"a\n\nb"` with every line a list line) keeps its empty line and does not
stop the rest of the list from being emulated: where the source layout has a
marker for it, the line gets the spacers and "•" alone; where it has none,
it is a plain empty line without a bullet. (No corpus text has an empty list
item, so which of the two Figma records is not measured; both are handled.)
Other lists
(the 4 numbered documentation texts of simple-design-system, whose numbers
hang left of the box) are outlined in `auto` (`text-outlined-list`); in
`editable` the markers are dropped (`text-list-unsupported`).

## Fallback fonts in the `.fig`

`derivedTextData.fontMetaData` lists one entry per font file the layout used
(`key {family, style, postscript}`, `fontLineHeight`, `fontDigest` (SHA-1 of the
file), `fontStyle`, `fontWeight`). Glyphs refer only to a style (`styleID`), not
to a font, so the file does not say which glyphs a fallback drew. The
translator exposes `layout.fallbackFonts`: entries whose family is neither a
run's family nor the node's own `fontName` (listed even when every character
overrides it: 35 auto-layout-playground texts list Whyte or SignPainter that
way and draw only Inter). In the corpus no text has one: Figma drew ⇧ ⌘ ⌥ ↩
with Inter itself, which has them; it is the Inter Penpot serves to the SVG
renderer (Google's subsets) that lacks them, while render-wasm loads the full
file. Hence the per-renderer character-coverage rule above.
