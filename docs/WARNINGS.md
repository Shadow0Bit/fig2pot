# Warning codes

Every warning fig2pot can emit, by area. A warning never stops the conversion: the node gets the
fallback in the third column. The CLI prints one summary line per code (`--verbose`: every
warning with its node id and name, `-q`: none); the library returns them as
`{ code, message, nodeId?, nodeName? }`. Codes are stable; `test/warnings-catalogue.test.ts` fails
when the source emits a code missing here or this file lists one the source never emits.

"Flag" names the option that changes the outcome (CLI flag / `ConvertOptions` field); `—` means
none does.

## Decode and instances

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `missing-blob` | A node refers to a blob (geometry, vector network, glyphs) the file does not contain. | The data is treated as absent (other warnings follow, e.g. `missing-geometry`). | — |
| `missing-component` | An instance refers to a component that is not in the file. | A plain board, no component link. | — |
| `missing-symbol` | Materialising an instance (or a nested swap) whose symbol is not in the file. | That instance's content is left empty. | — |
| `instance-cycle` | An instance (re)enters a symbol that is already being expanded. | The recursive instance is left empty. | — |
| `instance-too-deep` | Instances are nested more than 64 levels deep. | The deeper instance is left empty. | — |
| `instance-budget-exceeded` | More than `maxNodes` (default 5,000,000) nodes were materialised from instances. | Remaining instance content is left out. | `resolveInstances(…, { maxNodes })` (API only) |
| `bad-override` | An instance override has no valid `guidPath`. | The override is ignored. | — |

## Translation (nodes and layout)

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `unsupported-node-type` | A node type fig2pot does not convert (FigJam / Slides nodes, widgets, …; slices and variable nodes are skipped silently). | The node and its subtree are skipped. | — |
| `node-translation-failed` | Translating a node threw. | The node and its subtree are skipped. | — |
| `unsupported-grid-layout` | A frame uses grid auto layout. | Children keep their computed positions; no layout. | — |
| `mask-in-auto-layout` | A mask and its masked layers are children of an auto-layout frame. | They are grouped and positioned absolutely at their computed place. | — |
| `layout-grids-dropped` | The document has layout grids or guides (one warning per document). | They are not converted. | — |

## Vectors and booleans

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `corrupt-geometry` | An outline, glyph outline or vector network has non-finite coordinates. | The affected segments / glyphs / network are dropped. | — |
| `invalid-vector-network` | A vector network cannot be decoded. | The vector is drawn from its fill geometry. | — |
| `missing-geometry` | A shape has no fill geometry, or a vector has neither network nor fill geometry. | An empty path (later possibly `empty-path`). | — |
| `vector-paths-approximated` | The vector network cannot reproduce Figma's render (per-vertex radius, line caps, per-region fills without geometry, …). | Exact outlines are kept and used by the writer; per-region fills without geometry use the first region's fill. | — |
| `path-approximated` | Inexact vector paths with no usable (complete, clippable) Figma outline. | The approximate editable paths. | — |
| `copy-geometry-approximated` | A component copy's own vector outline is inexact while its main's is exact. | The copy is drawn as one editable path like its main, so it stays linked. | — |
| `empty-path` | A node has no drawable geometry. | The node is dropped. | — |
| `sheared-shape-to-path` | A rectangle or ellipse is sheared. | An exact path outline. | — |
| `boolean-flattened` | `--booleans editable` on a boolean whose operands are all boards. | Figma's result outline as one path. | — |
| `boolean-geometry-missing` | `flatten` mode, but the boolean has no computed outline. | An editable Penpot boolean. | — |
| `empty-boolean` | A boolean has no convertible operands. | The boolean is dropped. | — |
| `boolean-unsupported` | Penpot's builder could not build an editable boolean. | A plain group of the operands. | — |

