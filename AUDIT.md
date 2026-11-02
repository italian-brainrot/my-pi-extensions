# AUDIT

Memory of the tester ↔ fixer loop (see `.agents/skills/audit-loop`). Each pass appends; nothing here is
a substitute for reading the code.

Scope of this loop: `packages/pi-takeover`.

---

## Pass 1 — tester

Baseline before the pass: `npm test` → 323 passed, **1 already failing for a reason outside this scope**:
`test/pins.test.ts` says the Pi installed on this machine is 1.5.0 (`~/.pi/agent/install/current-version`)
while the repo typechecks against 1.4.0. Untouched by this pass; whoever re-pins the host packages owns it.
Every claim below about Pi's behaviour was re-read against the installed 1.5.0 sources as well as the
pinned 1.4.0 ones — `newSession` ordering, `InputSource`, `ExtensionMode`, shutdown reasons: unchanged.

After the pass: **326 green, 14 red (13 written here + the pin guard)**. Reproduce with
`npx vitest --run packages/pi-takeover`.

The 13 red tests sit in `test/queue-ownership.test.ts` (6), `test/chain-run.test.ts` (2),
`test/extension.test.ts` (4), `test/handoff.test.ts` (1).

The shape of the pass: the queue and the chain are on disk so that they outlive a `/reload`, but the code
that *mutates* them reads module-level memory, which does not survive a `/reload`. That is one root cause
with three symptoms (F1, F2, F3), and it had survived the suite because the only reload test in the file
never actually reloaded (F9).

### F1 — a `/reload` un-arms the "the user took the wheel" cancel, and the session is replaced anyway

`pi.on("input")` decides whether to cancel a queued handoff from module state alone — `if (pending)` —
while `peekHandoff()` is the only function that consults `pending.json`. After a `/reload` the new module
instance has an empty `pending`, so the typed message resets the chain (that part is file-based) and does
**not** cancel the handoff. Then `agent_settled` — which does go to disk — finds the handoff and applies it.
The result is the exact thing the guard rail exists to prevent: a session replaced under a user who has
just spoken.

README: "A message typed by the user cancels a queued handoff and starts a new chain." `/reload` is
documented as keeping the queue, so queue-plus-reloaded-session is the normal state, not an edge case.

Evidence (a reload modelled with `vi.resetModules()`, same agent dir, same session file):

```
pending exists after reload:               true
pending exists after user input:           true      ← should be false
sent at settle after user cancelled:       [{"content":"/takeover-apply", …}]
```

Red: `test/queue-ownership.test.ts` — "cancels the queued handoff when the user types a message into the
reloaded session" (asserts both halves: the queue is gone, and the next settle sends nothing).

Direction: any handler that mutates the queue has to restore it first, through a helper that also checks
ownership — see F3, because `peekHandoff()` currently caches a foreign handoff, so a bare
`peekHandoff(ctx)` in the `input` handler fixes F1 by introducing a worse bug.

Note for the same reason: `input` never fires for slash commands at all — `agent-session.js` `prompt()`
dispatches extension commands before `_runInputHandlers`, and `interactive-mode.js` intercepts the
built-ins (`/new`, `/resume`, `/quit`, `/reload`) before `prompt()` is reached. So no slash command can
ever be the "human took the wheel" signal; F4's reset is the place to catch `/new`.

### F2 — `/quit`, `/resume` and `/fork` keep the handoff after a reload

Same root cause: `session_shutdown` drops the queue only `if (pending)`. In a module instance that came
back from a `/reload`, the on-disk handoff survives the end of the session it belonged to — for up to
`PENDING_MAX_AGE_MS` (an hour), during which a `/resume` of that session re-applies it.

README: "An interrupted run drops the queued handoff. So does `/quit`, `/resume`, and `/fork`." The
existing green test ("drops a handoff when the session quits, but keeps it across a reload") only proves
it for a session that never reloaded, i.e. for the in-memory case.

Red: `test/queue-ownership.test.ts`, three tests over `reason: quit | resume | fork` — the queue is gone
and the prompt kept its `discarded-*.md` copy.

### F3 — the queue cache is session-blind, so a session can consume a handoff it does not own

Two halves, both in the module-level `pending`:

