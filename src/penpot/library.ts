/**
 * Typed facade over `@penpot/library` (the in-memory `.penpot` builder).
 *
 * The library takes plain JS objects with camelCase keys and converts them to
 * Penpot's kebab-case keywords (`fillColor` → `:fill-color`). A few keys need
 * odd spellings to survive that conversion: `layoutItemH-Sizing` becomes
 * `:layout-item-h-sizing`, whereas `layoutItemHSizing` would become
 * `:layout-item-hsizing` and be silently ignored.
 *
 * Validation: `addBoard` and `addGroup` check the full shape against Penpot's
 * schema and throw a `BuilderError` (with `.explain`); `addRect`, `addCircle`,
 * `addPath` and `addText` do NOT validate, so their params must be right by
 * construction.
 */
import * as raw from '@penpot/library';

export type Uuid = string;

export interface PenpotMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

// --- Paints ------------------------------------------------------------------

export interface PenpotGradientStop {
  /** `#rrggbb` */
  color: string;
  /** 0..1 */
  opacity?: number;
  /** 0..1 */
  offset: number;
}

/** Coordinates are normalised to the shape's selrect (0,0 top-left, 1,1 bottom-right). */
export interface PenpotGradient {
  type: 'linear' | 'radial';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  stops: PenpotGradientStop[];
}

/** Picture box relative to the shape's box (x,y,width,height in 0..1 units); absent = the picture fills the shape. */
export interface PenpotImageTransform {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PenpotImageColor {
  id: Uuid;
  width: number;
  height: number;
  mtype: string;
  name?: string;
  /** true = cover (keep proportions, crop), false = stretch. */
  keepAspectRatio?: boolean;
  transform?: PenpotImageTransform;
}

/**
 * Exactly one of `fillColor`, `fillColorGradient`, `fillImage` must be set.
 * (A type alias rather than an interface so it is assignable to `Record<string, unknown>`.)
 */
export type PenpotFill = {
  fillColor?: string;
  fillOpacity?: number;
  fillColorGradient?: PenpotGradient;
  fillImage?: PenpotImageColor;
  fillColorRefId?: Uuid;
  fillColorRefFile?: Uuid;
};

export type PenpotStrokeCap =
  | 'round'
  | 'square'
  | 'line-arrow'
  | 'triangle-arrow'
  | 'square-marker'
  | 'circle-marker'
  | 'diamond-marker';

/** Exactly one of `strokeColor`, `strokeColorGradient`, `strokeImage` must be set. */
export interface PenpotStroke {
  strokeColor?: string;
  strokeOpacity?: number;
  strokeColorGradient?: PenpotGradient;
  strokeImage?: PenpotImageColor;
  strokeColorRefId?: Uuid;
  strokeColorRefFile?: Uuid;
  strokeStyle?: 'solid' | 'dotted' | 'dashed' | 'mixed';
  strokeWidth?: number;
  strokeDash?: number;
  strokeGap?: number;
  strokeAlignment?: 'center' | 'inner' | 'outer';
  strokeCapStart?: PenpotStrokeCap;
  strokeCapEnd?: PenpotStrokeCap;
  hidden?: boolean;
}

// --- Effects -------------------------------------------------------------------

export interface PenpotShadow {
  id: Uuid | null;
  style: 'drop-shadow' | 'inner-shadow';
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  hidden: boolean;
  color: { color: string; opacity: number };
}

export interface PenpotBlur {
  id: Uuid;
  type: 'layer-blur';
  value: number;
  hidden: boolean;
}

export interface PenpotBackgroundBlur {
  id: Uuid;
  type: 'background-blur';
  value: number;
  hidden: boolean;
}

export type PenpotBlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

// --- Layout --------------------------------------------------------------------

export type PenpotLayoutSizing = 'fix' | 'auto' | 'fill';

export interface LayoutChildAttrs {
  'layoutItemH-Sizing'?: PenpotLayoutSizing;
  'layoutItemV-Sizing'?: PenpotLayoutSizing;
  layoutItemAlignSelf?: 'start' | 'end' | 'center' | 'stretch';
  layoutItemAbsolute?: boolean;
  layoutItemZIndex?: number;
  layoutItemMinW?: number;
  layoutItemMaxW?: number;
  layoutItemMinH?: number;
  layoutItemMaxH?: number;
  /** m1 top, m2 right, m3 bottom, m4 left. */
  layoutItemMargin?: { m1: number; m2: number; m3: number; m4: number };
  layoutItemMarginType?: 'simple' | 'multiple';
}

export type PenpotJustify = 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly' | 'stretch';

export interface LayoutContainerAttrs {
  layout?: 'flex';
  layoutFlexDir?: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  layoutGap?: { rowGap: number; columnGap: number };
  layoutGapType?: 'simple' | 'multiple';
  layoutWrapType?: 'wrap' | 'nowrap';
  layoutPadding?: { p1: number; p2: number; p3: number; p4: number };
  layoutPaddingType?: 'simple' | 'multiple';
  layoutJustifyContent?: PenpotJustify;
  layoutAlignContent?: PenpotJustify;
  layoutAlignItems?: 'start' | 'end' | 'center' | 'stretch';
}

export type ConstraintH = 'left' | 'right' | 'leftright' | 'center' | 'scale';
export type ConstraintV = 'top' | 'bottom' | 'topbottom' | 'center' | 'scale';

// --- Shapes --------------------------------------------------------------------

/** Attributes every shape accepts. */
export interface ShapeCommon {
  id: Uuid;
  name: string;
  hidden?: boolean;
  blocked?: boolean;
  opacity?: number;
  blendMode?: PenpotBlendMode;
  fills?: PenpotFill[];
  strokes?: PenpotStroke[];
  shadow?: PenpotShadow[];
  blur?: PenpotBlur;
  backgroundBlur?: PenpotBackgroundBlur;
  constraintsH?: ConstraintH;
  constraintsV?: ConstraintV;
  // Component copy links.
  shapeRef?: Uuid;
  componentId?: Uuid;
  componentFile?: Uuid;
  componentRoot?: boolean;
  /** Sync groups (`fill-group`, `swap-slot-<uuid>`, …) overridden in a copy. */
  touched?: string[];
}

/**
 * Geometry of a box shape: `x,y,width,height` is the UNtransformed box (its
 * centre is the shape's real centre); `transform` (linear part only) is applied
 * around that centre. The library derives `selrect` and `points` from these.
 */
export interface BoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  transform: PenpotMatrix;
  transformInverse: PenpotMatrix;
  flipX?: boolean;
  flipY?: boolean;
}

