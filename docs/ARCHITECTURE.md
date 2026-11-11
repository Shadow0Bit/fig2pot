# fig2pot architecture

`fig2pot` converts a Figma `.fig` file into a `.penpot` file.

```
bytes ──decodeFig──▶ FigFile ──buildTree──▶ FigDocument ──resolveInstances──▶ FigDocument
      ──translateDocument──▶ ir.Document ──writePenpot──▶ .penpot bytes
```

| Stage | Module | Contract |
| --- | --- | --- |
| container + kiwi decode | `src/fig/decode.ts` | `decodeFig(bytes): FigFile` |
| scene tree | `src/fig/tree.ts` | `buildTree(file): FigDocument` |
| blobs | `src/fig/blobs.ts`, `src/fig/vector-network.ts` | `decodeCommandsBlob(bytes): PathCommand[]`, `decodeVectorNetwork(bytes, …)` |
| instances | `src/fig/instances.ts` | `resolveInstances(doc, reporter): void` — materialises every INSTANCE's subtree in place |
| fig → IR | `src/fig/translate/` | `translateDocument(doc, reporter, options?): ir.Document` |
| IR | `src/ir.ts` | the neutral model; **the only thing both sides share** |
| IR → Penpot | `src/penpot/` | `writePenpot(doc, options?, reporter?): Promise<Uint8Array>` |
| glue | `src/index.ts`, `src/cli.ts` | `convert(bytes, options)`, the `fig2pot` CLI |

Types for the decoded kiwi message are generated from a real file's embedded
schema: `src/fig/schema.d.ts` (do not edit by hand; the readable form is
`docs/fig-schema.kiwi`). `src/fig/types.ts` defines `FigFile`, `FigNode`,
`FigDocument`.

## Ground rules

- **The IR is source- and target-agnostic.** `src/fig/**` never imports from
  `src/penpot/**` and vice versa. Both import `src/ir.ts` and `src/util/**`.
- **Never crash on a single node.** Unsupported or malformed input is reported
  through `Reporter.warn({ code, message, nodeId, nodeName })` with a stable
  kebab-case `code`, and conversion continues with the best available
  fallback. Only a file that cannot be decoded at all throws.
- **Deterministic output.** Same input → byte-identical IR. No `Math.random`,
  no clocks, no iteration over unordered sources. Penpot ids are derived from
  IR ids.
- **Visual fidelity first.** The acceptance bar is that Penpot renders what
  Figma rendered. When Penpot cannot express a feature, prefer a fallback that
  *looks* right (e.g. baked outlines) over one that is merely structurally
  similar, and emit a warning. Editability is the second priority.
- TypeScript, ESM, Node ≥ 24. Relative imports carry the `.ts` extension.
  Only erasable syntax (no `enum`, no `namespace`, no constructor parameter
  properties). `strict` + `noUncheckedIndexedAccess`.
- No new runtime dependencies without the orchestrator's sign-off.
- Tests: vitest, under `test/`, mirroring `src/`. Real `.fig` fixtures live in
  `test/fixtures/` (small, checked in) and `test/fixtures-large/` (not in git).

## Figma → IR decisions

- **Coordinates.** Each IR node carries `transform` (local → parent) and
  `size`, like the REST API's `relativeTransform`/`size`. Kiwi's
  `Matrix {m00 m01 m02 m10 m11 m12}` maps to IR
  `{a:m00, b:m10, c:m01, d:m11, e:m02, f:m12}`.
- **Groups.** A kiwi `FRAME` with `resizeToFit: true` is a Figma *group* →
  IR `group`. Everything else frame-like (`FRAME`, `SECTION`, `SYMBOL`,
  `INSTANCE`, component sets = `FRAME` with `isStateGroup`) → IR `frame`
  with the matching `role`.
- **Masks.** A node with `mask: true` masks its *following* siblings (up to
  the next mask or the end of the parent). The translator wraps
  `[mask, …masked siblings]` into an IR `group` with `mask` set.
- **Shapes.** `ROUNDED_RECTANGLE`/`RECTANGLE` → `rect`. Full `ELLIPSE` →
  `ellipse`. `VECTOR`, `LINE`, `STAR`, `REGULAR_POLYGON`, partial ellipses →
  `path`. `fillGeometry`/`strokeGeometry` are always decoded into
  `BaseNode.geometry` when present.
