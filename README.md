<img src="assets/icon.svg" width="64" height="64" alt="">

# fig2pot

fig2pot converts a Figma `.fig` file (the file Figma's *Save local copy* writes) into a `.penpot`
file, and can import the result into a Penpot project. It runs offline: it makes no Figma API
calls and reads the `.fig` binary format directly, which Figma does not document. The output is
built with Penpot's own [`@penpot/library`](https://www.npmjs.com/package/@penpot/library),
so it imports through Penpot's normal *Import* or through its API like any other `.penpot` file.

It is not a Figma plugin, not a sync tool, and not a Figma REST API client. A figma.com link is
not enough: you need the `.fig` file on disk. Design decisions are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements and install

Node ≥ 24 and pnpm.

```sh
pnpm install
pnpm run build                 # compiles src/ to dist/
node dist/cli.js --help
```

To have a `fig2pot` command on your PATH, run `pnpm add -g .` in the repository after building
(pnpm ≤ 10: `pnpm link --global`). It links the package's `bin`, `dist/cli.js`, to this checkout,
so a rebuild takes effect without reinstalling. During development `node src/cli.ts …` runs the TypeScript
sources directly (Node 24 strips the types), with no build step. The rest of this README writes
`fig2pot`; substitute whichever form you use.

## Usage

```
fig2pot <input.fig> [-o <output.penpot>] [options]   convert
fig2pot <input.fig> --upload [-o <file>] [--json]    convert and import into Penpot
fig2pot upload <file.penpot> [--json]                import an already converted file
fig2pot dump <input.fig> [--ir]                      print the decoded tree (or the IR) as JSON
```

**Convert.** Without `-o` the output is `<input name>.penpot` in the *current directory*.
Warnings go to stderr as a summary, one line per warning code:

```console
$ fig2pot test/fixtures/grida-frame.fig
wrote grida-frame.penpot (13 KiB)

$ fig2pot test/fixtures/f2s-structure.fig -o structure.penpot
1 warning(s):
      1 × images-downsampled — e.g. 1 image is shown much smaller than their size and was stored as reduced copies filtered like Figma's (…); the file is 0.0 MB smaller. Zoomed in past 2× they show less detail than the originals; use --no-downsample (downsampleImages: false) to keep only the originals
Run with --verbose to list every warning.
wrote structure.penpot (54 KiB)
```

`--verbose` prints every warning with the node id and name (`warning <code> [<id> "<name>"]: …`);
`-q` prints none. Every code, when it fires and what changes it: [docs/WARNINGS.md](docs/WARNINGS.md). Import the file in Penpot with *Drafts → Import* (or any project's menu). The
output is deterministic: the same `.fig` and options give a byte-identical `.penpot`.

**Upload** (see [Upload to Penpot](#upload-to-penpot)):

```console
$ export PENPOT_ACCESS_TOKEN=…   PENPOT_URL=http://localhost:9001
$ fig2pot test/fixtures/grida-frame.fig --upload
uploading 13 KiB to http://localhost:9001 …
imported "frame" (3 page(s)) as file e934306d-f1b6-81a6-8008-ed74123f1b23
http://localhost:9001/?screen=workspace&team-id=e934306d-…&file-id=e934306d-…-ed74123f1b23&page-id=acb37a1f-…

$ fig2pot test/fixtures/f2s-structure.fig --upload --json 2>/dev/null
{"url":"http://localhost:9001/?screen=workspace&team-id=…&file-id=…&page-id=…","fileId":"e934306d-f1b6-81a6-8008-ed74136b801f","teamId":"e934306d-f1b6-81a6-8008-ecb70fb82b5d","projectId":"e934306d-f1b6-81a6-8008-ecb70fbab192","name":"structure","pages":[{"id":"acb37a1f-15ae-5a56-b89d-9be7966457c8","name":"Page 1","url":"…"}],"warnings":1}
```

**Dump** (debugging): the decoded kiwi node tree, or with `--ir` fig2pot's neutral intermediate
model (what the Penpot writer receives). Byte arrays are shown as `"<n bytes>"`.

```console
$ fig2pot dump test/fixtures/grida-frame.fig | head -4
{
  "version": 101,
  "meta": {
    "client_meta": {
$ fig2pot dump --ir test/fixtures/grida-frame.fig | head -6
{
  "name": "frame",
  "pages": [
    {
      "id": "0:1",
      "name": "page-with-frame",
```

## Options

| Command / flag | Default | Meaning |
| --- | --- | --- |
| `fig2pot <input.fig>` | | Convert. |
| `fig2pot upload <file.penpot>` | | Import an already converted file into Penpot ([Upload](#upload-to-penpot)); conversion flags are refused. |
| `fig2pot dump <input.fig>` | | Print the decoded node tree as JSON. |
| `--ir` | off | With `dump`: print fig2pot's intermediate model instead (and its warnings on stderr). |
| `-o, --output <file>` | `<input name>.penpot` in the current directory | Output path. With `--upload` the file is written only when `-o` is given. |
| `--name <name>` | from the `.fig` | Document name (also the file name in Penpot), for conversion and upload alike. |
| `--text auto\|editable\|outline` | `auto` | `auto`: editable text where Penpot is expected to draw it as Figma did; glyph outlines when a font or a character is missing in Penpot, the text is truncated, underlined or struck through, has a list Penpot cannot emulate, or (SVG renderer) has a gradient or image fill (see [What converts](#what-converts-and-how)). `editable`: every text editable. `outline`: every text as outlines. |
| `--booleans flatten\|editable` | `flatten` | `flatten`: Figma's computed outline as one path (exact). `editable`: keep the operands, Penpot recomputes the result. |
| `--line-breaks source\|reflow` | `source` | `source`: every Figma line wrap becomes an explicit break. `reflow`: Penpot wraps editable text itself. |
| `--no-components` | off | Write components and instances as plain boards. |
| `--no-bake` | off | Do not rasterise paints Penpot cannot draw (tiled or rotated images, rotated crops, angular and diamond gradients); use Penpot's nearest editable equivalent. |
| `--bake-scale <n>` | `2` | Pixel density of baked and downsampled bitmaps. |
| `--no-image-profiles` | off | Keep images' embedded colour profiles as they are (default: store plain sRGB showing the colours Figma shows). |
| `--no-downsample` | off | Keep images at full resolution where they are shown much smaller (default: store a copy filtered like Figma's). |
| `--pixel-exact` | off | Also apply rewrites that change only sub-pixel anti-aliasing but alter the structure (below). |
| `--text-spacing line\|glyph\|none` | `line` (`glyph` with `--pixel-exact`) | Letter-spacing correction for fonts whose glyph widths differ between Figma and Penpot. |
| `--renderer svg\|wasm` | `svg` | The Penpot renderer the file is tuned for. |
| `-q, --quiet` | off | Print no warnings. |
| `--verbose` | off | Print every warning (node id and name) instead of the summary. |
| `--upload` | off | Import the result into Penpot; print its workspace URL. |
| `--json` | off | With `--upload` / `upload`: print one JSON object instead of the URL. |
| `--penpot-url <url>` | `$PENPOT_URL`, else `https://design.penpot.app` | Penpot base URL; a bare `host[:port]` means https (http for localhost). |
| `--project <id>` | `$PENPOT_PROJECT_ID`, else your Drafts | Target project UUID. |
| `-h, --help` | | Print the help. |

### Which option when

- **Default.** Keeps Figma's structure and numbers: every frame's clip setting, every shape's box,
  every text's runs. It fixes what is visible at 100 % zoom (stroke order, exact dashes, arrow
  caps, text that Penpot would draw differently, …) and reports each fix as a warning.
- **Closer pixels, less faithful structure: `--pixel-exact`.** Additionally unclips frames that
  hide nothing, redraws inside/outside strokes on inset boxes, corrects text spacing per glyph
  (many text leaves instead of about two), and outlines texts whose glyph shapes differ between
  Figma's Inter 3 and Penpot's Inter 4. Each rewrite is warned (`pixel-exact-*`).
- **Text.** `--text outline` gives the closest text rendering, with no text editable.
  `--text editable` keeps every text editable, accepting wrong fonts and positions where `auto`
  would have outlined. `--line-breaks reflow` lets Penpot rewrap text (lines may break
  differently from Figma). `--text-spacing none` keeps Figma's letter spacing values untouched
  (lines may come out up to ~0.8 % shorter).
- **`--renderer wasm`** when the team uses Penpot's new render engine (gradients and blurs are
  tuned for it; the default `svg` is what Penpot users get unless they switch).
- **Editability over looks.** `--booleans editable` (Penpot recomputes booleans, measurably
  differently from Figma on real icon sets), `--no-bake` (editable approximations: tile → cover,
  angular → linear, diamond → radial).
- **Import problems.** `--no-components` writes plain boards if Penpot refuses the components.
- **File size and images.** `--no-downsample` keeps full-resolution originals (bigger file, more
  detail when zoomed in past `bake-scale`×); `--no-image-profiles` stores image bytes unchanged (except
  PNGs with an EXIF orientation, which are always stored with turned pixels);
  `--bake-scale` trades bitmap sharpness for size.

## Upload to Penpot

`--upload` converts in memory and imports the result through Penpot's API; `fig2pot upload
<file.penpot>` imports a file you converted earlier (streamed from disk, never loaded whole).

| Variable / flag | Meaning |
| --- | --- |
| `PENPOT_ACCESS_TOKEN` | **Required.** A personal access token. Read only from the environment (a `--token` flag is refused) and never printed. |
| `PENPOT_URL` / `--penpot-url` | Penpot base URL, default `https://design.penpot.app`. **Always set it for a self-hosted Penpot**, or the token is sent to Penpot cloud. Sub-paths (`https://example.com/penpot`) work; a URL containing `@` (credentials) is rejected. |
| `PENPOT_PROJECT_ID` / `--project` | Target project UUID (from the project's URL). Default: the Drafts project of your default team. The flag wins. |
| `--name` | File name in Penpot (default: the Figma document's name). |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Proxy for the upload (lowercase works too). |

**Access token.** In Penpot open *Your account → Access tokens → Generate new token*, give it a
name and an expiry, and copy it (shown once). It acts as your account: store it like a password.
A self-hosted Penpot shows the menu only when it runs with the `enable-access-tokens` flag.

**Output contract** (for scripts and agents):
- On success stdout holds exactly one line, the workspace URL of the imported file with its first
  page selected; with `--json`, exactly one JSON object
  `{url, fileId, teamId, projectId, name, pages: [{id, name, url}], warnings}` where `warnings`
  is the number of conversion warnings (0 for `fig2pot upload`). Everything else (progress, the
  warning summary, `wrote …`) goes to stderr.
- Exit codes: `0` ok · `1` the input could not be read or converted (missing or unreadable file, not
  a `.fig`, a `.fig` that cannot be decoded) · `2` usage error,
  including a missing or unsendable `PENPOT_ACCESS_TOKEN` and an invalid project id · `3` upload
  failed (network, timeout, token rejected, Penpot refused the file; Penpot's error is shown as is).
- If the upload fails and no `-o` was given, the converted file is saved next to the input as
  `<name>.penpot` (or `<name>-1.penpot`, …; nothing is overwritten) and stderr gives the
  `fig2pot upload <path>` command to retry.
- If Penpot imported the file but a later step failed, stderr says the file **was imported**,
  with its id and URL: do not upload again.
- If the import request gets no answer (time-out, dropped connection, a gateway's 502/504),
  fig2pot looks in the target project for up to 10 s for a new file with this upload's name and
  content. Found: exit `0` as normal. Not found: exit `3`, the file was most likely not imported.
  Undetermined: exit `3` and stderr says Penpot **may have imported** the file and links the
  project: check it before retrying.
- Same-origin redirects are followed; a redirect to another origin (including http → https) fails
  with exit `3` and names it, and neither token nor file is sent there.

**Links.** The URL opens only in a browser logged in to that Penpot account; the token does not
log a browser in. For Penpot ≥ 2.19 it has the form `<base>/?screen=workspace&team-id=…&file-id=…&page-id=…`,
for older versions `<base>/#/workspace?…` (fig2pot reads `<base>/version.txt` to choose).

**Proxies.** Node's `fetch` ignores proxy variables by default; fig2pot turns on Node's built-in
support (`http.setGlobalProxyFromEnv()`, as `NODE_USE_ENV_PROXY=1` would) when one is set. The
proxy must support `CONNECT`; SOCKS is not supported. `localhost` is proxied too unless `NO_PROXY`
lists it.

`uploadToPenpot` (see [Library API](#library-api)) throws `PenpotUploadError` (`status`,
`penpot: {type, code, hint}`, and `fileId`/`url` or `importMayHaveCompleted`/`projectUrl` as above).
It does not touch proxy settings.

## Library API

The package root (`src/index.ts`) exports:

- `convert(figBytes, options?: ConvertOptions): Promise<{ penpot, warnings }>`: the whole conversion.
  `ConvertOptions` is `WriteOptions` plus `TranslateOptions` (`includeHidden`, default true) plus
  `name`. The CLI flags map to `WriteOptions` fields: `textMode`, `booleanMode`, `components`,
  `textLineBreaks`, `bakeUnsupportedPaints`, `bakeScale`, `convertImageProfiles`, `downsampleImages`,
  `pixelExact`, `textSpacing`, `renderer` (each documented in `src/penpot/index.ts`).
- `figToIR(figBytes, reporter, options?: TranslateOptions)`: the decoded, instance-resolved IR
  document (`src/ir.ts`); throws `FigDecodeError` for a file that cannot be decoded.
- `writePenpot(document, options?: WriteOptions, reporter?)`: IR → `.penpot` bytes.
- `uploadToPenpot(file, options: UploadOptions)`: `UploadOptions` is `{ accessToken, name, baseUrl?,
  projectId?, signal?, timeoutMs?, verifyGraceMs? }`; resolves to an `UploadResult`
  (`{ url, fileId, teamId, projectId, name, pages, recovered? }`).
- The stages themselves (`decodeFig`, `buildTree`, `resolveInstances`, `translateDocument`) and
  `CollectingReporter`. **`maxNodes`** (API only, no CLI flag) caps the nodes materialised from
  instances (default 5,000,000; `instance-budget-exceeded` beyond it): it is an option of
  `resolveInstances(doc, reporter, { maxNodes })`, so set it by running the stages yourself;
  `convert` and `figToIR` use the default.

## What converts and how

| Figma | Penpot | Notes |
| --- | --- | --- |
| Pages | Pages | Components used from other libraries go to an extra page, *Remote components*. |
| Frames, sections, groups | Boards, boards, groups | Clip setting kept (one default exception: `frame-clip-disabled-for-stroke`, for dashed strokes on a frame whose content does not overflow). |
| Auto layout | Flex layout | Direction, wrap, gaps, padding, alignment, absolute children, min/max sizes. Grid auto layout: children keep their positions, the grid is lost (`unsupported-grid-layout`). |
| Rectangles, ellipses, lines, stars, polygons | Rects, ellipses, paths | Corner radii per corner. Corner smoothing is written as plain radii (Penpot has none), without a warning. |
| Vectors | Paths | From the vector network, so strokes stay strokes; where the network cannot reproduce Figma's render, Figma's outline is used (`vector-paths-approximated`). Per-region fills become a group of paths. |
| Booleans | One flattened path | Figma's computed result (exact). `--booleans editable` keeps a Penpot boolean group. |
| Masks | Mask groups | Alpha and vector masks; vector masks are drawn opaque. |
| Text | Editable text or outlines | `auto` outlines a text when its font is missing from Penpot, a character is missing from the font file Penpot's renderer loads, it is truncated, underlined or struck through, it has a list Penpot cannot emulate, or (SVG renderer) a gradient or image fill; each reason has its own `text-outlined-*` / `font-unavailable` warning. A component's texts and their copies are decided together. Editable text is placed on Figma's baselines and wraps where Figma wrapped. |
| Fonts | Google Fonts / built-in | Mapped to Penpot's Google Fonts catalogue. Others: outlined in `auto`; in `--text editable` they keep their family name, so uploading the font to the Penpot team makes them render. |
| Image fills | Image fills | Fill, fit, crop, tile. Embedded colour profiles converted to the colours Figma shows; images shown much smaller stored as reduced copies (`images-downsampled`). EXIF orientation honoured; a PNG's is applied to its pixels (Penpot's WASM renderer ignores it). GIF, WebP and SVG images are never baked or downsampled (no decoder). |
| Paints Penpot cannot draw | Baked bitmaps | Tiled or rotated images, rotated crops, angular and diamond gradients are rasterised at `--bake-scale` (`paint-baked`). Linear and radial gradients stay gradients. |
| Strokes | Strokes | Inside / centre / outside. Figma paints a non-clipping frame's stroke under its children, Penpot over them: a separate *Stroke* shape restores the order (`frame-stroke-separated`). Dashes are drawn as paths so they restart on every side as in Figma (`stroke-dash-paths`). Arrow / diamond / circle caps are drawn from Figma's outline (`stroke-cap-outlined`). Per-side widths are drawn as filled shapes (`per-side-stroke-emulated`). |
| Effects | Shadows and blurs | Drop and inner shadows, layer blur, background blur (drawn by the WASM renderer only). Grey `multiply` shadows over opaque content become the equivalent normal shadow. |
| Components, variants, instances | Components, variants, copies | Overrides resolved; component sets become Penpot variant containers. If Penpot rejects a component, it and its copies become plain boards (`invalid-component`, `components-dropped`). |
| Colour and text styles | Library colours and typographies | Effect and grid styles are not converted. Colour variables are resolved to their values. |

## Known limits

- **Effects:** noise, grain and other effects Penpot lacks are dropped (`unsupported-effect`).
  Progressive blur is applied uniformly at its weakest radius (`progressive-blur`). Shadow blend
  modes other than the convertible multiply case are ignored.
- **Component sets** keep Penpot's native dashed border (`stroke-dash-approximated`): any extra
  child would make Penpot turn the variants into plain components.
- **Renderers.** Penpot's SVG and WASM renderers disagree on gradients, blur strengths, background
  blur, image-fill opacity, shadows of fill-less shapes and more; a file is tuned for one
  (`--renderer`). See the renderer section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Stroke joins:** Penpot has none; round and bevel joins are drawn mitred (`stroke-join-unsupported`,
  reported only where the difference shows).
- **Masks:** luminance masks act as alpha masks (`mask-type-approximated`).
- **Not converted:** prototype interactions, variables and tokens (bound colours are kept as plain
  values), layout grids and guides (`layout-grids-dropped`), effect and grid styles, hyperlinks
  in text, corner smoothing (drawn as plain radii). Grid auto layout
  keeps positions only.
- **Text:** in `auto`, underlined, struck-through and truncated text, and text with characters
  the font file Penpot serves lacks (⇧ ⌘ ↩, U+2011, … in the SVG renderer), are outlined, so not
  editable. With `--line-breaks source` Figma's soft wraps become explicit line breaks: editing
  the text does not rewrap it until you remove them (`--line-breaks reflow`). Small letter
  spacing values are added per line to make lines end where Figma's did (`text-spacing-corrected`;
  `--text-spacing none`). Lists are emulated with bullet characters (an empty item keeps its empty
  line); numbered lists are outlined.
- **Images** shown much smaller than their size are stored downsampled: zoomed in past 2× they
  show less detail than the original (`--no-downsample`).
- **The `.fig` format is undocumented** and Figma changes it; a newer file may decode partly or
  not at all. Every unsupported node type or feature is a warning, never a crash.
- **FigJam and Slides files** are not supported. fig2pot does not reject them (their header is
  recognised and decoded), but their board-specific node types (stickies, connectors, slides, …)
  are skipped with `unsupported-node-type`, so the result is mostly empty.
- **Memory and time** for large files, measured with `/usr/bin/time -l` on an Apple Silicon Mac
  (Node 24.18, other work running): `auto-layout-playground.fig` (22 MB, 283 boards) took 28 s
  and peaked at 1.46 GB resident, giving a 14 MB `.penpot`; `simple-design-system.fig` (7.9 MB,
  2,077 components) took 23 s and peaked at 1.64 GB, giving a 22 MB `.penpot`.

## Measured fidelity

The fidelity numbers below come from the visual harness in [tools/visual/](tools/visual/README.md):

- **Penpot**: a local Penpot 2.19.0 in Docker (the version `@penpot/library` 1.3.0 targets). Each
  converted file is imported through Penpot's API and every board is rendered by Penpot's own
  exporter, with the SVG renderer unless stated.
- **References**: Figma's own renders of the same boards, exported in a Figma editor through the
  plugin API ([tools/figma-refs/](tools/figma-refs/README.md)): 361 boards (every visible
  top-level frame, and the children of sections) of 15 fixtures, 283 of them from
  `auto-layout-playground.fig`.
- **Comparison**: the two PNGs are registered (best integer offset), composited over mid grey,
  and compared pixel by pixel. A board **passes the strict rule** when all three hold:
  1. visual accuracy ≥ 98 % (or at most 16 mismatched pixels): the share of *salient* pixels
     (everything within 2 px of a contrast edge, plus flat areas whose colour differs) that match,
     where edge pixels may move by up to 1 px but must keep their colour within 0.05 HyAB, flat
     pixels within ≈ 5 grey levels, and ink may not get lighter or darker by more than 0.15 OKLab
     lightness;
  2. regional accuracy ≥ 92 % in the worst 128 px window;
  3. local accuracy ≥ 85 % in the worst 32 px window.
- **Calibration**: an audit by eye found that the earlier rule (98 % "perceptual" accuracy) passed
  boards that were visibly wrong: a removed icon, a replaced word, recoloured text and wrong
  strokes all passed, and 14 of the labelled wrong boards did. The current rule fails all 14
  false passes and every injected defect in its test table, except changes of at most 1 px per
  edge (a border 3 → 5 px, a small corner radius).

<!-- RESULTS:START -->
| Configuration | Boards passing the strict rule (of 361) | Boards with visual accuracy ≥ 98 % (of 342) | Visual accuracy, mean | Visual accuracy, median |
| --- | --- | --- | --- | --- |
| default | 292 | 322 | 99.15 % | 99.70 % |
| `--pixel-exact` | 308 | 333 | 99.37 % | 99.84 % |
| `--renderer wasm` (rendered with the WASM renderer) | 267 | 316 | 98.66 % | 99.45 % |
| `--text outline --pixel-exact` | 324 | 333 | 99.46 % | 99.97 % |
<!-- RESULTS:END -->

Measured on 2026-11-11. 19 of the 361 boards are trivially empty in both renders; they pass but
are left out of the accuracy columns (hence "of 342"). The numbers move by a board or two between
runs: Penpot's exporter occasionally returns a board before its fonts have loaded, or fails a
WASM export on a temporary file.

What the strict rule's failures are, from a second audit by eye of the default run (30 passing
and 36 failing boards, worst first):

- No sampled passing board showed a difference a designer would notice.
- Of the 36 failing boards, 5 differ visibly at 100 % zoom: the noise / grain board (unsupported
  effect), three boards that share one component-set border (kept as Penpot's native dashes so
  the set stays a variant set), and one paragraph that picked up its frame's drop shadow (fixed
  since). About 15 differ only at 200–400 % zoom (text sitting about 1 px off, dash phase, shadow
  strength), and about 11 are a single anti-aliased pixel row with nothing to see.
- So the strict rule is conservative: most of its failures are not visible at normal zoom, and
  the boards a person would call different are a handful out of 361.

## Development

```
src/cli.ts, src/index.ts   the CLI; the library entry point (convert, uploadToPenpot, …)
src/ir.ts                  the neutral intermediate model both sides share
src/fig/                   .fig decoding: container + kiwi, scene tree, blobs, instances
src/fig/translate/         decoded tree → IR
src/penpot/                IR → .penpot (shapes, strokes, paints, images, components, upload)
src/penpot/text/           text: fonts, editability, line breaks, baselines, spacing (own README)
src/util/                  matrices, EXIF, the warning reporter
test/                      vitest tests mirroring src/; fixtures in test/fixtures/
tools/visual/              visual harness: local Penpot in Docker, render, diff against Figma
tools/figma-refs/          capture of Figma's reference renders
docs/                      ARCHITECTURE.md, WARNINGS.md, the readable kiwi schema (fig-schema.kiwi)
assets/                    icon
```

```sh
pnpm test                  # unit tests (tests needing test/fixtures-large/ or a live Penpot skip)
pnpm run typecheck
PENPOT_LIVE=1 pnpm exec vitest run test/penpot/live    # render checks against a running local Penpot
```

The visual harness, with Docker running:

```sh
docker compose -f tools/visual/docker-compose.yaml up -d    # local Penpot 2.19 on :9001
node tools/visual/batch.ts f2s- grida-                     # convert + render + diff the fixtures with references
```

Details, metrics and options: [tools/visual/README.md](tools/visual/README.md). The reference
renders (`test/refs/`, not in git) are captured in a Figma editor tab:
[tools/figma-refs/README.md](tools/figma-refs/README.md).

Warnings have stable kebab-case codes (`Reporter.warn({ code, message, nodeId, nodeName })`),
catalogued in [docs/WARNINGS.md](docs/WARNINGS.md) (`test/warnings-catalogue.test.ts` keeps it in
sync); conversion never stops for a single node, only for a file that cannot be decoded.

## Agent skill

[`skills/fig2pot/SKILL.md`](skills/fig2pot/SKILL.md) tells a coding agent (Claude Code) how to use
fig2pot: converting, uploading, choosing options, reading warnings. Install it by copying the
`skills/fig2pot/` directory into a project's `.claude/skills/` or into `~/.claude/skills/`.

## Fixtures and licences

The test fixtures come from open-source projects and Figma Community files under Apache-2.0, MIT
and CC BY 4.0; origin and licence per file are in [test/fixtures/README.md](test/fixtures/README.md)
and [test/fixtures-large/README.md](test/fixtures-large/README.md).

## Licence

No licence has been chosen for this code yet (`package.json`: `"license": "UNLICENSED"`,
`"private": true`). It includes generated data from third parties:
`src/penpot/text/gfonts-catalogue.ts` is derived from Penpot's Google Fonts catalogue
(`common/resources/fonts/gfonts.2025.11.28.json`, MPL-2.0, Copyright (c) KALEIDOS SUBSIDIARY SL);
`src/penpot/text/coverage-data.ts`, `advances-data.ts` and the metrics table in `metrics.ts` are
measured from the Google Fonts files (SIL OFL) and Penpot's built-in Source Sans Pro as Penpot
2.19 serves them.
