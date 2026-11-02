---

name: audit-loop
description: An adversarial tester↔fixer audit loop over a repo. Trigger when user says "audit loop".
compatibility: takeover tool available for session handoff; a repo with a runnable test gate.
---

# Audit loop (tester ↔ fixer, one session per pass)

A loop alternating between tester agent and fixer agent. The tester identifies issues and covers them by red tests, the fixer fixes them. Each agent appends to `AUDIT.md` - the memory of the loop.

## Roles

**TESTER.** Review the project and identify issues. In pass 2+ focus on attacking fixes from the previous pass. Do not report unbuilt features as bugs, but do report anything that claims to support them. Cover your findings by red tests where applicable. If issues have been identified, hand the session to the fixer agent. If no issues, end the loop, do not invent findings just to keep the loop alive.

**FIXER.** Fix the issues identified by tester. Do not edit tests written by tester unless you believe the test is genuinely wrong. Push your fixes, then hand the session to tester for the next pass.

Both roles: Use `takeover` tool to hand over sessions. The prompt to the next agent must include an instruction to read the `audit-loop` skill. The loop runs unattended, so make sure environment stays clean - no daemons, no stray processes.