- **Vector paths.** `PathNode.paths` comes from the vector network (so strokes
  stay real strokes). `pathsAreExact` is false when the network cannot
  reproduce the render (per-vertex corner radius, …); then targets fall back
  to `geometry`.
- **Per-region fills.** A vector whose regions carry different fills becomes
  an IR `group` (the vector's id and placement) of exact `…#fill<n>` paths,
  back → front, plus a `…#stroke` path on top when the stroke is visible.
- **Instances are materialised before translation**, at the `FigNode` level
  (`resolveInstances`): the symbol subtree is cloned, overrides
  (`symbolData.symbolOverrides`, keyed by `guidPath`) and derived layout
  (`derivedSymbolData`) are merged into fresh `NodeChange` objects, and the
  clones get REST-style path ids (`I<instance>;<node>`). The translator then
  treats them like any other node and only copies `componentRef` /
  `instanceOf`.
- **Remote components.** Symbols on the internal-only canvas that are
  instantiated by the document are emitted on a synthetic
  `remote-components` page.
- **Text.** `characters` + contiguous `runs`. Figma's computed layout
  (`derivedTextData`: baselines, glyph outlines) is preserved in
  `TextNode.layout` so a target can render exact vectors when a font is
  missing, place editable lines on Figma's baselines, and know what a
  truncated text shows (`truncationStart`), whether fallback fonts drew
  some glyphs (`fallbackFonts`, from `fontMetaData`), each glyph's
  origin and nominal advance (`glyphAdvances`), and the list bullets /
  numbers it synthesised (`markers`; the list paragraphs are
  `TextNode.lists`, from `textData.lines`). An instance keeps a derived text
  layout of an inner level only when the text that level assigned (a
  component property value an outer level re-assigns counts) is the final
  string and its glyph pattern fits it: a fitting length is no proof
  ("Inner" overridden with "Outer").

## IR → Penpot decisions

- Output is produced with `@penpot/library` (the same builder the official
  Figma exporter plugin uses); it validates every shape against Penpot's own
  schemas. `src/penpot/library.ts` is our typed facade over it.
- Penpot shapes use absolute page coordinates; the writer composes the IR's
  relative transforms.
- Penpot ids are deterministic UUIDs derived from IR ids.
- Paint order is reversed where Penpot's order differs from the IR's.
- Fallback policy (`WriteOptions`):
  - `textMode: 'auto' | 'editable' | 'outline'` — `auto` keeps a text
    editable only when Penpot is expected to draw it as Figma did, and
    otherwise emits Figma's glyph outlines as paths, with one warning code per
    reason: font unavailable, characters the font files the renderer loads
    lack (per family and renderer: SVG gets Google's subset files, WASM the
    full font; `coverage-data.ts`), truncation, lists it cannot emulate,
    underline / strikethrough, (`pixelExact` only) glyphs Penpot's copy of
    the font draws with another design (Figma's Inter 3 vs Penpot's Inter
    4), and (SVG renderer)
    gradient or image fills (`src/penpot/text/editability.ts`). The decision is
    shared by a main text and its copies (`classes.ts`), so every copy shape
    keeps a counterpart. Editable text is placed by a model of each renderer's
    baseline rounding: the box is shifted so every line lands within 0.5 px of
    Figma's where the rounding allows (`src/penpot/text/baseline.ts`), and
    percent line heights are laid out at whole px as Figma does.
  - `textSpacing: 'line' | 'glyph' | 'none'` — Penpot's copy of a font can
    have other glyph advances than Figma's (Inter 4 vs 3: lines up to 0.8 %
    short). `line` (default) gives each source line one extra letter spacing
    so that it starts and ends where Figma drew it (consecutive lines share
    one value where it keeps them all in place, so a paragraph stays one
    leaf; a line drifting > 1 px inside is split into ≤ 3 leaves; warned
    `text-spacing-corrected` once per document); `glyph` (default with `pixelExact`)
    corrects every character (~12 leaves per text); `none` keeps the source's
    spacing (`src/penpot/text/advances.ts`; README there).
  - `textLineBreaks: 'source' | 'reflow'` — `source` (default) makes every
    Figma line wrap an explicit break and gives the box room so Penpot never
    wraps again (`text/breaks.ts`; a line layout that does not match the text
    reflows, `text-line-breaks-inconsistent`); `reflow` lets Penpot wrap.
    Justified text always reflows.
  - `booleanMode: 'flatten' | 'editable'` — `flatten` (default) writes Figma's computed
    outline as a single path; `editable` keeps the operands and lets Penpot
    recompute the boolean, which measurably differs from Figma's result on
    real icon sets.
  - `components: boolean` (default true) — emit component/instance links, or plain boards.
  - Paints and images: `bakeUnsupportedPaints` (default true) and `bakeScale`
    (default 2) — Baking, below; `convertImageProfiles` (default true) —
    Image colours, below; `downsampleImages` (default true) — Reduced image
    copies, below. `ConvertOptions` (`src/index.ts`) adds `name` and the
    translator's `includeHidden`; the instance budget (`maxNodes`) is an
    option of `resolveInstances` only. Warning codes: `docs/WARNINGS.md`.
  - `pixelExact: boolean` (default false) — also apply rewrites that only
    change sub-pixel anti-aliasing but alter the design's structure: frames
    that hide nothing are written non-clipping (`clip.ts`, below), and
    inside/outside strokes are redrawn on inset boxes (`centredBand`, below),
    text spacing is corrected per glyph (`textSpacing: 'glyph'` unless
    `textSpacing` is given; `text/advances.ts`), and `textMode: 'auto'`
    outlines texts whose glyphs Penpot's copy of the font draws with another
    design (`text-outlined-glyph-shapes`).
    Off, every frame keeps Figma's `clipsContent` (except the stroke case of
    `frame-clip-disabled-for-stroke`), rects, ellipses and boards keep
    their true box, fill and native aligned stroke, and texts keep their runs.
    Each rewrite that fires is warned (`pixel-exact-unclipped`,
    `pixel-exact-stroke-inset`, `pixel-exact-text-spacing` once per document). The default
    output keeps Figma's structure and numbers; emulations that fix
    differences visible at 100 % zoom (stroke order, exact dashes, marker caps,
    multiply shadows, …) stay on and are warned too.
  - `renderer: 'svg' | 'wasm'` (default `svg`, what Penpot 2.19 users get by
    default) — the Penpot renderer the numbers are tuned for. The two
    renderers disagree, and the writer emits the target's numbers only where
    they do (measured on 2.19, live checks in `test/penpot/live/`):
    - gradients: SVG reads coordinates in bounding-box space (linear iso-lines
      perpendicular to start→end in normalised space; radial ellipse in
      normalised space, stretched with the box), WASM in pixel space (radial
      `width` additionally × boxW/boxH). `gradients.ts` takes the dual vector
      (linear) / principal axes (radial) in the target's space;
    - blurs: SVG layer blur σ = value, shadow σ = blur / 2, background blur
      not drawn (warning `background-blur-unsupported`); WASM σ ≈ 0.565 ·
      value + 0.45 for all three. Figma's σ is radius / 2;
    - dashes: SVG draws an open path's round/square caps on every dash, WASM
      and closed shapes never do, so there dashes are lengthened by the caps.
    - aligned strokes on filled boxes (`pixelExact` only): SVG draws them
      centred on an offset box (no fill fringe, see below), WASM keeps
      Penpot's aligned stroke.
    Known remaining disagreements: shadows of shapes without fill (Penpot
    shadows a fill-less board's children, not its stroke; WASM shadows any
    stroke-only shape as if it were filled — see the `Stroke` band below), image fill
    opacity (WASM ignores it), `layoutItemZIndex` (WASM ignores it),
    stroke-only masks, clipping boards isolating blend modes (SVG only),
    the fill fringe under aligned strokes (WASM), exports of non-clipping
    boards and groups cropped to their box (both exporters; WASM also for
    page-level boards).
