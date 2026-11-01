---

name: audit-loop
description: Run an adversarial tester↔fixer audit loop over a repo, one fresh session per pass, driven by pi-takeover. Trigger on "audit loop", "tester↔fixer loop", "audit passes", or any request that a tester agent and a fixer agent should alternate until the tester finds nothing.
compatibility: pi-takeover installed (the `takeover` tool); a repo with a runnable test gate
---

# Audit loop (tester ↔ fixer, one session per pass)

Two agents alternate on one repo, and each one is a **brand-new session**: the tester files findings with
deliberately-red tests, the fixer turns them green by fixing the product, the next tester attacks _those
fixes_. Nothing survives except the repo, one log file, and the handoff prompt. That constraint is the
whole design: a pass that has to explain itself from scratch is a pass whose findings are real.

Start one when the user says **"audit loop"** (also: "tester/fixer loop", "run passes until it is clean").
Join one when a handoff prompt names a pass number and a role — then follow the role rules below, read the
newest log section with `scripts/loop.sh pass <repo>` instead of the whole file, and skip the setup.

## Before pass 1

1. `scripts/loop.sh status <repo>` — branch, HEAD, dirty state, every pass in the log, and the current
   status bullet. If the log already exists, this is a continuation: find the next role and pass number.
   Start from a clean tree (commit or stash first): every later pass reasons about HEAD, and about which
   failures are deliberate rather than yours.
2. Find the **gate**: one command that runs typecheck, lint, and the suites (`npm run check`, `make check`,
   …), and learn how to run one file of tests. If the repo has no gate, build one first — a loop without a
   gate cannot tell a finding from a broken build. Record the counts.
3. Make sure the log (`docs/AUDIT.md`) and the status bullet in `MEMORY.md` exist. `references/audit-log-format.md`
   has the shapes; create them with the pass-1 heading and nothing else.
4. **Set the budget.** One takeover per pass, and pi-takeover's default chain cap is 12 — six passes.
   `PI_TAKEOVER_MAX_CHAIN` is read when the extension loads, so it needs a restart, not `/reload`. Say the
   budget out loud in the first handoff, and count down in each later one.
5. Hand off: call `takeover` with a tester prompt for pass 1 (`references/handoff-anatomy.md`). Then
   **finish the turn** — the tool queues, it does not interrupt. Do no more work in this session.

## Roles

**TESTER.** Do not touch product code. For each finding: an id `R<pass>-<n>`, a severity
(`BLOCKER` / `BUG` / `PAPERCUT` / `MISSING-COVERAGE`), the mechanism, a _measured_ reproduction (a number,
an output, a dump — not a theory), the holding test that stays red, a suggested fix, and what that fix must
not break. Commit locally; do not push a red gate, the next session works in the same tree. Leave the log
with a "Handoff to the fixer" list in the order to work in. Pass 1 sweeps the whole codebase. **Pass 2+
attacks the previous pass's fixes at the fix** — its handoff list is your target list. Also leave a
"Probed and not filed" section: what you checked, measured, and decided not to report, with the reason, so
later passes do not re-litigate it. Report the gate twice back to back so a flake cannot hide in a count.
State whether you changed product code — if you did not, you owe no smoke run and should say so.

**FIXER.** The tester's write-ups and handoff list are the spec; work in that order. Make the red tests
green by fixing the product — never by weakening, deleting or re-parameterising a test. If a test is
genuinely wrong, change it and add a "One test changed, with a stated reason" note. Fix the mechanism, not
the symptom: one place that bounds a string beats a bound at each of six quote sites. Update the design and
dev docs and any model-facing text when behaviour moved, pin each fix (break it deliberately, a named test
must fail — a fix no mutation kills is unpinned), get the gate fully green, run it twice, push, then update
the log and `MEMORY.md` and hand to a tester for the next pass. End every fix write-up with where it is
deliberately weak and what the next pass should try: **the fixer writes the next pass's attack list.**

Both roles: never edit the user's `AGENTS.md` or anything they own; never re-open a settled design
decision — if a finding needs a product decision, stop the loop and ask the human.

## Handing off

The next agent has zero context, so the prompt carries: absolute repo path, role and pass number, what the
last pass did (test counts, commit shas, pushed or not, dirty or clean), the read-first order, the gate
commands _with their current counts_, each finding one line, the attack list, the hard rules, the chain
position and remaining budget, and the stop condition. It also says "follow the `audit-loop` skill for the
role rules", which keeps later prompts short. 5–10k characters is normal. Naming the previous session file
is optional; the log is the memory, not the transcript.

## Stopping

End the loop and report to the human — do not hand off — when the tester files no `BLOCKER`/`BUG` and every
`PAPERCUT` is either fixed or accepted in writing in the log; when the budget is gone; or when the human
types anything (a typed message cancels a queued handoff, and discarded prompts go to
`<agent-dir>/takeover/discarded-*.md`). **An empty pass is a valid and valuable result** — do not invent
findings to keep the loop alive. Stop early and report if a pass cannot reproduce the gate it was promised,
or if a suite turns flaky: at that point the counts in the handoffs stop meaning anything.

## Environment

Runs unattended, so leave the machine as you found it: no daemons, no scratch processes, no dirty tree.
Kill every job you start — `trap 'kill $(jobs -p)' EXIT INT TERM`, never `$!` (it holds one pid, not the
24 you started); an orphaned busy loop reparents to PID 1 and stays invisible in a GUI monitor, and one of
these loops burned 17.5 core-hours that way. `scripts/loop.sh strays` checks. Smoke tests of a pi extension
go in a throwaway agent dir, never the user's, and never beside a running session.
