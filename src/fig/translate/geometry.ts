import type * as ir from '../../ir.ts';
import type * as fig from '../schema.d.ts';
import type { FigNode } from '../types.ts';
import { decodeCommandsBlob } from '../blobs.ts';
import { windingFromKiwi } from './common.ts';
import type { TranslateContext } from './context.ts';

/** Decodes kiwi `fillGeometry`/`strokeGeometry` into IR paths (empty paths are dropped). */
export function decodeGeometry(paths: fig.Path[] | undefined, ctx: TranslateContext, node?: FigNode): ir.Path[] {
  const out: ir.Path[] = [];
  for (const path of paths ?? []) {
    const bytes = ctx.blob(path.commandsBlob, node);
    if (!bytes) continue;
    let corrupt = false;
    const commands = decodeCommandsBlob(bytes, () => {
      corrupt = true;
    });
    if (corrupt) ctx.warn('corrupt-geometry', 'outline geometry contains non-finite coordinates; the affected segments were dropped', node);
    if (commands.length > 0) out.push({ windingRule: windingFromKiwi(path.windingRule), commands });
  }
  return out;
}

export function geometryOf(node: FigNode, ctx: TranslateContext): ir.BaseNode['geometry'] {
  const fill = decodeGeometry(node.change.fillGeometry, ctx, node);
  const stroke = decodeGeometry(node.change.strokeGeometry, ctx, node);
  if (fill.length === 0 && stroke.length === 0) return undefined;
  const geometry: NonNullable<ir.BaseNode['geometry']> = {};
  if (fill.length > 0) geometry.fill = fill;
  if (stroke.length > 0) geometry.stroke = stroke;
  return geometry;
}