- Baking (`bake.ts`, `raster.ts`; `bakeUnsupportedPaints`, default on): a fill
  Penpot cannot draw — tiled image, rotated image, rotated/mirrored crop,
  fit/crop on a rotated path, angular or diamond gradient — is rasterised into
  a PNG that covers the Penpot shape's box and written as a plain image fill
  (`keepAspectRatio: false`, no placement), warned `paint-baked` once per node.
  - Drawn in the Penpot box's space (`PaintTarget.space`): the node's local
    box for box shapes (rotation/mirroring still come from the shape's
    transform), the page-space content bounds for paths, which is where
    Penpot puts a path's image fill. Non-rectangular shapes clip the bitmap.
  - Figma conventions (checked against the auto-layout-playground renders):
    tiles start at the node's top-left corner, a tile is the image's natural
    size × `scalingFactor`, `rotation` turns each tile (clockwise). Angular:
    position = atan2(t, s) / 2π in the handle frame (0 along h0→h1, sweeping
    towards h2, i.e. clockwise for Figma's default handles); diamond: |s| + |t|.
    Stops interpolate in straight-alpha sRGB. (The corpus has no angular or
    diamond gradient; those follow the REST semantics.)
  - Resampling in premultiplied alpha: area average when downscaling,
    bilinear when upscaling, supersampling for rotated maps; angular seams are
    supersampled.
  - `bakeScale` (default 2) is the bitmap's pixel ratio, reduced (warning
    `bake-downscaled`) to stay within 4096 px a side and 16 MP.
  - The paint opacity stays the fill's opacity (editable), except for the
    WASM renderer, which ignores image fill opacity: there it is in the pixels.
  - Identical (paint, box, scale) share one media object; decoded sources and
    encoded bitmaps are cached across the writer's rebuild attempts. PNG bytes
    are deterministic.
  - Not baked: strokes (Penpot's renderers place stroke images differently:
    SVG over the stroke's own bounds, WASM at the image's pixel size), GIF /
    WebP / SVG sources (no decoder; cover + warning), image filters (Figma's
    adjustment curves are undocumented; `image-filters-unsupported`).
