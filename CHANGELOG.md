# Changelog

Notable changes to the repository and to each package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version scheme is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Affected packages: `pi-memory`, `pi-subagent` (formatting only).

### Changed

- **`pi-memory` injects `MEMORY.md` as its own prompt section instead of as project context.**
  Appending it to `systemPromptOptions.contextFiles` made the assistant's notes another
  `<project_instructions path="…">` block inside `<project_context>`, indistinguishable from the
  user's `AGENTS.md` and re-sent whenever either file changed. The extension now writes
  `systemPromptOptions.sections.assistant_memory`, which Pi renders as its own section near the end
  of the prompt:

  ```text
  <assistant_memory>
  Assistant-maintained memory. … Use the normal file tools on this path to change it.

  <memory path="/repo/MEMORY.md">
  # Notes
  …
  </memory>
  </assistant_memory>
  ```

  One `<memory path="…">` block per memory file, in the same discovery order as before, and the note
  opens the section outside those tags and ahead of them — the position Pi's own lead-in line has
  inside `<project_context>`. An edit to the notes now patches just that section; `project_context`
  and the user's spec are untouched. A run that finds nothing to inject removes the section and
  otherwise leaves the prompt options alone, so a `MEMORY.md` deleted or emptied mid-session stops
  being injected on the next run.

- **The pi-memory tests stopped repeating the model-facing note.** Rewording `MEMORY_NOTE` had
  broken two of them for no behavioural reason. They now import it from the extension and assert
  what must actually hold: that it opens the section, that it is outside the `<memory>` tags, that
  each file's text is inside them. 27 tests, up from 22, with the new ones covering the section
  boundary (nothing about memory reaches `contextFiles`), the section being removed, a no-op run
  leaving the prompt options untouched, and another extension's prompt section being left alone.
- Re-ran the formatter over `pi-subagent`'s tool description, which a manual edit had left in a shape
  `npm run lint` rejects.

## [0.2.0] - 2026-10-25

Affected packages: `pi-memory` (new), and the repository's own context files.

### Added

- **`pi-memory`**, an extension with no tools: it handles `before_agent_start` and appends
  `MEMORY.md` to `systemPromptOptions.contextFiles`, which is the list Pi renders as
  `<project_instructions path="…">` blocks inside `<project_context>`. So the assistant gets a file
  of its own beside the user's `AGENTS.md`, in the same section, with a note in front of it saying
  that keeping that file current is part of the job and naming the path to edit.

  It is a no-op unless the file exists, so it is opt-in per directory and never writes anything:
  missing, empty, unreadable, or a directory named `MEMORY.md` all change nothing. Discovery follows
  Pi's own `AGENTS.md` rules — `<agent-dir>/MEMORY.md` first, then ancestors from the outermost in,
  the working directory's last — and a file reached twice (a symlink, or an agent directory inside
  the searched tree) is injected once. Each run re-reads the files rather than caching them at
  startup, which is what lets an edit made mid-session reach the model on the next prompt as a
  section delta instead of a replaced prompt; a file larger than `PI_MEMORY_MAX_BYTES` (16 KiB by
  default) is cut on a line boundary and says so.

  22 tests cover the scopes and their order, the shape Pi expects (`loadProjectContextFiles` is the
  reference, and one test fails if Pi ever starts loading `MEMORY.md` itself), re-reading between
  runs, deduplication, the skip cases, truncation, and the injected note verbatim.
- The repository's own split, which the package exists to make possible: `AGENTS.md` keeps only the
  section the user wrote, and the commands, rules, layout, and per-extension notes a previous session
  had put in it now live in `MEMORY.md`. From the next session on, both are injected here — the
  user's spec as Pi loads it, these notes as `pi-memory` loads them.

### Changed

- `test/load.test.ts` now expects a package that registers no tools (`pi-memory` is listed with
  `tools: []`), and `docs/adding-an-extension.md` and `docs/testing.md` describe the event-driven
  kind of extension and how to test one.

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

  The exposure was not limited to background jobs. A sidecar is written the moment a command starts,
  foreground calls included, so a nested pi also adopted the command that was running it and killed
  its own parent on exit — `pi -p` inside a `bash` call killed the `bash` call. That self-killing
  loop is where the symptom came from: three verification commands in one session (`pi --no-session
  -p`, `pi --mode rpc`) died at 33s, 0.4s, and 4s, with no timeout anywhere near those limits.
- **Liveness checks no longer count an un-reaped child as running.** A signalled child is a zombie
  until its parent reaps it, and `kill(pid, 0)` succeeds against a zombie, which would have pinned an
  adopted job to "running" (and hidden the bug above from the first regression test).

Six new tests in `packages/pi-bg-tasks/test/cross-process.test.ts` run a second runtime as a real
process against the same agent directory; five of the six fail against the previous implementation,
including the one that guards this bug directly — a nested runtime started by a `bash` call kills
that very call, which the assertion reports as `the nested runtime killed its own parent: Command
terminated by signal SIGTERM`.

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
