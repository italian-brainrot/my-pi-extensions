# Assistant notes for my-pi-extensions

## Layout

- `packages/<name>/src/index.ts` — the extension. Single file is fine; split when a file grows past
  ~700 lines and you have tests that make the split safe.
- `test/helpers/extension.ts` — `loadExtension` gives a recording `ExtensionAPI`, a temp agent dir, a
  temp cwd, `callTool`, and `emit` for lifecycle events. New `pi.*` members an extension reaches for
  must be added there, with a comment about why.
- `test/load.test.ts` loads every package through Pi's own loader; `test/repo.test.ts` enforces
  packaging conventions. If you change packaging, expect to update those.
- Extensions keep state on disk under `<agent-dir>/bg-tasks` (see `pi-bg-tasks`); tests point
  `PI_CODING_AGENT_DIR` at a temp directory.
- `AGENTS.md` (user-owned, injected by Pi) and `MEMORY.md` (assistant-owned, injected by `pi-memory`)
  sit at the repository root; both are committed, and a session in this checkout sees them in that
  order.

## Notes on the extensions

- `pi-bg-tasks` **replaces the built-in `bash` tool**; its tests spawn real processes. Timing
  assertions need margin for CI.
- `pi-bg-tasks` keeps a per-runtime job registry, and a command outlives the call that started it, so
  the shutdown contract matters twice over: a real kill must be observable through `bg_wait`,
  `bg_stop`, the log, and the process table; a session swap (`/new`, `/resume`, `/fork`) must leave
  running commands running; and a session swap must not leave two lifetimes of cleanup racing over
  the same command (the SIGTERM grace timer is deliberately ref'd, and the next `session_start`
  cancels a pending kill). `test/lifecycle.test.ts` covers all three.
- `pi-subagent` spawns a nested `pi`; tests use `test/fixtures/fake-pi.mjs` and override
  `process.argv[1]` through `withPiArgv`.
- `pi-memory` registers no tools: it handles `before_agent_start` and writes the `MEMORY.md` it finds
  (`<agent-dir>` plus every ancestor) into `systemPromptOptions.sections.assistant_memory`, which Pi
  renders as its own section (last, after `<cwd>`) holding one `<memory path="…">` block per file,
  with `MEMORY_NOTE` as the section's lead-in line outside those tags. Never `contextFiles`: that
  would put the notes in the `<project_instructions>` tag holding the user's `AGENTS.md`. The section
  is rewritten every run and deleted when a run finds nothing, so a file emptied or deleted
  mid-session stops being injected, and a no-op run touches no prompt options at all. Files are
  re-read every run, so an edit lands as a delta of that section alone. One test asserts Pi's own
  `loadProjectContextFiles` still does not return `MEMORY.md` — if that ever changes, the extension
  has to be rethought, not patched. `test/injection.test.ts` imports `MEMORY_NOTE` and `SECTION_NAME`
  from `src/index.ts`: keep prompt wording out of the test file, assert placement instead.
- The cheap end-to-end check is a scratch directory with a canary line in its `MEMORY.md` and
  `pi --no-session -e ./packages/pi-memory/src/index.ts -p "print verbatim every part of your system
  prompt between and including the tags whose name contains memory or instructions; no tools"`: the
  `<assistant_memory>` section comes back with the note ahead of a `<memory path="/abs/MEMORY.md">`
  block, `<project_instructions>` holds only `AGENTS.md`, and the same run in a directory with no
  `MEMORY.md` reports no memory section at all — that is the no-op contract. Pi's section rendering
  is not exported, so no unit test can assert the final prompt text.
- All three read configuration at module load, so a second `loadExtension()` in one test file needs
  `vi.resetModules()` first.