## Text

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `font-unavailable` | A font is neither built into Penpot nor in its Google Fonts catalogue. | `auto`: outlines. `editable`: the family name is kept; it renders once the font is uploaded to the team. | `--text` |
| `font-variant-unavailable` | The family exists in Penpot but not with this weight / italic. | The nearest variant. | — |
| `text-outlined-fallback-glyphs` | `auto`: a character is missing from the font file the target renderer loads (SVG: Google's subset files), or Figma drew glyphs with a fallback font. | Outlines. | `--text editable`, `--renderer` |
| `text-outlined-glyph-shapes` | `auto` with `--pixel-exact`: Penpot's copy of the font draws enough of the glyphs with other shapes (Inter 4 vs Figma's Inter 3). | Outlines. | `--pixel-exact`, `--text` |
| `text-outlined-truncated` | `auto`: the text is truncated with an ellipsis. | Outlines. | `--text editable` |
| `text-outlined-list` | `auto`: a list Penpot cannot emulate (numbered, nested, wrapped, not left-aligned, unknown bullet, …). | Outlines. | `--text editable` |
| `text-outlined-decoration` | `auto`: underline or strikethrough. | Outlines. | `--text editable` |
| `text-outlined-gradient-fill` | `auto`, SVG renderer: a gradient or image text fill. | Outlines. | `--text editable`, `--renderer wasm` |
| `text-outlined-component` | `auto`: another text of the same component class is outlined. | Outlines like the rest of its class. | `--text` |
| `text-kept-editable-component` | `auto`: this text alone would be outlined (decoration, truncation, glyph shapes) but its component class stays editable. | Editable text. | `--text outline` |
| `text-outline-fills-merged` | Outlines drawn as one path for the class, but the runs have different fills. | One path with the first run's fill. | — |
| `text-outlines-missing` | A text should be outlined but the file has no glyph outlines. | Editable text. | — |
| `text-conversion-failed` | Building the editable text threw. | Outlines when available, else the text is skipped. | — |
| `text-list-emulated` | A bulleted list is emulated (empty items keep their line). | "•" characters between invisible spacers. | — |
| `text-list-unsupported` | A list that cannot be emulated is written editable. | Text without markers or list indent. | `--text auto` |
| `text-spacing-corrected` | `--text-spacing line` changed some line's letter spacing (once per document). | Lines start and end where Figma drew them; typing in a line keeps its spacing. | `--text-spacing none` |
| `text-line-breaks-inconsistent` | `--line-breaks source` but Figma's line layout does not match the text. | Penpot wraps the text itself. | — |
| `text-truncation-emulated` | Truncated text written editable. | The shown text and an ellipsis in a fixed box (editing does not re-truncate). | `--text auto` |
| `text-truncation-unsupported` | A truncating text with no recorded truncation. | A fixed box; overflowing text stays visible. | — |
| `text-paragraph-spacing-emulated` | Paragraph spacing > 0 between paragraphs. | Spacer lines between paragraphs. | — |
| `text-paragraph-indent-emulated` | Paragraph indent > 0. | A leading spacer. | — |
| `text-paragraph-spacing-clamped` | Paragraph spacing beyond what spacers can emulate. | Clamped. | — |
| `text-paragraph-indent-clamped` | Paragraph indent beyond what spacers can emulate. | Clamped. | — |
| `text-hyperlink-unsupported` | A run has a hyperlink. | The link is dropped. | — |
| `text-small-caps-unsupported` | Small caps. | Original case. | — |
| `text-line-height-estimated` | Auto line height without Figma's line layout. | A per-family estimate (or Penpot's default). | — |
| `text-line-height-approximated` | A percent line height without the font's metrics in the file. | A default font line height. | — |
| `text-without-runs` | A text has no style runs. | Penpot's default text style. | — |
| `text-fill-failed` | Text fills could not be converted. | Transparent fill. | — |
| `text-missing-data` | A text node has no text data. | Empty text. | — |
| `text-missing-layout` | A text has no computed layout (baselines, glyphs). | Placement and line breaks without Figma's layout; no outlines. | — |
| `text-layout-failed` | The computed layout could not be read. | As `text-missing-layout`. | — |
| `text-missing-style-override` | A character style id is missing from the style table. | The node's base style. | — |
| `text-style-failed` | A character style could not be built. | A fallback style. | — |
| `text-style-ids-overflow` | More character style ids than characters. | The extra ids are ignored. | — |
| `text-emoji-not-outlined` | Emoji glyphs (images in Figma) in a text. | They are missing from the outlines. | — |
| `text-glyph-rotation` | Rotated glyphs in a text. | Outline rotation is a best guess. | — |

