/**
 * Unpacks reference bundles downloaded by `capture.js` into test/refs/<fixture>/:
 *
 *   <node-id>.png, manifest.json, pages/<page-id>.json (REST-style JSON per page)
 *
 *   node tools/figma-refs/unpack.ts <downloads-dir> [--delete]
 *
 * The downloads directory is scanned recursively; files that do not start with
 * the bundle magic are ignored.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAGIC = 'F2PREFS1';
const ROOT = join(import.meta.dirname, '..', '..');

interface Header {
  fixture: string;
  fileKey: string | null;
  part: number;
  entries: { path: string; offset: number; length: number }[];
  manifest: { nodeId: string }[];
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const downloads = process.argv[2];
const remove = process.argv.includes('--delete');
if (!downloads) {
  console.error('usage: node tools/figma-refs/unpack.ts <downloads-dir> [--delete]');
  process.exit(2);
}

const manifests = new Map<string, Map<string, unknown>>();
for (const path of walk(downloads)) {
  const bytes = readFileSync(path);
  if (bytes.length < 12 || bytes.subarray(0, 8).toString('latin1') !== MAGIC) continue;
  const headerLength = bytes.readUInt32LE(8);
  const header = JSON.parse(bytes.subarray(12, 12 + headerLength).toString('utf8')) as Header;
  if (!/^[\w.-]+$/.test(header.fixture)) throw new Error(`suspicious fixture name in ${path}`);
  const dir = join(ROOT, 'test', 'refs', header.fixture);
  const payload = bytes.subarray(12 + headerLength);
  for (const entry of header.entries) {
    if (!/^[\w./-]+$/.test(entry.path) || entry.path.includes('..')) throw new Error(`suspicious path ${entry.path}`);
    const target = join(dir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, payload.subarray(entry.offset, entry.offset + entry.length));
  }
  let merged = manifests.get(header.fixture);
  if (!merged) {
    merged = new Map();
    const existing = join(dir, 'manifest.json');
    if (existsSync(existing)) {
      for (const item of JSON.parse(readFileSync(existing, 'utf8')) as { nodeId: string }[]) merged.set(item.nodeId, item);
    }
    manifests.set(header.fixture, merged);
  }
  for (const item of header.manifest) merged.set(item.nodeId, item);
  console.log(`${header.fixture} part ${header.part}: ${header.entries.length} files`);
  if (remove) rmSync(path);
}

for (const [fixture, merged] of manifests) {
  const dir = join(ROOT, 'test', 'refs', fixture);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify([...merged.values()], null, 2));
  console.log(`${fixture}: manifest has ${merged.size} render targets`);
}
