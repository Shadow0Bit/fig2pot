---
name: fig2pot
description: Converts a Figma .fig file into a .penpot file and optionally imports it into a Penpot project, returning a workspace link. Use when converting, migrating or importing Figma designs to Penpot ("fig to penpot"), uploading a converted design to a Penpot project, or getting a Penpot link for a Figma file.
---

# fig2pot

fig2pot reads a Figma `.fig` file on disk, writes a `.penpot` file, and with `--upload` imports it
into Penpot. It never calls Figma.

## Before you start

- Get a `.fig` **file**. A figma.com URL is not enough: ask the user to export it in Figma with
  *File → Save local copy…* and give you the path. FigJam and Slides files are not supported
  (they convert to near-empty pages with `unsupported-node-type` warnings); say so instead of
  converting them.
- Find the command, in this order:
  1. `fig2pot` on PATH (`command -v fig2pot`);
  2. `node <repo>/dist/cli.js` (build it first with `pnpm install && pnpm run build` in the repo);
  3. `node <repo>/src/cli.ts` (runs the sources; no build).
  All need Node ≥ 24. `fig2pot --help` lists every flag. Below, `fig2pot` stands for whichever
  form works.

## Convert

```sh
fig2pot design.fig -o design.penpot
```

- Without `-o` the output is `<input name>.penpot` in the **current directory**, not next to the
  input. Pass `-o` with an absolute path.
- Success: exit code `0` and the last stderr line `wrote <path> (<n> KiB)`. Exit `1` means the
  input could not be read or converted (missing or unreadable file, not a `.fig`; stderr names the
  reason, e.g. `ENOENT: no such file or directory`); exit `2` is a usage error.
- Warnings never fail the run. stderr shows a summary, one line per code:
  ```
  1 warning(s):
        1 × images-downsampled — e.g. 1 image is shown much smaller than …
  Run with --verbose to list every warning.
  ```
- The user imports the file in Penpot with *Drafts → Import*.

## Convert and upload

```sh
PENPOT_URL=https://penpot.example.com fig2pot design.fig --upload --json -o design.penpot
```

- `PENPOT_ACCESS_TOKEN` must already be set in the environment. Check with
  `[ -n "$PENPOT_ACCESS_TOKEN" ]`, never by printing it, and never put the token on a command
  line (fig2pot refuses token flags). If it is missing, stop and ask the user to create one in
  Penpot (*Your account → Access tokens → Generate new token*; a self-hosted Penpot shows this
  only with the `enable-access-tokens` flag) and export it themselves.
- `PENPOT_URL` (or `--penpot-url`) defaults to Penpot cloud, `https://design.penpot.app`. For any
  self-hosted Penpot set it explicitly every time, or the upload goes to the cloud.
- Target project: `--project <uuid>` or `PENPOT_PROJECT_ID`; default is the user's Drafts.
- `-o` keeps a local copy; without it nothing is written unless the upload fails.
- stdout holds exactly one JSON object; everything else is on stderr:
  ```json
  {"url":"…","fileId":"…","teamId":"…","projectId":"…","name":"structure",
   "pages":[{"id":"…","name":"Page 1","url":"…"}],"warnings":1}
  ```
  `warnings` is a count. Without `--json`, stdout is the single URL line.
- To upload an already converted file: `fig2pot upload design.penpot --json` (conversion flags are
  refused there).

Exit codes and what to do:

| Exit | Meaning | Do |
| --- | --- | --- |
| `0` | Imported | Give the user `url`. |
| `1` | The input could not be read or converted (also a missing `.penpot` for `fig2pot upload`) | Report stderr verbatim; check the path and that the input is a Figma design `.fig` (or a `.penpot` for `upload`). |
| `2` | Usage error: missing / malformed token, invalid project id, bad flag | Fix the command or ask the user for the token; do not retry blindly. |
| `3` | Upload failed | Read stderr (below). |

On exit `3`:
- stderr says `the file WAS imported`: it exists (id and URL are given). Do not upload again.
- stderr says `MAY HAVE IMPORTED`: the connection dropped and fig2pot could not tell. Ask the user
  to check the linked project (or list its files through the API) before any retry.
- Otherwise it was not imported. fig2pot saved the conversion next to the input as
  `<name>.penpot` (or `<name>-1.penpot`, …) and prints the `fig2pot upload <path>` retry command.
  A rejected token (`did not accept the access token`) needs a new token from the user.

