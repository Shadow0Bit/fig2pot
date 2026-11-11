/**
 * fig2pot intermediate representation (IR).
 *
 * The IR is the contract between a *source* (today: the `.fig` decoder in
 * `src/fig/`; later possibly the Figma REST API) and a *target* (today: the
 * Penpot writer in `src/penpot/`). It is deliberately source-agnostic: nothing
 * in here mentions kiwi, GUIDs, blobs or Penpot.
 *
 * Conventions
 * - All lengths are in CSS pixels. Angles are never stored; rotation lives in
 *   `transform`.
 * - Colors are straight (non-premultiplied) RGBA with every channel in 0..1.
 * - `transform` maps a node's local space (origin at its top-left corner,
 *   x right, y down, extent `size`) into its PARENT's local space. A page's
 *   direct children are positioned in page (canvas) space.
 * - Paint and effect arrays are ordered bottom → top, i.e. the LAST entry is
 *   painted on top (Figma order). Children arrays are ordered back → front.
 * - Everything is plain JSON-serialisable data except `ImageAsset.bytes`.
 * - Optional means "not applicable / source did not say"; consumers must not
 *   crash on absent optional fields.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * 2D affine matrix in CSS/SVG order:
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type BlendMode =
  | 'pass-through'
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'linear-burn'
  | 'color-burn'
  | 'lighten'
  | 'screen'
  | 'linear-dodge'
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

// ---------------------------------------------------------------------------
// Path geometry
// ---------------------------------------------------------------------------

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  /** Cubic bézier: control points (x1,y1) (x2,y2), end point (x,y). */
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  /** Quadratic bézier: control point (x1,y1), end point (x,y). */
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' };

export type WindingRule = 'nonzero' | 'evenodd';

/** One or more sub-paths sharing a winding rule, in the owning node's local space. */
export interface Path {
  windingRule: WindingRule;
  commands: PathCommand[];
}

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

interface PaintBase {
  visible: boolean;
  /** Paint-level opacity 0..1, multiplied with the colour's own alpha. */
  opacity: number;
  blendMode: BlendMode;
  /** Id of a shared colour style in `Document.styles.colors`, if the paint comes from one. */
  styleId?: string;
}

export interface SolidPaint extends PaintBase {
  type: 'solid';
  color: Color;
}

export interface GradientStop {
  /** 0..1 along the gradient. */
  position: number;
  color: Color;
}

export interface GradientPaint extends PaintBase {
  type: 'gradient';
  gradientType: 'linear' | 'radial' | 'angular' | 'diamond';
  /**
   * Three points in the node's normalised space (0,0 = top-left, 1,1 =
   * bottom-right), identical in meaning to the Figma REST API's
   * `gradientHandlePositions`:
   *   [0] start (linear) / centre (radial, angular, diamond)
   *   [1] end of the gradient axis (where position = 1)
   *   [2] end of the perpendicular axis; its distance from [0] is the
   *       gradient "width" (the minor radius for radial/diamond).
   */
  handles: [Vec2, Vec2, Vec2];
  stops: GradientStop[];
}

export type ImageScaleMode = 'fill' | 'fit' | 'crop' | 'tile';

export interface ImageFilters {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}

export interface ImagePaint extends PaintBase {
  type: 'image';
  /** Key into `Document.images`. May reference a missing asset; consumers must cope. */
  imageRef: string;
  scaleMode: ImageScaleMode;
  /**
   * `crop` only: maps the node's normalised space (0..1) into the image's
   * normalised space (0..1) — i.e. which part of the image is visible.
   */
  imageTransform?: Matrix;
  /** `tile` only: scale of one tile relative to the image's natural size. */
  scalingFactor?: number;
  /** Clockwise rotation in degrees applied to the image (0/90/180/270). */
  rotation?: number;
  filters?: ImageFilters;
}

export type Paint = SolidPaint | GradientPaint | ImagePaint;

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

export type StrokeCap =
  | 'none'
  | 'round'
  | 'square'
  | 'line-arrow'
  | 'triangle-arrow'
  | 'diamond'
  | 'circle';