export interface CornerRadii {
  r1?: number;
  r2?: number;
  r3?: number;
  r4?: number;
}

export interface BoardParams extends ShapeCommon, BoxGeometry, CornerRadii, LayoutChildAttrs, LayoutContainerAttrs {
  showContent?: boolean;
  hideFillOnExport?: boolean;
  isVariantContainer?: boolean;
  variantId?: Uuid;
  variantName?: string;
}

/** Groups recompute their box from their children on close; only the orientation (`transform`) is kept. */
export interface GroupParams extends ShapeCommon, BoxGeometry, LayoutChildAttrs {
  maskedGroup?: boolean;
}

export interface RectParams extends ShapeCommon, BoxGeometry, CornerRadii, LayoutChildAttrs {}

export interface CircleParams extends ShapeCommon, BoxGeometry, LayoutChildAttrs {}

/** Path `content` is SVG path data (M/L/C/Z) in absolute page coordinates; selrect is derived from it. */
export interface PathParams extends ShapeCommon, LayoutChildAttrs {
  content: string;
  svgAttrs?: { fillRule?: 'nonzero' | 'evenodd' };
}

export interface TextParams extends ShapeCommon, BoxGeometry, LayoutChildAttrs {
  content: unknown;
  growType: 'auto-width' | 'auto-height' | 'fixed';
  [key: string]: unknown;
}

export type PenpotBoolType = 'union' | 'difference' | 'intersection' | 'exclude';

export interface BoolParams {
  groupId: Uuid;
  type: PenpotBoolType;
}

