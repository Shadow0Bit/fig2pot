# Rules for coding agents

fig2pot converts Figma `.fig` files into Penpot `.penpot` files. Full process:
[CONTRIBUTING.md](CONTRIBUTING.md). Design and code rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- Before you finish, run `pnpm run typecheck` and `pnpm test`. Both must pass. Report what you ran.
- Every behaviour change gets a test under `test/`, mirroring `src/`.
- `src/fig/**` and `src/penpot/**` never import each other; both use only `src/ir.ts` and `src/util/**`.
- Never crash on a single node: `Reporter.warn({ code, message, nodeId, nodeName })` with a stable kebab-case code, then fall back.
- A new warning code goes in `docs/WARNINGS.md`; `test/warnings-catalogue.test.ts` enforces it.
- Output must stay deterministic: no `Math.random`, no clocks, no iteration over unordered sources.
- Visual fidelity first, editability second.
- TypeScript, ESM, Node ≥ 24. Only erasable syntax (no `enum`, `namespace`, constructor parameter properties). Relative imports end in `.ts`.
- Do not add runtime dependencies; propose them to the maintainer instead.
- Do not edit `src/fig/schema.d.ts` by hand (generated; readable form: `docs/fig-schema.kiwi`).
- Fixtures: open licence only, never a private file; at most 1 MB in `test/fixtures/`; add a row to `test/fixtures/README.md`.
- A change to the `.penpot` output (`src/fig/translate/`, `src/fig/instances*`, `src/penpot/`) needs before/after Penpot renders and Figma's render of each affected board in the PR. If you cannot produce them, say so; never claim a visual check you did not do.
- New option: update the README options table and the CLI help.
