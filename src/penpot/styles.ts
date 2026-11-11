/**
 * Shared styles → Penpot library colours and typographies.
 *
 * A Penpot library colour holds one colour / gradient / image, so a colour
 * style with several paints becomes several library colours (like the Figma
 * exporter plugin does); a paint that carries `styleId` links to the colour
 * created from the paint at the same position in its style.
 */
import type * as ir from '../ir.ts';
import { hex, opacity } from './colors.ts';
import { convertGradient } from './gradients.ts';
import { penpotId } from './ids.ts';
import type { BuildContext, LibraryColorParams, LibraryTypographyParams, Uuid } from './library.ts';
import { describeBuilderError } from './library.ts';
import type { MediaRegistry } from './media.ts';
import { resolveFont } from './text/fonts.ts';
import { defaultAutoLineHeight, explicitRatio } from './text/line-height.ts';

type Warn = (code: string, message: string) => void;

/**
 * Splits `a/b/c` into Penpot's path (`a / b`) and name (`c`). Empty segments are dropped, so a name made
 * only of slashes (`/`, ` / `) gets the non-empty name Penpot requires.
 */
export function splitPath(full: string): { path: string; name: string } {
  const parts = full
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const name = parts.pop() ?? '';
  return { path: parts.join(' / '), name: name === '' ? 'Unnamed' : name };
}

export class StyleRegistry {
  /** styleId → library colour id per paint index (undefined for paints that were not registered). */
  private readonly colors = new Map<string, (Uuid | undefined)[]>();
  private readonly typographies = new Map<string, Uuid>();

  colorRef(styleId: string, paintIndex: number): Uuid | undefined {
    return this.colors.get(styleId)?.[paintIndex];
  }

  typographyRef(styleId: string): Uuid | undefined {
    return this.typographies.get(styleId);
  }

  registerColors(builder: BuildContext, styles: readonly ir.ColorStyle[], media: MediaRegistry, warn: Warn): void {
    for (const style of styles) {
      const { path, name } = splitPath(style.name);
      const ids: (Uuid | undefined)[] = [];
      style.paints.forEach((paint, index) => {
        const params = libraryColor(paint, media);
        if (!params) {
          ids.push(undefined);
          return;
        }
        const id = penpotId(`${style.id}#${index}`, 'color');
        const visibleCount = style.paints.filter((p) => p.visible).length;
        const entry: LibraryColorParams = {
          ...params,
          id,
          name: visibleCount > 1 ? `${name} ${index + 1}` : name,
        };
        if (path) entry.path = path;
        try {
          builder.addLibraryColor(entry);
          ids.push(id);
        } catch (error) {
          warn('invalid-color-style', `Colour style "${style.name}" was rejected: ${describeBuilderError(error)}`);
          ids.push(undefined);
        }
      });
      this.colors.set(style.id, ids);
    }
  }

  registerTypographies(builder: BuildContext, styles: readonly ir.TypographyStyle[], warn: Warn): void {
    for (const style of styles) {
      const { path, name } = splitPath(style.name);
      const s = style.style;
      const font = resolveFont(s.fontFamily, s.fontWeight, s.italic);
      const ratio = explicitRatio(s.lineHeight, s.fontSize) ?? defaultAutoLineHeight(s.fontFamily).ratio;
      const letterSpacing = s.letterSpacing.unit === 'px' ? s.letterSpacing.value : (s.letterSpacing.value / 100) * s.fontSize;
      const id = penpotId(style.id, 'typography');
      const params: LibraryTypographyParams = {
        id,
        name,
        fontId: font.fontId,
        fontFamily: font.fontFamily,
        fontVariantId: font.fontVariantId,
        fontSize: num(s.fontSize),
        fontWeight: font.fontWeight,
        fontStyle: font.fontStyle,
        lineHeight: num(ratio),
        letterSpacing: num(letterSpacing),
        textTransform: TEXT_TRANSFORM[s.textCase],
      };
      if (path) params.path = path;
      try {
        builder.addLibraryTypography(params);
        this.typographies.set(style.id, id);
      } catch (error) {
        warn('invalid-text-style', `Text style "${style.name}" was rejected: ${describeBuilderError(error)}`);
      }
    }
  }
}

const TEXT_TRANSFORM: Record<ir.TextStyle['textCase'], string> = {
  original: 'none',
  upper: 'uppercase',
  lower: 'lowercase',
  title: 'capitalize',
  'small-caps': 'none',
};

function num(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}

function libraryColor(paint: ir.Paint, media: MediaRegistry): Omit<LibraryColorParams, 'id' | 'name'> | undefined {
  if (!paint.visible) return undefined;
  switch (paint.type) {
    case 'solid':
      return { color: hex(paint.color), opacity: opacity(paint.color.a * paint.opacity) };
    case 'gradient': {
      // A style has no shape: interpret the handles in a unit square.
      const result = convertGradient(paint, { toBox: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width: 1, height: 1 });
      return result ? { gradient: result.gradient, opacity: 1 } : undefined;
    }
    case 'image': {
      const image = media.image(paint.imageRef);
      return image ? { image: { ...image, keepAspectRatio: true }, opacity: opacity(paint.opacity) } : undefined;
    }
  }
}
