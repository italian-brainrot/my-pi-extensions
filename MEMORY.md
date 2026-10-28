# Assistant notes for my-pi-extensions

## Layout

- `packages/<name>/src/index.ts` — the extension. Single file is fine; split when a file grows past
  ~700 lines and you have tests that make the split safe.
- `test/helpers/extension.ts` — `loadExtension` gives a recording `ExtensionAPI`, a temp agent dir, a
  temp cwd, `callTool`, and `emit` for lifecycle events. New `pi.*` members an extension reaches for
  must be added there, with a comment about why.
- `test/load.test.ts` loads every package through Pi's own loader and asserts the tools and lifecycle
  events each registers; `test/repo.test.ts` enforces packaging conventions. If you change packaging,
  expect to update those.
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
  running commands running; and a session swap must not leave two lifetimes of cleanup racing over the
  same command (the SIGTERM grace timer is deliberately ref'd, and the next `session_start` cancels a
  pending kill). `test/lifecycle.test.ts` covers all three.
- `pi-subagent` spawns a nested `pi`; tests use `test/fixtures/fake-pi.mjs` and override
  `process.argv[1]` through `withPiArgv`.
- `pi-memory` registers no tools: it handles `before_agent_start` (write the `MEMORY.md` it finds —
  `<agent-dir>` plus every ancestor — into `systemPromptOptions.sections.assistant_memory`, which Pi
  renders as its own section, last, after `<cwd>`, holding one `<memory path="…">` block per file with
  `MEMORY_NOTE` as the section's lead-in line outside those tags) and `session_start` (forget that
  session's rendering, so its next run re-reads the files). Never `contextFiles`: those render as
  `<project_instructions>`, and the assistant's notes would sit in the same tag as the user's
  `AGENTS.md`. **A section is read once per session.** Pi patches a section whose text changed, which
  replays new text ahead of the messages that already followed it and breaks the provider's prompt
  cache, and it makes an edit the assistant already made look like new information; so re-rendering on
  every run is the bug this shape avoids. `test/injection.test.ts` keeps runs in one file as separate
  sessions unless a test names the session it is continuing, which is how the per-session contract and
  the eviction of remembered sessions are exercised. Keeping the Pi-side `[Context]` startup listing
  honest about `MEMORY.md` would mean patching Pi's resource loader to load it; that is out of scope —
  do not reach into a runtime you were only handed.
- All three read configuration at module load, so a second `loadExtension()` in one test file needs
  `vi.resetModules()` first.

## Checking prompt behaviour for real

The cheap end-to-end check is a scratch directory with a canary line in its `MEMORY.md` and
`pi --no-session -e ./packages/pi-memory/src/index.ts -p "print verbatim every part of your system
prompt between and including the tags whose name contains memory or instructions; no tools"`: the
`<assistant_memory>` section comes back with the note ahead of a `<memory path="/abs/MEMORY.md">`
block, `<project_instructions>` holds only `AGENTS.md`, and the same run in a directory with no
`MEMORY.md` reports no memory section at all — that is the no-op contract. Pi's own
`loadProjectContextFiles` does not return `MEMORY.md`, and if that ever changes the extension has to be
rethought, not patched. Pi's section rendering is not exported, so no unit test can assert the final
prompt text.
