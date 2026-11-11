import type { Document, Reporter, Warning } from './ir.ts';
import { decodeFig } from './fig/decode.ts';
import { buildTree } from './fig/tree.ts';
import { resolveInstances } from './fig/instances.ts';
import { translateDocument } from './fig/translate/index.ts';
import type { TranslateOptions } from './fig/translate/context.ts';
import { writePenpot, type WriteOptions } from './penpot/index.ts';
import { CollectingReporter } from './util/reporter.ts';

export type { Document, Warning, Reporter } from './ir.ts';
export type { WriteOptions } from './penpot/index.ts';
export type { TranslateOptions } from './fig/translate/context.ts';
export { decodeFig, FigDecodeError } from './fig/decode.ts';
export { buildTree } from './fig/tree.ts';
export { resolveInstances } from './fig/instances.ts';
export { translateDocument } from './fig/translate/index.ts';
export { writePenpot } from './penpot/index.ts';
export { CollectingReporter } from './util/reporter.ts';
export { uploadToPenpot, normalizePenpotUrl, accessTokenProblem, PenpotUploadError, DEFAULT_PENPOT_URL } from './penpot/upload.ts';
export type { UploadOptions, UploadResult, PenpotErrorInfo } from './penpot/upload.ts';

export interface ConvertOptions extends WriteOptions, TranslateOptions {
  /** Overrides the document name stored in the `.penpot` file. */
  name?: string;
}

export interface ConvertResult {
  /** Bytes of the `.penpot` file. */
  penpot: Uint8Array;
  warnings: Warning[];
}

/** `.fig` bytes → neutral IR document. Throws `FigDecodeError` when the file cannot be decoded. */
export function figToIR(fig: Uint8Array, reporter: Reporter, options: TranslateOptions = {}): Document {
  const doc = buildTree(decodeFig(fig));
  resolveInstances(doc, reporter);
  return translateDocument(doc, reporter, options);
}

/** Converts the bytes of a `.fig` file into the bytes of a `.penpot` file. */
export async function convert(fig: Uint8Array, options: ConvertOptions = {}): Promise<ConvertResult> {
  const reporter = new CollectingReporter();
  const document = figToIR(fig, reporter, options);
  if (options.name) document.name = options.name;
  const penpot = await writePenpot(document, options, reporter);
  return { penpot, warnings: reporter.warnings };
}