- Image colours (`image-color.ts`, `color-profile.ts`; `convertImageProfiles`,
  default on; live checks in `test/penpot/live/images.test.ts`):
  - Penpot 2.19 stores media byte for byte. Its SVG renderer (Chromium)
    applies an embedded ICC profile, `cICP`, `gAMA` and `cHRM` (even `gAMA`
    alone); the WASM renderer ignores all of them. Figma, in a file without
    a colour profile (`documentColorProfile` absent / LEGACY), ignores all of
    them too (auto-layout-playground: 17 PNGs with Display P3 / calibrated
    display profiles render with their raw values, 0 levels off where the
    converted colours are 45–58 off; its one gAMA 1/2.2 + cHRM PNG, the
    32 px avatar of 2495:1898 at an exact 16:1 placement, interior pixels
    only: RMSE 3.86 levels / bias −0.04 raw against 5.55 / +2.66 converted,
    at every registration offset). The translator records this as
    `ImageAsset.ignoresEmbeddedProfile`; files with an sRGB or Display P3
    profile are assumed to colour-manage (no reference renders).
  - So every PNG / JPEG is stored as plain sRGB: when the colours the source
    shows are the stored values, the colour chunks / ICC segments (and Apple's
    `iDOT`) are dropped losslessly; when the source applies a non-sRGB
    profile, the pixels are converted and re-encoded (PNG → 8-bit PNG,
    ancillary `eXIf`/`pHYs`/text kept, `eXIf` then dropped by the
    orientation rule below; JPEG → JPEG q95, EXIF kept). A
    profile that is sRGB (colorants within 0.0025, curves within ½ level) is
    only dropped. Unconvertible colour information (grey / CMYK / LUT-only
    profiles, Lab PCS, HDR transfers) leaves the bytes as they are
    (`image-profile-unsupported`). Baked bitmaps use the same converted pixels.
  - Conversion: ICC v2/v4 matrix/TRC (`curv` identity / gamma / table,
    `para` 0–4; colorants used as stored, i.e. already D50-adapted, `chad`
    only documents that), PNG `gAMA`+`cHRM` (Bradford to D50), `cICP`
    (BT.709 / P3 / BT.2020 primaries, sRGB / BT.709 / linear / gamma
    transfers); relative colorimetric, clipped, straight alpha, colour
    channels only, exact rounding. Bit-identical to Chromium on the five
    profile kinds of the corpus and to ColorSync for Display P3, Adobe RGB
    and Generic RGB. 16-bit PNGs are converted at 8 bits.
