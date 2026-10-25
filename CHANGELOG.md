# Changelog

Notable changes to the repository and to each package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version scheme is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-25

### Added

- Monorepo layout: `packages/pi-bg-tasks` and `packages/pi-subagent`, each a Pi package with its own
  `package.json`, README, and tests, plus a root Pi manifest that lists every extension entry so
  `pi install .` loads the set.
- Shared test harness (`test/helpers/extension.ts`) that loads an extension with a recording
  `ExtensionAPI`, a temp agent dir, and a hand-built tool context. 57 tests across both packages,
  plus repository-level packaging tests (`test/repo.test.ts`) and a load test through Pi's own
  extension loader (`test/load.test.ts`). No model, no network.
- Tooling: `npm run check`, `npm run manifest` (root manifest sync), `npm run new` (extension
  scaffold), `npm run dev` (Pi with the repo's extensions loaded from source), Biome, `tsc --noEmit`,
  Vitest with forked isolated workers, and GitHub Actions CI on Node 22 and 24.
- Docs: root README, per-package READMEs, `docs/adding-an-extension.md`, `docs/testing.md`,
  `docs/packaging-and-installing.md`, and `AGENTS.md`.

### Changed

- `pi-bg-tasks`: `bg_stop` on an already-finished job no longer repeats the task ID inside the status
  sentence and no longer points at a log file that has already been deleted.
- `pi-subagent`: a non-zero exit with a clean stop reason now reads
  `Subagent failed (exit code N): …` instead of `Subagent stop: …`.

Both were message-only fixes; behaviour and result details are unchanged.
