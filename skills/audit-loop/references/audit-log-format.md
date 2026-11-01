# The log and the status bullet

`docs/AUDIT.md` is the loop's only memory. A pass that is not written down did not happen: the next agent
starts from a blank context and reads this file. Two sections per pass, one per role, and they never get
rewritten — later passes append.

```
# Audit log
<one paragraph: what the loop is, the finding-id scheme, the severity ladder, the three rules>

## Pass 1 — <date> (tester)
Gate at the start: <counts, re-run before starting, identical?>
Gate at the end: <counts, which failures are deliberate and in which files>
Files added / changed; nothing deleted or weakened, except <list or "nothing">.
Summary: <n findings: x BUG, y PAPERCUT, z MISSING-COVERAGE. No BLOCKER.>

### R1-01 — BUG — <one-line claim>
<mechanism, then the measured reproduction — a number, a dump, an exit code — then the holding test as
`test/file.test.ts::R1-01`, then "Suggested fix: …" and what it must not break>

### Re-checking the previous pass's fixes
| fix | held? | what was probed |
| --- | ----- | --------------- |

### Probed and not filed
<what was tested, what it cost, and why it is not a finding. The next tester does not re-litigate these
without new evidence.>

### Handoff to the fixer
<numbered list in the order to work in, one line each>

## Pass 1 fixes — <date> (fixer)
Gate: <what was red, what is green now, run twice>. Pushed as <shas>.
### R1-01 — <what the fix is, in one clause>
<where it lives, what it replaced, which tests pin it, and **where it is deliberately weak** + "*Pass 2
should try:* …">

### One test changed, with a stated reason
### Probed and left alone, on purpose
### Handoff to pass 2 (tester)
```

Conventions worth keeping:

- **Ids are `R<pass>-<n>`** and the holding test carries the same id in its name, so a red test and a log
  entry point at each other from either side.
- **Severity is a claim, not a mood.** `BLOCKER` = shipped behaviour is wrong in a way a user hits. `BUG` =
  reachable and wrong. `PAPERCUT` = wrong in a corner, or honest but misleading. `MISSING-COVERAGE` = no
  bug found, no way to know. Say "No BLOCKER" when there is none — the absence is a finding too.
- **A finding is measured.** "The note is unbounded" is a theory; "the dead-channel result is 300 240
  characters, from a 300 000-character `__name__`" is a finding. Include the input that produces it.
- **The "_Pass N+1 should try:_" bullet is the escalation.** Without it the next tester sweeps blindly and
  re-finds what pass 2 already found.
- **Accepted weaknesses stay visible.** A fixer who decides not to fix something writes the decision down
  with its reason; a tester who finds it again later needs to know somebody chose it.

## The `MEMORY.md` status bullet

One bullet, overwritten every pass, at the top of the file. It is what a session that never joined the loop
needs in order to not undo it:

```
- Audit loop state: **pass 6 (tester) complete — three findings filed (R6-01…R6-03), each with a holding
  test that stays red. Next: pass 6 (fixer).** Read docs/AUDIT.md §"Pass 6 audit": per-finding write-ups,
  the re-check table, "Probed, measured, and not filed", and §"Handoff to the fixer (pass 6)" for order.
  Gate this pass leaves: tsc/biome green, 207 vitest — 204 pass, 3 fail on purpose (two identical full
  runs, only timings differed), 47 pytest. Mutation anchors: 66/66 match; the full run is owed by the
  fixer, and R6-01's fix owes a mutation of its own. New test ids: … Pass 6 changed no product file.
```

Keep the counts, the shas, and who owes what. A pass that skips this bullet makes the next agent re-derive
the state of the world from a 3000-line log, and the one after that will trust a stale one.