- Reduced image copies (`downsample.ts`; `downsampleImages`, default on):
  Figma draws a downscaled image with an area-average (box) filter (best of
  13 filters on 150 of 155 downscaled regions of auto-layout-playground;
  median 2.6 levels on detailed pixels, bilinear 11.2, mipmapped trilinear
  12.2); Penpot's SVG renderer is closest to mipmapped trilinear with a
  −0.5 LOD bias, which breaks up small text in screenshots. A fill picture
  shown at less than 1 / `bakeScale` of its natural size is stored as a box
  filtered copy at `bakeScale` × its displayed size, rounded to whole
  displayed pixels (an odd-sized copy's half-size mip level is a pixel short
  and Chromium then resamples it ~1:1 with drift); one media object per
  image and size, at most 8 sizes per image; placed by an explicit picture
  box (`keepAspectRatio: false`) so the copy's rounded size moves nothing;
  the unused original is not stored (auto-layout-playground's `.penpot`:
  30.2 → 14.3 MB, measured 2026-11-11).
  One `images-downsampled` warning per document says how many images were
  reduced, how many originals were left out, the bytes saved and how to turn
  it off; `image-variants-capped` when an image is shown at more than 8
  sizes. A paint linked to a library colour keeps the colour's full-size
  image (the style and the fill hold the same media). A component copy's
  image fill is compared with its main's by the source paint, not by the
  stored copy (a copy shown at another size stores another reduced copy;
  no `fill-group` touch), unless the copy's bitmap has more pixels than the
  main's: a sync would then replace it with the main's smaller one.
- EXIF orientation (`util/exif.ts`; tag 0x0112 read as SHORT, or a single
  BYTE / LONG as tolerant readers do): browsers draw a JPEG (APP1 EXIF) and
  a PNG (`eXIf`) oriented. Penpot 2.19's SVG renderer honours both, its WASM
  renderer only the JPEG's: it draws a PNG's stored pixels unturned, squeezed
  into the turned box (live check in `test/penpot/live/images.test.ts`). So a
  PNG whose orientation is not 1 is stored re-encoded with turned pixels and
  without `eXIf` (`orientPng`, whatever `convertImageProfiles` says; colour
  chunks and text kept, `pHYs` dropped when the axes swap); JPEGs keep their
  EXIF. The writer orients wherever it decodes pixels itself (reduced copies,
  baked bitmaps), and `sniffImage` reports the displayed size (axes swapped
  for orientations 5–8). The corpus has no image with an orientation other
  than 1, so what Figma does with one is not measured.
- Decoded sources (`bake.ts`) are kept as straight 8-bit RGBA (a quarter of
  premultiplied floats; the resamplers premultiply as they read), at most
  64 MB at once (least recently used dropped; encoded results are kept),
  and resampled row by row straight into the 8-bit output.
  auto-layout-playground: peak RSS 2.5 GB → 1.6 GB with reduced copies
  (1.5 GB without), 14.6 s → 12.9 s; byte-identical media.
  Error vs Figma on the 145 regions shown below 0.5× (mean / median
  levels): SVG original 2.24 / 1.00 → 1.68 / 0.70 (109 regions better, 9
  worse); WASM 4.57 / 1.67 → 2.53 / 0.53 (143 better, none worse). A 1×
  copy is worse in SVG (1.98 / 1.23: Chromium resamples a near-1:1 copy with
  drift) and drops zoom detail. Placement: Figma's and Penpot's picture boxes
  agree to < ¼ px (sub-pixel offset search: best at 0 in 154 / 155 regions,
  both sides).
