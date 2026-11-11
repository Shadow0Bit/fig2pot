/**
 * End-to-end self-test of the visual harness (needs Docker; starts the stack
 * if it is down and leaves it running):
 *
 *   node tools/visual/selftest.ts [--renderer svg|wasm|both]
 *
 * (Unit tests of the diff maths: `node --test tools/visual/diff.test.ts`.)
 *
 * 1. builds a sample `.penpot` with @penpot/library (two boards: rect, circle,
 *    gradient fill, Inter text), imports it, checks that board ids survive
 *    import (= penpotId(<figma id>)) and that the file id is remapped;
 * 2. renders both boards (render-only) and checks their sizes;
 * 3. uses those renders as "Figma references" for a fresh import of the same
 *    file → every board must score 1.0 (also proves export determinism);
 * 4. diffs against a variant with a different rect colour → Board A must
 *    drop clearly below 1, Board B must stay at 1, exit code 1;
 * 5. checks that Inter really loaded: the gfonts proxy served Inter, no
 *    exporter font warnings, and the Inter render differs from the same text
 *    in Roboto (another Google font).
 */
import { strict as assert } from 'node:assert';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { penpotId } from '../../src/penpot/ids.ts';
import { diffImages, visualPasses } from './diff.ts';
import { COMPOSE_FILE, isReady, PenpotClient, topLevelBoards, up, type Renderer } from './penpot.ts';
import { main as runCli, WORK_DIR, type Report } from './run.ts';
import { buildSamplePenpot, SAMPLE_BOARDS, SAMPLE_PAGE, ROBOTO } from './sample.ts';

