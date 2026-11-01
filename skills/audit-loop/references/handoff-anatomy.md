# Handoff prompts

A takeover prompt is the only thing the next session reads besides the repo. It is a role card, a map of
the repo, and a set of numbers to check itself against. Write it as instructions to an agent who has never
seen this project and cannot ask questions.

## The parts, in order

1. **Role and pass, first line.** `You are the TESTER in the tester↔fixer audit loop on
   /abs/path/to/repo. This is pass 3.` Absolute path, always — the next session starts wherever it likes.
2. **What just happened.** The previous pass in two sentences, with its commit shas, whether they are
   pushed, whether the tree is clean, and what is red on purpose right now. A fixer who cannot tell a
   deliberate red test from breakage will "fix" the test.
3. **Read first, in this order.** The user's spec file (mark it "never edit"), `MEMORY.md`, the newest
   section of `docs/AUDIT.md` by name, the design/dev docs, `git log --oneline -N`. Point at the exact
   section, not the whole 3000-line log, and say why each file matters.
4. **The gate, with numbers.** The command, how to run one file, and the counts you just measured
   (`207 vitest — 204 pass, 3 fail on purpose`, `47 pytest`, two identical runs). The next agent re-runs it
   and a mismatch is how it notices that the repo moved under the prompt. Name the commands that do not
   work here ("never `npx pytest`, it hangs").
5. **The job.** For a tester: the attack list, in order, one bullet per target, each naming the file and
   what is weak there. For a fixer: the findings, one numbered bullet each, with severity, one-line
   mechanism, and the holding test's name.
6. **The rules.** Product code off-limits (tester) / tests off-limits (fixer). Never edit the user's files.
   Do not weaken a test to pass. Commit locally, do not push a red gate. Whether a smoke run is owed.
7. **Budget and stop.** `takeover #7 of 40`. What a pass with nothing to report should do (say so and
   report to the human, do not hand off).
8. **One line pointing at the skill**: `Follow the audit-loop skill for the role rules and the log format.`
   It stops every prompt from re-deriving the same rules.

## Tester pass 1 (opening the loop)

```
You are the TESTING agent in a tester↔fixer audit loop for /abs/repo (distrobox; do not touch the host).

## Project state
<one paragraph: what the software is, the process/module boundaries, where each side lives, which
milestones are done and which are deliberately not built — "do not report unbuilt features as bugs, but
do report anything that claims to support them">

Read first: AGENTS.md (the user's, never edit it), MEMORY.md, docs/DESIGN.md, docs/DEV.md, git log.

## Gate
`npm run check` = tsc ✓, biome ✓, 87 vitest, 35 pytest — green as of <sha>. Run stages separately once
things go red (`npm run check` stops at the first failure). Re-run anything flaky twice and report it.

## Your job
Sweep the whole codebase this pass: protocol boundaries, error paths, abort/teardown, resource limits,
anything that can be answered falsely. File every finding in docs/AUDIT.md §"Pass 1 — <date> (tester)"
with a holding test that stays red, severity BLOCKER/BUG/PAPERCUT/MISSING-COVERAGE, a measured
reproduction, and a suggested fix. Do not change product code. Commit locally; the gate will be red on
purpose — say how many tests and which files. End with §"Handoff to the fixer".

takeover #1 of 40. If you find nothing, say so plainly and report to the human instead of handing off.
Follow the audit-loop skill for the role rules and the log format.
```

## Fixer, pass N

```
You are the FIXER for pass 4 of the tester↔fixer audit loop on /abs/repo. HEAD is <sha> (local, not
pushed — the gate is red on purpose: 13 failing tests are the tester's holding tests, they are your spec,
not breakage).

Read first: AGENTS.md (never edit), MEMORY.md, docs/AUDIT.md §"Pass 4 audit — <date> (tester)" — per
finding it has the mechanism, the measured reproduction, the holding test, and what your fix must not
break — then §"Handoff to the fixer (pass 4)", which is the order to work in.

Gate now: tsc ✓, biome ✓, 153 vitest (139 pass / 14 fail), 47 pytest ✓. `npm run fmt` before expecting
biome to pass. NEVER `npx pytest`.

Fix all ten, in that order, without weakening, deleting or re-parameterising any test:
1. R4-01 PAPERCUT — `src/prompt.ts:51` quotes a channel name from history raw; the bound is on the write
   path only. Holding test: `test/prompt.test.ts::R4-01`.
2. …

Then: update docs/DESIGN.md + docs/DEV.md and the model-facing prompt text, add a mutation line per fix to
scripts/mutation-audit.sh and run it, get the gate green twice, push, update the §"Pass 4 fixes" section
(every write-up ends with where it is deliberately weak and what pass 5 should try) and the MEMORY.md
status bullet, and hand to a fresh tester for pass 5.

takeover #8 of 40. Follow the audit-loop skill for the role rules and the log format.
```

## Tester, pass N (attacking the fixes)

Same as pass 1, with the job replaced by:

```
You are audit pass 6. The fixer just fixed all seven pass-5 findings and got the gate green. Attack
*those fixes* — at the fix, not the symptom. The target list is docs/AUDIT.md §"Pass 5 fixes": each
write-up ends with where it is deliberately weak and a "*Pass 6 should try:*" bullet, in the fixer's own
order. Also re-check pass 5's fixes against pass 4's, and fill in the "Re-checking pass 5's fixes" table.
The seven fixes are: R5-01 (…), R5-02 (…) — one clause each so you know what you are attacking.
Do not re-file anything in §"Probed and not filed" without new evidence.
```