## Images and paints

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `missing-image` | An image paint has no hash, or its image is not in the file. | The fill is dropped. | — |
| `unsupported-image` | An image of unknown format or size, or Penpot rejected an image (or a baked / reduced copy). | The fill is dropped (reduced copy: the original is used). | — |
| `image-profile-unsupported` | Colour information that cannot be converted to sRGB (grey / CMYK / LUT profiles, Lab PCS, HDR). | Bytes as they are; the two renderers may show different colours. | — |
| `images-downsampled` | Images shown much smaller than their size were stored as reduced copies (once per document). | Less detail when zoomed in past `--bake-scale`×; smaller file. | `--no-downsample` |
| `image-variants-capped` | An image is shown at more than 8 sizes. | Full-size original for the extra sizes. | — |
| `image-scale-mode-approximated` | A fit / crop image (placed by Penpot image transforms, drawn as cover by older renderers); or, when not baked, a tiled image, a rotated / mirrored crop, or fit / crop on a rotated path. | Cover for the cases Penpot cannot place. | `--no-bake` (off: baked instead) |
| `image-rotation-unsupported` | A rotated image fill that is not baked. | The rotation is ignored. | `--no-bake` (off: baked instead) |
| `image-filters-unsupported` | An image with exposure / contrast / … adjustments. | The adjustments are ignored. | — |
| `unsupported-image-filter` | An image filter field with no IR equivalent. | Dropped. | — |
| `paint-baked` | A paint Penpot cannot draw (tiled or rotated image, rotated crop, angular / diamond gradient) was rasterised. | An image fill at `--bake-scale`. | `--no-bake` |
| `paint-bake-failed` | Such a paint could not be rasterised. | The editable approximation. | — |
| `bake-downscaled` | A baked bitmap exceeded 4096 px a side or 16 MP. | A lower pixel density. | `--bake-scale` |
| `gradient-approximated` | More gradient stops than Penpot keeps, or (not baked) angular → linear, diamond → radial. | The approximation. | `--no-bake` (off: baked instead) |
| `invalid-gradient` | A degenerate gradient. | Dropped. | — |
| `gradient-without-stops` | A gradient has no stops. | Dropped. | — |
| `unsupported-gradient-color-space` | A gradient interpolated in another colour space. | sRGB interpolation. | — |
| `unsupported-paint` | A paint type fig2pot does not convert. | Dropped. | — |
| `paint-missing-color` | A solid paint without a colour. | Black. | — |
| `unresolved-color-variable` | A bound colour variable is not in the file. | Its cached colour. | — |
| `paint-blend-mode-unsupported` | A fill or stroke paint has a blend mode. | Ignored. | — |
| `too-many-fills` | More fills than Penpot supports on one shape. | The bottom ones are dropped. | — |

## Strokes and effects

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `stroke-dash-paths` | A dashed stroke whose pattern Figma restarts on every side / edge. | Dashes drawn as open sub-paths with a solid stroke. | — |
| `stroke-dash-approximated` | Dashes kept as Penpot's own: more than 2,000 dashes, round / square caps, component sets, page-level boards, a dash pattern Penpot's single dash/gap cannot express. | Penpot's dashes. | — |
| `stroke-cap-outlined` | Arrow / triangle / diamond / circle caps on an open stroked path. | The stroke drawn from Figma's outline. | — |
| `stroke-join-unsupported` | A round or bevel join visibly differs from Penpot's miter. | Miter joins. | — |
| `per-side-stroke-emulated` | Per-side stroke widths. | The stroke drawn as a filled shape. | — |
| `per-side-stroke-approximated` | Per-side widths on a component set or a sheared shape. | The largest width on every side. | — |
| `per-side-stroke-clipped` | An emulated per-side stroke lies partly outside a clipping board. | Clipped there. | — |
| `per-side-stroke-dash-dropped` | A dashed per-side stroke. | Solid. | — |
| `per-side-stroke-radius-ignored` | A per-side stroke on a box with corner radii. | Square corners on the stroke. | — |
| `unsupported-stroke-cap` | An unknown stroke cap. | No cap. | — |
| `unsupported-stroke-align` | Offset stroke alignment. | Centred. | — |
| `variable-stroke-width` | Variable-width strokes. | A constant width. | — |
| `unsupported-brush-stroke` | Brush strokes. | A plain stroke. | — |
| `unsupported-effect` | Noise, grain, texture or another effect Penpot lacks. | Dropped. | — |
| `progressive-blur` | A progressive blur. | Its weakest radius applied uniformly (often no blur). | — |
| `multiple-blurs` | More than one layer / background blur on a node. | One kept. | — |
| `background-blur-unsupported` | A background blur with the SVG renderer. | Kept for the WASM renderer, not drawn by SVG. | `--renderer wasm` |
| `shadow-behind-translucent-fill` | A drop shadow Figma hides behind a translucent fill. | Penpot draws it under the fill. | — |
| `shadow-blend-mode-converted` | A grey `multiply` shadow over opaque content. | The equivalent black normal shadow. | — |
| `shadow-blend-mode-unsupported` | Another blended shadow. | The blend mode is ignored. | — |

