/**
 * Contracts for the `.fig` side of the pipeline.
 *
 * Pipeline:  bytes ─decodeFig→ FigFile ─buildTree→ FigDocument
 *            ─resolveInstances→ FigDocument (instances materialised)
 *            ─translate→ ir.Document
 */
import type { Message, NodeChange } from './schema.d.ts';

export type { Message, NodeChange };

/** Canonical string form of a kiwi GUID: `${sessionID}:${localID}`. */
export type GuidString = string;

/** Raw decoded `.fig` container. */
export interface FigFile {
  /** `fig-kiwi` for design files (`fig-jam.` / `fig-deck` for FigJam / Slides). */
  prelude: string;
  /** Container version from the header. */
  version: number;
  /** The decoded kiwi message (schema-driven; shape described by `schema.d.ts`). */
  message: Message;
  /** `message.blobs` flattened to their bytes; index = blob index used by `commandsBlob` etc. */
  blobs: Uint8Array[];
  /** `images/<hash>` entries from the ZIP, keyed by lower-case hex hash. Empty for bare files. */
  images: Map<string, Uint8Array>;
  /** Parsed `meta.json` from the ZIP, if any. */
  meta?: Record<string, unknown>;
  /** `thumbnail.png` from the ZIP, if any. */
  thumbnail?: Uint8Array;
}

/**
 * One node of the scene tree.
 *
 * `change` holds the node's effective properties. For ordinary nodes it is the
 * decoded NodeChange as-is. For nodes materialised from a component instance
 * it is a NEW object: the symbol node's NodeChange with all applicable
 * overrides / derived data merged in (the originals are never mutated).
 */
export interface FigNode {
  /**
   * Document-unique id. Ordinary nodes: their GuidString (`12:34`).
   * Materialised instance descendants: a path id `I<instance>;<…>;<node>`
   * following the Figma REST API convention (`I12:3;4:5`).
   */
  id: string;
  /** The node's own GUID (for materialised nodes: the GUID of the symbol node it clones). */
  guid: GuidString;
  type: NonNullable<NodeChange['type']>;
  change: NodeChange;
  parent?: FigNode;
  /** Back → front (sorted ascending by `parentIndex.position`). */
  children: FigNode[];
  /**
   * Set on materialised instance descendants: `id` of the node in the main
   * component (SYMBOL subtree) this node mirrors. For a node inside a nested
   * instance this is the id of the node as it appears inside the *owning*
   * symbol's own materialised tree (so it always resolves to a FigNode that
   * exists in the document tree after `resolveInstances`).
   */
  componentRef?: string;
  /** Set on INSTANCE nodes once resolved: `id` of the SYMBOL FigNode it instantiates. */
  symbolId?: string;
}

export interface FigDocument {
  file: FigFile;
  /** The DOCUMENT node. */
  root: FigNode;
  /** CANVAS nodes shown to the user, in page order. */
  pages: FigNode[];
  /** The hidden "Internal Only Canvas" holding remote library symbols, if present. */
  internalCanvas?: FigNode;
  /** Every node in the tree by `FigNode.id` (kept up to date by `resolveInstances`). */
  byId: Map<string, FigNode>;
  /** Shared style nodes etc. that are not part of the scene tree but are referenced by GUID. */
  byGuid: Map<GuidString, FigNode>;
}