export interface VariantProperty {
  name: string;
  value: string;
}

export interface ComponentParams {
  componentId: Uuid;
  fileId?: Uuid;
  pageId?: Uuid;
  /** The main board. */
  frameId?: Uuid;
  name?: string;
  path?: string;
  variantId?: Uuid;
  variantProperties?: VariantProperty[];
}

export interface LibraryColorParams {
  id: Uuid;
  name: string;
  path?: string;
  color?: string;
  opacity?: number;
  gradient?: PenpotGradient;
  image?: PenpotImageColor;
}

export interface LibraryTypographyParams {
  id: Uuid;
  name: string;
  path?: string;
  fontId: string;
  fontFamily: string;
  fontVariantId: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  textTransform: string;
}

export interface MediaParams {
  id?: Uuid;
  name: string;
  /** Integers. */
  width: number;
  height: number;
}

export interface BuildContext {
  readonly currentFileId: Uuid;
  readonly currentPageId: Uuid;
  readonly currentFrameId: Uuid;
  readonly lastId: Uuid;
  addFile(params: { id?: Uuid; name: string; isShared?: boolean }): Uuid;
  closeFile(): void;
  addPage(params: { id?: Uuid; name: string; background?: string }): Uuid;
  closePage(): void;
  addBoard(params: BoardParams): Uuid;
  closeBoard(): void;
  addGroup(params: GroupParams): Uuid;
  closeGroup(): void;
  addBool(params: BoolParams): Uuid;
  addRect(params: RectParams): Uuid;
  addCircle(params: CircleParams): Uuid;
  addPath(params: PathParams): Uuid;
  addText(params: TextParams): Uuid;
  addLibraryColor(params: LibraryColorParams): Uuid;
  addLibraryTypography(params: LibraryTypographyParams): Uuid;
  addComponent(params: ComponentParams): void;
  addFileMedia(params: MediaParams, blob: Blob): Uuid;
  getMediaAsImage(mediaId: Uuid): Omit<PenpotImageColor, 'keepAspectRatio' | 'transform'> | undefined;
  getInternalState(): unknown;
}

export function createBuildContext(options?: { referer?: string }): BuildContext {
  return raw.createBuildContext(options) as BuildContext;
}

export function exportAsBytes(context: BuildContext): Promise<Uint8Array> {
  return withSafeStackTraces(() => raw.exportAsBytes(context));
}

export function exportStream(context: BuildContext, stream: WritableStream): Promise<void> {
  return withSafeStackTraces(() => raw.exportStream(context, stream));
}

/**
 * The library's zip writer calls `WritableStreamDefaultWriter.releaseLock()`,
 * which makes Node build (and format) an internal error. A third-party
 * `Error.prepareStackTrace` hook that throws while formatting it (vitest's
 * does, on this bundle) aborts the whole export, so during the export such a
 * hook falls back to plain formatting instead of throwing.
 */
async function withSafeStackTraces<T>(run: () => Promise<T>): Promise<T> {
  const hook = Error.prepareStackTrace;
  if (!hook) return run();
  const safe: typeof hook = (error, frames) => {
    try {
      return hook(error, frames);
    } catch {
      return `${String(error)}\n${frames.map((f) => `    at ${String(f)}`).join('\n')}`;
    }
  };
  Error.prepareStackTrace = safe;
  try {
    return await run();
  } finally {
    if (Error.prepareStackTrace === safe) Error.prepareStackTrace = hook;
  }
}

/** Shape of the library's `BuilderError` (thrown on schema validation failures). */
export interface BuilderErrorLike {
  message: string;
  type?: string;
  code?: string;
  hint?: string;
  explain?: unknown;
}

/** A one-line description of a library error, including the schema explanation when there is one. */
export function describeBuilderError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & BuilderErrorLike;
  let explain: unknown;
  try {
    explain = e.explain;
  } catch {
    explain = undefined;
  }
  const details = explain === undefined || explain === null ? '' : ` ${JSON.stringify(explain)}`;
  return `${e.hint ?? e.message}${details}`;
}
