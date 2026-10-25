# Working in this repository

This is a monorepo of my [Pi](https://pi.dev) extensions. Each extension is a package under
`packages/`, and the repository itself is also a Pi package: the root `package.json` lists every
extension entry so one install loads the set.

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
   export internals just to test them, and do not mock the tool layer.
5. **Every behaviour change needs a test** in the owning package. Model-facing text (tool
   descriptions, result text) is part of the interface: change it deliberately and assert it.
6. **READMEs document behaviour**, not code structure: what each tool does, its parameters,
   environment variables, and failure modes. Update the package README and the root table together.
7. **Do not publish.** Packages stay `private: true` until there is an npm scope and a publish
   workflow.
8. **Do not touch my personal Pi configuration** (`~/.pi/agent/settings.json`,
   `~/.pi/agent/extensions/`) unless I ask. Development runs through `npm run dev`.

## Layout worth knowing

- `packages/<name>/src/index.ts` — the extension. Single file is fine; split when a file grows past
  ~700 lines and you have tests that make the split safe.
- `test/helpers/extension.ts` — `loadExtension` gives a recording `ExtensionAPI`, a temp agent dir, a
  temp cwd, `callTool`, and `emit` for lifecycle events. New `pi.*` members an extension reaches for
  must be added there, with a comment about why.
- `test/load.test.ts` loads every package through Pi's own loader; `test/repo.test.ts` enforces
  packaging conventions. If you change packaging, expect to update those.
- Extensions keep state on disk under `<agent-dir>/bg-tasks` (see `pi-bg-tasks`); tests point
  `PI_CODING_AGENT_DIR` at a temp directory, so nothing of mine is touched by the suite.

## Notes on the extensions

- `pi-bg-tasks` **replaces the built-in `bash` tool**; its tests spawn real processes. Timing
  assertions need margin for CI.
- `pi-subagent` spawns a nested `pi`; tests use `test/fixtures/fake-pi.mjs` and override
  `process.argv[1]` through `withPiArgv`.
- Both read configuration at module load, so a second `loadExtension()` in one test file needs
  `vi.resetModules()` first.

## How they reach my sessions

This repository is installed in my personal Pi settings as a local package (`pi install .`, visible in
`pi list`), so editing a file here and running `/reload` is enough. The copies that used to sit in
`~/.pi/agent/extensions/` were retired to `~/.pi/agent/retired-extensions-2026-10-25/` on 2026-10-25.
Do not put files back there: they would load alongside the package and claim the `bash` tool twice.