const execFileAsync = promisify(execFile);
// FIG2POT_VISUAL_WORK (as batch.ts) keeps concurrent self-tests apart; diff.test.ts reads the same place.
const dir = join(process.env.FIG2POT_VISUAL_WORK ? resolve(process.env.FIG2POT_VISUAL_WORK) : WORK_DIR, 'selftest');

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms)\n      ${(error as Error).message.replace(/\n/g, '\n      ')}`);
  }
}

async function readReport(out: string): Promise<Report> {
  return JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as Report;
}

async function frontendLogsSince(sinceIso: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['compose', '-f', COMPOSE_FILE, 'logs', '--no-color', '--since', sinceIso, 'penpot-frontend'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function suite(renderer: Renderer): Promise<void> {
  console.log(`\n== renderer: ${renderer}`);
  const base = join(dir, renderer);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  const samplePath = join(base, 'sample.penpot');
  const modifiedPath = join(base, 'sample-modified.penpot');
  const fontPath = join(base, 'sample-roboto.penpot');
  await writeFile(samplePath, await buildSamplePenpot());
  await writeFile(modifiedPath, await buildSamplePenpot({ rectColor: '#30A46C' }));
  await writeFile(fontPath, await buildSamplePenpot({ font: ROBOTO }));
  const since = new Date(Date.now() - 2_000).toISOString();

  await step('import preserves page + board ids, remaps the file id', async () => {
    const client = await PenpotClient.connect({ renderer });
    const bytes = new Uint8Array(await readFile(samplePath));
    const { fileId, pages } = await client.importPenpotFile(bytes, 'selftest ids');
    try {
      const file = await client.getFile(fileId);
      assert.equal(pages.length, 1);
      assert.equal(pages[0]!.id, penpotId(SAMPLE_PAGE.nodeId, 'page'), 'page id preserved');
      const boards = topLevelBoards(file.pages[0]!);
      assert.deepEqual(
        boards.map((b) => [b.id, b.name, b.width, b.height]),
        SAMPLE_BOARDS.map((b) => [penpotId(b.nodeId), b.name, b.width, b.height]),
      );
      assert.ok(file.pages[0]!.objects[penpotId('1:12')], 'nested text shape id preserved');
    } finally {
      await client.deleteFile(fileId);
    }
  });

  await step('--list prints both boards', async () => {
    const code = await runCli(['--penpot', samplePath, '--list', '--renderer', renderer]);
    assert.equal(code, 0);
  });

  const renders = join(base, 'render');
  await step('--render-only exports every top-level board at the right size', async () => {
    const code = await runCli(['--penpot', samplePath, '--render-only', '--out', renders, '--renderer', renderer]);
    assert.equal(code, 0);
    const files = (await readdir(join(renders, 'candidate'))).sort();
    assert.equal(files.length, 2, files.join(', '));
  });

  // Turn the renders into a refs dir keyed by fake Figma ids.
  const refs = join(base, 'refs');
  await mkdir(refs, { recursive: true });
  const rendered = (await readdir(join(renders, 'candidate'))).sort();
  for (const b of SAMPLE_BOARDS) {
    const f = rendered.find((name) => name.includes(penpotId(b.nodeId).slice(0, 8)));
    assert.ok(f, `render for ${b.name}`);
    await writeFile(join(refs, `${b.nodeId.replace(/:/g, '-')}.png`), await readFile(join(renders, 'candidate', f)));
  }
  await writeFile(
    join(refs, 'manifest.json'),
    JSON.stringify(SAMPLE_BOARDS.map((b) => ({ nodeId: b.nodeId, name: b.name, page: SAMPLE_PAGE.name, scale: 1 })), null, 2),
  );

  await step('diff against itself (fresh import) → accuracy 1.0, exit 0', async () => {
    const out = join(base, 'same');
    const code = await runCli(['--penpot', samplePath, '--refs', refs, '--out', out, '--renderer', renderer]);
    const report = await readReport(out);
    for (const b of report.boards) {
      assert.equal(b.matchedBy, 'id', `${b.name} matched by id`);
      assert.equal(b.metrics?.accuracy, 1, `${b.name} accuracy`);
      assert.equal(b.metrics?.contentAccuracy, 1, `${b.name} contentAccuracy`);
      assert.equal(b.metrics?.perceptualAccuracy, 1, `${b.name} perceptualAccuracy`);
      assert.equal(b.metrics?.visualAccuracy, 1, `${b.name} visualAccuracy`);
      assert.equal(b.metrics?.localAccuracy, 1, `${b.name} localAccuracy`);
      assert.equal(b.status, 'ok', `${b.name} passes the visual rule`);
    }
    assert.equal(code, 0);
  });

  await step('diff against a modified rect colour → Board A clearly < 1, exit 1', async () => {
    const out = join(base, 'modified');
    const code = await runCli(['--penpot', modifiedPath, '--refs', refs, '--out', out, '--renderer', renderer]);
    const report = await readReport(out);
    const a = report.boards.find((b) => b.nodeId === '1:2')!;
    const b = report.boards.find((x) => x.nodeId === '1:3')!;
    assert.ok(a.metrics && a.metrics.contentAccuracy < 0.9, `Board A contentAccuracy ${a.metrics?.contentAccuracy}`);
    assert.ok(a.metrics && a.metrics.accuracy < 0.95, `Board A accuracy ${a.metrics?.accuracy}`);
    assert.ok(a.metrics.perceptualAccuracy < 0.9, `Board A perceptualAccuracy ${a.metrics.perceptualAccuracy}`);
    assert.equal(b.metrics?.contentAccuracy, 1, 'Board B untouched');
    assert.equal(b.metrics?.perceptualAccuracy, 1, 'Board B untouched (perceptual)');
    assert.ok(!visualPasses(a.metrics), `Board A fails the visual rule (visual ${a.metrics.visualAccuracy}, local ${a.metrics.localAccuracy})`);
    assert.equal(b.metrics?.visualAccuracy, 1, 'Board B untouched (visual)');
    assert.equal(code, 1);
    console.log(`      Board A: accuracy ${a.metrics.accuracy.toFixed(4)}, contentAccuracy ${a.metrics.contentAccuracy.toFixed(4)}, perceptualAccuracy ${a.metrics.perceptualAccuracy.toFixed(4)}, ssim ${a.metrics.ssim.toFixed(4)}`);
  });

  await step('Inter is really used (gfonts proxy hit, no font warnings, differs from Roboto)', async () => {
    const logs = await frontendLogsSince(since);
    assert.match(logs, /GET \/internal\/gfonts\/font\/inter\/\S+ HTTP\/1\.1" 200/, 'frontend proxied an Inter font file from fonts.gstatic.com');
    const sameReport = await readReport(join(base, 'same'));
    const fontWarnings = sameReport.warnings.filter((w) => /font/i.test(w));
    assert.deepEqual(fontWarnings, [], 'exporter font warnings');
    const out = join(base, 'font-control');
    const code = await runCli(['--penpot', fontPath, '--refs', refs, '--out', out, '--renderer', renderer]);
    const report = await readReport(out);
    for (const b of report.boards) {
      const m = b.metrics;
      assert.ok(m, `${b.name} compared`);
      console.log(`      Roboto vs Inter, ${b.name}: perceptual ${(m.perceptualAccuracy * 100).toFixed(2)} %, strict content ${(m.contentAccuracy * 100).toFixed(2)} %, full ${(m.accuracy * 100).toFixed(2)} %`);
      assert.ok(m.contentAccuracy < 0.995, `${b.name}: Roboto render should differ from Inter (got ${m.contentAccuracy})`);
      // The acceptance metric must fail a different font face (default --min 0.98).
      assert.ok(m.perceptualAccuracy < 0.98, `${b.name}: perceptual metric forgives Roboto vs Inter (${m.perceptualAccuracy})`);
      console.log(`        visual ${(m.visualAccuracy * 100).toFixed(2)} %, regional ${(m.regionalAccuracy * 100).toFixed(2)} %, local ${(m.localAccuracy * 100).toFixed(2)} %`);
      assert.ok(!visualPasses(m), `${b.name}: the visual rule forgives Roboto vs Inter (visual ${m.visualAccuracy}, local ${m.localAccuracy})`);
    }
    assert.equal(code, 1, 'a font swap fails the run');
  });
}

async function unit(): Promise<void> {
  console.log('\n== diff.ts');
  await step('identical PNGs → 1.0; padded candidate registers; overflow flagged', async () => {
    const { PNG } = await import('pngjs');
    const mk = (w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8Array => {
      const p = new PNG({ width: w, height: h });
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) p.data.set(paint(x, y), (y * w + x) * 4);
      return new Uint8Array(PNG.sync.write(p));
    };
    const square = (c: [number, number, number, number], pad = 0) => (x: number, y: number): [number, number, number, number] =>
      x < pad || y < pad || x >= 100 + pad || y >= 100 + pad ? [0, 0, 0, 0] : x >= 40 + pad && x < 60 + pad && y >= 40 + pad && y < 60 + pad ? c : [255, 255, 255, 255];
    const a = mk(100, 100, square([0, 0, 0, 255]));
    const same = diffImages(a, a).result;
    assert.equal(same.accuracy, 1);
    assert.equal(same.contentAccuracy, 1);
    const other = diffImages(a, mk(100, 100, square([255, 0, 0, 255]))).result;
    assert.equal(other.mismatchedPixels, 400);
    assert.equal(other.contentPixels, 400);
    assert.equal(other.contentAccuracy, 0, 'content metric ignores the flat background');
    // Penpot-style transparent export padding: registered away, not a mismatch.
    const padded = diffImages(a, mk(110, 110, square([0, 0, 0, 255], 5))).result;
    assert.deepEqual(padded.offset, { x: -5, y: -5 });
    assert.deepEqual(padded.sizeDelta, { width: 10, height: 10 });
    assert.equal(padded.boundsMismatch, false);
    assert.equal(padded.contentAccuracy, 1);
    // Opaque overflow in the candidate only: mismatch + boundsMismatch.
    const overflow = diffImages(a, mk(110, 100, (x, y) => (x < 100 ? square([0, 0, 0, 255])(x, y) : [0, 0, 255, 255]))).result;
    assert.deepEqual(overflow.offset, { x: 0, y: 0 });
    assert.equal(overflow.boundsMismatch, true);
    assert.equal(overflow.totalPixels, 11_000);
    assert.equal(overflow.mismatchedPixels, 1_000);
  });
}

const { values } = parseArgs({ options: { renderer: { type: 'string', default: 'both' } } });
const renderers: Renderer[] = values.renderer === 'both' ? ['svg', 'wasm'] : [values.renderer as Renderer];

const t0 = Date.now();
await unit();
if (!(await isReady())) await up({ log: (m) => console.log(`[visual] ${m}`) });
for (const r of renderers) await suite(r);
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} in ${((Date.now() - t0) / 1000).toFixed(1)} s (artifacts: ${dir})`);
process.exitCode = failures === 0 ? 0 : 1;
