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

Tests: `npm run test -- --run packages/pi-takeover`. `test/session.test.ts` drives the real
`node_modules/.bin/pi --mode rpc` with `test/fixtures/fake-model.ts`, which answers from rules matched
against the transcript it is shown and logs what every call was given. `npm run smoke -- pi-takeover`
prints the same flow for reading rather than asserting.
