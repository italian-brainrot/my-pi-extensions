# AUDIT

Memory of the tester ↔ fixer loop (see `.agents/skills/audit-loop`). Each pass appends; nothing here is
a substitute for reading the code.

Scope of this loop: `packages/pi-bg-tasks`.

---

## Pass 1 — tester

Baseline before the pass: `npm test` → 205/205 green. After the pass: **206 green, 11 red in 5 files**, all
of them written by this pass. Reproduce with `npx vitest --run packages/pi-bg-tasks`.

Findings, most valuable first. Each has a red test that fails for exactly the stated reason.

### F1 — the replacement `bash` tool silently drops `settings.shellCommandPrefix`

Pi passes two settings into its own shell tool: `shellPath` (which this extension re-implements) and
`shellCommandPrefix`, described in Pi's own settings schema as "prefix prepended to every bash command,
for example to enable shell aliases" (`agent-session.js` `_buildRuntime` →
`bash: { commandPrefix, shellPath }`; `createShellToolDefinition` builds
`` `${commandPrefix}\n${command}` ``). `registerBashOverride` calls `createBashToolDefinition(cwd)` with
no options and replaces `execute`, so the prefix never applies.

Impact: a project that relies on aliases, shell functions or an environment set up by the prefix works
with the built-in tool and fails with pi-bg-tasks installed — the failure looks like "command not found"
from the model's side, and the model then goes looking for the wrong cause.

Evidence: same settings, same command. Built-in → `"ALIASES-ON\ncmd\n"`; this extension → `"cmd\n"`.

