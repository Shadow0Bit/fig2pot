# Test fixtures

Small `.fig` files, checked in. Each is used unchanged except for its name: the `grida-` / `f2s-`
prefix was added, and in fig2sketch's names `_` became `-` (`noise_and_grain.fig` →
`f2s-noise-and-grain.fig`). Figma reference renders of most of them live in `test/refs/` (not in
git; see `tools/figma-refs/README.md`).

| File | Origin | Licence | What it exercises |
| --- | --- | --- | --- |
| `grida-blank.fig` | [gridaco/grida](https://github.com/gridaco/grida) `fixtures/test-fig/L0/blank.fig` | Apache-2.0 | One empty page. |
| `grida-components.fig` | grida `L0/components.fig` | Apache-2.0 | 4 pages: components, a component set with a dashed border, instances, instances with overrides. |
| `grida-frame.fig` | grida `L0/frame.fig` | Apache-2.0 | 3 pages: a frame, a clipping frame and a group, each holding rounded rectangles. |
| `grida-stroke.fig` | grida `L0/stroke.fig` | Apache-2.0 | Vector rectangles with inside / centre / outside strokes, with and without fills. |
| `grida-vector.fig` | grida `L0/vector.fig` | Apache-2.0 | One stroked open vector (an S-curve). |
| `f2s-broken-images.fig` | [sketch-hq/fig2sketch](https://github.com/sketch-hq/fig2sketch) `tests/data/broken_images.fig` | MIT | An image fill missing from the file and one in an unknown format (`missing-image`, `unsupported-image`). |
| `f2s-corners.fig` | fig2sketch `corners.fig` | MIT | Per-corner radii and corner smoothing on vectors, rectangles and frames. |
| `f2s-noise-and-grain.fig` | fig2sketch `noise_and_grain.fig` | MIT | Noise and grain effects, progressive blur, radial gradients, a font Penpot lacks (Baloo Bhaijaan). |
| `f2s-prototyping.fig` | fig2sketch `prototyping.fig` | MIT | 2 pages of prototype frames (scrolling, overlays), auto layout, a section. |
| `f2s-prototyping-components.fig` | fig2sketch `prototyping_components.fig` | MIT | Two components with auto layout, ellipses, Inter text. |
| `f2s-prototyping-swaps-and-instances.fig` | fig2sketch `prototyping_swaps_and_instances.fig` | MIT | Nested auto layout, instances, linear gradients, drop shadows, per-side strokes, Inter text. |
| `f2s-sections.fig` | fig2sketch `sections.fig` | MIT | A section holding component sets with dashed borders and nested frames. |
| `f2s-stacks-wrap.fig` | fig2sketch `stacks_wrap.fig` | MIT | Wrapping auto layout with many rectangles. |
| `f2s-structure.fig` | fig2sketch `structure.fig` | MIT | Groups, a component and two instances, image fills (one shown downsampled), paths, a drop shadow. |
| `f2s-vector.fig` | fig2sketch `vector.fig` | MIT | One complex vector network with round caps. |
| `radix-icons.fig` | Figma Community file [Radix Icons](https://www.figma.com/community/file/1510053249065427020) by WorkOS, as archived in grida `fixtures/test-fig/community/1510053249065427020-workos-radix-icons.fig` (grida's note: overrides added for each icon component) | CC BY 4.0 | 553 icon components and 223 instances, ~900 booleans (union, subtract, intersect), ~2,100 paths, round and square caps, alpha masks, a layout grid, wrapping auto layout, a remote component, a font Penpot lacks (Untitled Sans). |

The feature lists were taken from `node src/cli.ts dump --ir <file>` and the converter's warnings.
