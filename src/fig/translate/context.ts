import type { Reporter } from '../../ir.ts';
import type { FigDocument, FigNode } from '../types.ts';

export interface TranslateOptions {
  /** Include hidden (`visible: false`) nodes. Default true (they are emitted with `visible: false`). */
  includeHidden?: boolean;
}

/** Shared state handed to every translate function. */
export interface TranslateContext {
  doc: FigDocument;
  reporter: Reporter;
  options: Required<TranslateOptions>;
  /** Convenience wrapper around `reporter.warn` that fills in node id/name. */
  warn(code: string, message: string, node?: FigNode): void;
  /** Bytes of blob `index`, or undefined (with a warning) when out of range. */
  blob(index: number | undefined, node?: FigNode): Uint8Array | undefined;
}

export function createContext(doc: FigDocument, reporter: Reporter, options: TranslateOptions = {}): TranslateContext {
  const ctx: TranslateContext = {
    doc,
    reporter,
    options: { includeHidden: options.includeHidden ?? true },
    warn(code, message, node) {
      reporter.warn({ code, message, nodeId: node?.id, nodeName: node?.change.name });
    },
    blob(index, node) {
      if (index === undefined || index === null) return undefined;
      const bytes = doc.file.blobs[index];
      if (!bytes) ctx.warn('missing-blob', `blob ${index} is missing`, node);
      return bytes;
    },
  };
  return ctx;
}
