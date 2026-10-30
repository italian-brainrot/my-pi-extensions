# Notes

What this file is: how the system works where `AGENTS.md` and the code stop. Present tense, no dates,
no record of what a session did. `docs/adding-an-extension.md`, `docs/testing.md`, and each package's
README carry the conventions, the prompt-section rules, and the test harness — they are not repeated
here, and anything they already say does not belong in this file either.

## Pi runtime, beyond its own docs

Pi 1.4.0 behaviour that its own docs do not state — read out of the installed sources or watched in a
real session, not assumed.

- The loader caches extension modules by cwd (`loadExtensionsCached`). `clearExtensionCache()` — run by
  `resourceLoader.reload()`, which is what `/reload` does, or by a cwd change — is the only thing that
  discards them, and jiti itself runs with `moduleCache: false`. So a session replacement (`newSession`,
  `fork`, `switchSession`) keeps the same module instance and its top-level state and re-binds the
  existing handlers to the new session (`AgentSession.bindExtensions` is what emits `session_start`);
  only `/reload` re-runs the factories. Module state is per-process, not per-session: anything that must
  survive a reload, or be scoped to one session, goes on disk (`<agent-dir>/<package>/`) or into a
  session custom entry.
- Pi never loads the copies of `typebox` and `@earendil-works/*` that sit in a package's own
  `node_modules`: `getAliases` in `pi-coding-agent/dist/core/extensions/loader.js` rewrites those specifiers
  (and the legacy `@mariozechner/*` ones) to paths resolved out of Pi's tree, and Pi pins them exactly. So
  the versions in this repo's `node_modules` only ever reach `tsc` and Vitest, and a bump there changes what
  the types claim, never what an extension runs. jiti is not aliased — it is the compiler Pi loads our
  source with, and the same exact-pin rule applies because `foreign-runtime.mjs` imitates that loader.
- A `ctx` is bound to the session that built it. `runtime.invalidate()` marks it stale during session
  replacement and `reload()`, and its getters then throw the `assertActive` error — including inside a
  template literal in a debug line that would never have printed. Read what you need from the old ctx
  before `newSession()`/`fork()`/`switchSession()`/`reload()`; afterwards use the context handed to
  `withSession`.
- Pi creates one `AbortController` per agent run (`Agent.runWithLifecycle`) and passes that signal to
  every tool call in the run. An `abort` listener therefore outlives the call that installed it and
  fires on an unrelated Escape later in the same run. Remove every listener in the `finally` of the
  call that installed it.
- A tool result reaches the model only through `content`. `details` and `structuredContent` go to the
  UI and nothing else, so anything the model must see is in `content`, and whatever goes there needs
  its own cap; the full payload belongs in `details`.
- A custom entry appended in `newSession({ setup })` is visible through `getBranch()` in the new
  session's first `before_agent_start`. That is how pi-takeover's `<takeover>` prompt section survives
  a reload or resume without any state in the process. In the `TranscriptContext` a provider sees, the
  system message carries `sections` and empty `content`, so a scripted model tests
  `message.sections.takeover` rather than the text.
- `setModel` and `setThinkingLevel` are on the extension API, not on any context, and a replacement
  session starts from the model in settings — a model the agent chose is session-scoped and lost. The
  change has to come from an extension handler running in the incoming session: pi-takeover writes
  `{provider, id, thinkingLevel}` into the lineage entry and applies it at `session_start` with
  `reason === "new"`. That event is emitted by `AgentSession.bindExtensions`, before
  `finishSessionReplacement` runs `rebindSession` and `withSession`, so the model is already right when
  the handoff prompt is sent. Get the `Model` with `ctx.modelRegistry.find(provider, id)`. Guard on the
  reason: on a resume the session's own later choice must win.

## MEMORY.md itself

pi-memory renders this file once per session and re-renders only at a session boundary, so an edit here
is visible to the next session and never to the one that made it. A line in this file is therefore never
evidence of what the code does now — go and read the code.

Deletion is the normal edit. A line that duplicates the code, a README, or `docs/` costs prompt space in
every session and buys nothing, and a line that has stopped being true is worse than no line.
