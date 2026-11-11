# Large fixtures (not in git)

Only this README is tracked; the files below are downloaded by hand. Tests that need them skip
when they are absent, so `pnpm test` passes without them.

| File | Origin | Licence | Size |
| --- | --- | --- | --- |
| `auto-layout-playground.fig` | Figma Community file [Figma auto layout playground](https://www.figma.com/community/file/784448220678228461), as archived in [gridaco/grida](https://github.com/gridaco/grida) `fixtures/test-fig/community/784448220678228461-figma-auto-layout-playground.fig` (grida's note: export settings added to each top-level frame) | CC BY 4.0 | 22.9 MB |
| `simple-design-system.fig` | Figma's [Simple Design System](https://www.figma.com/community/file/1380235722331273046), as archived in grida `fixtures/test-fig/community/1380235722331273046-figma-simple-design-system.fig` | CC BY 4.0 | 7.9 MB |
| `rest/auto-layout-playground.document.json` | Figma REST API dump of the same file: `document.json` from grida `fixtures/test-figma/community/784448220678228461-figma-auto-layout-playground.zip` | CC BY 4.0 | 44 MB |
| `rest/radix-icons.document.json` | Figma REST API dump of `test/fixtures/radix-icons.fig`: `document.json` from grida `fixtures/test-figma/community/1510053249065427020-workos-radix-icons.zip` | CC BY 4.0 | 19 MB |

There is no REST dump of `simple-design-system.fig` (grida has none). The local files are
byte-identical to grida's (`.fig` against the Git LFS sha256; `radix-icons.document.json`
checked against the zip, 2026-11-11).

## Download

The `.fig` files are in Git LFS, so they come from `media.githubusercontent.com`; the zips are
ordinary files on `raw.githubusercontent.com`.

```sh
cd test/fixtures-large
base=https://media.githubusercontent.com/media/gridaco/grida/main/fixtures/test-fig/community
curl -fL -o auto-layout-playground.fig "$base/784448220678228461-figma-auto-layout-playground.fig"
curl -fL -o simple-design-system.fig  "$base/1380235722331273046-figma-simple-design-system.fig"

mkdir -p rest && raw=https://raw.githubusercontent.com/gridaco/grida/main/fixtures/test-figma/community
curl -fL -o /tmp/alp.zip   "$raw/784448220678228461-figma-auto-layout-playground.zip"
curl -fL -o /tmp/radix.zip "$raw/1510053249065427020-workos-radix-icons.zip"
unzip -p /tmp/alp.zip   '*/document.json' > rest/auto-layout-playground.document.json
unzip -p /tmp/radix.zip '*/document.json' > rest/radix-icons.document.json
```

## Tests that skip without them

- `auto-layout-playground.fig`: `test/penpot/assembly.test.ts` (determinism of a large file with
  baked tiles), `test/fig/translate/` lines, open-stroke, text-layout and smoke tests,
  `test/penpot/text/components.test.ts`, the live `test/penpot/live/text-spacing.test.ts`.
- `simple-design-system.fig`: `test/fig/instances.test.ts` and `instances-regressions.test.ts`
  (props, swaps, deep nesting), `test/penpot/variants.test.ts` (variant containers),
  `test/fig/translate/` text, text-layout, lines, open-stroke and smoke tests,
  `test/penpot/text/components.test.ts`.
- A `.fig` together with its `rest/*.document.json`: `test/fig/instances-oracle.test.ts`
  (materialised instances against the REST tree), `test/fig/translate/oracle.test.ts`,
  `text-oracle.test.ts` (auto-layout-playground) and `vector.test.ts` (radix-icons vector
  networks).

The visual harness (`tools/visual/batch.ts`) also picks up `auto-layout-playground.fig`: 283 of
the 361 reference boards are from it.
