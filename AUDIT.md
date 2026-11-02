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
that _mutates_ them reads module-level memory, which does not survive a `/reload`. That is one root cause
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

- `peekHandoff()` copies whatever is in `pending.json` into `pending` _before_ comparing session keys, and
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

---

## Pass 2 — fixer

Started from `b8c6309` (326 green, 14 red). Finished: **344 green, 1 red** — the 13 red tests are green,
and the only failure left is `test/pins.test.ts` (installed pi 1.5.0 vs the repo's 1.4.0 pins), untouched
as instructed. One more pre-existing `npm run check` failure was quietly fixed: `AUDIT.md` as committed was
not biome-clean (`*mutates*` → `_mutates_`), so `npm run lint` was red at the baseline too; `npm run fmt`
normalized it, and it will keep normalizing this file.

### The root cause, fixed once

The module-level `let pending` is gone. **The queue is the file**: `readHandoff()` reads `pending.json` and
nothing caches it, so there is no queue a `/reload` can hide from. That deletes F1 and F2 by construction
rather than by adding a restore to each handler, and it makes every question about the queue cost one small
file read (they are asked a handful of times per event, never in a loop).

On top of it, ownership is explicit (F3):

- `ownedHandoff(ctx)` — the queued handoff, and only when `handoff.sessionKey === sessionKey(ctx)`. A
  foreign one is returned as nothing, untouched. It is now the only way anything reaches the queue: the
  tool, the settle, `input`, `session_shutdown`, and all three commands.
- The mutators are handed the thing they mutate — `claimHandoff(handoff)`, `putHandoffBack(handoff)`,
  `discardHandoff(handoff, reason)` — and each re-reads first: if the file now holds a different `id`, they
  do nothing. A mutator can no longer destroy a handoff that arrived after it was handed one.

F1/F2/F4 were fixed by making the README's guard-rail claims true rather than by rewriting them. The header
comment gained three paragraphs (the chain is one run; the queue is the file; a handoff belongs to the
session that queued it) because those are now the invariants the code is built on.

### Per finding

- **F1, F2** — fixed by the above. The `input` handler and the `quit | resume | fork` branch of
  `session_shutdown` now ask the file through `ownedHandoff(ctx)`. The `input` comment also records why
  `/new` cannot be caught there (Pi dispatches commands before the input handlers), which is what pushes
  that case into F4's reset.
- **F3** — `ownedHandoff` plus the id-guarded mutators. Extra hardening in the same spirit: `queueHandoff`
  pushes whatever is in the file, and if that handoff belongs to another session its prompt is written to
  `discarded-*.md` before it is displaced, because destroying it is not this session's to do silently.
  Covered by a new test in `test/chain-lineage.test.ts`.
- **F4** — `session_start` resets the chain when the reason is `startup` or `new` **and** the session has no
  takeover lineage (`lineageOf(ctx)`), which is the lineage-aware form the direction asked for. Chose not
  to reset on `resume`/`fork`/`reload`: a chain survives a resume of the session it is standing in, and
  `/reload` keeps the queue, so it keeps the count too. This is safe for a launched-and-resumed process
  because the _first_ session of any pi process gets reason `startup` even under `--resume <file>` (recorded
  in `MEMORY.md`).

  Related, and new behaviour of mine: `nextChainPosition(ctx)` now takes the session, and the chain's
  `used` count is `max(chain.json.count, this session's lineage position)`, with `chainId` preferring the
  lineage's id over the file's. Without that, F4's reset and the input-reset give any other session sharing
  the agent dir the power to zero the counter under a session that is mid-chain, and the cap — the loop's
  only brake — could be walked straight through. `test/chain-lineage.test.ts` covers the position, the id,
  and that a user-invoked `/takeover` still starts a chain at 1 whatever the lineage says.
- **F5** — believed the README. `renderSection` adds a chain line: `takeover #N of C allowed in this chain;
  K more will start, then the tool refuses`, a "the cap is reached, finish here and report" variant at the
  cap, and "in a chain with no cap" when `maxChain` is 0 (which is what keeps the `no 0` test honest). Still
  derived only from the lineage entry, so it stays byte-identical across runs of that session; verified in
  the smoke output, where the section reaches a real model call.
- **F6** — `notify(replacement ?? ctx, message, "error")`. `api` is still what _sends_ the fallback prompt,
  because Pi gives `sendUserMessage` to the API and to a replacement context, never to a command context;
  the two targets are now separate variables (`sender` / the notify target) instead of one `target`.
- **F7** — the age check now lives in `ownedHandoff` and announces itself, so every path that finds a stale
  handoff (settle, input, shutdown, the three commands) reports it once and retires it. Chose a UI notice
  only, like the interrupted-run drop next to it, not a message into the session: a queued handoff that has
  sat for an hour is not a reason to start a run.
- **F8** — `MAX_DISCARDED_PROMPTS = 20`, pruned by mtime after every write, whole sweep wrapped in one
  `try` so a vanishing file never costs the newest copy. `pi-bg-tasks`' `MAX_RETAINED_LOGS` was the model,
  with no age rule and no throttle: at ≤ 20 files a scan is free.
- **F9** — kept the tester's `resetModules` calls; added the sharper lesson to `docs/testing.md` ("a test
  that models a `/reload` has to actually reload", with the paired assertion that distinguishes the two:
  delete the file between loads and expect the second load to have forgotten it).
