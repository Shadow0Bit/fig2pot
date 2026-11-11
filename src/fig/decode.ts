import { inflateSync, unzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { compileSchema, decodeBinarySchema } from 'kiwi-schema';
import type { FigFile, Message } from './types.ts';

export class FigDecodeError extends Error {
  override name = 'FigDecodeError';
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const KNOWN_PRELUDES = new Set(['fig-kiwi', 'fig-jam.', 'fig-deck', 'fig-site', 'fig-buzz', 'fig-make']);

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

function decompressChunk(chunk: Uint8Array, index: number): Uint8Array {
  try {
    return startsWith(chunk, ZSTD_MAGIC) ? zstdDecompress(chunk) : inflateSync(chunk);
  } catch (cause) {
    throw new FigDecodeError(`could not decompress chunk ${index} of canvas data`, { cause });
  }
}

/** Splits the `fig-kiwi` container into its (still compressed) chunks. */
function readChunks(canvas: Uint8Array): { prelude: string; version: number; chunks: Uint8Array[] } {
  if (canvas.length < 12) throw new FigDecodeError('file is too short to be a .fig file');
  const prelude = new TextDecoder('latin1').decode(canvas.subarray(0, 8));
  if (!KNOWN_PRELUDES.has(prelude) && !prelude.startsWith('fig-')) {
    throw new FigDecodeError(`not a .fig file (unexpected header ${JSON.stringify(prelude)})`);
  }
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 4 <= canvas.length) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > canvas.length) {
      throw new FigDecodeError('truncated .fig file (chunk runs past end of data)');
    }
    chunks.push(canvas.subarray(offset, offset + length));
    offset += length;
  }
  return { prelude, version, chunks };
}

/**
 * Decodes a `.fig` file: either the ZIP flavour (`canvas.fig` + `meta.json` +
 * `images/`) or a bare `fig-kiwi` container.
 */
export function decodeFig(bytes: Uint8Array): FigFile {
  let canvas = bytes;
  const images = new Map<string, Uint8Array>();
  let meta: Record<string, unknown> | undefined;
  let thumbnail: Uint8Array | undefined;

  if (startsWith(bytes, ZIP_MAGIC)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch (cause) {
      throw new FigDecodeError('could not read .fig ZIP archive', { cause });
    }
    const canvasEntry = entries['canvas.fig'];
    if (!canvasEntry) throw new FigDecodeError('ZIP archive has no canvas.fig entry');
    canvas = canvasEntry;
    for (const [name, data] of Object.entries(entries)) {
      if (name.startsWith('images/') && data.length > 0) {
        images.set(name.slice('images/'.length).toLowerCase(), data);
      }
    }
    thumbnail = entries['thumbnail.png'];
    const metaEntry = entries['meta.json'];
    if (metaEntry) {
      try {
        meta = JSON.parse(new TextDecoder().decode(metaEntry)) as Record<string, unknown>;
      } catch {
        meta = undefined;
      }
    }
  }

  const { prelude, version, chunks } = readChunks(canvas);
  if (chunks.length < 2) throw new FigDecodeError('.fig file has no schema/data chunks');

  let message: Message;
  try {
    const schema = decodeBinarySchema(decompressChunk(chunks[0]!, 0));
    const compiled = compileSchema(schema) as { decodeMessage(bytes: Uint8Array): Message };
    message = compiled.decodeMessage(decompressChunk(chunks[1]!, 1));
  } catch (cause) {
    if (cause instanceof FigDecodeError) throw cause;
    throw new FigDecodeError('could not decode kiwi data in .fig file', { cause });
  }

  const blobs = (message.blobs ?? []).map((blob) => blob.bytes);
  return { prelude, version, message, blobs, images, meta, thumbnail };
}