- Inexact paths (`pathsAreExact: false`) are drawn from the source's
  outlines. Figma's stroke outline of an inside/outside stroke is the full 2w
  band around the path; Figma clips it to (inside) or cuts it from (outside)
  the fill shape, so the writer draws it in a mask group whose mask is the
  fill outline (inside) or a box with the fill outline cut out, even-odd
  (outside) — the same in both renderers. Open paths are stroked centred by
  Figma and use the outline as is; without a fill outline the editable paths
  are used. A flattened boolean without fills (Figma stores no fill outline
  then) is drawn from its centred stroke outline; an editable stroke-only
  boolean whose head operand is a path loses that path's `svg-attrs`, which
  would make Penpot give the boolean a default black fill.
- Marker caps (`line-arrow`, `triangle-arrow`, `diamond`, `circle`): Penpot
  draws them as markers of its own shape and size (and the two renderers
  differ), so an open stroked path with one of them is drawn from Figma's
  stroke outline like an inexact path (warning `stroke-cap-outlined`; 44
  arrow boards of auto-layout-playground failed on Figma's 12 px chevron vs
  Penpot's marker). Round, square and butt caps stay editable SVG line caps.
- Stroke order and dashes (`frame-strokes.ts`, `dashes.ts`; live checks in
  `test/penpot/live/strokes.test.ts`, both renderers):
  - Figma paints a frame's stroke above its children when the frame clips
    and below them when it does not; Penpot paints a board's stroke above its
    children either way. A non-clipping frame whose stroke band a visible
    child (or unclipped descendant) reaches has its stroke drawn by a
    separate `Stroke` shape: the board's first child (last for a clipping
    board), same box, radii and alignment, absolute in a flex board,
    constrained left-right/top-bottom; in a "first on top" flex board it gets
    `layoutItemZIndex` n (clipping: above the flow children's n−1…0) or −1.
    A page-level non-clipping board separates only an inside stroke: Penpot's
    exporters crop it to its box (SVG cut a centre stroke child's dashes in
    half, WASM dropped them), so it keeps a centre / outside stroke on itself
    (`frame-stroke-order-approximated`, `stroke-dash-approximated`).
    A fill-less non-clipping frame with a stroke and a drop shadow: Figma
    shadows the stroke only (auto-layout-playground "Tip" 1620:1472: 3 px of
    stroke on the left, 5 px on the right, the text inside clean; a frame with
    neither fill nor stroke shadows its children, the tooltip 1620:1749),
    Penpot shadows the board's children (SVG) or a filled box (WASM). The
    stroke goes to a separate shape that takes the drop shadows, drawn as the
    stroke's band filled even-odd (WASM shadows a stroke-only shape as if it
    were filled); warned `frame-shadow-on-stroke`. With
    `showShadowBehindNode: false` Figma also hides the shadow inside the box,
    which Penpot cannot (2 px more on the inner side of the left / top
    stroke). Otherwise the stroke stays on the
    board. The decision is shared by every frame linked through
    `componentRef`/`instanceOf`, so mains and copies keep parallel shapes (a
    member that does not need it gets the shape without strokes). Per-side
    stroke outlines follow the same order. Warned `frame-stroke-separated`.
    The empty stand-ins stay: Penpot's sync re-adds a main's child missing
    from a copy unless the copy's parent has `shapes-group` touched, and that
    touch stops every later structural sync of the board
    (`logic/libraries.cljc`, `only-main` / `add-shape-to-instance`).
  - A board whose validity in Penpot depends on its exact child list never
    receives a synthesized child (stroke shape, dash path, band, per-side
    outline): a component set, which becomes a variant container holding
    variant mains only — one extra child and Penpot keeps its variants as
    plain components (`variants-as-components`; Figma gives sets a dashed
    border by default: 76 sets of simple-design-system). It keeps Penpot's
    native stroke, painted above its children: dashes Penpot's way
    (`stroke-dash-approximated`), stroke order
    (`frame-stroke-order-approximated`), per-side widths as the largest one
    (`per-side-stroke-approximated`). Its clip is never dropped for a stroke.
    A variant main (a child of a set) may get stroke children — Penpot
    validates only the container's list — but never a sibling, which would
    land inside the set: it keeps its clip and Penpot's dashes then. Neither
    does a mask group's member or a boolean's operand (the sibling would be
    masked content / an operand). Decided per component class like the
    shapes above.
  - Figma dashes every segment on its own (each side and corner arc of a
    rect/frame, each quarter of an ellipse, each edge of a vector): the
    pattern is stretched to a whole number of periods (`round(L / period)`,
    at least 1) and starts and ends with half a dash; a segment shorter than
    one dash is solid (REST `strokeGeometry`, 23 distinct dashed rects/frames
    and the dashed lines of auto-layout-playground). Penpot has one dash/gap
    pair and no offset, so butt-capped dashes are drawn as open sub-paths with
    a solid centred stroke, on the stroke's centre line (outline offset by
    ∓w/2 for inside/outside; sharp corners meet at the offset corner, radii
    become r ∓ w/2). Rect/ellipse → group {shape, dash path}; frame → the
    `Stroke` dash path; vector → centred/open paths only (warning
    `stroke-dash-paths`). Beyond 2,000 dashes on one shape (`MAX_DASHES`,
    counted before they are laid out) Penpot's own dashes are kept
    (`stroke-dash-approximated`; a [0.01, 0.01] pattern on a 2000 px box
    took 12 s and 2.3 MB). The centre/outside dashes (or per-side outline) of a
    clipping frame: when nothing overflows it (`ClipAnalysis.hidesContent`),
    the board is written without its clip and the `Stroke` shape is its last
    child (warning `frame-clip-disabled-for-stroke`; the only clip dropped by
    default); when its content overflows,
    the board keeps its clip and the `Stroke` shape is a sibling directly
    above it in the parent (absolute in a flex parent, same hidden / opacity
    / blend / constraints), shared through the component classes like the
    child shape. Kept as Penpot dashes (warning `stroke-dash-approximated` on
    boards): round/square caps, closed vector paths with inside/outside
    alignment, and a page-level clipping board that cannot show the stroke
    (no parent for a sibling; Penpot's exporter also crops a non-clipping
    page-level board to its box), and component sets (above). Exported on its own, a
    non-clipping board is cropped to its box by Penpot's exporter, so the
    outside part of such a stroke child shows only on the canvas (f2s-sections
    1:9).
  - An even-odd path with an inside/outside stroke has its holes wound
    against their outline (`windAlternately`): Penpot's SVG renderer clips an
    inner stroke under the nonzero rule, so a hole wound like its outline got
    the doubled stroke on both sides (auto-layout-playground 2411:12761).
  - A boolean operand (editable boolean) gets none of these emulations, nor
    the stroke-outline mask group: Penpot unions every shape of an operand,
    and Figma ignores an operand's stroke. An inexact operand is its fill
    outline.
  - A component copy's path follows its main's `pathsAreExact` (warning
    `copy-geometry-approximated` when the copy alone is inexact, e.g. a
    corner-radius override), so both have the same shapes; a closed one is
    then drawn from its own fill outline (which has the override's rounded
    corners) with the native stroke, instead of the radius-less network
    (auto-layout-playground's cursor `I…;485:923`).
- Clips that hide nothing (`clip.ts`, `pixelExact` only): a clip edge off the pixel grid is
  anti-aliased and so is content ending exactly there; Penpot multiplies the
  two coverages (a 1.25 px line on a board edge at y = …25 drew 56 % instead
  of 75 %). A clipping frame below page level whose visible content (boxes
  grown by outward strokes, Figma's path and glyph outlines, shadows, layer
  blurs; nothing in its rounded corners' squares) stays inside its box is
  written non-clipping (warning `pixel-exact-unclipped`). Page-level boards
  keep their clip (Penpot's exporter crops a non-clipping one to its box).
  Off by default: the frame would stop clipping what is added to it later. Figma's clipping-frame stroke order
  is what Penpot draws on any board, and a non-clipping board does not
  isolate blend modes, like Figma's pass-through frames.
- Opaque aligned strokes on filled boxes, SVG renderer, `pixelExact` only
  (`centredBand`; warning `pixel-exact-stroke-inset`): Penpot
  draws an inside/outside stroke as a doubled stroke clipped to the shape, so
  where the edge is off the pixel grid the fill's anti-aliased edge shows
  through (inside: fill colour in the outer edge row; outside: a light seam
  at the inner edge); Figma draws neither. A rect or circle whose top stroke
  paint is opaque solid normal and whose fills are solid (no inner shadow,
  no background blur) is written as the box inset (inside) / outset
  (outside) by w/2 with the stroke centred, radii r ∓ w/2 (not when an inside
  radius is below w/2); in an auto layout flow, inside strokes only, with
  margins of w/2 that keep the box's place and size. A board with such a
  fill and inside stroke whose stroke band no child reaches gets the same as
  its first child (`Fill and stroke`, absolute, constrained to the board),
  the board keeping its box, radii, clip and layout without fill or stroke;
  decided per component class like the `Stroke` shape, never for a component
  set. Off by default: the shape's box, radii and alignment would no longer
  be the design's. Not for WASM: it
  snaps centred strokes of boxes to whole pixels (paths would work, at the
  cost of turning boxes into paths); there the native stroke stays (live
  check `test/penpot/live/edges.test.ts`).
- Renderer-independent emulations:
  - dots (zero-length dashes) are short dashes: Penpot's `dotted` style
    ignores the gap (period = width + 5);
  - a `vector` mask (silhouette) has its mask shape drawn opaque, because
    Penpot masks by alpha (warning `mask-made-opaque` when that changes its
    alpha); `luminance` stays a warning;
  - a `normal` group/frame whose content uses a blend mode is written with
    opacity 0.999: Penpot isolates a container only when its opacity is below 1
    (in both renderers; a non-clipping board does not isolate);
  - stroke widths and dash patterns follow a scale baked into the geometry,
    for paths as for boxes;
  - an image whose picture box is placed (`fit`, `crop`) has
    `keepAspectRatio: false`: the box already has the final proportions;
  - a drop shadow that Figma hides behind a translucent fill
    (`showBehindNode: false`) is drawn by Penpot; warned
    (`shadow-behind-translucent-fill`), not emulated;
  - Penpot shadows have no blend mode: over opaque content a grey `multiply`
    shadow (grey g, alpha a) scales what is under it by 1 − a + a·g, which is
    exactly a black normal shadow at alpha a·(1 − g). Over transparency
    multiply draws the colour itself, so the conversion is made only when the
    node's nearest enclosing frame has an opaque fill (also right when that
    frame is exported on its own; over white both forms agree; warning
    `shadow-blend-mode-converted`), no group between them isolates (opacity
    below 1, a blend mode other than pass-through, a mask: Figma composes the
    shadow there over transparency, i.e. grey, which is what Penpot draws
    unconverted), and the frame clips or every drop shadow stays inside its
    box (live check on a red frame, both renderers). Other blended shadows
    are warned (`shadow-blend-mode-unsupported`);
  - Penpot has no stroke joins (it draws miter, bevelled beyond the miter
    limit 4): `stroke-join-unsupported` is reported once per node, only
    where a round / bevel join shows — at a vertex of the stroked outline
    where Penpot's join reaches ≥ 0.1 px past Figma's (`joinDifference`):
    not for ellipses, fully rounded boxes, straight lines or smooth curves
    (simple-design-system 3,194 → 1,960, all icons with real corners).
- Import safety: Penpot rejects the whole file for a single unusable number.
  Effects with non-finite parameters are dropped (`invalid-effect`); a node
  whose coordinates leave Penpot's `safe-number` range (±2³¹−1) is skipped
  with its content (`geometry-out-of-range`); repeated node / page ids get a
  `#dup<n>` suffix (`duplicate-id`).
- Components: when Penpot rejects a component (its main board, or
  `addComponent`), which only shows once the pages are built, the file is
  rebuilt with that component's main and copies as plain boards, so no copy
  points at a missing component; only the final build's warnings are
  reported. Touched groups are computed against the mains' final names.
- Names: the library reads every shape name as a path (`50/50` → `50 / 50`),
  so `/` in ordinary shape names is written as U+2215 DIVISION SLASH (which
  the library and Penpot keep); component mains keep real ` / ` paths, and a
  component named only with slashes becomes `Unnamed`.
- Determinism: the library's export is normalised (`zip.ts`): storage objects
  are renamed to ids derived from their content hash, every reference is
  rewritten, timestamps become the Unix epoch, and entries get a fixed mtime.
  The global clock is not patched (the export is asynchronous).
