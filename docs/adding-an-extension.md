# Adding an extension

## 1. Scaffold it

```bash
npm run new -- pi-wordcount --description "Count words in the files a session touched"
```

That creates `packages/pi-wordcount/` with a `package.json` (Pi manifest, peer dependencies, npm
metadata), `src/index.ts`, `test/extension.test.ts`, and `README.md`, then rewrites the root
manifest. Add the new package to the table in the root README.

## 2. Write the extension

An extension is a module with a default export that receives the Pi extension API:

```ts
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wordcount",
    label: "Word count",
    description: "Count words in a file. Describe what the model should expect back.",
    parameters: Type.Object({ path: Type.String({ description: "File to count" }) }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path } = params as { path: string };
      return { content: [{ type: "text", text: `…${path}` }], details: { path } };
    },
  });

  pi.on("session_start", () => {
    /* start session-scoped work here */
  });

  pi.on("session_shutdown", async () => {
    /* stop it here; the handler must be idempotent */
  });
}
```

Rules worth keeping, from Pi's own [extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):

- An extension does not have to register anything visible. Handling `before_agent_start` and editing
  `event.systemPromptOptions` — `sections`, `promptGuidelines`, `contextFiles` — is a complete
  extension; that is how `pi-memory` adds a memory file to the prompt. Edit the structured options
  rather than returning a replacement `systemPrompt`, so Pi can diff the sections and append a
  transcript delta instead of rewriting the prompt for every run.

- `contextFiles` always render as `<project_instructions path="…">` inside `<project_context>`, which
  is what Pi loads `AGENTS.md` into. Text that should carry its own tag goes in `sections`, which Pi
  wraps in `<name>…</name>` and places after the built-in sections; the name must match
  `/^[a-z][a-z0-9_-]*$/` and is shared with every other extension, so own it and rewrite it on every
  run rather than appending to it.

- A section Pi sees as changed becomes a transcript delta: the new text is replayed ahead of the
  messages that already followed it, and the provider's prompt cache breaks from there down. So decide
  when a section is allowed to change, and hold it still the rest of the way. `pi-memory` renders its
  section once per session and re-renders it only at a session boundary (`session_start`), because
  Pi re-reads `AGENTS.md` on `/reload` but never between two runs of one session.

- Not every context can do everything. A tool's `execute` gets an `ExtensionToolContext`; waiting for
  the agent, starting a new session, forking, switching sessions, and `/reload` belong to the
  `ExtensionCommandContext` Pi hands to command handlers. A tool that needs one of those reaches it by
  queueing work and dispatching an extension command at a safe boundary — `pi.sendUserMessage("/my-command", {
  expandPromptTemplates: true })` from an event handler, which Pi runs as the command. A captured `pi`
  or context also goes stale the moment the session is replaced; use the context a replacement hands
  back, and read anything you will need from the old one before the call. `pi-takeover` is the example.

- Do not start processes, timers, watchers, or sockets in the factory. Some Pi invocations load
  extensions without starting a session. Start them from `session_start` or from the tool that
  needs them, and clean up in `session_shutdown`.
- `/reload` replaces the runtime: module state is gone, so anything that must survive a reload
  belongs on disk (`<agent-dir>/<package-name>/…` is the pattern `pi-bg-tasks` uses). A handler
  must not reuse state captured before `await ctx.reload()`.
- Model-facing text is an interface. Descriptions, parameter descriptions, and result text are what
  the model reads; keep them accurate and put the details there rather than in a chat reply.
- Anything that can be configured should read one clearly named environment variable or settings
  key, documented in the package README.

## 3. Conventions every package follows

`npm test` enforces most of these (`test/repo.test.ts`), and `npm run manifest` enforces the
manifest entry.

| Rule                                                                                  | Why                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package name matches its directory and starts with `pi-`.                             | Predictable install paths, and the root manifest is generated from the directory.                                                                                             |
| `"pi": { "extensions": ["./src/index.ts"] }` in the package manifest.                 | Lets the package be installed on its own, and lets tests load it the way Pi does.                                                                                             |
| Every entry file exists and is listed in the root manifest.                           | `pi install <repo>` loads everything, or nothing.                                                                                                                             |
| Host packages (`@earendil-works/pi-*`, `typebox`) are `peerDependencies: "*"` only.   | A physical copy bypasses Pi's module mapping and creates duplicate registries and classes. Pi warns about it. Pin the version in the root `devDependencies` for typechecking. |
| `files: ["src", "README.md"]`, `keywords` include `pi-package`, `pi-extension`, `pi`. | Correct tarball, gallery discovery.                                                                                                                                           |
| `private: true` until publishing is real.                                             | Nothing reaches npm by accident.                                                                                                                                              |
| A README with install, usage, and a configuration table.                              | Documented behaviour is the contract.                                                                                                                                         |
| At least one test under `test/`, driven through the shared harness.                   | Behaviour, not implementation.                                                                                                                                                |
| Tool names do not collide with another package in this repo.                          | Pi reports a collision instead of silently replacing a tool.                                                                                                                  |

## 4. Test it

Add tests next to the package, using the harness — see [docs/testing.md](./testing.md). The short
version:

```ts
import { loadExtension, packageDir } from "../../../test/helpers/extension.ts";

const ext = await loadExtension({ packageDir: packageDir("pi-wordcount") });
const result = await ext.callTool("wordcount", { path: "README.md" });
```

The harness gives each test file a fresh module instance, a temp agent dir, and a temp working
directory, so an extension that writes files or spawns processes is tested against real files and
real processes. Only the model is missing.

Then add the package to `EXPECTED` in `test/load.test.ts` — the tools and lifecycle events it
registers. That file asserts what Pi sees when it loads the repository, so a new package without an
entry fails with a message saying exactly what to add. An extension that adds no tools (`pi-memory`
changes the system prompt instead) is listed with `tools: []`.

## 5. Verify

```bash
npm run check          # manifest --check, typecheck, lint, tests
npm run dev            # load it in a real pi session, then /reload after edits
npm run smoke          # drive it with a scripted model against a real pi, and print the result
```

`npm run smoke` needs a scenario in `scripts/extension-smoke.mjs` and a `test/fixtures/fake-model.ts`
in the package. Writing them is worth it for any extension whose behaviour depends on Pi's own
lifecycle — sessions, prompts, the system prompt — rather than on what the tool returns.

`npm run check` failing is a normal part of the loop: Biome reformats, `npm run fmt` fixes files, and
the manifest script rewrites the root list when you add a package.

## 6. Install it for real

```bash
pi install .                       # whole repository
pi install ./packages/pi-wordcount # just this package
```

Then `pi list` to confirm, and `/reload` (or a new session) to load it.
