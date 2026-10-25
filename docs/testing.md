# Testing extensions

The suite runs under Vitest with `pool: "forks"` and `isolate: true`, because extension tests spawn
real processes and load Pi's own runtime. Nothing in the suite needs a model, an API key, or the
network.

```bash
npm test                                  # everything
npm run test -- --run packages/pi-bg-tasks
npm run test:watch
```

## What the harness does

`test/helpers/extension.ts` exports `loadExtension`, which is how every package test starts:

```ts
import { loadExtension, packageDir, type LoadedExtension } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterAll(() => ext?.dispose());
```

`loadExtension`:

- points `PI_CODING_AGENT_DIR` at a **temp agent dir** before importing, so anything the extension
  derives from `getAgentDir()` (log directories, settings lookups) is inside the test;
- imports the package entry point and calls its factory with a **recording `ExtensionAPI`** built on
  a Proxy: `registerTool`, `on`, `registerCommand`, and friends are captured, and any other member
  throws with a message telling you to add it to the harness, so tests never silently skip a code
  path the extension added;
- exposes `tools`, `handlers`, and `calls` for assertions;
- `callTool(name, params, { signal, onUpdate, context })` runs a registered tool's `execute` with a
  hand-built `ExtensionToolContext`; `context` overrides land on the context, which is how you set
  `model`, `thinkingLevel`, `cwd`, `sessionId`, or `sessionFile`;
- `emit(event)` delivers lifecycle events to the handlers the extension registered, which is how
  reload, adoption, and shutdown behaviour is tested:

  ```ts
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ```
- `dispose()` restores the environment and removes the temp directories.

Options: `{ packageDir, entry, cwd, agentDir, env }`. Reusing `agentDir` across two loads models a
reload: the same on-disk configuration with a fresh runtime.

Two small helpers come with it: `test/helpers/wait.ts` (`waitFor`, `isAlive`) for watching real
processes, and `test/helpers/env.ts` (`withEnv`) for scoping environment variables.

## Repo-level tests

- `test/load.test.ts` loads every package through Pi's own `discoverAndLoadExtensions`, which
  resolves the package manifest and compiles the source with jiti. It asserts no load errors, no
  load warnings, and the exact tool set. This is what catches packaging mistakes that unit tests
  cannot see.
- `test/repo.test.ts` checks packaging and repository conventions: names, `pi.extensions` entries,
  peer-only host packages, READMEs, test presence, and root-manifest sync.

## Patterns that work

**Drive behaviour through the tool, not through internals.** `bash`, `bg_stop`, `bg_wait`, and
`subagent` are what the model sees; testing them keeps refactors free. That is why the extensions are
still single-file modules: the tests pin behaviour first.

**Real processes are the point.** `pi-bg-tasks` tests spawn real `sleep` and `seq` commands, assert
that a backgrounded pid is alive, stop it, and then poll with `waitFor(() => !isAlive(pid), …)`. Keep
the sleeps short and always clean up: end each test by stopping what it started, or emit
`{ type: "session_shutdown", reason: "quit" }` in `afterAll`.

**Stub an external CLI with a fixture.** `pi-subagent` spawns `pi`, so
`packages/pi-subagent/test/fixtures/fake-pi.mjs` stands in for it: it speaks the slice of
`pi --mode json` the extension parses and writes what it was invoked with into a temp directory the
test reads back. The extension finds its entry point through `process.argv[1]`, so tests wrap the
call in `withPiArgv(fakePi, …)`.

**Assert on cost and usage numbers where they are the feature.** The subagent's value is that token
and cost totals from a nested process reach Pi's session accounting, so the tests assert sums,
per-component costs, and that context size is the largest single response rather than the sum.

## Gotchas

- **Vitest caches modules per test file.** An extension that reads configuration at module load
  (job registries, log directories, `PI_SUBAGENT_MAX_DEPTH`) needs `vi.resetModules()` before a
  second `loadExtension()` in the same file, otherwise the second load reuses the first load's
  module state and environment.
- **Environment is process-wide.** Load options set `process.env` before import and restore it in
  `dispose()`. Do not rely on env changes made after a load to affect module-level constants.
- **The tool context is not Pi's.** The harness builds a context object, so features that need a real
  session (UI dialogs, `executeTool`, `modelRegistry`) are unavailable. If an extension reaches for
  them, the harness throws with instructions: either add a stub to the harness or cover that part in a
  real `pi` session with `npm run dev`.
- **Kill timers keep the process alive.** `pi-bg-tasks` deliberately does not unref its SIGTERM grace
  timer, so a worker can sit for a few seconds after stopping a job. Vitest's teardown allows it.
- **Timings are assertions too.** Prefer `waitFor` polling to fixed sleeps, and give timing-based
  assertions (the blocking mutex test) a margin wide enough for a loaded CI runner.
- **Do not add a build step.** Sources are TypeScript loaded through jiti; Vitest transforms them for
  tests. `tsc --noEmit` is the only compiler in the loop.