export interface Stroke {
  /** Bottom → top. Empty means no stroke. */
  paints: Paint[];
  weight: number;
  /** Present only when the four sides differ (rectangles / frames). */
  perSide?: { top: number; right: number; bottom: number; left: number };
  align: 'inside' | 'center' | 'outside';
  join: 'miter' | 'bevel' | 'round';
  miterLimit?: number;
  startCap: StrokeCap;
  endCap: StrokeCap;
  /** Alternating dash, gap lengths. Empty = solid. */
  dashPattern: number[];
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface ShadowEffect {
  type: 'drop-shadow' | 'inner-shadow';
  visible: boolean;
  color: Color;
  offset: Vec2;
  /** Blur radius (Figma's `radius`). */
  blur: number;
  spread: number;
  blendMode: BlendMode;
  /** Drop shadow only: whether the shadow is visible through a transparent node. */
  showBehindNode?: boolean;
}

export interface BlurEffect {
  type: 'layer-blur' | 'background-blur';
  visible: boolean;
  radius: number;
}

export type Effect = ShadowEffect | BlurEffect;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type ConstraintH = 'left' | 'right' | 'left-right' | 'center' | 'scale';
export type ConstraintV = 'top' | 'bottom' | 'top-bottom' | 'center' | 'scale';

export type Sizing = 'fixed' | 'hug' | 'fill';

/** Auto layout container settings (Figma "stack"). */
export interface AutoLayout {
  direction: 'horizontal' | 'vertical';
  wrap: boolean;
  /** Gap between items along the primary axis. Ignored when `primaryAlign` is `space-between`. */
  itemSpacing: number;
  /** Gap between wrapped lines (only meaningful when `wrap`). */
  counterSpacing: number;
  padding: { top: number; right: number; bottom: number; left: number };
  primaryAlign: 'start' | 'center' | 'end' | 'space-between';
  counterAlign: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  /** Alignment of wrapped lines. */
  counterAlignContent: 'auto' | 'space-between';
  /** When true the first child is drawn on top ("first on top" canvas stacking). */
  reverseZIndex: boolean;
  strokesIncludedInLayout: boolean;
}

/** How a node takes part in its parent's auto layout. */
export interface LayoutChild {
  positioning: 'auto' | 'absolute';
  alignSelf?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface BaseNode {
  /**
   * Stable, document-unique id. For nodes materialised from a component
   * instance this is a path id (e.g. `I12:3;4:5`), so it is NOT a GUID and
   * targets must derive their own ids from it.
   */
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  /** Local → parent. See file header. */
  transform: Matrix;
  size: Size;
  /** Bottom → top. */
  fills: Paint[];
  stroke?: Stroke;
  /** Bottom → top. */
  effects: Effect[];
  constraints?: { horizontal: ConstraintH; vertical: ConstraintV };
  /** Horizontal / vertical sizing behaviour (resolved, à la Figma's layoutSizing*). */
  sizing?: { horizontal: Sizing; vertical: Sizing };
  /** Only when the parent is an auto layout frame. */
  layoutChild?: LayoutChild;
  /**
   * For a node inside a component instance: the id of the node it mirrors in
   * the component it was instantiated from (the *nearest* main component —
   * for nested instances that is the inner component's node). Absent on
   * instance roots (see `FrameNode.instanceOf`) and on plain nodes.
   */
  componentRef?: string;
  /**
   * Source-computed outlines in local space, if the source provides them
   * (Figma `fillGeometry` / `strokeGeometry`). `fill` is the node's shape,
   * `stroke` is the already-expanded stroke outline. Targets may use these to
   * render exactly what Figma rendered when they cannot express a feature.
   */
  geometry?: { fill?: Path[]; stroke?: Path[] };
}

export interface FrameNode extends BaseNode {
  type: 'frame';
  children: Node[];
  clipsContent: boolean;
  /**
   * [topLeft, topRight, bottomRight, bottomLeft], already clamped to the box
   * (CSS rule: all four scaled by `min(1, w/(tl+tr), w/(bl+br), h/(tl+bl),
   * h/(tr+br))`), i.e. the radii the source actually renders.
   */
  cornerRadii?: [number, number, number, number];
  /** 0..1 iOS-style corner smoothing; informational. */
  cornerSmoothing?: number;
  layout?: AutoLayout;
  /** Marks what kind of Figma container this came from; affects naming/defaults only. */
  role: 'frame' | 'section' | 'component' | 'component-set' | 'instance';
  /** Set on a main component's root: id into `Document.components`. */
  componentId?: string;
  /** Set on an instance root: id (into `Document.components`) of the component it instantiates. */
  instanceOf?: string;
}

/**
 * A group has no geometry of its own: `size`/`transform` describe its
 * children's bounding box, `fills`/`stroke` are empty. When `mask` is set the
 * FIRST child is the mask shape and clips/masks all following children.
 */
export interface GroupNode extends BaseNode {
  type: 'group';
  children: Node[];
  mask?: { type: 'alpha' | 'vector' | 'luminance' };
}

export interface RectNode extends BaseNode {
  type: 'rect';
  /**
   * [topLeft, topRight, bottomRight, bottomLeft], already clamped to the box
   * (CSS rule: all four scaled by `min(1, w/(tl+tr), w/(bl+br), h/(tl+bl),
   * h/(tr+br))`), i.e. the radii the source actually renders.
   */
  cornerRadii?: [number, number, number, number];
  cornerSmoothing?: number;
}

/** A full ellipse inscribed in `size`. Arcs/donuts are emitted as `path` nodes. */
export interface EllipseNode extends BaseNode {
  type: 'ellipse';
}

/**
 * Arbitrary vector geometry (Figma VECTOR, LINE, STAR, REGULAR_POLYGON,
 * partial ELLIPSE, …).
 */
export interface PathNode extends BaseNode {
  type: 'path';
  /**
   * The editable centre-line geometry in local space: fills fill it, strokes
   * stroke it. May contain open sub-paths.
   */
  paths: Path[];
  /**
   * False when `paths` is only an approximation of what the source renders
   * (e.g. per-vertex corner rounding that could not be reproduced). Targets
   * that favour visual fidelity should then prefer `geometry`.
   */
  pathsAreExact: boolean;
}

export interface BooleanNode extends BaseNode {
  type: 'boolean';
  operation: 'union' | 'subtract' | 'intersect' | 'exclude';
  /** Operands, back → front. `subtract` removes all later children from the first. */
  children: Node[];
}

// --- Text ------------------------------------------------------------------

export interface LineHeight {
  unit: 'auto' | 'px' | 'percent';
  /** px value, or percent of font size (100 = 1×). Unused for `auto`. */
  value: number;
}

export interface LetterSpacing {
  unit: 'px' | 'percent';
  /** px, or percent of font size. */
  value: number;
}

export interface TextStyle {
  fontFamily: string;
  /** The style name as the source reports it, e.g. "Semi Bold Italic". */
  fontStyle: string;
  /** CSS numeric weight 100..900, derived from the style name when the source gives none. */
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textCase: 'original' | 'upper' | 'lower' | 'title' | 'small-caps';
  textDecoration: 'none' | 'underline' | 'strikethrough';
  /** Bottom → top. */
  fills: Paint[];
  hyperlink?: string;
  /** Id of a shared text style in `Document.styles.typographies`. */
  styleId?: string;
}

/** A maximal range of characters sharing one style. Runs are contiguous and cover the whole string. */
export interface TextRun {
  /** UTF-16 code unit offsets into `TextNode.characters`, end exclusive. */
  start: number;
  end: number;
  style: TextStyle;
}

export interface TextLine {
  /** UTF-16 offsets, end exclusive. */
  start: number;
  end: number;
  /** Baseline origin in the node's local space. */
  baseline: Vec2;
  width: number;
  lineHeight: number;
  /** Distance from the top of the line box to the baseline. */
  ascent: number;
}

export interface TextNode extends BaseNode {
  type: 'text';
  characters: string;
  runs: TextRun[];
  /** Which dimensions follow the content. */
  autoResize: 'none' | 'height' | 'width-and-height' | 'truncate';
  alignHorizontal: 'left' | 'center' | 'right' | 'justified';
  alignVertical: 'top' | 'center' | 'bottom';
  paragraphSpacing: number;
  paragraphIndent: number;
  /**
   * List paragraphs (bulleted / numbered lines), in paragraph order. `start`
   * is the UTF-16 offset of the paragraph's first character; `level` its
   * nesting (1 = outermost). The source draws a marker (bullet or number) that
   * is not part of `characters` before the paragraph and indents its text;
   * the drawn markers are `layout.markers`.
   */
  lists?: { start: number; type: 'ordered' | 'unordered'; level: number }[];
  /**
   * Source-computed layout, when available. `lines` is the source's line
   * breaking; `outlines` are the glyph outlines of the whole text in local
   * space, one entry per run that has visible glyphs (`runIndex` indexes
   * `runs`), usable to render the text as vectors when the font is
   * unavailable in the target.
   */
  layout?: {
    lines?: TextLine[];
    outlines?: { path: Path; runIndex: number }[];
    /**
     * Truncated text (`autoResize: 'truncate'`, or a line limit): offset of
     * the first character the source does not show. It draws an ellipsis
     * after the visible text instead; `lines` and `outlines` cover only what
     * it shows (the ellipsis included in `outlines`).
     */
    truncationStart?: number;
    /**
     * Fonts the source drew some glyphs with that are none of the runs'
     * families (glyphs missing from the run's font, drawn with a fallback).
     * Which characters they drew is not known.
     */
    fallbackFonts?: { family: string; style: string }[];
    /**
     * The glyph the source drew for each character that has one (UTF-16
     * `offset` of its first character, in offset order): origin (`x`, `y` =
     * baseline) in local space and nominal `advance` (px; the font's advance
     * × size, without letter spacing or kerning). A glyph covering several
     * characters (ligature, contextual arrow) is listed at its first one;
     * the others have no entry. Lets a target whose copy of the font has other
     * advances correct the spacing.
     */
    glyphAdvances?: { offset: number; x: number; y: number; advance: number }[];
    /**
     * Glyphs the source synthesised before a line (list bullets and numbers;
     * not the truncation ellipsis): `start` is the UTF-16 offset of the first
     * character of the line they precede; origin (`x`, `y` = baseline) in local
     * space, nominal `advance` and `fontSize` px.
     */
    markers?: { start: number; x: number; y: number; advance: number; fontSize: number }[];
  };
}

export type Node =
  | FrameNode
  | GroupNode
  | RectNode
  | EllipseNode
  | PathNode
  | BooleanNode
  | TextNode;

export type NodeType = Node['type'];

export type ContainerNode = FrameNode | GroupNode | BooleanNode;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface Page {
  id: string;
  name: string;
  background?: Color;
  /** Back → front. */
  children: Node[];
  /**
   * `remote-components` is a synthetic page holding the main components that
   * live in other libraries but are instantiated in this document, so that
   * every `instanceOf` resolves to a node somewhere in `Document.pages`.
   */
  kind: 'page' | 'remote-components';
}

export interface ComponentDef {
  /** Equals the `componentId` of the main component's root frame. */
  id: string;
  name: string;
  description?: string;
  /** Component set (variant group) this component belongs to. */
  set?: { id: string; name: string };
  /** Variant property name → value, when part of a set. */
  variantProperties?: Record<string, string>;
  /** True when the main lives on the `remote-components` page. */
  remote: boolean;
}

export interface ImageAsset {
  ref: string;
  bytes: Uint8Array;
  /** Sniffed from magic bytes; undefined when unrecognised. */
  mimeType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';
  width?: number;
  height?: number;
  /**
   * True when the source draws this image's stored values as sRGB, ignoring every embedded
   * colour description (PNG `iCCP` / `cICP` / `gAMA` / `cHRM`, JPEG APP2 ICC). Absent: the
   * source colour-manages embedded profiles (converts them to its display space).
   * Figma does this for files without a colour profile (`documentColorProfile` LEGACY).
   */
  ignoresEmbeddedProfile?: boolean;
}

export interface ColorStyle {
  id: string;
  /** May contain `/` separated groups. */
  name: string;
  paints: Paint[];
}

export interface TypographyStyle {
  id: string;
  name: string;
  style: Omit<TextStyle, 'fills' | 'hyperlink' | 'styleId'>;
}

export interface Document {
  name: string;
  pages: Page[];
  /** Keyed by `ComponentDef.id`. */
  components: Record<string, ComponentDef>;
  /** Keyed by `ImageAsset.ref`. */
  images: Record<string, ImageAsset>;
  styles: {
    colors: ColorStyle[];
    typographies: TypographyStyle[];
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Warning {
  /** Stable machine code, e.g. `unsupported-node-type`, `missing-image`. */
  code: string;
  message: string;
  nodeId?: string;
  nodeName?: string;
}

/**
 * Collects non-fatal problems. Converters must report unsupported features
 * here and keep going; they must never throw for a single bad node.
 */
export interface Reporter {
  warn(warning: Warning): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const IDENTITY: Matrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function isContainer(node: Node): node is ContainerNode {
  return node.type === 'frame' || node.type === 'group' || node.type === 'boolean';
}
