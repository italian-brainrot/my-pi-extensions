# Assistant notes for my-pi-extensions

## Commands

| Command                                 | Use                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `npm run check`                         | Manifest check, typecheck, lint, tests. Run it before declaring work done. |
| `npm test`                              | Vitest suite (spawns real processes; ~30s).                                |
| `npm run typecheck`                     | `tsc --noEmit`.                                                            |
| `npm run fmt` / `npm run lint`          | Biome fixes / Biome check. Biome is the formatter; do not hand-format.     |
| `npm run manifest`                      | Regenerate the root `pi.extensions` list from `packages/*`.                |
| `npm run new -- pi-x --description "…"` | Scaffold a new extension package.                                          |
| `npm run dev`                           | Run Pi with these extensions loaded from source.                           |

## Rules

1. **One package per extension**, named `pi-<thing>`, with `src/index.ts`, `test/`, `README.md`, and a
   `pi.extensions` entry in its own `package.json`. Run `npm run manifest` after adding one.
2. **Pi-provided modules are peers.** `@earendil-works/pi-*` and `typebox` go in `peerDependencies`
   with `"*"`, never in `dependencies` (a bundled copy creates duplicate Pi registries). Versions for
   typechecking live in the root `devDependencies` and must match the installed Pi.
3. **No build step.** Sources are TypeScript, loaded through jiti. Typecheck only.
4. **Tests drive behaviour through registered tools**, using `test/helpers/extension.ts`. Do not
   export internals just to test them, and do not mock the tool layer. An extension that registers no
   tool at all (`pi-memory`) is driven the same way through the lifecycle event it handles: `emit`
   the event and assert on what it changed.
5. **Every behaviour change needs a test** in the owning package. Model-facing text (tool
   descriptions, result text, injected prompt text) is part of the interface: change it deliberately
   and assert it.
6. **READMEs document behaviour**, not code structure: what each tool does, its parameters,
   environment variables, and failure modes. Update the package README and the root table together.
7. **The agent directory is shared by every pi process.** A nested `pi -p`, an RPC session, and a
   `subagent` child all load these extensions against the same `<agent-dir>`. Anything written under
   it must say which process owns it, and must leave entries owned by another live process alone —
   never assume you are the only writer. `pi-bg-tasks` records `ownerPid` in its sidecars for this
   reason (and reads the parent process out of `/proc` for sidecars written before that field
   existed); `adoptJobs` and `pruneRetention` are the places to look. Note that every `bash` call —
   foreground included — has a sidecar while it runs, so the worst case is a nested runtime killing
   the command that launched it; `test/cross-process.test.ts` guards exactly that.
8. **Keep `MEMORY.md` current, and leave `AGENTS.md` to the user.** This file is where a session
   writes what it learned; `AGENTS.md` holds only the sections the user wrote, and a request in it
   not to modify that file is honoured. Write memory notes here as you work — decisions, constraints,
   gotchas, commands, invariants — and prune them; `pi-memory` re-reads this file before every run,
   so what you save reaches the next prompt.

## Layout worth knowing

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
- `pi-memory` registers no tools: it handles `before_agent_start`, appends `<agent-dir>/MEMORY.md`
  and every ancestor `MEMORY.md` to `systemPromptOptions.contextFiles` (which is what renders
  `<project_instructions>` blocks inside `<project_context>`), and is a complete no-op when no such
  file exists. It re-reads the files on every run rather than caching them, so edits land on the next
  prompt as a prompt-section delta. Its injected note is asserted verbatim in
  `test/injection.test.ts`, and one test asserts Pi's own `loadProjectContextFiles` still does not
  return `MEMORY.md` — if that ever changes, the extension has to be rethought, not patched.
- Pi's own section rendering is not exported, so no unit test can assert the final prompt text. The
  cheap end-to-end check is a scratch directory with a canary line in its `MEMORY.md` and
  `pi --no-session -p "quote the line that starts with CANARY… and its path; no tools"`: the line
  comes back with the file's absolute path inside a `project_instructions` block, and the same run
  in a directory with no `MEMORY.md` reports no such block at all — that is the no-op contract.
- All three read configuration at module load, so a second `loadExtension()` in one test file needs
  `vi.resetModules()` first.