The link opens only in a browser logged in to that Penpot account; the token does not log a
browser in. For follow-up work in Penpot, use `fileId` and `pages[].id` with Penpot's RPC API
(`POST <PENPOT_URL>/api/rpc/command/get-file`, header `Authorization: Token $PENPOT_ACCESS_TOKEN`)
or a Penpot MCP server if one is configured.

## Choose options

Start with the defaults: they keep Figma's structure (clip settings, box sizes, text runs) and fix
what is visible at 100 % zoom. Change them for these goals:

| Goal | Flags |
| --- | --- |
| Penpot's new (WASM) renderer is used by the team | `--renderer wasm` |
| Closest pixels, structure may change (frames unclipped, strokes on inset boxes, text split per glyph, some Inter text outlined) | `--pixel-exact` |
| Most faithful text, none editable | `--text outline` (with `--pixel-exact` for the closest overall) |
| Every text editable, even where it will look wrong | `--text editable` |
| Text that rewraps when edited | `--line-breaks reflow` |
| Figma's letter-spacing values untouched | `--text-spacing none` |
| Editable booleans / editable approximations of baked paints | `--booleans editable` / `--no-bake` |
| Penpot rejects the import because of components | `--no-components` |
| Full-resolution images, original image bytes | `--no-downsample`, `--no-image-profiles` |

`--pixel-exact` and `--text outline` trade editability for looks: tell the user the trade-off and
let them choose rather than picking one silently.

## Read warnings

Each line is `<count> × <code> — e.g. <one message>`. `--verbose` lists every warning with node id
and name (`warning <code> [<id> "<name>"]: …`). Report the ones that change what the user gets
(every other code, with when it fires and the flag that changes it, is in `docs/WARNINGS.md` of the
fig2pot repository):

| Code | Tell the user |
| --- | --- |
| `font-unavailable` | Penpot has no such font; the text is outlined (not editable). With `--text editable` it renders once the font is uploaded to the Penpot team. |
| `text-outlined-*` (`fallback-glyphs`, `decoration`, `truncated`, `list`, `gradient-fill`, `glyph-shapes`, `component`) | These texts are vector outlines, not editable, because Penpot would draw them differently (missing characters, underline, ellipsis, numbered or nested list, gradient fill, …). `--text editable` keeps them editable. |
| `unsupported-effect`, `progressive-blur` | Noise/grain/texture effects are dropped; a progressive blur is reduced to its weakest radius (usually no blur). |
| `missing-image`, `unsupported-image` | An image fill was not in the file or unreadable and is dropped. |
| `unsupported-node-type` | Nodes of that type were skipped (FigJam/Slides content, widgets, …). |
| `images-downsampled` | Images are stored at displayed size × 2; less detail when zoomed in (`--no-downsample`). |
| `paint-baked` | Tiled or rotated images, rotated crops or angular/diamond gradients became bitmaps (`--no-bake` for editable approximations). |
| `stroke-dash-paths`, `stroke-cap-outlined`, `per-side-stroke-emulated`, `frame-stroke-separated` | Strokes drawn as extra paths or shapes so they look as in Figma; editing them differs from a plain stroke. |
| `stroke-dash-approximated`, `stroke-join-unsupported` | Dash layout or round/bevel joins differ slightly from Figma. |
| `variants-as-components`, `invalid-component`, `components-dropped` | Variants or components could not be kept as such and became plain components or boards. |
| `geometry-out-of-range` | A node too far off-canvas for Penpot was skipped with its content. |
| `layout-grids-dropped`, `unsupported-grid-layout` | Layout grids/guides dropped; grid auto layout kept as fixed positions. |

## Debug

- `fig2pot dump design.fig > tree.json` prints the decoded Figma tree; `fig2pot dump --ir
  design.fig` prints fig2pot's intermediate model. Use them to find a node by the id in a warning.
- If Penpot refuses the import, quote its error (`type`/`code`/`hint` on stderr) verbatim to the
  user, then retry with `--no-components`.

## Tell the user up front

- Prototype interactions, variables (bound colours become plain values), layout grids, effect
  and grid styles, and text hyperlinks are not converted.
- Some texts become outlines in the default mode; numbered lists, underlines and truncation are
  the usual causes.
- Penpot's two renderers draw gradients and blurs differently; the file is tuned for one.
- The `.fig` format is undocumented; a file from a newer Figma may convert partly.
- Large files (20+ MB) take tens of seconds and about 1.5 GB of memory.
