# Changelog

Notable changes to the repository and to each package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version scheme is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-25

Affected packages: `pi-bg-tasks`.

### Fixed

- **A second pi process no longer kills this session's background commands.** Adoption had no notion
  of ownership: every pi process adopts every live sidecar it finds in the shared
  `<agent-dir>/bg-tasks`, so a nested `pi -p`, an RPC session, or a `subagent` call was tracking the
  parent's commands, took their completions first, deleted their metadata, and killed them all when
  it exited. That surfaced as `Command terminated by signal SIGTERM` on commands nobody had stopped,
  including commands whose timeout had been raised.

  Sidecar metadata now records `ownerPid`. Adoption leaves another live session's commands alone,
  takes over commands whose owning process is gone, and never prunes logs or metadata a live session
  still owns. A runtime that re-adopts its own commands after a crash claims their sidecars, so it
  can still stop them at shutdown. Sidecars written before this field existed carry no marker, so the
  process table answers the same question for them: a command whose parent process is alive belongs
  to that runtime, and one reparented to init lost its owner.
- **Liveness checks no longer count an un-reaped child as running.** A signalled child is a zombie
  until its parent reaps it, and `kill(pid, 0)` succeeds against a zombie, which would have pinned an
  adopted job to "running" (and hidden the bug above from the first regression test).

Five new tests in `packages/pi-bg-tasks/test/cross-process.test.ts` run a second runtime as a real
process against the same agent directory; four of the five fail against the previous
implementation, including the one that guards this bug directly.

### Added

- `jiti` as a root dev dependency, so test fixtures can load an extension entry the way Pi does.

## [0.1.0] - 2026-10-25

### Added

- Monorepo layout: `packages/pi-bg-tasks` and `packages/pi-subagent`, each a Pi package with its own
  `package.json`, README, and tests, plus a root Pi manifest that lists every extension entry so
  `pi install .` loads the set.
- Shared test harness (`test/helpers/extension.ts`) that loads an extension with a recording
  `ExtensionAPI`, a temp agent dir, and a hand-built tool context. 82 tests across both packages,
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