- **F10** — the scrub list moved to `test/helpers/config-env.mjs` (with `config-env.d.mts` beside it:
  `tsc` with no `allowJs` cannot type an imported `.mjs`, and the scripts are plain `node`, so a `.d.mts`
  is the one arrangement that serves both — Node 22 here also cannot import a `.ts` from a `.mjs`).
  `extension.ts` re-exports it, `hermetic-env.ts` imports it directly, and `extension-smoke.mjs` scrubs
  both lists out of the `pi` it spawns, prints `config: …` and `scrubbed from this shell: …` before the run,
  and cleans its temp dirs on `exit`/`SIGINT`/`SIGTERM` (the interrupted run used to leak them).
  Guarded without a process: `test/repo.test.ts` now requires any script that spawns **and** makes a temp
  dir to import the scrub list and to not spread `...process.env`. `scripts/dev.mjs` is deliberately outside
  that rule — it starts the user's own pi, where their configuration is the point.

Verified from this shell (`PI_TAKEOVER_MAX_CHAIN=100` exported by `.bashrc`): the printed config line says
`PI_TAKEOVER_MAX_CHAIN unset`, the lineage entries say `"maxChain":12`, and the tool says
`takeover 1/12`. Also ran the suite hostile:
`PI_TAKEOVER_MAX_CHAIN=100 PI_MEMORY_FILENAME=HOST-NOTES.md PI_BG_TASKS_KEEP_RUNNING=0 npx vitest --run`
→ the same 344 green / 1 pin red, and `ls /tmp` after it is empty of `pi-ext-`/`takeover-`/smoke dirs.

### Decided against

- Re-pinning pi, or touching `test/pins.test.ts`.
- A test that spawns a real `pi` to check the smoke script: the assertion would either be a fixed sleep
  (flaky on a loaded runner) or vacuous if the flow had not finished. The static guard + the manual run
  above is what stands in for it.
- Making the chain expire by age. A chain is now a run, so age barely matters, and a second rule for when a
  counter resets is a second thing to get wrong.
- Letting an `input` in a session that does not own the chain skip the chain reset. The chain is per agent
  dir and has no owner to check; "a human typed something in this pi" is the rule the README states, and the
  queue — the part that can actually be owned — is protected.
- Turning the queue into a list so two sessions can each have a handoff. The state folder has never
  supported that, the README says the queue holds one, and F3's rule is about not destroying what is not
  yours, not about sharing.

### For the next tester

Things that are now true and were not, so they are worth attacking:

1. Every read of the queue goes to disk. A test can write `pending.json` by hand and the extension will
   answer to it in that same load — `sessionKey` is `file:<sessionFile>` or `id:<sessionId>` or the literal
   `session:unknown`; anything that makes two contexts share a key shares a handoff.
2. `claimHandoff`/`putHandoffBack`/`discardHandoff` no-op when the file holds a different `id`. A handoff
   object obtained before something else moved the queue is inert — including inside `applyTakeover`, which
   claims before it confirms, so a `PI_TAKEOVER_CONFIRM` decline re-arms a handoff only if the queue is
   empty or still holding it.
3. `nextChainPosition(ctx)` = `max(file.count, lineage.position) + 1`, `chainId` = lineage's, else the
   file's, else new. A lineage entry with a large `position` therefore raises the count for that session
   only; the file is still what other sessions read, and the tool's advertised position (from
   `nextChainPosition`) and the position written at apply time are computed separately, in two different
   contexts, which may not agree if the session changes between them.
4. The chain reset fires at `session_start` on `startup`/`new` when `lineageOf(ctx)` is undefined. What
   counts as lineage is "the last `custom`/`takeover` entry on `getBranch()` with a numeric `position`" —
   an entry with `position` missing is not lineage, so such a session resets the chain even if it arrived by
   takeover.
5. The expiry notice comes out of `ownedHandoff`, so it fires from `/takeover` with no arguments too, and
   it is UI-only: in `--print`/`--no-session` modes nothing says it at all.
6. `pruneDiscardedPrompts` keeps 20 by mtime and only ever looks at `discarded-*.md`. A file the user puts
   in that folder under a different name is never touched; one named `discarded-x.md` is fair game.
7. The smoke script's own knobs are now scrubbed. Its scenario still re-applies `PI_TAKEOVER_DEBUG` from
   the shell on purpose, and nothing else has a way through — so a smoke run cannot be told to use another
   cap without editing the scenario.