## Components

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `invalid-component` | Penpot rejected a component. | It and its copies become plain boards. | `--no-components` |
| `component-dropped` | A component lost its main board. | It and its copies become plain boards. | `--no-components` |
| `components-dropped` | Penpot kept rejecting components after several rebuilds. | Every component becomes a plain board. | `--no-components` |
| `variants-as-components` | A component set cannot become a Penpot variant container. | Its variants are plain components. | — |
| `nested-main-component` | A main component inside another component. | A plain board. | — |
| `unknown-component` | A main board whose component is not described in the document. | A plain board. | — |
| `duplicate-main-component` | A component with several mains. | Only the first is a main. | — |
| `missing-main-component` | A copy whose main is not in the document. | A plain board. | — |

## Structure rewrites (default)

Each keeps what Figma draws at 100 % zoom and changes the layer structure a little.

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `frame-stroke-separated` | A non-clipping frame whose stroke a child reaches (Figma paints it under the children), or a fill-less frame whose stroke Figma shadows. | A separate "Stroke" shape (child or sibling). | — |
| `frame-clip-disabled-for-stroke` | A clipping frame with dashes / per-side outline drawn outside its box, while nothing overflows it. | The board without its clip. | — |
| `frame-stroke-order-approximated` | A page-level board or a component set whose stroke Figma paints under its children. | Penpot paints it above. | — |
| `frame-shadow-on-stroke` | A fill-less frame with a stroke and a drop shadow. | The shadow on the separate "Stroke" shape. | — |
| `frame-shadow-approximated` | Same, but the stroke cannot be separated. | Penpot shadows the children instead. | — |
| `mask-made-opaque` | A vector mask whose shape is not opaque. | The mask shape drawn opaque black. | — |
| `mask-type-approximated` | A luminance mask. | An alpha mask. | — |
| `mask-dropped` | The mask shape could not be converted. | An unmasked group. | — |
| `blend-isolation-emulated` | A normal group / frame whose content uses blend modes. | Opacity 0.999 (Penpot then isolates). | — |
| `blend-mode-approximated` | `linear-burn` / `linear-dodge`. | The nearest Penpot blend mode. | — |
| `transform-scale-baked` | A transform that scales the node. | The scale baked into the size. | — |
| `skewed-board` | A sheared board. | The shear stays in its transform. | — |
| `empty-group` | A group with no convertible children. | Dropped. | — |

## Pixel-exact rewrites (`--pixel-exact` only)

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `pixel-exact-unclipped` | A clipping frame below page level that hides nothing. | The board without its clip. | `--pixel-exact` |
| `pixel-exact-stroke-inset` | SVG renderer: an opaque inside / outside stroke on a filled rect, ellipse or board. | A centred stroke on a box inset / outset by half its width (boards: an inset "Fill and stroke" child). | `--pixel-exact` |
| `pixel-exact-text-spacing` | `--text-spacing glyph` (the default with `--pixel-exact`) split runs into per-glyph leaves (once per document). | Many text leaves; typing inside one inherits its spacing. | `--text-spacing` |

`text-outlined-glyph-shapes` (Text) also fires only with `--pixel-exact`.

## Output checks (before any upload)

What would make Penpot refuse the whole file is caught while writing it.

| Code | When | What you get | Flag |
| --- | --- | --- | --- |
| `invalid-geometry` | A non-finite transform or size. | The node is skipped. | — |
| `geometry-out-of-range` | Coordinates beyond Penpot's range (±2³¹−1). | The node is skipped with its content. | — |
| `invalid-effect` | An effect with non-finite parameters. | The effect is dropped. | — |
| `duplicate-id` | Several nodes or pages share an id. | Renumbered (`#dup<n>`). | — |
| `invalid-shape` | Penpot's builder rejected a shape. | Retried without styling; else its children are kept, or it is skipped. | — |
| `node-conversion-failed` | Writing a node threw. | The node is skipped. | — |
| `invalid-color-style` | Penpot rejected a colour style. | The style is not in the library. | — |
| `invalid-text-style` | Penpot rejected a text style. | The typography is not in the library. | — |
