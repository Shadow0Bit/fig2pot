# Contributing to fig2pot

fig2pot is a side project. Contributions that make it better are welcome: bug fixes, better
fidelity, new Figma features, fixtures, docs. AI-made contributions are welcome too, as long as
they are worth merging (see [AI-assisted contributions](#ai-assisted-contributions)).

Be kind. The maintainer may close any issue or PR.

## Setup

Node ≥ 24 and pnpm.

```sh
pnpm install
pnpm test                  # unit tests (tests needing test/fixtures-large/ or a live Penpot skip)
pnpm run typecheck
node src/cli.ts <file.fig> # run the CLI from source, no build step
```

The source layout, the live Penpot tests and the visual harness are described in the README's
[Development](README.md#development) section.

## Pull requests

Open a PR directly; no issue is needed first. A PR is merged when:

1. **CI is green.** CI runs `pnpm run typecheck` and `pnpm test` on every PR, and a PR cannot be
   merged until both pass. Run them locally before pushing.
2. **Behaviour changes come with a test.** A fix gets a test that fails without it; a new feature
   gets a test that covers it. Tests live under `test/`, mirroring `src/`.
3. **Rendering changes come with screenshots** (below).
4. **Docs follow the code.** A new option goes in the README's options table and the CLI help; a
   new warning code goes in [docs/WARNINGS.md](docs/WARNINGS.md)
   (`test/warnings-catalogue.test.ts` fails otherwise).

Write commit messages as a plain imperative sentence ("Keep dash phase on rotated strokes"). PRs
are squash-merged, so the PR title becomes the commit on `main`: make it read the same way.

### Rendering changes

A PR is a rendering change when it changes the `.penpot` output, which in practice means code
under `src/fig/translate/`, `src/fig/instances*` or `src/penpot/`. For every board it affects,
add to the PR description:

- the Penpot render **before** (on `main`),
- the Penpot render **after** (with the PR),
- Figma's render of the same board (a screenshot from Figma is fine).

Name the fixture or file and the board. If you used `tools/visual/` with reference renders, its
`report.html` rows are a welcome addition, not a substitute.

## Code rules

The rules are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#ground-rules), which is the source
of truth. In short:

- `src/fig/**` and `src/penpot/**` never import each other; they share only `src/ir.ts` and
  `src/util/**`.
- Never crash on a single node: report a warning with a stable kebab-case code and fall back.
- Output is deterministic: the same input gives a byte-identical file.
- Visual fidelity first, editability second.
- TypeScript, ESM, erasable syntax only, relative imports with the `.ts` extension.
- No new runtime dependency without maintainer approval: say why in the PR.

## Fixtures

Test fixtures are real `.fig` files under `test/fixtures/`. A new one must:

- be under an open licence (Apache-2.0, MIT, CC BY, CC0) or your own work. Never a client's or
  otherwise private file;
- get a row in [test/fixtures/README.md](test/fixtures/README.md) with its origin, licence and
  what it exercises;
- be at most 1 MB. Larger files go in `test/fixtures-large/` (not in git; list them in its
  README), and tests that need them skip when they are absent;
- exercise one feature where possible.

## Reporting a bug

Open an issue with:

- the `.fig` file, or a cut-down copy that still shows the bug;
- if you cannot share it: the output of `fig2pot dump <file.fig>` and `fig2pot dump --ir
  <file.fig>`, and the `--verbose` warnings. These contain the file's text and layer names, so
  check them before posting;
- the command you ran, and for a rendering bug, screenshots of Figma's render and Penpot's.

## AI-assisted contributions

Using a coding agent is fine. You are answerable for every line of the PR as if you had written
it: read the diff, run the tests yourself, and report what you ran and what you did not.
[AGENTS.md](AGENTS.md) is the short rule set agents load automatically.

## Licence

fig2pot is MIT-licensed. By contributing you agree that your contribution is released under the
same [MIT License](LICENSE).
