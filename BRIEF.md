# fig2pot — build brief

Build a Node CLI that converts a Figma `.fig` file into a `.penpot` file that Penpot can import (Dashboard → Import).

```
fig2pot design.fig -o design.penpot    # convert
fig2pot dump design.fig > tree.json    # debug: decoded node tree as JSON
```

## Stack
Node 24, TypeScript, ESM. Output via [`@penpot/library`](https://www.npmjs.com/package/@penpot/library) (`createBuildContext` → `addFile/addPage/addBoard…` → `exportStream`). It's pre-release; read its type definitions for the real shape API. Decode with `fflate` + `fzstd` + `kiwi-schema`, or reuse `fig-kiwi` / `openfig-core` if one decodes real files cleanly — evaluate before writing your own.

## Architecture
`src/fig/` (decode .fig → tree) → `src/ir.ts` (our own neutral node model) → `src/penpot/` (IR → Penpot). Keep the IR source-agnostic so a Figma REST API input can be added later. No Figma API calls in this tool.

## The .fig format (undocumented; verify against real files)
- Usually a ZIP: `canvas.fig`, `meta.json`, `images/<hash>`. Older files are bare `canvas.fig`.
- `canvas.fig`: 8-byte prelude `fig-kiwi`, u32 LE version, then `[u32 LE length][chunk]…`. Chunk 0 = Kiwi schema, chunk 1 = data. Each chunk is raw-deflate **or** zstd — sniff magic bytes `28 b5 2f fd`.
- Data is a flat `nodeChanges` list. Rebuild the tree from `guid` + `parentIndex.{guid, position}` (sort siblings by `position` string). Skip the internal-only canvas.
- `transform` is a 2×3 matrix relative to parent — compose to absolute for Penpot.
- Vector geometry lives in `blobs` (`commandsBlob`, `vectorNetworkBlob`) — needs decoding.
- Instances are NOT expanded: resolve from the component (`SYMBOL`) + overrides.

## Milestones (stop and report after each)
1. `dump` works on a real `.fig`.
2. Pages, frames→boards, groups, rectangles, ellipses, solid fills, strokes, radius, opacity.
3. Text (styled runs, fonts mapped to Google Fonts or a fallback), image fills.
4. Vectors/paths, booleans, gradients, shadows/blur, auto layout→flex.
5. Components + instances, color/text styles.

## Done when
- Each milestone has tests over small fixture `.fig` files (one feature each, checked in under `test/fixtures/`).
- Output imports into Penpot without errors and looks right. Verify in a local Penpot (Docker) if you can; otherwise say it was not verified.
- Unsupported node types/features are logged as warnings, never crash the run.

## Reference
Official Figma→Penpot plugin (same mapping problem, MPL-2.0): https://github.com/penpot/penpot-exporter-figma-plugin · Format notes: https://grida.co/docs/wg/feat-fig/
