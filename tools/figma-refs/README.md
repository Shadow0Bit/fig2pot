# Figma reference renders

Ground truth for the visual tests: what Figma itself renders for every
top-level frame of every fixture, plus Figma's REST-style JSON per page (a
structural oracle: absolute bounding boxes, fills, text, expanded instances…).

Output (not in git): `test/refs/<fixture>/`

```
<node-id>.png        Figma's render of that node at scale 1, covering its full render bounds
                     (outside strokes, shadows, overflowing children included)
manifest.json        [{ nodeId, name, page, pageId, type, width, height, box, renderBounds, scale }]
pages/<page-id>.json `exportAsync({ format: 'JSON_REST_V1' })` of the page
```

Rendered nodes: every visible top-level node of every page and, for sections,
their children (recursively through nested sections), up to 4096 px a side.

## How they are captured

Figma's REST API would be the obvious route, but on a free (Starter, "View"
seat) account `GET /v1/files` and `GET /v1/images` are limited to a handful of
requests per month. Instead the capture runs inside a Figma editor tab, where
the plugin API is available as the `figma` global:

1. Import the `.fig` fixtures into a Figma account (Drafts → Import). Node ids
   are preserved by the import, so they equal the GUIDs in the `.fig` file.
   `files.json` records the resulting file keys.
2. Open a file in the browser and run `capture.js` in the page (console or
   browser automation), then `__f2pCapture({ fixture: '<fixture-name>' })`.
   It exports the PNGs and JSON and hands them to the browser as download
   bundles (`f2prefs-<fixture>-<n>.bin`) — Figma's CSP forbids posting them to
   localhost.
3. `node tools/figma-refs/unpack.ts <browser-downloads-dir> [--delete]` writes
   the bundles into `test/refs/`.

`receiver.ts` is a tiny local HTTP sink for pages that *can* reach localhost.
