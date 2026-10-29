# pi-takeover

End the running agent, and start a fresh one whose entire context is the prompt the old one wrote.

Only one conversation fits in the KV cache at a time, so autonomy cannot come from running agents side
by side. It comes from replacing them. The `takeover` tool takes one argument — the handoff prompt — and
when the current turn ends, the session is replaced by a new agent that starts from that prompt and
nothing else. An implementer hands to a reviewer, the reviewer hands back, and the loop runs to
"nothing is blocking" with exactly one live session the whole time.

## Install

From this repository (loads every extension in it):

```bash
pi install .
```

Only this package:

```bash
pi install ./packages/pi-takeover
```

Try it for one run, without touching settings:

```bash
pi -e ./packages/pi-takeover/src/index.ts
```

## Usage

```
> Implement the fix in <desc>. When it is done, call takeover with a handoff prompt for a reviewer
  who has to decide whether to merge.
```

The agent calls `takeover` with a self-contained prompt, finishes its turn, and the replacement
happens by itself. It can also be driven from the keyboard:

| Command              | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `/takeover <prompt>` | Replace this session now with a fresh agent on that prompt               |
| `/takeover`          | Report the queue, the chain, and whether this session arrived by handoff |
| `/takeover-cancel`   | Discard a handoff the tool queued                                        |
| `/takeover-apply`    | Internal: the step the tool triggers when a turn ends                    |

The tool **queues**; it does not interrupt. Pi replaces a session cleanly at the point where a run has
settled, so the handoff lands after the agent has said what it wanted to say and never between a tool
call and its result. The tool's own result tells the agent exactly that: finish the turn, do not start
new work.

## What the new agent gets

- the handoff prompt as its first message, verbatim;
- the model and thinking level the session it replaced was running on, including one that agent had
  switched to for itself;
- a `<takeover>` section in its system prompt: its position in the chain, how many takeovers are left
  before the cap, and the path of the previous session file, which it is free to read if the handoff
  left something out;
- a transcript marker (`↳ takeover #2 from <session>`, expandable, which also shows the model it put the
  session on) that the model never sees, so the human can follow the chain;
- a session name taken from the first line of the handoff (`takeover #2: REVIEW: …`).

The replaced session is not deleted. Its transcript is complete, it is the parent of the new session,
and `/resume` can go back to it. Nothing about the model, the terminal, or the working directory
changes — the conversation is what changes.

The model does not carry itself, though. A takeover is Pi's `/new`, and Pi gives a new session the
configured default model: a switch made inside a session belongs to that session. So the outgoing
session writes its selection into the lineage entry, and the incoming session reads it back and puts it
on itself before its first message. If that model cannot be used in the new session — an extension that
registers it did not load, or its provider has no credentials there — the session says so and runs on
what it picked by itself. And a session that changed model after the handoff outranks it: resuming that
session restores the session's own last choice, not the one the chain started with.

## Guard rails

A takeover chain is a counting of consecutive handoffs, in `<agent-dir>/takeover/chain.json`.

- The chain is capped (default 12). At the cap the tool refuses and says so, and a handoff that crosses
  the cap while queued is dropped with one message into the session telling the agent to stop and report
  to the human. A broken takeover cannot loop forever.
- A message typed by the user cancels a queued handoff and starts a new chain. A human who intervenes
  should not have a session replaced under them a second later.
- An interrupted run drops the queued handoff. So does `/quit`, `/resume`, and `/fork`.
- Every dropped handoff is written to `<agent-dir>/takeover/discarded-<id>.md`, so a prompt is never
  lost just because a session ended.
- `/reload` keeps the queue: it lives on disk, keyed to the session that queued it.

## Configuration

Read when the extension loads, so a change needs a restart rather than `/reload`.

| Setting                 | Default | Effect                                                         |
| ----------------------- | ------- | -------------------------------------------------------------- |
| `PI_TAKEOVER_MAX_CHAIN` | `12`    | Takeovers per chain before more are refused; `0` means no cap  |
| `PI_TAKEOVER_CONFIRM`   | off     | `1` asks before applying a queued handoff                      |
| `PI_TAKEOVER_NAME`      | on      | `0` stops naming the incoming session after its handoff prompt |
| `PI_TAKEOVER_DEBUG`     | off     | `1` writes what happened to stderr                             |

State: `<agent-dir>/takeover/` — `pending.json`, `chain.json`, `discarded-*.md`.

## Worth knowing

- In `--mode json` and `--print` the handoff prompt is awaited, because that process would otherwise
  exit with the new run mid-flight. In the interactive and rpc modes the new run simply continues.
- Sessions started with `--no-session` are in memory: the handoff still works, there is just nothing
  to go back to afterwards.
- A second Pi process sharing this agent dir shares the queue file too. The queue belongs to one
  session at a time; that is the same assumption the rest of the state folder makes.

## Development

```bash
npx vitest --run packages/pi-takeover       # queue, apply, and configuration tests
npx vitest --run packages/pi-takeover/test/session.test.ts
npm run smoke -- pi-takeover                     # a scripted model against a real pi, printed
```

`test/session.test.ts` runs a real `pi --mode rpc` against `test/fixtures/fake-model.ts`, which answers
from rules matched against the transcript it is shown, and logs what each model call was given. That is
what proves a handoff really reached a fresh session. `docs/testing.md` describes the harness.
