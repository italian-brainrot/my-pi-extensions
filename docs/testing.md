# Testing extensions

The suite runs under Vitest with `pool: "forks"` and `isolate: true`, because extension tests spawn
real processes and load Pi's own runtime. Nothing in the suite needs a model, an API key, or the
network.

```bash
npm test                                  # everything
npx vitest --run packages/pi-bg-tasks    # one package (the `test` script already passes --run)
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
- exposes `tools`, `commands`, `handlers`, `sent`, and `calls` for assertions, plus `modelsSet`,
  `thinkingLevelsSet` and the mutable `modelSet.ok` (what `pi.setModel` answers, which is how a test
  says the host refused a model) for extensions that change the model;
- `callTool(name, params, { signal, onUpdate, context })` runs a registered tool's `execute` with a
  hand-built `ExtensionToolContext`; `context` overrides land on the context, which is how you set
  `model`, `thinkingLevel`, `cwd`, `sessionId`, or `sessionFile`;
- `emit(event)` delivers lifecycle events to the handlers the extension registered, which is how
  reload, adoption, and shutdown behaviour is tested:

  ```ts
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ```
- `runCommand(name, args, context)` runs a registered slash command's handler, and `ext.sent` collects
  what the extension sent back into the session with `pi.sendUserMessage`. `pi-takeover` is the package
  that uses both most: a tool queues work, and a command is the only context Pi lets replace a session
  from, so the queue is tested through the tool and the replacement through the command.
- `dispose()` restores the environment and removes the temp directories.

Options: `{ packageDir, entry, cwd, agentDir, env }`. Reusing `agentDir` across two loads models a
reload: the same on-disk configuration with a fresh runtime.

Two small helpers come with it: `test/helpers/wait.ts` (`waitFor`, `isAlive`) for watching real
processes, and `test/helpers/env.ts` (`withEnv`) for scoping environment variables.

## Driving a real Pi

Unit tests fake the parts Pi would otherwise provide. Where the behaviour _is_ Pi's — a session being
replaced, a system prompt reaching a model, a transcript being written — a faked part proves the shape
of the call and nothing more. `packages/pi-takeover/test/session.test.ts` therefore starts a real
`pi --mode rpc` (the one pinned in `devDependencies`) in a temporary agent dir and working dir, with
`-ne` so nothing outside the test loads, and talks the protocol by hand.

The model is `packages/<package>/test/fixtures/fake-model.ts`: an extension registering a `fake`
provider whose `streamSimple` answers from rules matched against the transcript it was shown, and
appends what every call was shown to `PI_FAKE_LOG`. Rules rather than a turn counter because Pi builds a
fresh extension instance per session, so anything counted in the fixture restarts when a session does.
Reading the log is how a test sees the context of a session it did not start.

The same fixture drives the manual version, which prints the whole flow instead of asserting on it:

```bash
npm run smoke -- pi-takeover
```

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

**Assert on the prompt an extension produces, not on how it built it.** An extension that shapes the
system prompt registers no tool, so the harness's `emit` is the whole interface: fire
`before_agent_start` with the `systemPromptOptions` Pi would pass, and assert on what the handler
left behind. `packages/pi-memory/test/injection.test.ts` is the worked example: which scopes are
injected and in which order, the shape of the section it owns against what Pi's own
`loadProjectContextFiles` returns (and that Pi still does not load `MEMORY.md` itself), deduplication
through a symlink, one read per session and what a session boundary (`session_start`) re-reads, and
where the model-facing note sits relative to the `<memory>` tags. Import prompt text from the
extension instead of copying it into a test: assert the structure that has to hold, so rewording the
text stays a deliberate edit to the extension rather than a test failure.

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
  session (UI dialogs, `executeTool`) are unavailable; `modelRegistry` is a stub whose `find` answers
  for any provider and id, which is enough to look a recorded model up but nothing else. If an
  extension reaches for something missing, the harness throws with instructions: either add a stub to
  the harness or cover that part in a real `pi` session with `npm run dev`.
- **Kill timers are cancelled, but a kill still takes a moment.** `pi-bg-tasks` cancels the timer of
  every wait that returns early and unrefs the SIGTERM→SIGKILL escalation timer, so a finished tool
  call never holds the process open. A worker can still sit until a killed command actually exits.
- **Behaviour that lives per runtime needs a second process.** A cross-session bug — one pi process
  reaching into another's state — cannot be reproduced inside one runtime, because each load has its
  own module registry. Spawn a fixture that loads the same entry in its own process:
  `packages/pi-bg-tasks/test/fixtures/foreign-runtime.mjs` drives `test/cross-process.test.ts`.
- **`kill(pid, 0)` says yes to a zombie.** A signalled child stays in the process table until its
  parent reaps it, and killing a zombie succeeds. So a liveness assertion can pass on a command that
  was already killed. `isAlive` in `test/helpers/wait.ts` reads `/proc/<pid>/stat` and treats `Z` as
  finished (the extension does the same). Run helper processes with `spawn` + await `close`, not
  `spawnSync`: `spawnSync` blocks this runtime's event loop, its children are not reaped, and every
  killed job looks alive.
- **Timings are assertions too.** Prefer `waitFor` polling to fixed sleeps, and give timing-based
  assertions (the blocking mutex test) a margin wide enough for a loaded CI runner.
- **RPC commands are not serialised.** `pi --mode rpc` starts each line it reads as its own async
  handler, so a command that awaits (like `set_model`, which checks credentials) can finish after the
  one sent right after it. Send the next command when the answer to the previous one arrives —
  `packages/pi-takeover/test/session.test.ts` waits for each id before it prompts.
- **Do not add a build step.** Sources are TypeScript loaded through jiti; Vitest transforms them for
  tests. `tsc --noEmit` is the only compiler in the loop.
