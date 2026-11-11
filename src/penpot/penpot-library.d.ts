// @penpot/library ships no type definitions. These are the raw exports only;
// `library.ts` narrows them into a typed facade, use that instead.
declare module '@penpot/library' {
  export function createBuildContext(options?: { referer?: string }): unknown;
  export function exportAsBytes(context: unknown, options?: unknown): Promise<Uint8Array>;
  export function exportStream(context: unknown, stream: WritableStream, options?: unknown): Promise<void>;
}
