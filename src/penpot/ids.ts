import { createHash } from 'node:crypto';

/** Fixed namespace so that the same IR id always yields the same Penpot id. */
const NAMESPACE = 'fig2pot:6f1d1c4e-3b7a-4c58-9a51-0d8a5f2e7c11';

/**
 * Deterministic RFC 4122 version-5-style UUID for an IR id.
 *
 * `scope` separates id spaces that could otherwise collide (e.g. `shape`,
 * `page`, `component`, `media`, `color`, `typography`).
 */
export function penpotId(irId: string, scope = 'shape'): string {
  const hash = createHash('sha1').update(`${NAMESPACE}/${scope}/${irId}`).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
