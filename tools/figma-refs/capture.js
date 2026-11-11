/**
 * Runs INSIDE a Figma editor tab (the `figma` plugin API global is available
 * in the browser console of files you can edit). Exports ground truth for the
 * open file and hands it to the browser as ONE downloaded bundle, because
 * Figma's CSP forbids posting to localhost.
 *
 * Usage (console / automation):   __f2pCapture({ fixture: 'grida-frame', json: true })
 * Progress:                       __f2pState
 *
 * Bundle layout: "F2PREFS1" | u32le headerLength | header JSON | payload
 *   header = { fixture, fileKey, part, entries: [{ path, offset, length }], manifest: [...] }
 * `tools/figma-refs/unpack.ts` turns bundles into test/refs/<fixture>/.
 */
window.__f2pCapture = async function capture(options) {
  const { fixture, json = true, scale = 1, maxSide = 4096, maxBundleBytes = 48 * 1024 * 1024 } = options;
  const state = (window.__f2pState = { status: 'running', done: 0, total: 0, parts: 0, errors: [] });
  const encoder = new TextEncoder();

  let part = 0;
  let entries = [];
  let chunks = [];
  let size = 0;
  let manifest = [];

  const flush = () => {
    if (entries.length === 0) return;
    const header = encoder.encode(
      JSON.stringify({ fixture, fileKey: figma.fileKey ?? null, part, entries, manifest }),
    );
    const prefix = new Uint8Array(12);
    prefix.set(encoder.encode('F2PREFS1'), 0);
    new DataView(prefix.buffer).setUint32(8, header.length, true);
    const blob = new Blob([prefix, header, ...chunks], { type: 'application/octet-stream' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `f2prefs-${fixture}-${part}.bin`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    part++;
    state.parts = part;
    entries = [];
    chunks = [];
    manifest = [];
    size = 0;
  };

  const add = (path, bytes) => {
    if (size > 0 && size + bytes.length > maxBundleBytes) flush();
    entries.push({ path, offset: size, length: bytes.length });
    chunks.push(bytes);
    size += bytes.length;
  };

  try {
    const targets = [];
    const visit = (node, page) => {
      if (!node.visible) return;
      const box = node.absoluteBoundingBox;
      if (!box || box.width < 1 || box.height < 1) return;
      if (box.width * scale <= maxSide && box.height * scale <= maxSide) targets.push({ node, page });
      if (node.type === 'SECTION') for (const child of node.children) visit(child, page);
    };
    for (const page of figma.root.children) {
      await page.loadAsync();
      for (const child of page.children) visit(child, page);
      if (json) {
        try {
          const rest = await page.exportAsync({ format: 'JSON_REST_V1' });
          add(`pages/${page.id.replace(':', '-')}.json`, encoder.encode(JSON.stringify(rest)));
        } catch (error) {
          state.errors.push(`json ${page.id}: ${error}`);
        }
      }
    }
    state.total = targets.length;

    for (const { node, page } of targets) {
      try {
        const bytes = await node.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: scale },
          // Full render bounds: outside strokes, shadows and overflowing children are part of
          // what Figma shows, so they are part of the reference.
          useAbsoluteBounds: false,
        });
        const box = node.absoluteBoundingBox;
        const render = node.absoluteRenderBounds ?? box;
        manifest.push({
          nodeId: node.id,
          name: node.name,
          page: page.name,
          pageId: page.id,
          type: node.type,
          width: box.width,
          height: box.height,
          // Page-space rectangles: the node's own box and the area the PNG covers.
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          renderBounds: { x: render.x, y: render.y, width: render.width, height: render.height },
          scale,
        });
        add(`${node.id.replace(/:/g, '-')}.png`, bytes);
      } catch (error) {
        state.errors.push(`png ${node.id}: ${error}`);
      }
      state.done++;
      // Yield so the tab stays responsive and memory can be reclaimed.
      if (state.done % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    flush();
    state.status = 'done';
  } catch (error) {
    state.status = 'failed';
    state.errors.push(String(error));
  }
  return state;
};