- `peekHandoff()` copies whatever is in `pending.json` into `pending` *before* comparing session keys, and
  returns `undefined` on a mismatch. So a peek in an unrelated session — a settle there, the `/takeover`
  status command — parks another session's handoff in memory;
- `discardHandoff()` then mutates that memory without asking who owns it: `input`, `session_shutdown`,
  and the age check all discard whatever happens to be cached.

Reachable today (and about to be much more reachable once F1/F2 are fixed the naive way): a handoff
queued by session A is destroyed by a message typed in session B, and B is told "you sent a message".

Red: `test/queue-ownership.test.ts`, "a queue that belongs to someone else" (2 tests: a message in
another session leaves the file alone; a settle in another session neither applies it nor makes it
cancellable). These are also the guard rails the F1/F2 fix has to pass.

Direction: make ownership explicit rather than inferring it from which session is live — e.g. a
`takeOwnedHandoff(ctx)`-style accessor that restores from disk and returns the handoff only when
`handoff.sessionKey === sessionKey(ctx)`, and a `discardHandoff(handoff, reason)` that is handed the thing
it discards instead of reaching for module state. Peeking for reporting (`/takeover` with no args) may
stay session-blind, but it must not hand anything to a mutator.

### F4 — the chain counter has no run: the next process inherits the previous one's

`chain.json` is a counter in the agent dir. The only things that reset it are an interactive message
(`input`) and a user-invoked `/takeover <prompt>`. Nothing else ever starts a chain, and it never expires.
An rpc-driven run — `test/session.test.ts`, `scripts/extension-smoke.mjs`, and every scripted or headless
driver — sends its prompts with `source: "rpc"`, so it never produces either reset. So the cap is not
"takeovers per chain" in the sense the README sells; it is "takeovers per agent dir since a human last
typed something".

Evidence, two runs against one agent dir:

- seeded `chain.json` with `count: 1`, `PI_TAKEOVER_MAX_CHAIN=1`, fresh rpc process, fresh session: the
  model's very first `takeover` call is refused — "this chain already used 1 takeovers and the cap is 1".
  The loop is dead before its first handoff, and only deleting the file revives it.
