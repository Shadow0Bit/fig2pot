import type * as ir from '../../../src/ir.ts';
import { IDENTITY } from '../../../src/ir.ts';
import type { TextDeps } from '../../../src/penpot/text/index.ts';
import { CollectingReporter } from '../../../src/util/reporter.ts';

export const BLACK: ir.SolidPaint = {
  type: 'solid',
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  color: { r: 0, g: 0, b: 0, a: 1 },
};

export function style(overrides: Partial<ir.TextStyle> = {}): ir.TextStyle {
  return {
    fontFamily: 'Inter',
    fontStyle: 'Regular',
    fontWeight: 400,
    italic: false,
    fontSize: 16,
    lineHeight: { unit: 'px', value: 24 },
    letterSpacing: { unit: 'px', value: 0 },
    textCase: 'original',
    textDecoration: 'none',
    fills: [BLACK],
    ...overrides,
  };
}

/** Builds a text node from `[text, style]` segments (runs are derived from the segment lengths). */
export function textNode(
  segments: [string, Partial<ir.TextStyle>?][],
  overrides: Partial<ir.TextNode> = {},
): ir.TextNode {
  let offset = 0;
  const runs: ir.TextRun[] = segments.map(([text, s]) => {
    const run = { start: offset, end: offset + text.length, style: style(s) };
    offset += text.length;
    return run;
  });
  return {
    type: 'text',
    id: '1:2',
    name: 'Text',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'pass-through',
    transform: IDENTITY,
    size: { width: 200, height: 40 },
    fills: [],
    effects: [],
    characters: segments.map(([t]) => t).join(''),
    runs,
    autoResize: 'none',
    alignHorizontal: 'left',
    alignVertical: 'top',
    paragraphSpacing: 0,
    paragraphIndent: 0,
    ...overrides,
  };
}

/** Minimal stand-in for the core writer's fill converter: solid paints only, reversed (Penpot = top first). */
export function testDeps(): TextDeps & { reporter: CollectingReporter } {
  return {
    reporter: new CollectingReporter(),
    fills(paints) {
      return paints
        .filter((p): p is ir.SolidPaint => p.type === 'solid')
        .map((p) => ({
          fillColor:
            '#' +
            [p.color.r, p.color.g, p.color.b]
              .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
              .join(''),
          fillOpacity: p.color.a * p.opacity,
        }))
        .reverse();
    },
  };
}

export interface ContentShape {
  type: 'root';
  verticalAlign: string;
  children: { type: 'paragraph-set'; children: ParagraphShape[] }[];
}
export type ParagraphShape = Record<string, unknown> & { type: 'paragraph'; children: LeafShape[] };
export type LeafShape = Record<string, unknown> & { text: string };

export function paragraphs(content: unknown): ParagraphShape[] {
  return (content as ContentShape).children[0]!.children;
}