Red: `test/shell-settings.test.ts` (3 tests — agent-level prefix, prefix on a backgrounded spawn, project
prefix winning over the agent one, which is Pi's merge order).

Direction: read `shellCommandPrefix` from the same two files `readConfiguredShell()` already walks
(project settings of the pi process cwd, then agent dir; project wins), prepend it the way Pi does, and
cache it per runtime alongside the cached shell so "the shell is chosen once per runtime" stays true.

### F2 — logs, sidecars and the log dir are group-writable and world-readable

`ensureLogDir()` makes `<agent-dir>/bg-tasks` with default mode (0775 under this umask) and the log is
opened with `openSync(logPath, "w")`, the sidecar with `writeFileSync` — 0664 in a real install
(`ls -l ~/.pi/agent/bg-tasks` shows `-rw-rw-r--`). Pi writes the same class of data (a truncated tool's
full output) with mode 0600 and says why in `utils/output-files.js`: "Output can carry private data, so
only the user may read them."

What is in there: the whole command line in the sidecar (`curl -H 'Authorization: Bearer …'` lands
verbatim), and command output in the log. Group-_writable_ is worse than readable — another user on the
machine can append text to a running task's log, which this session then reports to the model as its own
command output.

Red: `test/permissions.test.ts` (2 tests — mode bits of dir/log/sidecar/kept foreground log; and an
already 0775 directory from an older install being tightened).

Direction: `mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })` and create files with 0600
(`openSync(path, "w", 0o600)`, `writeFileSync(…, { mode: 0o600 })`). `mkdirSync`'s mode is ignored for a
directory that already exists, so the existing dir has to be `chmod`'d once — that is what the second
test asks for, and it is what makes the fix cover installs that already have files in there.

### F3 — `session_start` prunes before it adopts, so a restart can lose a live command

`adoptJobs()` calls `pruneRetention()` first. In a fresh runtime the registry is still empty, so
`tracked?.status === "running"` protects nothing, and a live command whose files are older than
`RETENTION_MS` — or simply outside the newest `MAX_RETAINED_LOGS` — loses its sidecar. Adoption then skips
it and the command becomes unmanageable for the session that is now responsible for it: `bg_wait` lists
nothing, `bg_stop` throws "Unknown task", the log the model was told to read can disappear, and the
process is not stopped at shutdown. Realistic shape: a quiet dev server that has been up for more than
three days, then `/reload`.

Red: `test/lifecycle.test.ts`, two tests in the "log retention" block — one backdated past the retention
window, one pushed outside the newest 100 logs by 105 newer files.

Direction: adopt first, then prune (or treat a sidecar whose `pid` is alive as protected during the
prune). Keep the protections `pruneRetention` already has: never touch a file this runtime tracks as
running, never touch another live runtime's files (`test/cross-process.test.ts` guards exactly that).

### F4 — a task that daemonises is never stopped by anything

Commands are spawned `detached`, so the shell leads a process group and `bg_stop` signals `-pid` — which
does reach every process of a _running_ task (pinned green in `test/process-groups.test.ts`). But a task
that forks a worker and lets its wrapper shell exit (`npm run dev &`, `foo &`, a forking dev server)
"completes" immediately while the worker keeps running **in that same group**. From then on nothing
signals the group: `bg_stop` answers "already completed", and `session_shutdown reason:"quit"` only
signals jobs it still considers running. The worker outlives the stop request, the session and the
runtime, forever. This contradicts the README ("Jobs always stop on real shutdown (`quit`)") and the tool
description ("Stop a running background task").

Red: `test/process-groups.test.ts` — after `bg_stop`, and separately after a quit shutdown, no process
started by the task may survive. (Third test in that file is the already-green pin for the running-task
case; keep it green.)

Direction: extend the _stop_ path only. Signal `-pid` even when the leader has exited (ESRCH means the
group is gone, so it is cheap and safe). Do **not** redefine "running" as "the group still has members" —
that would make `sleep 1 & echo started` never finish and would break `bg_wait` and the foreground
results.

### F5 — retention never runs during a session, so the log dir grows without bound

`pruneRetention()` is only reachable from `adoptJobs()`, i.e. at `session_start`. An interactive session
that runs for days without reloading leaves one full log per truncated command (a 5 MB log from one
command is normal), plus every background task's log. Measured: 105 truncated foreground commands in one
runtime → 105 files on disk, cap untouched. The README states the 3-day / newest-100 rule as if it holds.

Red: `test/lifecycle.test.ts` — the log dir must be inside 100 logs after 105 truncated foreground
commands, without a session restart.

Direction: run the prune periodically — e.g. throttled inside `spawnJob` (at most once every N seconds).
It must carry the same protections as F3, or it will do to a long-running task what F3 does at reload.

### F6 — a spawn failure in a missing working directory blames the shell (minor)

With `ctx.cwd` gone, `spawn` fails with ENOENT and the tool reports
`"[bg-tasks] failed to start command with bash: spawn bash ENOENT"`. The model concludes bash is missing.
Pi's own tool checks first: `"Working directory does not exist: <path>\nCannot execute bash commands."`

Red: `test/foreground.test.ts` — the result must name the working directory and must not claim the shell
failed to start.

### F7 — documentation drift, no test

`isOwnedByAnotherSession()`'s comment says a pid recycled by an unrelated live process is "answered from
the process table". It is not: the function returns as soon as `ownerPid` is a number, so a recycled owner
pid marks the sidecar foreign forever — never adopted, never pruned. Either fix the comment or fall
through to the process table when the owner pid's `/proc` start time disagrees. Comment-only fix is fine.

### Coverage worth keeping, worth not re-litigating

Checked by hand this pass and found working — do not spend the next pass re-discovering these, and do not
let a fix regress them:

- Process-group killing of a running task (`sleep A & sleep B` → both die).
- SIGTERM→SIGKILL escalation for a task that traps SIGTERM: `bg_stop` returns in ~5.0 s with `killed`.
- Output counts past the 16 MB scan cap: `bytes` exact, `lines`/`chars` prefixed `>=`, scan ~30 ms.
- A finished background task keeps its log; a finished foreground task's log is deleted unless truncated.
- Preview keeps multi-byte characters intact; heredocs, `cmd # comment`, trailing `\` and leading `(` all
  survive because output is attached by file descriptor rather than by a shell wrapper. **No test covers
  those four command forms** — worth a green pin while `spawnJob` is being touched.
- `PI_SESSION_ID/PI_SESSION_FILE/PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL` and the `<agent-dir>/bin` PATH
  prefix match Pi's `getShellEnv()`/`resolveSpawnContext` exactly; stale `PI_*` from a parent pi is cleared.
- Ownership across runtimes: foreign sidecars are not adopted, not stopped, not pruned; orphaned ones are
  adopted, claimed and stopped at quit; the nested-pi-kills-its-own-wrapper case is guarded.
- `blocking` mutex, and the abort-after-background case (a backgrounded task survives a later abort).

Harness traps hit during this pass, so the fixer does not write them again:

- `loadExtension()` in the same file reuses the cached module, so `LOG_DIR` still points at the **previous
  test's** agent dir unless `vi.resetModules()` runs first. Use `makeTempDir()` + `agentDir:` +
  `vi.resetModules()` before each load when a test asserts on paths under `agentDir`.
- `bg_stop` right after `timeout: 0` can read an empty log: the shell has not flushed yet. Let the command
  finish and read the log through `bg_wait`'s `tasks[].log_path`.
- `finishedResult` details carry no `pid`, so a test cannot recover a finished task's process group from
  the result — find the process by its command line instead (see `test/process-groups.test.ts`).

---

## Pass 1 — fixer

All 11 red tests green; F1–F6 fixed in `packages/pi-bg-tasks/src/index.ts`, F7 comment-only. `npm run check`
passes end to end (deps, manifest, skills, tsc, biome, **224 tests**). No test written by the tester was
changed; three files with 7 tests were added to pin decisions the red tests did not cover.

- **F1** — `readConfiguredShell()` became `configuredSetting(key)` over the same two files, resolved **per
  key**, so a project setting one of `shellPath` / `shellCommandPrefix` still gets the other from the agent
  scope (Pi deep-merges scopes key by key: `settings-manager.js` `deepMergeSettings(global, project)`).
  `withCommandPrefix()` is applied inside `spawnJob` — the only place a command is handed to a shell — so the
  foreground and `timeout: 0` paths both get it, while sidecars, listings and `$` lines keep the raw command.
  Cached once per runtime beside the shell, so "the shell is chosen once per runtime" now covers the prefix.
- **F2** — `ensureLogDir()` mkdirs `0700` and then clears group/other bits on the directory that already
  exists (`mkdir`'s mode is ignored for an existing one); `openPrivate()` opens logs, sidecars and appended
  notes with mode `0600` _and_ `fchmod`s them (a mode argument is umask-masked, and ignored for a file that
  already exists); `pruneRetention()` `tightenPrivate`s every file it walks, so files an older install left
  behind are fixed without deleting them.
- **F3** — `adoptJobs()` reads the dir, adopts, claims (rewrites the sidecar) and registers the job as
  running, and only then calls `pruneRetention()`.
- **F5** — new `enforceRetention()`, called from `markDone`: one directory listing decides, a full pass runs
  when the last one is older than `RETENTION_THROTTLE_MS` (60s) or the dir already holds `MAX_RETAINED_LOGS`
  logs. It is the _same_ `pruneRetention()` with the _same_ protections as F3, not a second implementation.
  Completion is the right trigger: the dir only grows when a command ends, and that is also the moment the
  job's own log stops being protected as running, so the cap reaches exactly 100 rather than 100 + running.
- **F4** — `killJob`'s inline signal helper became `signalJobTree()`. New `hasLeftoverGroup()` /
  `stopLeftoverGroup()` signal `-pid` for a job whose leader has exited — SIGTERM, poll `kill(-pid, 0)` for
  `SIGTERM_GRACE_MS`, then SIGKILL — awaited from `bg_stop` on a finished job and from `killAllJobs()`. The
  reuse guard is `!processAt(pid)`: the group is only signalled while nothing at all lives at that pid,
  because a finished pid is reusable and whatever took it would be leading the group being signalled. With
  the pid free, the id either still belongs to the task's own leftovers or is free, and signalling a free id
  is ESRCH. "Running" is untouched, so `sleep 1 & echo started` still finishes.
- **F6** — `missingWorkingDirectory(cwd)` runs in the bash `execute` before spawning, with Pi's wording. It
  returns an error result rather than throwing, so it arrives as the tool's answer (Pi's throw is caught by
  its own caller; a harness calling `execute` would see a rejection).
- **F7** — comment only, as allowed. A marked sidecar whose owner pid has been recycled stays foreign for
  good: never adopted, never pruned.

New pins, all green: `test/retention-in-session.test.ts` (a mid-session pass leaves a running task's log and
sidecar, and the dir holds at most cap + running; a pass tightens `0664` files and ages stale ones out),
`test/settings-scopes.test.ts` (per-key scope merge in both directions), `test/stop-reach.test.ts` (a
SIGTERM-ignoring leftover is escalated to SIGKILL by `bg_stop` and by a quit shutdown, which waits for it; a
`setsid`-ed process is out of reach, pinned as the boundary rather than as a bug).

Also fixed in passing: `isAlive()` now shares `processAt()` instead of duplicating the EPERM branch;
`loadExtension()` now removes the working-directory temp dir it created (it never removed any, so a full
test run left ~90 directories in `/tmp`); biome wanted `_emphasis_` over `*emphasis*` in `docs/testing.md`
and `AUDIT.md`, which had `npm run check` failing before this pass touched anything.

### For pass 2 — what to attack

In rough order of how much I distrust it:

1. `stopLeftoverGroup`'s guard is a point-in-time `kill(pid, 0)`. Sound against a pid that is _already_
   reused, but there is a window between the check and the signal. It also refuses when an unreaped zombie
   sits at that pid, so a leftover group behind an adopted job whose leader is a zombie is never stopped.
   `kill(-pid, 0)` (group existence) is Linux/macOS thinking: on Windows the leftover path is inert.
2. A task that daemonises and then outlives a reload is untrackable: the sidecar records the wrapper shell's
   pid, which is gone, so `adoptJobs()` drops it as dead and the worker becomes nobody's. F4 reaches only
   leftovers whose job is still in this runtime's registry. The registry cap (`MAX_REGISTRY_SIZE`) evicts
   finished jobs the same way.
3. Retention is driven by completions, so a session whose tasks never finish never prunes. Defend or replace
   that: the cap is only enforceable over finished jobs' logs, and the README now states it that way.
4. `tightenPrivate()` changes the mode of files this process did not create, including a live other-runtime's.
   Same user, only ever narrowing — argue about whether that is a right.
5. Retention mid-session can delete a truncated foreground log an earlier tool result pointed at, once it
   falls outside the newest 100. `details.logPath` and the "Full output:" note then name a missing file.
6. Pre-existing divergence, deliberately left alone and a fair finding: shell _resolution_ is not Pi's. Pi's
   `getShellConfig` throws `Custom shell path not found: …` for a configured path that does not exist, falls
   back `/bin/bash` → bash on PATH → `sh`, and uses `commandTransport: "stdin"` for the legacy WSL bash path.
   This extension spawns the configured path or literal `bash` and reports `failed to start command with
   bash: spawn bash ENOENT`.
7. The F7 limitation, if someone wants it fixed rather than described: telling a recycled `ownerPid` from the
   real owner means the pid's start time (`/proc/<pid>/stat` field 22 after the last `)`, plus `btime` from
   `/proc/stat`) against the sidecar's `startedAt`. CLOCK_MONOTONIC excludes suspend, so on a laptop that
   estimate is off by however long the machine slept — a heuristic that misfires exactly where pids are most
   likely to have been recycled.

Harness notes for this pass:

- A mid-session full pass needs a _trigger_: put `MAX_RETAINED_LOGS` `bg-*.log` names in the dir, or wait out
  60s. mtimes written in a loop can land in the same timestamp, so backdate the filler files if a test
  asserts which names survive the count sweep.
- `trap '' TERM; sleep N & echo started` gives a worker that ignores SIGTERM (the disposition is inherited by
  the forked child) — the only way to reach the escalation branch for a finished task. It makes `bg_stop`
  take about 5s, so give a `waitFor` past it.
- The marker-sleep trick from `test/process-groups.test.ts` (find the process by its `/proc` cmdline) is what
  makes leftover-group assertions possible; a finished job's result carries neither pid nor group id.
- `pruneRetention()` deliberately does **not** call `ensureLogDir()`: a job that ends during teardown runs
  a retention pass, and creating the log dir there puts back a directory the test just deleted.
- A full suite left ~6 `/tmp/pi-ext-*` directories, from loads that reused an earlier load's module and
  agent dir. Fixed in pass 2 (`lifecycle.test.ts`, plus two `pi-takeover` files that never disposed their
  `beforeAll` load); a clean run now leaves none.

---

## Pass 2 — tester

Baseline: `0c7e72e`, 224/224 green. After the pass: **229 green, 7 red in 4 files**, all written by this
pass. `tsc` and biome are clean; `npm run check` fails only on the 7 red tests. Reproduce with
`npx vitest --run packages/pi-bg-tasks`.

Red: `test/stop-group-escalation.test.ts` (3), `test/reload-leftover.test.ts` (1),
`test/settings-shell-edges.test.ts` (3). New green pins: `test/prefix-command-forms.test.ts` (5).

### F8 — nothing escalates a group whose leader died: a running task's stop leaks its workers

The pass-1 leftover stop is only wired into the branch for a job that is **already finished** when
`bg_stop` looks at it, and `killAllJobs` computes `leftovers` once, before anything is killed. For a task
that is running when it is stopped, every decision is made from the **leader's** state:

- `killJob`'s grace timer is gated on `job.status === "running"`, and the status is the leader's;
- `bg_stop`'s running branch awaits `getDone(job)` — the leader being reaped is what ends it;
- `killAllJobs` puts the job in `running` (never in `leftovers`, which is filtered at entry), and its
  `Promise.all` resolves on the same `getDone`;
- `runWithTimeout`'s abort path goes straight to `finishedResult`.

So: a task whose shell dies on SIGTERM while another member of its group ignores SIGTERM. The shell is
reaped, the job goes to `killed`, every wait resolves, the escalation is skipped because the status is no
longer `"running"` — and the worker is left running in the group the shell led, forever. `bg_stop` answers
`Task bg-x stopped (killed).`

Evidence, same command shape as pass 1's `stop-reach` pin plus a `trap - TERM` so the leader is not also
immune (`trap '' TERM; sleep N & echo started; trap - TERM; wait` — the disposition is inherited across
fork+exec, `trap - TERM` puts the shell back to default termination, `wait` keeps it running until
signalled). After `kill -TERM <pgid>` from a plain shell: `kill -0 <pgid>` → ESRCH, `kill -0 -<pgid>` →
success, the `sleep N` alive 12 s later. That is exactly the state `hasLeftoverGroup()` is built to
recognise, and it is reached a hundred milliseconds into a stop that then refuses to act on it.

Red, one per entry point: `bg_stop` on a running task; `session_shutdown reason:"quit"`; an aborted run.
All three leave the worker alive.

Direction: make the stop about the group rather than the leader, keeping the `!processAt(pid)` guard.

- `killJob`'s escalation: escalate when the leader is gone but the group is not —
  `job.status === "running" || (processGroupExists(pid) && !processAt(pid))`;
- `bg_stop`: after the race in the running branch, if `hasLeftoverGroup(job)` then
  `await stopLeftoverGroup(job)` and say so, as the finished branch already does;
- `killAllJobs`: re-scan for leftovers after the running jobs' leaders have been reaped instead of
  filtering once at entry, and give the shutdown room for the second window (the group stop can now start
  after the leader stop);
- `runWithTimeout`: stop the group before `finishedResult` — which also deletes a non-truncated log.

Must not regress: `process-groups.test.ts` test 1, `stop-reach.test.ts` test 3 (a `setsid`-ed process:
`hasLeftoverGroup` is false there, so it stays out of reach), and "running" must stay the leader's state —
`sleep 1 & echo started` still finishes.

### F9 — a leftover group is forgotten when the runtime that started it goes away

`markDone` unlinks the sidecar as soon as a job stops. That is the only record of which group id to signal,
so the pass-1 fix reaches a leftover group **only in the runtime that started the task**. A session
replacement (`/reload`, `/new`, `/fork`) deliberately keeps everything running, and the runtime taking over
discovers what to manage by reading sidecars: there is none, so the worker is nobody's. `bg_wait` lists
nothing, `bg_stop` has no ID, and the new runtime's quit shutdown signals nothing.

Reproduction: `bash { command: "sleep 153 & echo started", timeout: 5 }` → completed, worker alive;
`session_shutdown reason:"reload"`; new runtime in the same agent dir (`vi.resetModules()` + shared
`agentDir`) → `session_start` adopts nothing → `session_shutdown reason:"quit"` → the worker is still
alive, in the group its dead shell led, and nothing can point at it.

That contradicts two unqualified sentences: "Jobs always stop on real shutdown (`quit`), together with
whatever they left running in their process group" (README, settings table) and the tool description's
"A process the task left running in that group is stopped too" — neither says "…by the runtime that
started it", and the section right above them promises that state survives a reload.

Red: `test/reload-leftover.test.ts`.

Direction, either of these is acceptable — say which in AUDIT.md, since the second means deleting this
test:

1. Close it: in `markDone`, keep the sidecar of a backgrounded job when `hasLeftoverGroup(job)` is true
   (the leader is reaped by the time the exit event fires, so the check is exact), and in `adoptJobs`
   treat a sidecar whose `pid` is dead as a finished-but-owned entry rather than unlinking it when
   `processGroupExists(pid) && !processAt(pid)` — `killAllJobs`'s leftovers filter then covers it.
   Ownership rules stay as they are: a sidecar owned by a live runtime is foreign and its group is not
   ours to signal. Such an entry should not appear as "running", and a normal task whose group went empty
   still loses its sidecar at once, so the common case creates no extra files.
2. Scope the claim: say in the README and in `bg_stop`'s description that the group a task leaves behind
   is stopped by the runtime that started it, and that a replacement session inherits only live leaders.

### F10 — a project-scope setting that is present but empty does not override the agent scope

`configuredSetting()` returns the first scope whose value is a non-empty string. Pi's merge drops a key only
when it is `undefined`: `deepMergeObjects` iterates the project file's own keys and `continue`s just for an
`undefined` value, so a JSON `null` or `""` that is present in the project file _is_ the merged value
(`settings-manager.js:19-31`). Nothing normalises it on the way out — `getShellCommandPrefix()` returns
`this.settings.shellCommandPrefix` verbatim (`:788`), and `getShellConfig()` treats a falsy `shellPath` as
unset. So `"shellCommandPrefix": ""` or `"shellPath": null` in a project is Pi's way of switching an
agent-level setting off, and this extension silently keeps the agent's value instead. The README's claim
that the two keys are resolved "the way Pi merges its settings" is what does not hold.

Red, both keys: project `{"shellCommandPrefix": ""}` over an agent prefix that still runs; project
`{"shellPath": null}` over an agent `shellPath` that does not exist, where Pi's default shell would run the
command and this reports a failed command.

Direction: resolve per key as "the innermost scope that _mentions_ the key", and treat any string (including
empty) or `null` as a value; only a missing key, or one that is not a string and not `null`, falls through.
The existing `settings-scopes.test.ts` and `shell-settings.test.ts` pins must stay green.

### F11 — a configured shell that does not exist is reported as a command that failed

`getShellConfig` in Pi refuses a configured path it cannot find, by name: `Custom shell path not found:
<path>` (`utils/shell.js`). Here `shellPath: "/definitely/not/a/shell"` reaches `spawn`, the `error` handler
writes `[bg-tasks] failed to start command with /definitely/not/a/shell: spawn … ENOENT` into the log, and
the result is `Command exited with code 127` with `isError` — a broken setting indistinguishable from a
command that failed, which is the F6 mistake one setting over. Fix direction: check the resolved shell before
spawning (once per runtime, next to `missingWorkingDirectory`) and return an error result with Pi's wording;
do not throw, for the reason already recorded under F6.

Red: `test/settings-shell-edges.test.ts`, third test.

Not a finding, worth knowing: the rest of Pi's shell resolution still differs and the README says so. Pi
falls back `/bin/bash` → `bash` on PATH → `sh`; this extension spawns literal `bash`. Pi's legacy-WSL
`commandTransport: "stdin"` is irrelevant here because output is attached by descriptor. A user on a machine
with no `bash` on PATH gets a failure from this extension and a working `sh` from Pi — documented, so left
alone; if anyone wants it closed, reuse `getShellConfig` rather than re-deriving it.

### Attacked, no finding

Recorded so pass 3 does not spend time here.

- **`stopLeftoverGroup`'s point-in-time guard is sound.** A group id `P` with nothing living at `P` can
  only be the task's own leftovers: a _new_ group with id `P` is created by a process that is itself at pid
  `P` (`processAt` → true → refuse), so mistaking one needs the pid to be recycled by a fresh group leader
  **and** that leader to die leaving members, all inside the microseconds between the check and the signal —
  a full pid wrap per stop attempt. The SIGKILL re-checks `!processAt(pid)` immediately before signalling,
  `bg_stop` twice on the same task is idempotent, and a stopped (`SIGSTOP`) or unreadable (EPERM) member
  keeps the group "existing" and gets SIGKILL, which is right.
- **The zombie refusal is unreachable, and refusing is the safe direction.** This runtime reaps its own
  children before `markDone`; an adopted leader's parent is gone, so init reaps it. A `kill(pid, 0)`-yes
  zombie therefore never hides a leftover group.
- **Retention.** A pass creates nothing and never `ensureLogDir`s. Foreign and this-runtime-running ids are
  collected before anything is deleted, so a sidecar and its log are always protected (or removed) as a pair
  — a foreign log cannot outlive its protecting sidecar by one pass. The count rule counts only files it may
  touch, which is what makes "cap + running" exact. The "a session whose tasks never finish never prunes"
  case is empty: a log dir only grows through completions, and every completion runs the throttle check, so
  the only files that can pile up without one are logs of running jobs, which no pass may touch. Deleting a
  log an earlier tool result pointed at is the documented cap, not a defect, and `bg_wait` already prints
  `(no log: …)` for it.
- **`tightenPrivate` on files another live runtime owns** — it only ever clears group/other bits, which is
  the documented intent, and the alternative (a shared dir where one runtime's files stay 0664 because
  another runtime happened not to run a pass) is worse. Left as is.
- **Modes.** `openPrivate` passes the mode to `open` _and_ `fchmod`s, so the process umask cannot widen it and
  a pre-existing file cannot keep a loose mode; `ensureLogDir` mkdirs 0700 and tightens an existing dir.
  `LOG_DIR` existing as a non-directory surfaces as an fs error naming the log path, which is diagnostic.
  A symlink planted at a log name is not reachable: the directory is 0700 and the ids are 62^8.
- **`missingWorkingDirectory`** uses the same cwd expression as Pi (`ctx.cwd || process.cwd()`, mirroring
  `resolveSpawnContext`), Pi's wording for the missing case, and adds the not-a-directory case Pi's
  `fsAccess(cwd, F_OK)` lets through into a spawn `ENOTDIR`.
- **`withCommandPrefix`** is applied in `spawnJob` only, which is the only place a command reaches a shell;
  the raw command is what `writeMeta`, `bg_wait`'s listing and `structuredContent.tasks[].command` carry
  (now pinned green, along with heredoc / trailing-comment / trailing-backslash / leading-paren forms
  surviving the join).
- **Windows**: `process.kill(-pid, 0)` is inert there, and so is the whole leftover path — `detached` is
  false and `signalJobTree` uses `taskkill /T /F`. Consistent, and nothing claims otherwise.
- **Not tested, too narrow to be worth it**: an abort landing in the one event-loop turn between the
  timeout timer firing and `runWithTimeout` reaching its `finally` releases the job to the background and
  then lets that abort kill it, while reporting it as moved to the background. `bg_wait` still shows it.

### For pass 3 — what to attack

- Whatever shape F8's fix takes: the shutdown path is the risky one (two grace windows, and `stop-reach`'s
  `>= 4000` assertion already budgets for one). Do not widen that assertion to make a red test pass — check
  which window the wait actually belongs to.
- F9 option 1 keeps sidecars around; check it does not resurrect a finished task as adoptable-forever, and
  that retention still collects such a record once its group is gone.
- F10's fix walks the two scope files; the trap is that `settings.json` may be missing, unreadable or
  invalid in either scope, and the cached-per-runtime rule ("the shell is chosen once per runtime") has to
  stay true for both keys.
- Still open from pass 1, cosmetic: several loads in `test/lifecycle.test.ts` reuse an earlier load's module
  and agent dir, which is where the ~6 surviving `/tmp/pi-ext-*` directories come from. Give them
  `vi.resetModules()` and their own `agentDir` and that note can be deleted from this file.

Harness notes:

- The marker sleeps used by this pass are 147, 149, 151, 153. Passes must keep them unique across files —
  the `/proc` scans are process-global and Vitest runs test files in parallel forks.
- `trap '' TERM; … ; trap - TERM; wait` is the shape that reaches F8; without the `trap - TERM` the leader
  is immune too and pass 1's pin already covers it.
- `stop-group-escalation.test.ts` emits a quit shutdown in its second test and then keeps using the same
  runtime; that is deliberate (Pi would emit `session_start` again), and the third test does not depend on
  adoption.
- A full suite leaves exactly 6 `/tmp/pi-ext-*` directories; the four files this pass added leave none.

---

## Pass 2 — fixer

All 7 red tests green, none of them edited. `npm run check` passes end to end (deps, manifest, skills,
tsc, biome, **243 tests**: 229 carried, 7 fixed, 7 new pins). Reproduce with
`npx vitest --run packages/pi-bg-tasks` (86) or `npm test` (243).

### F8 — the stop is about the group, not only about the leader

Four entry points, one rule: once the leader is gone, the group is asked on its own account.

- `killJob`'s grace timer: `job.status === "running" || hasLeftoverGroup(job)`. A leader that died on the
  first SIGTERM no longer cancels the escalation for the members that ignored it. `signalJobTree` already
  signals `-pid`, so the same call reaches them.
- New `stopJobAndWait(job)`: the leader's window (kill, then race `getDone` against `SIGTERM_GRACE_MS +
  1000`) and then `stopLeftoverGroup`, which is now conditional on `hasLeftoverGroup` — so a task whose
  whole group dies on SIGTERM still pays exactly one window. `bg_stop`'s running branch calls it and says
  in the result what it did to the group (`groupNote`, shared with the finished branch).
- `killAllJobs`: one list of targets (`status === "running" || hasLeftoverGroup(job)`), and every target is
  stopped by `stopJobAndWait`. `Promise.all` over `stopJobAndWait` starts every stop before awaiting any,
  so the leaders are all signalled synchronously — the entry-time `leftovers` filter that was computed once
  is gone, and a running job that becomes a leftover job is covered without a re-scan. Its cap is now two
  windows: `2 * (SIGTERM_GRACE_MS + 1000)`.
- `runWithTimeout`: before `finishedResult`, `if (job.killRequested) await stopLeftoverGroup(job)`. The
  timeout release path is untouched — no kill was asked for there, and stopping the group of a task that
  was deliberately left running would contradict "a backgrounded task survives a later abort".

**The timing question pass 1 flagged.** `stop-reach`'s `>= 4000` belongs to a job that was _already
finished_ when the shutdown looked at it: for that job the group stop _is_ the first and only window
(SIGTERM, 5s poll, SIGKILL → ~5.15 s), and it is unchanged. The second window exists only for a job whose
leader was running at entry — and there `killJob`'s timer fires its group SIGKILL at t=5 s while the
leader's window is still open, so the two windows overlap: measured on that shape, `bg_stop` 5.11 s and
the shutdown 5.11 s, not ~10 s. Nothing was widened. What the second window must not become is a cost paid
always, so
`test/stop-window.test.ts` pins the other side: a cooperative group gives a `bg_stop` and a shutdown that
come back in under 2500 ms.

`stopLeftoverGroup` also now waits up to `GROUP_REAP_MS` (1 s) after a SIGKILL for the group to actually
disappear, so a caller waiting for a stop waits for the last signal it asked for, and so the "is the group
gone" answer it returns is not a race against init reaping an orphan.

### F9 — resolution 1: close it, the record outlives the runtime

`markDone` and `finishedResult` now call `releaseJobRecord(job)`: keep the sidecar (`writeMeta`) when
`hasLeftoverGroup(job)`, otherwise unlink it as before. The exit event has fired and Node has reaped the
leader by then, so the check is exact, and a task whose group went empty with its shell still leaves no
file behind (pinned). The sidecar gained `status`, `exitCode`, `signal` and `finishedAt` so a runtime that
inherits the record reports the task as it was and can tell it from a live one.

`adoptJobs` now has three outcomes for a sidecar that is ours: live leader → running task (as before);
dead leader with a group that still exists and nothing living at the pid → a **finished** job in the
registry (`finishedStatus` from the recorded exit code, `finishedAt` restored, `backgrounded` taken from
the meta so a foreground-origin record does not appear in the `bg_wait` table); otherwise unlink, as
before. It is claimed (`writeMeta`) because with the previous runtime gone this one is the only one that
will signal that group. From there `killAllJobs`'s filter and `bg_stop` reach it with the same code as
their own finished jobs — which is what `test/reload-leftover.test.ts` needed, and
`test/leftover-record.test.ts` pins the handover, the by-ID stop, and that it is never reported as running.

Collecting such a record: `stopLeftoverGroup` unlinks it when it ends with the group gone; a record whose
group is still alive is now in `pruneRetention`'s protected set (alongside foreign-owned and this-runtime
-running ids, computed in the same pass over the sidecars) so the count sweep cannot strand a live group;
and once the group is gone the record is back under the age and count rules, and is unlinked outright at
the next `session_start`. **No eager mid-session sweep** — `retention-in-session.test.ts` pins that a
dead-pid sidecar is left in place (and tightened) by a mid-session pass, so a stale record can sit for up
to the 3-day window. That is a 400-byte file, and it is the same rule that already governs every other
sidecar.

### F10 — a key that is present wins, `""` and `null` included

`configuredSetting` resolves a key as "the innermost scope that mentions it": `Object.hasOwn` on the
parsed scope, project-of-the-process-cwd first; a string (empty included) or `null` is the value, anything
else — number, object, `undefined` — falls through to the next scope, and a scope that is missing,
unreadable or not valid JSON answers nothing (`continue`, not a throw). `shellPath: null` and
`shellCommandPrefix: ""` therefore mean unset, matching `deepMergeObjects`. Still resolved once per runtime:
`shellSettings()` caches the whole `ShellSettings` object, both keys together, on first use.
`test/settings-robustness.test.ts` pins the malformed-scope and non-string cases.

### F11 — a broken `shellPath` is named, as an error result

`resolveShellSettings` checks a _configured_ shell once per runtime and records `missingShellPath`; the
bash `execute` answers `Custom shell path not found: <value>` + `Cannot execute bash commands.` with
`isError`, next to the missing-working-directory check, and never spawns. Pi throws that exact string from
`getShellConfig`; it stays a result here for the reason already recorded under F6. Deliberate divergence:
Pi checks the configured value with `access(path, F_OK)`, which rejects a bare name (`shellPath: "sh"` is
broken in Pi itself), while a value with no separator is looked up on `PATH` here — green tests
(`settings-scopes`, `shell-precedence`) configure `sh` and `bash` by name. Documented in the README, along
with the unchanged default-shell divergence.

### Tests I touched, and why

- `wait-listing.test.ts`, "lists finished background tasks even when nothing is running": added
  `await sleep(200)` after the `isAlive` wait. Genuine flake, seen once in a full parallel run — `isAlive`
  calls a signalled child finished the moment it is a zombie, the extension's exit handler lands a moment
  later, and `bg_wait` then legitimately reports "1 task(s) finished". The neighbouring test in the same
  file already does exactly this, with a comment saying so. No assertion changed.
- `lifecycle.test.ts`: the loads the previous two passes blamed for the surviving temp dirs now use
  `vi.resetModules()` and their own `agentDir`, and the two-runtime test now really has two registries (its
  `bg_stop` cleanup gained a `waitFor`, since the shared-registry version was only stopping `kept` as a side
  effect of `quit`). That note is deleted from this file.
- Out of the loop's package but the same leak: `pi-takeover/test/extension.test.ts` and
  `handoff.test.ts` loaded an extension in `beforeAll` and never disposed it — those were 4 of the 6
  surviving `/tmp/pi-ext-*` directories. Both now have `afterAll(() => ext?.dispose())`.
  **A clean full run now leaves 0 `/tmp/pi-ext-*` directories and no stray processes.**

New pins: `test/leftover-record.test.ts` (3), `test/stop-window.test.ts` (2),
`test/settings-robustness.test.ts` (2). Marker sleeps used here: 155, 157, 159, 161.

### For pass 3 — what to attack

- **The two-window cap against `teardownTimeout: 10_000`.** A shutdown that genuinely needs both windows
  can wait up to 12 s; in a test that is a teardown timeout. Measure rather than assume: how long does a
  quit take when a task is running, its leader dies on SIGTERM and a member ignores SIGKILL for a while
  (an unreadable/`D`-state member, or a group whose leader was `SIGSTOP`ped)? Nothing in the suite pays
  both windows fully today.
- **`stopLeftoverGroup`'s record unlink** happens only when `!processGroupExists(pid)`. A member that
  cannot be killed (uninterruptible sleep) keeps the group "existing", so the record survives and is now
  also protected from retention by the live-group rule. Is that the right trade, and can a run accumulate
  protected records (one per stuck group) without bound?
- **The ownership chain for inherited records**: the adopting runtime rewrites `ownerPid`, so a third
  runtime sees a live owner and leaves it alone. Reload twice, then kill the middle runtime without a
  shutdown: does the record still find someone, and does `isOwnedByAnotherSession`'s recycled-pid rule
  (F7) interact badly with a record that is now expected to be inherited repeatedly?
- **`shellPathExists` uses `process.env.PATH`, while commands get `<agent-dir>/bin` prepended** by
  `buildEnv`. A `shellPath` naming a program that lives only in `<agent-dir>/bin` resolves for the child
  and not for the check, so the tool would refuse every command. Also: the check is `F_OK`, so a directory
  or an unreadable file passes and the failure is back to a spawn error (this is Pi's behaviour too).
- **`finishedAt` / `exitCode` carried in a sidecar** are trusted numbers on adoption. A truncated or
  hand-edited sidecar, or one written by an older version, decides what `bg_wait` reports; check the
  bounds (`finishedAt` before `startedAt`, absurd runtimes) and that nothing arithmetic-dependent keys off
  them.
- Whether the finished-record should be listed by `bg_wait` when `meta.backgrounded` was true: it is, and
  `wait-listing.test.ts` does not cover it. The README's "finished in the foreground, not in the table"
  rule is what decides it.
- Still open from pass 1, unchanged: retention driven by completions, `tightenPrivate` on another
  runtime's files, the recycled-`ownerPid` heuristic, Pi's `/bin/bash` → `bash` → `sh` fallback (now
  documented in the README rather than merely absent).

Harness notes:

- `hasLeftoverGroup` is the only thing that distinguishes "the leader died" from "the group is gone", and
  it is two `kill(2)` calls; it is now called from `markDone`, `finishedResult`, `releaseJobRecord`,
  `killJob`'s timer, `killAllJobs`, and `pruneRetention`. A test that wants a group to look gone has to
  make it actually gone (the reap poll means "about to be gone" reads as existing for up to 1 s).
- `killAllJobs` caps at two windows, so a test asserting a shutdown waited must say which window it means;
  a finished task at entry has one, a running task with an immune member has two that overlap.
- A test that asserts on files under `agentDir` needs its own `agentDir` per test in this file — the log
  dir is shared across the handover test by design and nothing else.

---

## Pass 3 — tester

Baseline: `f0e7dd9`, 243/243 green, and a clean run leaves no `/tmp/pi-ext-*` and no strays (checked
again: still true with this pass's files added). After the pass: **248 green, 8 red in 4 files**, all
written by this pass; 106 in the package (98 green, 8 red). `tsc` and biome are clean, `npm run check`
fails only on the 8. Reproduce with `npx vitest --run packages/pi-bg-tasks`.

Findings, most valuable first. Each is covered by a red test that fails for exactly the stated reason.

### F12 — a bare `shellPath` is looked up on the runtime's PATH, not on the PATH commands get

`buildEnv` puts `<agent-dir>/bin` in front of the `PATH` handed to every command, exactly as Pi's
`getShellEnv` does, and hands that environment to `spawn` — libuv resolves a bare program name against
the **child's** `PATH`, which is what makes `shellPath: "bash"` work at all. The check that decided to
support bare names scans a different `PATH`: `shellPathExists` reads `process.env.PATH`, the runtime's
own, which never has the agent dir's `bin` in it. So a shell the user installed in pi's bin dir — the
documented place for user executables, and the one directory every command of the session can see — is
refused, and refused for _every_ command of the session (`Custom shell path not found: …`), while the
child would have run it.

Evidence: `shellPath: "audit-session-shell"`, the program at `<agentDir>/bin/audit-session-shell`. The
tool answers `Custom shell path not found`; the same file, reached through the environment `buildEnv`
builds, executes as a shell (checked directly with `spawn(name, args, { env })`).

Red: `test/shell-path-lookup.test.ts`, first test.

Direction: resolve the candidate against the PATH the child gets (`binDir` first, same order as
`buildEnv`), and keep the once-per-runtime cache. Going the other way — dropping bare names and using
Pi's `F_OK` on the literal value — is also coherent, but then the README's "looked up on `PATH`"
sentence and the `settings-scopes` / `shell-precedence` pins that configure `sh` and `bash` by name have
to go with it.

### F13 — a settings file containing the JSON value `null` makes every command throw

`JSON.parse("null")` succeeds and answers `null`, and `Object.hasOwn(settings, key)` is outside the
`try`, so `configuredSetting` throws `TypeError: Cannot convert undefined or null to object` out of the
`bash` tool's `execute`. One file — a project's `settings.json` written by a script with an unset
variable, say — breaks every command in the session, with a message that points at neither file. Pi
answers an empty scope plus a reported load error for the same content (`tryLoadFromStorage` catches the
throw from `migrateSettings`) and carries on.

Red: `test/settings-robustness.test.ts`, two tests (project scope null, agent scope null). Nothing else
about a scalar scope misbehaves: `[]`, `"x"`, `42`, `true` all answer nothing for the key and fall
through.

Direction: a parsed scope that is not a non-null object answers nothing for every key. Two lines, and it
keeps the "a malformed scope does not lose the scope that is readable" rule the file already pins.

### F14 — the registry cap throws away the obligation the kept record exists to carry

Pass 2 keeps a finished background task's sidecar while its process group lives, and adopts such a record
in a replacement runtime, because the sidecar is the only record of the group id somebody still has to
stop. The thing that carries that obligation is the job in the registry: `killAllJobs` filters
`status === "running" || hasLeftoverGroup(job)`, and `bg_stop` looks the ID up in `jobs`. `enforceRegistryCap`
then drops the oldest finished job whenever the registry passes `MAX_REGISTRY_SIZE` (200) — and a session
passes 200 by running commands, since every command, foreground ones included, is a registry entry. The
record stays on disk (protected from retention by the live-group rule, which is the point of it), and the
runtime that started the task forgets it: it disappears from `bg_wait`, `bg_stop` answers
`Unknown task: bg-…`, and a quit shutdown signals nothing. Measured with one daemonising task followed by
201 sequential foreground `true` commands: the sidecar is there, `bg_wait` lists nothing, the worker is
alive after the shutdown.

That is the F9 hole, reopened by a cap, and the "always stop on real shutdown" sentence is what does not
hold. It does not need anything exotic: 200 commands is an ordinary session.

Red: `test/record-cap.test.ts`, two tests. They are two requirements, not one: the shutdown must leave no
process behind, and the ID must keep working while the record stands. If the second is judged out of
scope, say why — `bg_stop`'s error text currently offers "tasks older than the retention window are no
longer tracked" as the explanation, and this task is not that.

Direction: `enforceRegistryCap` should evict what carries nothing before it evicts what carries something
(a finished job with `hasLeftoverGroup` is not a candidate while anything else can go). If that risks an
unbounded registry (a session that daemonises thousands of times), say what the bound is instead of
letting the cap quietly drop obligations.

### F15 — a configured shell that exists but cannot be executed still arrives as exit 127

`shellPathExists` is Pi's `access(path, F_OK)`, which a directory and a 0644 file both pass. The setting
then reaches `spawn`, which answers EACCES; the log gets `[bg-tasks] failed to start command with
<path>: spawn <path> EACCES` and the result is `Command exited with code 127` with
`structuredContent.exit_code: 127` — the failure mode F11 exists to prevent, one check over. Pi has the
same hole, and this extension's README promises otherwise: a value "is checked before anything is
spawned … instead of running something that cannot start".

Red: `test/shell-path-lookup.test.ts`, two tests (a directory, a non-executable file). They assert that
the result does not report a command exit code and does say something about the configured shell, without
pinning wording.

Direction: "can be executed" means a regular file with `X_OK`, not `F_OK`. Keep it once per runtime, and
keep it a result rather than a throw, for the reason already recorded under F6.

### F16 — a runtime deletes a sidecar it cannot parse, including another live session's record

`adoptJobs` parses a sidecar and, on failure, unlinks it and moves on — before any ownership question,
which it cannot ask without the parse. But sidecars are rewritten in place (`openPrivate(path, "w")`
truncates, then the bytes arrive), so a runtime that lists the log dir during another runtime's
`writeMeta` sees a partial file and removes it; a runtime killed during a write leaves the same shape
permanently. `writeMeta` runs at every spawn, at every release to the background, at every `markDone`
that keeps a record, and at every adoption, and `adoptJobs` runs at the start of every nested `pi` — which
is the situation the README's headline bug is about.

What the victim loses is the record itself, and every rule that reads it: a live command's sidecar gone
means not adoptable after a reload, not protected by the foreign/live-group/running protections, so its
log is prunable and its process is nobody's to stop.

Red: `test/cross-process.test.ts`, one test: this session's live background command, its sidecar cut to
half its bytes (standing in for a read during the write), and the foreign runtime's `sidecarsAfter` no
longer contains it.

Direction: two independent halves. Leave an unparseable sidecar where it is — retention's age and count
rules collect garbage without anyone destructively guessing at it. And make the write atomic (write
`<id>.json.tmp` in the same directory, `renameSync` over the target) so no reader can see a half file in
the first place; if a temp name is introduced, check the retention walk and the log-count rule against it,
and decide who collects a `.tmp` left by a crash.

### New pins, all green

- `test/stop-under-pressure.test.ts` (2). The reach half of the F8 fix: a member a SIGTERM can never
  deliver to, because it is `SIGSTOP`ped, is still ended by the escalation and `bg_stop` says it stopped
  the group. And eight tasks of that shape are swept by one shutdown, which returns in ~5.1 s — the two
  windows really do overlap; eight such groups cost the same as one (pinned under 8 s, against a
  `teardownTimeout` of 10 s).
- `test/inherited-record.test.ts` (2). The `backgrounded` field of a kept record, which pass 2 introduced
  and nothing covered: a backgrounded task's record is listed by `bg_wait` after a handover as the
  finished task it was (`completed (exit 0)`, `adopted`), never as a running one; a foreground-origin
  record is not listed — and its group is stopped all the same.
- `test/cross-process.test.ts` (1) and `test/fixtures/foreign-runtime.mjs` (`--spawn <command>`). The
  cross-process half of F9, which the in-process reload tests cannot reach: a runtime that goes away
  **without** a shutdown (the fixture exits after its task finishes, handlers never run) leaves a finished
  task's record, and the next session adopts it, lists it as finished and adopted, stops its group at its
  own shutdown, and drops the record with the group.

### Attacked, no finding

Recorded so pass 4 does not spend time here.

- **`killAllJobs`'s two-window cap is unreachable, and nothing about it is wrong.** `stopJobAndWait` can
  in principle wait 6 s for a leader and then 6 s for a group, and the shutdown cap is
  `2 * (SIGTERM_GRACE_MS + 1000)` = 12 s, past `teardownTimeout: 10_000`. To pay the second window a
  member has to survive the escalation's `SIGKILL` at t=5 s, and the escalation signals `-pid`, which
  includes the leader. A stopped member does not survive it (pinned green); a `D`-state member cannot be
  produced from an unprivileged container; a member owned by another user would need one. Measured: eight
  immune groups, one shutdown, 5109 ms, all eight gone. So 12 s is a bound no reachable shape pays, and
  the shape that could pay it is a shape no stop can win.
- **A leftover group we may not signal.** `processGroupExists` answers EPERM as "exists", so
  `hasLeftoverGroup` is true and `stopLeftoverGroup`'s first `kill(-pid, SIGTERM)` throws, which returns
  `false` without unlinking: the record then sits under the live-group protection forever. Unreachable in
  the sandbox, bounded by the number of groups this user may not signal, and the direction is the safe
  one (it does not claim a stop it could not make). The same early return also skips the unlink when the
  group vanishes between the check and the signal — one stale record until the next `session_start` or
  retention pass. Not worth a test either way.
- **An abort landing between the timeout timer and the `finally` is not a turn that exists.** Twelve runs
  of `sleep N` with `timeout: 1` and the abort jittered ±1 and ±8 ms around the expiry ended in exactly
  one of two coherent states every time: `Command aborted` and the command gone, or `timed out … moved to
  background` and the command alive (the documented survivor of a later abort). None reported a
  backgrounding and killed the task. The reason is ordering, not luck: once the race settles on
  `"timeout"`, the continuation of `runWithTimeout` runs as microtasks before any later macrotask can
  dispatch `abort`, and there is no `await` between the race and `releaseToBackground`. Left untested;
  it is a fuzz on timing margins.
- **The numbers a sidecar carries are trusted, and only the report is hurt.** A record hand-edited to
  `startedAt: 9e15`, `finishedAt: 0`, `exitCode: 1e999`, `signal: "SIGMOOSE"` is adopted and reported as
  `killed (exit Infinity)` with `-9000000000000.0s`; the group was still stopped at shutdown, and the
  only arithmetic keyed off those fields is `wallSeconds`. A `signal` that is not a signal name is enough
  to make the status `killed`, since `finishedStatus` only tests truthiness. A record can also point
  `log_path` at any file this user can read and `bg_wait` will report its size and line count — a 0700
  directory written by that same user, so not a trust boundary. If anyone wants the reporting tidy:
  validate on adoption (finite, integral, `finishedAt >= startedAt`, `signal` in `osConstants.signals`).
  A _truncated_ sidecar parses to nothing and is dropped — see F16 for what dropping costs.
- **The ownership chain across more than two runtimes.** Worth knowing when reading the reload tests:
  every in-process runtime in the suite shares `process.pid`, so `ownerPid` always reads as "ours" and
  those tests pin handover, not foreignness. The foreignness and adoption rules that do differ are now
  pinned across a real process boundary (the new `--spawn` fixture test). A third runtime can only see a
  record whose recorded owner is already dead, which is the adopt case; a live owner is left alone
  (`sidecarsAfter` keeps it, pinned).
- **`configuredSetting` beyond `null`.** Missing, unreadable, `EISDIR`, invalid JSON, and a top-level
  `[]`, `"x"`, `42` or `true` all answer nothing or fall through, as pinned. With `PATH` unset a bare
  name is correctly reported as missing, because the child would not find it either.
- **Retention against kept records, `setsid`, double stops, zombie leaders.** Unchanged from the pass-2
  record; the mid-session pass still leaves a dead-pid sidecar alone, and the new foreground-record pin
  confirms the id-based protection covers a record nothing lists.

### For pass 4 — what to attack

- **F16's atomic write**, if it is taken: `.json.tmp` names must not be read as sidecars by `adoptJobs`
  (they do not end in `.json`) nor counted as logs, must not be `tightenPrivate`d into something's way,
  and a crash leaves temp files that nothing currently collects.
- **F14's bound.** If obligation-carrying jobs are no longer evictable, what happens in a session that
  daemonises thousands of times, and does `enforceRegistryCap` then have any candidates left at all? If
  instead the registry keeps dropping them, the shutdown and `bg_stop` have to find the obligation
  elsewhere — which means a sidecar scan in the stop path, with the ownership rules that implies.
- **F12's cache against `buildEnv`.** `buildEnv` builds the PATH per call from `process.env`, while the
  shell (and its existence answer) is resolved once per runtime. A `PATH` change inside a runtime now
  changes what a bare `shellPath` means for the child but not for the check. Also Windows: the same
  lookup wants `where`/`PATHEXT` thinking, and the file's second describe (`X_OK`, `isFile`) is POSIX-shaped.
- **`stopLeftoverGroup`'s early `return false` on a failed first signal** — it conflates "could not
  signal", "group is gone" and "nothing to do". Nothing observable depends on it today.
- Carried forward, still open and still cosmetic-or-documented: `tightenPrivate` on files another live
  runtime owns, the recycled-`ownerPid` rule, Pi's `/bin/bash` → `bash` → `sh` fallback, retention driven
  by completions.

### Harness notes

- Marker sleeps used by this pass: 163, 165 (`record-cap`), 167, 169 (`stop-under-pressure`), 171, 173
  (`inherited-record`), 177 (`cross-process`).
- **Do not set the loaded extension to `undefined` after an in-test `session_shutdown`.** It makes
  `afterEach` skip `dispose()`, and the load's temporary _working_ directory is left behind: eight
  `/tmp/pi-ext-*` directories, all from two files. Emitting the shutdown again in `afterEach` is a no-op,
  so dispose unconditionally instead.
- `test/fixtures/foreign-runtime.mjs --spawn <command>`: starts the command as a background task of its
  own, waits for it with `bg_wait` so the task's own record is written the way a finished task writes it,
  prints `spawned: {id, pid}`, and exits **without** running the shutdown handlers — a runtime going away
  without stopping what it started.
- The registry pressure in `record-cap.test.ts` needs **sequential foreground** fillers: they have all
  finished before the cap is asserted, they leave no log or sidecar behind (so retention is out of the
  picture and the only record in the log dir is the one under test), and the leftover record is the oldest
  finished job, i.e. the first eviction candidate. 201 of them cost ~400 ms; the red version of the first
  test runs ~13 s because it waits out the "is it gone?" check.
- A `SIGSTOP`ped process is still scannable through `/proc/<pid>/cmdline` and is still killed by the
  escalation. `kill -STOP $!` from inside the spawned shell races the `exec` and can stop bash instead of
  the worker — stop the member from the test process, after finding it by its marker.
- `settings.json` holding `null` is the only JSON value that breaks the scope walk; `[]`, `"x"`, `42` and
  `true` are inert. If a test wants a _parse_ failure, an empty file or `{"key": ` is the way.