- same agent dir, cap 100 (my shell's ambient value, see F10), seeded at 12: one rpc prompt ping-ponged
  the chain from 13 to 100 in ~12s, 88 session files. The cap is the only thing that stopped it — which is
  also why `capAnnounced` staying per-session matters while F4 is being fixed.

Red: `test/chain-run.test.ts` — "starts a fresh chain for a session that did not arrive by takeover"
(`session_start` reason `startup`, no lineage → the tool accepts at position 1 of 3) and "starts a fresh
chain for a session the user made with `/new`" (same with reason `new`).
Guard (green, must stay green): "continues the chain of a session that arrived by takeover".

Direction: reset at `session_start` when the incoming session has no takeover lineage, i.e.
`if (event.reason === "startup" || event.reason === "new") resetChainUnlessLineage(ctx)`. This is safe,
and I checked rather than assumed: in `agent-session-runtime.js` `newSession()` runs `options.setup`
before `finishSessionReplacement()` → `rebindSession()` → `bindExtensions()` → the `session_start` emit,
and a probe against a real pi printed
`session_start reason=new branch=["model_change","thinking_level_change","custom:takeover","session_info"]`
— the entry pi-takeover wrote is already visible at that moment, so a lineage-aware reset cannot wipe a
chain mid-flight. `session.test.ts` catches a lineage-blind implementation (the third session must be
`position: 2`, `chain.count === 2`).

### F5 — the `<takeover>` prompt section does not say what the README says it says

`renderSection()` emits two lines: that the session was spawned by a takeover, and the previous session
file. The README promises "its position in the chain, how many takeovers are left before the cap", and
the package header comment for the section is the shorter claim. `TakeoverEntry` carries `position` and
`maxChain`, and the entry renderer shows them — only the model never learns.

Why it matters for this extension specifically: the chain cap is the loop's brake, and an agent in an
unattended loop only finds out it is at the cap by calling `takeover` and being refused. The section is
the one place it could know earlier.

Red: `test/extension.test.ts`, "tells the incoming session where the chain stands" (position 3, cap 12
both present) and "does not mention a cap there when the chain has none" (`maxChain: 0` → the position is
there, no `0`).

Direction: one added line in `renderSection`, worded however you like — the tests assert the numbers, not
the phrasing. It stays byte-identical across runs of that session because it is derived from the entry, so
the cache and the provider-cache argument in the comment keep holding.

### F6 — a takeover that fails says nothing to anyone

The catch in `applyTakeover()` notifies `replacement ?? api`, and `ExtensionAPI` has no `ui` member
(`core/extensions/types.d.ts`; only `ExtensionContext` does), so when no replacement ever existed the
error notification goes nowhere — `target.ui?.notify?.()` is just `undefined`. The user sees a handoff
prompt arrive as a user message with no explanation; the agent reasonably reads it as coming from the user.
In the test harness it is invisible too: the recording Proxy throws on `api.ui` and `notify()` swallows it.

Red: `test/handoff.test.ts`, "tells the session when a takeover failed and the prompt is run in place"
(the outgoing command context's `ui.notify` got a message containing the failure).

Direction: when `replacement` is undefined the outgoing `ctx` is not yet stale (Pi invalidates it on
teardown, which did not happen), so notify `ctx`; when it exists, notify the replacement, as now.

### F7 — a queued handoff can expire in silence

`peekHandoff()` drops anything older than `PENDING_MAX_AGE_MS` and the settle handler then behaves as if
nothing had ever been queued. The agent was told "it applies when this turn ends", and it is a plausible
sequence for a handoff to sit through a reload and an idle hour: the agent stops working, nothing
happens, and no message is ever produced. `discardHandoff()` debug-logs where the prompt went and says
nothing to the session.

Red: `test/extension.test.ts`, "says so when a queued handoff expired instead of being applied" — no apply,
and a notice mentioning the takeover reaches the session's UI.

### F8 — `discarded-*.md` grows without limit

Every drop writes another file into `<agent-dir>/takeover/` and nothing prunes them. For an extension
whose advertised mode is unattended looping, with F1/F2/F4 making drops more likely and `refuseAtCap`
writable from any process sharing the agent dir, the folder only ever grows. `pi-bg-tasks` already solves
the same problem for its own state folder (`MAX_RETAINED_LOGS`); imitate it.

Red: `test/extension.test.ts`, "does not let dropped prompts fill the agent dir" — 40 backdated files plus
one fresh drop leaves at most 30, and the prompt that was just dropped is among what is kept. The cap
number is yours to choose (anything well under 40 passes); the two things the test insists on are that the
folder is bounded and that the newest copy survives.

### F9 — the reload test never reloaded (test defect, fixed in this pass, not a code bug)

`test/extension.test.ts` "finds the queued handoff again after a reload replaces the module" called
`loadExtension` twice without `vi.resetModules()`, so Vitest returned the same module instance: the test
proved that a module-level variable survived a call to a helper. Probe: with the second load the
extension sent `/takeover-apply` **after `pending.json` had been deleted**, which a fresh module could not
do. `docs/testing.md` warns about exactly this in its gotchas.

Fixed in place (`vi.resetModules()` before the second load) and paired with
"forgets a handoff that is no longer on disk", which is what distinguishes a real reload from a cached
one. Both are green now; **do not remove the `resetModules` calls** — without them three of the F1/F2 red
tests silently pass again. `test/queue-ownership.test.ts` and `test/chain-run.test.ts` reset in
`beforeEach` for the same reason.

### F10 — `scripts/extension-smoke.mjs` is not hermetic against the shell (no red test)

The suite scrubs every `PI_*` configuration variable, and `test/env-hermetic.test.ts` guards that. The
smoke script spreads `...process.env` into the `pi` it spawns, so it does not: from this shell
(`.bashrc` exports `PI_TAKEOVER_MAX_CHAIN=100`) a smoke run reported `"maxChain":100` in every lineage
entry and let the scripted chain run to 100. Anyone reading the smoke output learns the wrong thing about
the cap, and a scenario can be silently changed by the shell it was typed in — the failure mode
`docs/testing.md` describes for the suite, still live in the dev tool.

No red test (it would mean spawning a real `pi` inside a test to check a dev script). Direction: move the
scrub list out of `test/helpers/extension.ts` into a plain `.mjs` module both the harness and the scripts
import, apply it in `extension-smoke.mjs`, and print the effective configuration at the top of a run.
