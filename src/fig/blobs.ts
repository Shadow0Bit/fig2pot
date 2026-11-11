import type { PathCommand } from '../ir.ts';

/**
 * Decodes a `commandsBlob` (used by `fillGeometry`, `strokeGeometry` and glyph
 * outlines): a sequence of `[u8 opcode][f32 LE …]` records.
 *
 *   0 = close, 1 = moveTo(x,y), 2 = lineTo(x,y),
 *   3 = quadTo(cx,cy,x,y), 4 = cubicTo(c1x,c1y,c2x,c2y,x,y)
 *
 * Decoding stops silently at the first unknown opcode or truncated record.
 * Only finite commands are returned: a record with a NaN / infinite value is
 * skipped (a corrupt moveTo drops its whole sub-path), and `onCorrupt` — if
 * given — is called once per skipped record so callers can warn.
 */
export function decodeCommandsBlob(bytes: Uint8Array, onCorrupt?: (offset: number) => void): PathCommand[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commands: PathCommand[] = [];
  let offset = 0;
  const has = (floats: number): boolean => offset + floats * 4 <= bytes.length;
  const floats = (n: number): number[] | undefined => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(view.getFloat32(offset + i * 4, true));
    offset += n * 4;
    return out.every(Number.isFinite) ? out : undefined;
  };
  /** Inside a sub-path whose moveTo was corrupt: drop everything up to the next moveTo. */
  let skipping = false;

  while (offset < bytes.length) {
    const recordStart = offset;
    const opcode = bytes[offset++];
    const arity = opcode === 0 ? 0 : opcode === 1 || opcode === 2 ? 2 : opcode === 3 ? 4 : opcode === 4 ? 6 : -1;
    if (arity < 0 || !has(arity)) break;
    const v = floats(arity);
    if (!v) {
      onCorrupt?.(recordStart);
      if (opcode === 1) skipping = true;
      continue;
    }
    if (opcode === 1) skipping = false;
    if (skipping) continue;
    if (opcode === 0) commands.push({ type: 'Z' });
    else if (opcode === 1) commands.push({ type: 'M', x: v[0]!, y: v[1]! });
    else if (opcode === 2) commands.push({ type: 'L', x: v[0]!, y: v[1]! });
    else if (opcode === 3) commands.push({ type: 'Q', x1: v[0]!, y1: v[1]!, x: v[2]!, y: v[3]! });
    else commands.push({ type: 'C', x1: v[0]!, y1: v[1]!, x2: v[2]!, y2: v[3]!, x: v[4]!, y: v[5]! });
  }
  return commands;
}
