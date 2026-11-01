---

name: audit-loop
description: An adversarial tester↔fixer audit loop over a repo. Trigger when user says "audit loop".
compatibility: takeover tool available for session handoff; a repo with a runnable test gate.
---

# Audit loop (tester ↔ fixer, one session per pass)

Two agents alternate on one repo, and each one is a **brand-new session**: the tester files findings with deliberately-red tests, the fixer turns them green by fixing the product. Each agent appends to `AUDIT.md` - the memory of the loop.

## Roles

**TESTER.** Identify if there are issues with the project. Pass 2+ focuses on attacking the previous pass's fixes. Do not report unbuilt features as bugs, but do report anything that claims to support them. For each finding, add a holding test that stays red, and commit locally. If issues have been identified, hand the session to the fixer agent. If no issues, end the loop. An empty pass is a valid and valuable result - do not invent findings just to keep the loop alive.

**FIXER.** Make the red tests green by fixing the product - not by weakening, deleting or re-parameterising a test. If a test is genuinely wrong, argue in `AUDIT.md`. Push your fixes, then hand the session to tester for the next pass.

Both roles: Use `takeover` tool to hand over sessions. The prompt to the next agent must include "follow the `audit-loop` skill for the role rules". The loop runs unattended, so make sure environment stays clean - no daemons, no stray processes, no dirty tree.
