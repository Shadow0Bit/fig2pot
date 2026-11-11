/**
 * Makes the library's `.penpot` export byte-identical for identical input.
 *
 * What varies between runs of `@penpot/library` (1.3.0):
 * - storage objects (`objects/<uuid>.<ext>` + `objects/<uuid>.json`) get random
 *   ids, referenced by `mediaId` in `files/<file>/media/<media>.json`;
 * - media `createdAt` is the current time, in the machine's time zone;
 * - zip entry modification times.
 *
 * The archive is rewritten: storage objects are renamed to ids derived from
 * their content, every reference is rewritten, timestamps become the Unix
 * epoch, and entries are stored in the library's order with a fixed mtime.
 * The global clock is deliberately left alone (the export is asynchronous, a
 * patched `Date` would leak into whatever else runs meanwhile).
 */
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { penpotId } from './ids.ts';

/** The timestamp written everywhere (Unix epoch, in the library's own format). */
export const FIXED_TIMESTAMP = '1970-01-01T00:00:00+00:00';
/**
 * Zip (DOS) times start in 1980 and fflate encodes them with the LOCAL date getters: a date built from
 * local components (at call time, in the current zone) is written as 1980-01-02 12:00 in every time zone.
 */
const fixedMtime = (): Date => new Date(1980, 0, 2, 12, 0, 0);

const OBJECT_RE = /^objects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/;
const TIMESTAMP_RE = /"(createdAt|modifiedAt|updatedAt|deletedAt)":"\d{4}-\d\d-\d\dT[^"]*"/g;

export function normalizeExport(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);

  // Storage object id → deterministic id from the content of its data file (not its `.json` descriptor).
  const renamed = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const name of names) {
    const m = OBJECT_RE.exec(name);
    if (!m || m[2] === 'json' || renamed.has(m[1]!)) continue;
    const hash = createHash('sha256').update(entries[name]!).digest('hex');
    // Identical images stay distinct objects, numbered in archive order.
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    renamed.set(m[1]!, penpotId(`${hash}#${n}`, 'storage-object'));
  }

  const mtime = fixedMtime();
  const out: Zippable = {};
  for (const name of names) {
    const m = OBJECT_RE.exec(name);
    const target = m && renamed.has(m[1]!) ? `objects/${renamed.get(m[1]!)}.${m[2]}` : name;
    let data = entries[name]!;
    if (name.endsWith('.json')) data = strToU8(rewriteJson(strFromU8(data), renamed));
    // Already-compressed images are stored as they are.
    const level = m && /^(png|jpe?g|gif|webp)$/i.test(m[2]!) ? 0 : 6;
    out[target] = [data, { mtime, level }];
  }
  return zipSync(out, { level: 6, mtime });
}

function rewriteJson(text: string, renamed: ReadonlyMap<string, string>): string {
  let out = text.replace(TIMESTAMP_RE, (_, key: string) => `"${key}":"${FIXED_TIMESTAMP}"`);
  if (renamed.size > 0) out = out.replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (whole, id: string) => {
    const next = renamed.get(id);
    return next === undefined ? whole : `"${next}"`;
  });
  return out;
}
