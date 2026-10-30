# Notes

## pi-takeover (2026-10-29)

The agent calls `takeover` with a handoff prompt; the session is replaced at `agent_settled` and a fresh
agent starts from that prompt alone. One live session at a time, which is what the KV cache allows.

Pi facts that took digging, in case the extension has to change:

- `newSession()`, `fork`, `switchSession`, `waitForIdle` exist only on the **command** context. A tool's
  `execute` gets `ExtensionToolContext` and cannot reach them. The bridge is
  `pi.sendUserMessage("/my-command", { expandPromptTemplates: true })`: Pi runs a leading-`/` message as
  the extension command, and from inside `agent_settled` it defers the send until the settle boundary has
  closed, which is what makes that boundary the safe place to replace a session.
- Extension modules are re-evaluated for every session (`moduleCache: false` in the loader). Module-level
  state does not cross a session replacement, and neither does anything a test fixture counts. What has
  to survive goes on disk (`<agent-dir>/takeover/`) or into a session custom entry.
- `ctx` belongs to the session it was built for. After `ctx.newSession()` its getters throw
  `assertActive` — including inside a template literal that a debug log would not have printed. Read
  everything needed before the call; afterwards only the `withSession` context is usable.
- A custom entry appended in `newSession({ setup })` is visible through `getBranch()` in the new session's
  first `before_agent_start`. That is how the `<takeover>` prompt section survives a reload or a resume
  without keeping any state in the process.
- In the `TranscriptContext` a provider sees, the system message carries `sections`; its `content` is
  empty. A scripted model checks `message.sections.takeover`.
- Replacing a session does not disturb `pi-bg-tasks` jobs: shutdown reason is `new`, and those survive
  everything but `quit`.
- A replacement session picks its model from settings, so a model the agent switched to (session-scoped,
  like everything Pi's `/model` does) is lost. `setModel`/`setThinkingLevel` are on the **API**, not on
  any ctx, so only the incoming session's own extension instance can apply them: the outgoing one records
  `{provider, id, thinkingLevel}` in the lineage entry, and the new session reads it at its `session_start`
  with `reason: "new"`. That event fires before `withSession` runs (rebindSession → bindExtensions), so the
  model is right before the handoff prompt is sent. `ctx.modelRegistry.find(provider, id)` gives the Model.
  Guard on `reason === "new"`: on a resume, the session's own later choice has to win.
- In `--mode rpc` each stdin line starts its own async handler, so a slow command (`set_model` checks auth)
  can finish after the one sent after it. Wait for each reply before sending the next.

Tests: `npx vitest --run packages/pi-takeover` (the `test` script already passes `--run`, so
`npm run test -- --run …` duplicates the flag and vitest refuses). `test/session.test.ts` drives the real
`node_modules/.bin/pi --mode rpc` with `test/fixtures/fake-model.ts`, which answers from rules matched
against the transcript it is shown and logs what every call was given. `npm run smoke -- pi-takeover`
prints the same flow for reading rather than asserting.

## pi-bg-tasks (2026-10-30)

`bash` gains `timeout` and auto-backgrounds at it; `bg_wait` waits for any task and then answers with a
table of every background task of the session: status, run time, lines/chars, exit code, log path.

Pi facts worth keeping:

- Pi makes **one AbortSignal per agent run** (`runWithLifecycle`'s controller) and hands it to every tool
  call in that run. An `abort` listener outlives the call that added it, which is how a command that had
  been deliberately released to the background got killed by an unrelated Escape later in the same run.
  Every listener this extension installs is removed in the `finally` of the call that installed it.
- `details` and `structuredContent` never reach the model, only `content` does. So the task table is capped
  for the model (30 newest) while `details.tasks` carries all of them.
- Output size is read from the log, never tracked in memory: newline bytes (exact, because 0x0A cannot
  appear inside a UTF-8 sequence) plus `StringDecoder` for characters, cached per job on size+mtimeMs, and
  marked `>=` past the 16 MB scan cap. Line counting matches `truncateTail`'s: a final line with no newline
  counts as a line.
- A job is a _background task_ (`job.backgrounded`) once it was spawned with `timeout: 0`, released at the
  timeout, or adopted. Foreground commands live in the same registry so they can still be killed, but their
  logs are deleted when they finish, so listing them would be noise.

Tests: `test/wait-listing.test.ts` reloads the extension per test (`vi.resetModules()`), because the listing
is exactly the module-level registry, and a shared runtime would leak earlier tests' tasks into it.

## web-browsing skill (2026-10-30)

`skills/web-browsing/` — `scripts/web.sh` (search / read / eval / shot) and `scripts/browse.mjs` (multi-step
over CDP). The root manifest now declares `pi.skills: ["./skills"]`, which the already-installed repo package
picks up for every session; `~/.local/bin/obscura` symlinks `~/Apps/obscura/obscura`. Check discovery without
a model: `pi --mode rpc` then `{"type":"get_commands"}` → `skill:web-browsing`. `test/skills.test.ts` runs Pi's
own skill loader over `skills/` and checks each script parses, prints usage, and fails without its binary;
`npm run manifest` keeps `pi.skills` honest.

Obscura 0.2.5, verified rather than assumed:

- `fetch --dump markdown|text|links|html|cookies|assets`; `--dump original` is the raw body and skips the
  browser (JSON/API/files); `--eval` prints the JSON-encoded result of a JS expression; `-s` PNG; `-o` file;
  `-q` no banner. Navigation failure exits 1, an HTTP 404 exits 0. `--wait S` is a **fixed** delay, so leave
  it unset to get the adaptive settle.
- DuckDuckGo answers a headless fetch: `lite.duckduckgo.com/lite/?q=` with `a.result-link` (snippet is the
  next `<tr>`, the real URL is the `uddg` query param), `html.duckduckgo.com/html/?q=` with `a.result__a`.
  Mojeek returned nothing. `docs.obscura.sh` routinely times out.
- CDP: connect to the **browser** endpoint, then `Target.createTarget` + `Target.attachToTarget {flatten:true}`
  and send every later call with that `sessionId`; a direct `/devtools/page/<id>` socket answers
  "No page for session". The page target is destroyed when the connection closes, `Network.setCookies` /
  `Storage.setCookies` are accepted but do nothing, and `--storage-dir` wrote no files — so DOM and cookies
  live exactly one connection, which is why `browse.mjs` takes a whole flow per call.
- `LP.getMarkdown` does DOM → markdown; `Page.captureScreenshot` returns base64 PNG; `Input.dispatchMouseEvent`
  needs coordinates from `DOM.getBoxModel` on a `Runtime.evaluate` object id, and JS `el.click()` is a fine
  fallback. `serve` never exits on idle: `browse.mjs stop` kills the pid it recorded.
- Pi's own module cache is irrelevant here, but note a shell gotcha when cleaning up: `pkill -f "obscura serve"`
  matches the shell running it. Use `pkill -f "obscura[ ]serve"`.
