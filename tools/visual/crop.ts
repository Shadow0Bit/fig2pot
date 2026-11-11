/**
 * Crops (and optionally magnifies) a region of a PNG — handy for inspecting diff images.
 *
 *   node tools/visual/crop.ts <in.png> <out.png> <x> <y> <width> <height> [zoom=1]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [input, output, ...rest] = process.argv.slice(2);
const [x = 0, y = 0, width = 100, height = 100, zoom = 1] = rest.map(Number);
if (!input || !output) {
  console.error('usage: node tools/visual/crop.ts <in.png> <out.png> <x> <y> <width> <height> [zoom]');
  process.exit(2);
}
const source = PNG.sync.read(readFileSync(input));
const target = new PNG({ width: width * zoom, height: height * zoom });
for (let ty = 0; ty < target.height; ty++) {
  for (let tx = 0; tx < target.width; tx++) {
    const sx = x + Math.floor(tx / zoom);
    const sy = y + Math.floor(ty / zoom);
    const ti = (ty * target.width + tx) * 4;
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) {
      target.data.fill(128, ti, ti + 4);
      continue;
    }
    source.data.copy(target.data, ti, (sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4);
  }
}
writeFileSync(output, PNG.sync.write(target));
