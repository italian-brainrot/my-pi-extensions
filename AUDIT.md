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

---

## Pass 3 — fixer

All 8 red tests green, none of them edited. `npm run check` passes end to end (deps, manifest, skills,
tsc, biome, **270 tests**: 248 carried, 8 fixed, 14 new pins). Reproduce with
`npx vitest --run packages/pi-bg-tasks` (120) or `npm test` (270). A clean full run again leaves 0
`/tmp/pi-ext-*` directories and no stray processes.

### F12 — the shell check answers for the PATH the child gets

New `commandPathDirs()`: this process's `PATH`, with `<agent-dir>/bin` prepended if it is not already
there — the exact value `buildEnv` now puts into the environment, so the two cannot drift. `buildEnv`'s
own inline version of that logic is gone; one place builds a PATH. libuv resolves a bare program name
against the child's environment, so a shell in pi's bin dir is now accepted, and the check no longer
refuses a name that every command of the session could run.

Still one scan per runtime: `resolveShellSettings` caches the whole `ShellSettings`, and
`commandPathDirs()` is called inside it. It is also called per spawn by `buildEnv`, which is where it was
called before.

### F13 — a scope that is not an object answers nothing

`configuredSetting` parses to `unknown`, then `if (parsed === null || typeof parsed !== "object") continue`
before `Object.hasOwn`. One line, and it keeps both rules the file already pins: a malformed scope does not
lose the scope that _is_ readable, and only a missing key falls through.

### F14 — the cap may not drop the obligation, and what bounds the registry instead

Chose the strict version of the tester's direction, not the conditional one: `enforceRegistryCap` never
evicts a finished job that carries a live-group obligation, even when nothing else can go. The conditional
version ("while something else can go") still drops the obligation once the registry is all obligations,
which is the hole.

- `BgJob.groupRecord` says this job's sidecar exists to name a group that still has to be stopped. Set in
  `releaseJobRecord` (where `hasLeftoverGroup` is exact) and on the adopted-record branch of `adoptJobs`;
  cleared by `stopLeftoverGroup` when it ends with the group gone, and by the cap when it re-checks
  `hasLeftoverGroup` and the group has since died. The flag is a shortcut that keeps the cap's loop off
  200 `kill(2)` pairs per spawn; the answer is always re-checked for a flagged entry before anything is
  skipped.
- **The bound:** the registry can sit over `MAX_REGISTRY_SIZE` by one entry per live process group still
  waiting to be stopped — the same shape, and the same justification, as the log dir's "cap plus the
  protected files", which the README already states that way. Those entries are not permanent: a group is
  stopped by `bg_stop` or a shutdown or dies on its own, and the entry then evicts like any other finished
  job (pinned). A session that daemonises a thousand times has a thousand live groups, and no cap on a map
  of ids fixes that; the cap bounds bookkeeping, not processes.
- No sidecar scan was added to `bg_stop` or to `killAllJobs`. With eviction fixed, the entry is always in
  the registry of the runtime that owns the record; adding a scan would let a stop reach records this
  runtime deliberately did _not_ adopt (another session's, or one from before its own `session_start`),
  which is the ownership rule doing work. If pass 4 finds a path where an obligation is on disk and not in
  the registry of its owner, that scan is the fallback, with `isOwnedByAnotherSession` in it.
- `bg_stop`'s "Unknown task" text no longer blames "tasks older than the retention window"; it says a task
  stops being tracked once its log and sidecar have been pruned, which is now the only way it stops being
  tracked.

### F15 — "can be executed", not `F_OK`

`shellPathExists`/`isAccessible` became `unrunnableShell` + `shellCandidateState`: `statSync` must answer a
regular file, then `accessSync(X_OK)`. A bare name walks `commandPathDirs()` in order and treats a
non-executable entry as libuv does — skip it, keep looking — so the message can tell the two kinds of "no"
apart: `Custom shell path not found: <value>` (nothing of that name is runnable anywhere on that PATH) and
`Custom shell path not executable: <value>` (something is there and cannot be run). Both stay error
results, for the reason under F6, and `settings-shell-edges`'s pin on Pi's wording still passes. Windows
skips the `X_OK` half (no executable bit to consult; a `.cmd` is no more executable to `access()` than a
text file) and keeps the "is a file" half, which rejects a directory there too.

Deliberate divergence from Pi, as the tester said: Pi's `access(path, F_OK)` is relative to the working
directory and so rejects bare names, and passes a directory. README updated: the PATH checked is the one
commands get, in the order commands search it, and "found" means a runnable regular file.

### F16 — a reader leaves what it cannot read, and a writer never writes half a file

- `adoptJobs` no longer unlinks a sidecar that fails to parse: `if (!meta) continue`. It cannot ask the
  ownership question without the parse, and the file may be another live session's only record of a command
  it is waiting on. Retention's age and count rules collect garbage without anyone guessing at it, and the
  retention pass at the end of `adoptJobs` is where that happens.
- `writeMeta` writes `<id>.json.tmp` in the same directory (via `openPrivate`, so 0600) and `renameSync`s it
  over the target. A reader sees the old record or the new one, never a partial one.
- **Who collects a temp:** `pruneRetention`, which already walks every name. A `.json.tmp` matching `bg-*` is
  `tightenPrivate`d and, once older than `TEMP_FILE_MAX_AGE_MS` (60s — longer than any write and rename can
  take, so a live runtime's in-flight temp is never in range), unlinked. `adoptJobs`'s walk skips temps (they
  do not end in `.json`), `enforceRetention`'s cheap count counts only `.log` names, and the count sweep
  still pairs logs with sidecars by id, so a temp never enters it.
- README: the log-dir paragraph now says sidecars are written by rename, that an unreadable record is left
  alone, and that temps age out; the reload section says what the 200-entry task list may and may not drop.

### Tests I touched, and why

- `test/settings-robustness.test.ts`: **appended** two tests (a scope that is `[]`, a scope that is `42`), no
  existing test changed. `null` was the only value that broke the walk; the pins keep the guard from growing
  into a rule that also discards a readable scope. That file is the tester's, and it is where those two
  belong; adding to it is not editing their tests.

New pins: `test/shell-path-resolution.test.ts` (7 — bin dir wins over the rest of PATH, a non-executable
PATH entry is walked past, a symlink is followed, "not found" for a bare name nowhere to be found, "not
found" with `PATH` unset, "not executable" for a name that is there but unrunnable, nothing is checked when
`shellPath` is unset); `test/registry-cap.test.ts` (2 — the cap still evicts finished jobs that carry
nothing, and a record's protection ends with its group); `test/sidecar-files.test.ts` (3 — no temp survives a
normal run, a stale temp is collected and a fresh one tightened and kept, an unparseable record stays and is
not adopted and ages out).

`MEMORY.md`: no line added. What changed is in the code comments and the README; the one host fact worth
keeping (libuv resolves a bare name against the child's environment) is already in the `commandPathDirs`
comment where it is used.

### For pass 4 — what to attack

- **F14's bound at scale.** The registry is now `cap + live groups`. A runtime that adopts 300 records whose
  groups are alive at one `session_start`, with the registry already at the cap: does `enforceRegistryCap`
  stay cheap (it re-checks `hasLeftoverGroup` per flagged entry, so 300 × 2 `kill(2)` calls per spawn while
  the registry is over the cap), does one shutdown sweep them inside `teardownTimeout`, and does `bg_wait`
  still answer sensibly with 300+ tasks?
- **A live job with no sidecar.** `writeMeta` failing is deliberately non-fatal. What is a running job whose
  record was never written (log dir made unwritable, or a temp collected under a suspended runtime)? It is
  stoppable by this runtime, invisible to the next one, and unprotected from retention. That is the shape
  pass 3's atomic write makes rarer rather than impossible.
- **F12's cache against a `PATH` change inside a runtime:** the check uses the PATH at resolution time,
  `buildEnv` uses it per command. The existing rule is "the shell is chosen once per runtime"
  (`environment.test.ts`), and the README repeats it; a test that changes `PATH` mid-runtime and expects the
  other answer is arguing with that rule, so decide whether the rule is right before writing it.
- **Windows is still unexercised and POSIX-shaped:** `PATHEXT` is not consulted, so a `shellPath` of `bash`
  there resolves only to a file literally named `bash`; `unrunnableShell` splits on both separators; the
  leftover-group path is inert. Nothing claims otherwise, and there is no Windows runner.
- **A zombie adopted leader drops its record.** `isAlive` calls a zombie finished, so the adopted-job poller
  can call `markDone` while the leader is still at its pid — `hasLeftoverGroup` then reads false
  (`processAt` → true) and the record is dropped even if the group has members. Pass 2 recorded the same
  reasoning as unreachable (init reaps an orphan), and no shape in the suite makes an adopted leader's
  parent fail to reap it. A subreaper (`prctl(PR_SET_CHILD_SUBREAPER)`) would; nothing here sets one. Worth
  confirming rather than re-deriving.
- Carried forward, unchanged: `stopLeftoverGroup`'s early `return false` conflating "could not signal" with
  "nothing to do", `tightenPrivate` on files another live runtime owns, the recycled-`ownerPid` rule, Pi's
  `/bin/bash` → `bash` → `sh` fallback, retention driven by completions, the numbers in a sidecar being
  trusted by the report.

### Harness notes

- Marker sleeps this pass: 179 (`registry-cap`), 187 and 189 (`sidecar-files`).
- **`loadExtension({ env: { PATH: … } })` is how a test controls the PATH both the check and the child
  see.** The extension resolves the shell at first use, which is after the load, so load options are
  enough; `PATH: undefined` deletes the variable, which is what "no PATH at all" needs. Do not change
  `process.env.PATH` after a load and expect the cached answer to follow.
- A backgrounded task's log survives its completion (only a _foreground_ log is deleted when it was not
  truncated), so an assertion that a run "left nothing behind" has to filter `.log` out, or it will fail on
  a log that is correctly under retention rules.
- Temp collection is time-based (60s), so a test backdates the stale temp — `utimesSync` with ~10 minutes —
  rather than waiting for the grace.
- A test that runs two in-process runtimes on one agent dir must dispose the second in its own body:
  `afterEach` only knows the load in `ext`, and an undisposed load leaks its temp working dir.
- The registry-pressure recipe from pass 3 still holds: 201 sequential foreground `true` commands, which
  leave no log and no sidecar, so the only files in the log dir are the ones under test.

---

## Pass 4 — tester

Baseline: `200f672`, 270/270 green, 0 `/tmp/pi-ext-*` and no strays after a clean run. After the pass:
**268 green, 19 red in 7 files**. Fifteen of those tests are this pass's (13 red, 2 green); four are
pi-takeover tests that have nothing to do with `pi-bg-tasks` and are themselves finding F22. In the
package: **122 green, 13 red in 4 files, 33 files total** (was 120 green, 28 files). `tsc` and biome are
clean and `npm run check` fails only on the red ones. Reproduce with `npx vitest --run packages/pi-bg-tasks`.

The four pass-3 fixes all hold in the shapes they were written for. Two of them broke at the edge where
they meet something outside the extension — Pi's PATH, and the working directory of the command — and the
unified PATH turned out to be the part that changed behaviour.

### F17 — the PATH commands get is rebuilt, and a PATH entry that means "here" is dropped

`commandPathDirs()` splits `PATH` on `delimiter`, `.filter(Boolean)`s it, and `buildEnv` joins the result
back together. Pi's `getShellEnv` (utils/shell.js) does the same split **only to decide whether the bin dir
is already an entry**, and then hands the configured string on: `hasBinDir ? currentPath :
[binDir, currentPath].filter(Boolean).join(delimiter)`. An empty entry is not noise — bash, sh and libuv
all read it as the current directory of the command (verified: with `PATH=:/usr/bin:/bin` and a child cwd
holding `toolsh`, `spawn("toolsh", {cwd})` runs it; drop the empty entry and the same call is ENOENT).
So a session whose `PATH` was assembled as `PATH=$SOMETHING:$PATH` with `$SOMETHING` unset — or with a
trailing separator — can run a bare command out of its working directory with Pi's tool and gets
`command not found`, exit 127, with this one. The README's "`<agent-dir>/bin` is prepended to `PATH`,
matching the built-in tool" is the claim that does not hold: the bin dir is prepended, the rest is rebuilt.

This is also a pass-3 regression in one branch: before `commandPathDirs`, `buildEnv` only wrote
`env[pathKey]` when the bin dir was missing, so a `PATH` that already contained it was passed on verbatim,
empties included, exactly as Pi does. Now it never is.

Red: `test/shell-path-cwd.test.ts`, first three tests — a bare command that only an empty entry can find
answers 127; the entries a command sees, asserted against the configured string entry by entry; and the
bin-dir-already-on-PATH case, where pass 2 behaved like Pi and pass 3 does not.

Direction: hand on what was configured — `binDir` first, then the configured string, no split-and-refilter.
An empty entry then has to be answered honestly by the `shellPath` walk, where it means the cwd of the
command, i.e. F18. If instead the rebuild is judged deliberate, the README sentence and the
`commandPathDirs` comment ("the exact value `buildEnv` now puts into the environment" is about internal
agreement, not about Pi) both have to say so.

### F18 — a configured shell is resolved against the runtime's directory, not the command's

`resolveShellSettings` resolves a `shellPath` value with `statSync`/`accessSync` from the **extension
process**, and caches it once per runtime. The child is spawned with `cwd: ctx.cwd`, which is the _session_
cwd, and those differ in real Pi: `SessionManager.open` takes the cwd from the session header
(session-manager.js:1344), a replacement runtime is built with `cwd: sessionManager.getCwd()`
(agent-session-runtime.js:134-138), while `SettingsManager` — and therefore `process.cwd()` — stays where
pi was started (main.js:467). For a value with a separator that is relative, and for a bare name with a
relative or empty PATH entry, the check and the child look at two different files. Both directions are bad:
the session's own shell is refused for every command of the session, or the check passes, `spawn` fails
with ENOENT, and a broken setting arrives as `Command exited with code 127` — the exact shape F11/F15 exist
to prevent. Note this is not Pi's bug being re-reported: Pi's `access(path, F_OK)` is equally relative, but
this extension's README promises "the question it answers is the one the child asks".

Red: `test/shell-path-cwd.test.ts`, last two tests. `shellPath: "./session-dir-sh"` with the program in the
session directory answers `Custom shell path not found`; `shellPath: "./runtime-dir-sh"` with the program
in the runtime directory passes the check and then reports `exit_code: 127` and a `failed to start command
with ./runtime-dir-sh` note.

Direction: pick one and say which. (a) Keep "chosen once per runtime" per _directory_: cache the resolved
answer under `(configured value, cwd)` — a session has one or two cwds, so the rule stays true in the sense
the README means. (b) Make the agreement structural: let the walk return the absolute path it found and
spawn that, so a bare name cannot disagree with itself, and treat a value containing a separator as relative
to the spawn cwd (which needs the check to know the cwd, i.e. (a) anyway for the relative case). (c) Answer
a relative value with its own message and never spawn it — simplest, but it loses the ability to say
"found". Whatever is chosen, `settings-scopes`, `shell-precedence` and `shell-path-resolution` stay green,
and F17's empty entries make an empty PATH entry mean the same cwd, so the two want one design.

### F19 — an unusable log dir ends the call as a rejected promise carrying an errno

The third environment precondition has no check. `ensureLogDir()` swallows the failure to create the
directory ("A directory that cannot be created is reported by whatever writes into it next"), and the next
write is `openPrivate(logPath, "w")` in `spawnJob`, which is not wrapped. With the log dir un-writable
(`0500`, or a read-only agent dir) or replaced by a regular file — an old install, a stray `touch`, a
half-finished `mv` — every command of the session ends as `EACCES: permission denied, open
'…/bg-tasks/bg-guqfkzh1.log'` / `ENOTDIR: …`: a rejection rather than a result (the treatment F6 rejected
for the working directory), naming a log file that never existed and never naming the directory a user
could act on. The shell and the cwd both got a named, non-throwing answer; this one got neither.

Red: `test/log-dir-unusable.test.ts`, three tests (un-writable dir, a file in its place, and a fourth
control proving an ordinary first command still creates the dir and runs). The third test is a pin for the
fix: a refusal must not be cached the way `brokenShellPath` is, so the session recovers when the directory
becomes writable again.

Direction: check before opening the log, next to `missingWorkingDirectory` — `statSync(LOG_DIR)` is a
directory and `accessSync(LOG_DIR, W_OK | X_OK)` — and return an error result naming `LOG_DIR` with Pi's
`Cannot execute bash commands.` tail. Do not cache the answer across the runtime.

### F20 — the task listing drops running tasks past 30 and tells the model they were finished

`taskSection` prints `LISTING_MAX_TASKS` (30) rows and closes with "(N older finished tasks not listed;
their logs are in …)", where N is `infos.length - shown`. The comment above it reads "Running tasks sort
first, so anything dropped here is an old finished one" — true only while fewer than 30 tasks are running.
With 34 running tasks the table has 30 rows and the sentence says 4 finished tasks were left out, when the
4 are running. The README states the opposite: "The listing shows the 30 newest tasks (running ones are
always included)". A fan-out (`make -j40`, a watcher per package, a loop of `timeout: 0` calls) is enough
to get there, and what the model is told is not just incomplete but wrong.

Red: `test/wait-listing-overflow.test.ts` (2 tests): 34 running background tasks → 30 rows and a false
note; then 34 running plus 4 finished → the note counts 8 "finished" omissions where only 4 are finished.
`details.tasks`/`structuredContent.tasks` carrying all of them is pinned green in the same file.

Direction: either make the code match the README — running tasks are not capped, the cap is on finished
ones — and think about how wide a table that puts in front of the model when a session has 300 running
tasks (`taskListing` pads a column per row with a `Math.max(...rows)` spread), or cap the rows and fix the
note plus the README sentence. The note's count must describe the rows it describes either way.

### F21 — `adoptJobs` deletes a sidecar that parses to something that is not a record

F16's rule is "a record that cannot be parsed is left where it is", implemented as `if (!meta) continue`
after `readMeta`. `readMeta` returns whatever `JSON.parse` answers, and the guard stops only the falsy
ones. A sidecar that parses to `[]`, `42`, `"bg-nobody"` or `true` reaches the ownership question, which
can only answer "nobody's" (no numeric `ownerPid`, no numeric `pid` → `procStateAndParent(-1)` →
"absent"), and is unlinked. That is the destructive guess F16 was written to stop, one type error away:
a reader that cannot recognise a record removes it, which is what an older or newer reader does to a format
it does not know. `null` is the only non-object that is handled, which pass 3 pinned for the _settings_ walk
(F13) but not here.

Red: `test/sidecar-record-shapes.test.ts` (3 tests, `it.each` over `[]`, `42`, `"bg-nobody"`): a live
background task's sidecar replaced with each value; a second runtime's `session_start` must not delete it,
must not adopt it, and the age rule must be what collects it.

Direction: `if (!meta || typeof meta !== "object") continue;`. While there, the same reader-side question
applies to a _recognisable_ record whose fields have the wrong types (`{"pid": "123"}`): it is deleted too,
by the same fall-through. Whether a record with an unreadable shape is the reader's to remove is the
decision to record.

### F22 — the suite is not hermetic: the shell the tests run in configures the extensions

Every extension in this repo reads its configuration from the environment — pi-takeover
`PI_TAKEOVER_MAX_CHAIN`/`_CONFIRM`/`_NAME`/`_DEBUG` at module load, pi-bg-tasks `PI_BG_TASKS_KEEP_RUNNING`
at call time, pi-subagent `PI_SUBAGENT_MAX_DEPTH`/`_DEPTH`, pi-memory `PI_MEMORY_FILENAME`/`_MAX_BYTES`/`_DEBUG`.
`loadExtension` sets `PI_CODING_AGENT_DIR` plus whatever a test asks for and passes the rest through, so
the suite only means anything in a shell that configures nothing. This loop runs from pi sessions, and
those inherit the user's shell: `~/.bashrc` exports `PI_TAKEOVER_MAX_CHAIN=100`, which is why 4 pi-takeover
tests are red in this pass's numbers and why a fixer could waste a pass on them. Measured with
`PI_MEMORY_FILENAME=HOST-NOTES.md PI_SUBAGENT_MAX_DEPTH=0 PI_BG_TASKS_KEEP_RUNNING=0
PI_TAKEOVER_MAX_CHAIN=100 PI_TAKEOVER_CONFIRM=1`: **44 of the 89 tests in pi-memory, pi-subagent and
pi-takeover fail** without a line of code changing. pi-bg-tasks guards its own children against exactly
this ("no `PI_*` leftovers from a parent pi process"); the test process has no equivalent.

Red: `test/env-hermetic.test.ts` (2 tests): with all ten variables set, a `takeover` call must not report a
`/100` chain cap, and a `session_shutdown reason:"reload"` must still keep a running task — the second one
matters because `PI_BG_TASKS_KEEP_RUNNING` is read at call time, so a load-time snapshot is not enough.

Direction: in `loadExtension`, save and delete the extension-owned variables for the whole lifetime of the
load (restored in `dispose()`), so an ambient value reaches an extension only when the test names it in
`env:`. Keep the list next to the harness and consider `repo.test.ts` deriving it by grepping
`process.env.PI_` out of the packages, so a new variable cannot be added without joining it.

### New pins, all green

- `test/many-records.test.ts` (1). F14's bound at a size a long session reaches: 12 daemonised tasks whose
  records are the oldest finished jobs, then 201 sequential foreground fillers. Every record survives the
  cap, `bg_wait` lists all 12 as finished, one `bg_stop` by ID stops one group and drops only that record,
  and one shutdown stops the remaining 11 groups in **153 ms** — one overlapping grace window, not one per
  group. No `.json.tmp` survives the run, and no `.json` survives its group. The 201 fillers cost ~0.4 s,
  so the cap loop's per-entry `hasLeftoverGroup` re-check is not measurable at this size.
- Two green tests inside the red files: the log-dir control (a first command still creates the dir and
  runs) and the `structuredContent.tasks` counts in the listing-overflow file.

### Attacked, no finding

Recorded so pass 5 does not spend time here.

- **`shellCandidateState`'s `X_OK` is the right question, not `R_OK`.** A mode-0111 file is a _start_ for
  libuv: Linux checks `MAY_EXEC` for `execve`, so both a bare name and an absolute path run, and `/bin/sh`
  then fails reading its own script with exit 2 — an ordinary command failure, not a spawn error. A 0644
  file and a directory in a PATH entry are both skipped by libuv, which is what the check does; an
  all-unrunnable PATH gives the child EACCES and the check refuses with "not executable" first. A mode-0755
  script whose `#!` interpreter is missing really does reach `spawn` and answers ENOENT → exit 127, which
  no `stat`/`access` check can see; that makes the README's "instead of running something that cannot
  start" slightly stronger than the code, and is worth a wording fix, not a test.
- **The two messages.** For a bare name whose only PATH candidate is unrunnable, libuv's own answer would
  be ENOENT ("not found") while the extension says "not executable". Deliberate, pinned in pass 3, more
  useful; both refuse the same way. A directory candidate sets the same flag — same reasoning.
- **`~` in a configured value** is expanded (Pi's `access(F_OK)` would refuse the literal `~/…`), so this
  extension accepts something Pi rejects, and a refusal quotes the expanded path rather than what the user
  typed. Cosmetic, in the permissive direction.
- **A value with a trailing separator, `PATH` entries with trailing separators, a symlinked shell, a missing
  `<agent-dir>/bin`, `PATH` unset** — checked against `spawnSync`/`statSync` behaviour by hand and covered
  by pass 3's `shell-path-resolution` pins; `join` collapses the separator cases identically for the check
  and the child.
- **The zombie-adopted-leader case stays unreachable here.** This container's PID 1 is systemd and it reaps
  adopted orphans: 3.5 s after an orphaned leader exits, its pid is ESRCH and `kill(-pid, 0)` is ESRCH, so
  `hasLeftoverGroup` reads the group as gone rather than the leader as alive. The condition for it to become
  real is spelled out for whoever runs the suite elsewhere: a PID 1 that never reaps adopted orphans leaves
  the leader a zombie forever, `processAt(pid)` stays true, and the record is dropped at the next
  `session_start`.
- **An obligation on disk but not in the registry of its owner.** Walked every path out of F14's fix: the
  cap (re-checks before skipping), `markDone` and `finishedResult` (both set the flag and write the record
  together), `adoptJobs`'s `jobs.has(id)` skip (same process, same registry), `pruneRetention`'s
  live-group protection (re-derived from disk each pass), and `stopLeftoverGroup`'s unlink (only when the
  group is gone). Nothing found.
- **A live job with no sidecar** (pass 3's open question). The only consequence is invisibility to _other_
  runtimes: this runtime still stops it (`jobs`), and its log is still protected from this runtime's passes
  by `tracked?.status === "running"`. The reachable ways to get one are a `writeMeta` that fails after the
  log opened — the same directory accepted one and refused the other, i.e. ENOSPC — and both are contrived;
  no test. Note the flag is set regardless of whether the write succeeded (`releaseJobRecord`), so a failed
  write leaves an in-memory obligation with no on-disk record, which is the correct local answer.
- **`bg_wait` with hundreds of tasks**: 213 registry entries and 38 background tasks; the table caps at 30
  rows (see F20), `details.tasks`/`structuredContent.tasks` carry all of them, and counts are cached per job
  on size+mtime, so a listing after adoption is one scan per log, not one per wait.
- **Who collects what, for temps** (F16's edges): a `.json.tmp` is never adopted (it does not end in
  `.json`), never counted as a log, `tightenPrivate`d, and unlinked past 60 s; nothing else in the tree
  reads or removes one. Re-pinned at 12 records in the new scale test.
- **The sidecar's numbers, the recycled `ownerPid`, `tightenPrivate` on another runtime's files, retention
  driven by completions, Pi's `/bin/bash` → `bash` → `sh` default, `stopLeftoverGroup`'s early
  `return false`** — unchanged from the pass-2 and pass-3 records.

### For pass 5 — what to attack

- **F17 and F18 want one answer.** Mirroring Pi's PATH makes empty entries legal, and an empty entry means
  the command's cwd — the same thing a relative value needs. Decide the caching rule first: a check that is
  once-per-runtime cannot answer "where is `./x`" for two different `ctx.cwd` values. Then re-walk the
  ordering rules (bin dir first, first runnable entry wins, `Path` vs `PATH` key casing on Linux, a PATH
  entry that is a symlink to a directory), and make the README say what "found" means now that a bad
  interpreter is known to slip through.
- **F19's fix** must not become a cached per-runtime refusal (test 3 pins recovery), and `pruneRetention`
  still must not re-create the log dir during teardown (`lifecycle.test.ts`'s pin). Also worth a look: the
  `openPrivate` failure inside `appendToLog` is deliberately silent — a spawn-error note for a session whose
  log dir is broken disappears entirely.
- **F20's fix** on whichever side it lands: if running tasks are never capped, bound the model-facing table
  some other way and check `taskListing`'s per-column `Math.max(...rows)` spread at 300 rows; if the rows
  stay capped, the sentence under the table and the README's "running ones are always included" both move.
- **F21's one line**, plus the decision about a record whose _fields_ have the wrong types.
- **F22's scrub list**: every test that deliberately sets one of the ten variables must set it through
  `env:` (pi-memory and pi-subagent mostly do; check the rest), and the list needs a guard so it does not
  rot. This one is outside the loop's package and outside the loop's usual blast radius — a harness change
  touches every package.
- Still open and unchanged: everything listed as carried forward in pass 3.

### Harness notes

- Marker sleeps this pass: 191 (`wait-listing-overflow`), 193 (`many-records`), 197
  (`sidecar-record-shapes`), 199 (`env-hermetic`).
- **`bg_wait { timeout: 0 }` is the cheap way to get a listing** — the wait times out immediately and the
  table is the whole answer.
- A record only reaches the `bg_wait` table if the task was a _background_ task. The `timeout: 5`
  daemonising shape from `record-cap.test.ts` leaves a **foreground-origin** record that is deliberately not
  listed (`inherited-record.test.ts`); use `timeout: 0` when a test wants to see it.
- Two of the new files change `process.env` before a load (`PATH`, the `PI_*` set). Restore them in
  `afterEach`, and note that a test asserting on `process.env.PATH`-relative resolution has to
  `process.chdir` — that is what makes F18 visible at all. `shell-path-resolution.test.ts` already chdirs to
  a temp project dir, which is also where its project-scope `settings.json` lives.
- A test that makes the log dir un-writable must `chmod` it back before `dispose()`, or the temp agent dir
  cannot be removed and the run leaks.
- `existsSync` takes one argument: the assertion message goes in `expect(value, message)`, not in the call.
- **This session's shell exports `PI_TAKEOVER_MAX_CHAIN=100` (from `~/.bashrc`), so 4 pi-takeover tests are
  red for every pass of this loop until F22 is fixed.** Do not chase them as regressions.

---

## Pass 4 — fixer

All 15 of this pass's red tests green; none of them rewritten. The four pi-takeover reds went green with
F22, as the tester said they would — the chain logic was not touched. `npm run check` passes end to end
(deps, manifest, skills, tsc, biome, **301 tests**: 272 carried, 15 fixed, 14 new pins; 145 in the package,
33 files). Reproduce with `npx vitest --run packages/pi-bg-tasks` (145) or `npm test` (301). A clean run
again leaves 0 `/tmp/pi-ext-*` directories and no stray processes, and the whole suite is now green with all
ten extension variables set in the shell — see F22.

The two README-vs-code claims that were wrong in the permissive direction (`<agent-dir>/bin` "matching the
built-in tool", "instead of running something that cannot start") were made true by changing the code, and
the two that were wrong in the narrowing direction ("the question it answers is the one the child asks",
"running ones are always included") by changing the code as well. The one claim no check can support — a
script whose `#!` interpreter is missing — is now said honestly in the README instead.

### F17 — the `PATH` is handed on, not rebuilt

Chose the tester's recommended direction: mirror Pi. `commandPathDirs()` (split → `filter(Boolean)` →
rejoin) is gone, replaced by `commandPathValue()`, which is Pi's `getShellEnv` line for line: split the
configured string only to decide whether `<agent-dir>/bin` is already an entry, then use `currentPath`
itself, or `[binDir, currentPath].filter(Boolean).join(delimiter)`. An empty entry therefore survives into
the child, where bash, `sh` and libuv all read it as the command's working directory, and the
bin-dir-already-present branch behaves like pass 2's did. `buildEnv` calls it; so does the check, through
`commandSearchDirs(cwd)`, so the two still cannot drift.

The comment that claimed the old function produced "the exact value `buildEnv` now puts into the
environment" was true and useless — internal agreement, not agreement with the host. `commandPathValue`'s
comment now says what the value has to agree with: Pi's, and why `filter(Boolean)` is not a no-op.

### F18 — one answer for F17 and F18: resolve where the child resolves, cache per directory, spawn what was found

The tester's option (b) plus the caching half of (a), which the tester noted (b) needs anyway.

- **`ShellSettings` is split in two.** `ShellConfig` is what the two settings _say_ — `configured` (the
  `shellPath`, `~`-expanded) and `commandPrefix` — read exactly once per runtime, which keeps
  `environment.test.ts`'s "selects the shell once per runtime" and the `shellCommandPrefix` pins true.
  `ResolvedShell` is what one working directory decided about it: `{ shell, brokenShellPath? }`.
- **`resolveShell(cwd)` answers for the directory the command runs in**, cached in `shellsByCwd`, keyed by
  `resolve(cwd)`. The rule recorded in code and README: the settings are read once per runtime; the _answer
  to "can this be run, and where is it"_ is once per runtime **per working directory**, because a relative
  value, a relative `PATH` entry and an empty one all mean that directory, and Pi hands a replacement
  session a new one (session-header cwd) without restarting the process or this cache. A directory already
  asked is never asked again, so a settings change still needs `/reload`.
- **A bare value is searched on `commandSearchDirs(cwd)`** — `commandPathValue().value.split(delimiter)`
  mapped through `resolve(cwd, entry)`, so an empty entry is the command's directory and a relative entry is
  read from it, which is what libuv does. A value with a separator is `resolve(cwd, value)`.
- **What gets spawned is the absolute path that was found.** That is the structural half: a bare name
  resolved twice — once by the check, once by libuv against a child `PATH` that `buildEnv` rebuilds per
  command — can land on two different files. Now it is resolved once per directory and every command of the
  session starts that file, so a `PATH` change inside a runtime cannot swap the shell under the session
  (pinned). The _commands_ still get the PATH the session has, verbatim: only the shell's own resolution is
  fixed. `DEFAULT_SHELL` is still spawned as the literal `bash` and is still never checked
  (`shell-path-resolution`'s last pin).
- Both directions of the disagreement now answer as a named result: `./session-dir-sh` in the session
  directory runs; `./runtime-dir-sh`, which only the runtime can see, is `Custom shell path not found:
  ./runtime-dir-sh` with no `exit_code`, instead of a check that passes and a child that reports 127.

`withCommandPrefix` reads `ShellConfig`, so it does not depend on the directory and stays chosen once.

### F19 — the log dir is a precondition, answered as a result

`unusableLogDir()` sits next to `missingWorkingDirectory` in `execute`: `ensureLogDir()` (so the normal case
of a directory that does not exist yet stays normal), then `statSync` must answer a directory, then
`accessSync(W_OK | X_OK)` — a directory without `X_OK` takes no entries, so it cannot open a file in itself.
Three messages, each naming `LOG_DIR` and ending with Pi's `Cannot execute bash commands.`:
`Cannot create the log directory: …`, `Log directory is not a directory: …`,
`Log directory is not writable: …`. Nothing is spawned, so no log, no sidecar and no task.

**Not cached**, unlike every other answer in that part of the file: the tester's third test pins recovery,
and a permission fixed mid-session is worth recovering from. `spawnJob` keeps its own `ensureLogDir()` so it
stays self-contained, and `pruneRetention` still never creates the directory (`lifecycle.test.ts`'s pin).

### F20 — the note describes the rows, and there are now two caps

`LISTING_MAX_TASKS` became `LISTING_MAX_FINISHED_TASKS` (30) and `LISTING_MAX_RUNNING_TASKS` (100).

- **Running tasks are not capped by the finished cap** — that is the README's promise and the shape the model
  has to act on. They have a bound of their own (100) so the table cannot become 300 rows, and when that one
  bites the sentence says which kind went missing.
- **Finished rows are now the newest 30** (`.slice(-30)`, rows still printed chronologically), where the old
  code printed the _oldest_ 30 under a note saying "older finished tasks not listed". That was a second
  wrongness in the same sentence, in the other direction.
- The sentence counts each kind it left out: `(4 running tasks not listed; their logs are in …)`,
  `(4 older finished tasks not listed; …)`, or `(N running tasks and M older finished tasks not listed; …)`.
  `details.tasks`/`structuredContent.tasks` stay uncapped (pass 3 pinned that).
- `taskListing`'s per-column `Math.max(...rows)` spread became a loop, so the row count is not also a stack
  argument count.
- README: "The listing shows the 30 newest tasks (running ones are always included)" became what the code
  does — every running task up to 100, the newest 30 finished ones, and a sentence naming what was left out.

### F21 — a record is deleted on an affirmative answer, never on the absence of one

Two changes, one rule.

- `readMeta` now answers "a record": a JSON object, or undefined. `null`, `42`, `"bg-x"` **and `[]`** all
  parse and none of them is a record — an array is `typeof "object"`, so checking for an object is not
  enough on its own. `adoptJobs`'s `if (!meta) continue` then covers all of it, and `pruneRetention`'s
  protected-id scan sees the same undefined it saw before.
- **The decision the tester asked for: a record whose fields have the wrong types is also left alone.** In
  `adoptJobs`, `if (!Number.isFinite(pid)) continue;` before the fall-through that unlinks, and the two
  `Number.isFinite(pid) &&` guards below it went away. Deleting a sidecar claims "this command is over and
  left no group to stop", and a record that cannot answer that question is not evidence for it; the age and
  count rules collect it, exactly as pass 3 decided for the unreadable ones. This closes `{"pid": "123"}`,
  `{"pid": null}` and `{}` — and `lifecycle.test.ts`'s hand-written `bg-old.json` of `{}` still disappears,
  by the age rule rather than by a guess.
- README: the sidecar paragraph says what "cannot be read" means now, and says the rule outright: "Deleting
  a record is what an affirmative answer licenses … never the absence of one."

### F22 — the suite is hermetic, in two layers, with a guard against rot

- **Layer 1, `test/helpers/extension.ts`:** `EXTENSION_CONFIG_ENV_KEYS` (the ten variables the packages read)
  is saved and deleted when a load starts and put back when the **last** load in the process is disposed —
  counted, not snapshotted per load, because `PI_BG_TASKS_KEEP_RUNNING` is read at call time and because two
  loads can be alive at once and disposed in any order: a per-load restore would hand the shell's value back
  to a load that is still running. `loadExtension({ env })` is applied after the scrub, so a test's value
  wins (pinned).
- **That alone was not enough, and measuring found out.** With all ten variables set, the load-time scrub
  left **20 tests red**: `test/load.test.ts` (2 — Pi's own loader never passes through `loadExtension`),
  `packages/pi-memory/test/injection.test.ts` (17 — the file does `import { MEMORY_NOTE } from "../src/index.ts"`,
  so the extension's module-level configuration was read when the _test file_ was imported, before any load),
  and `packages/pi-takeover/test/session.test.ts` (1 — the real `pi` child inherits the test process's
  environment).
- **Layer 2, `test/helpers/hermetic-env.ts`, wired in as a Vitest `setupFiles` entry:** deletes the same list
  before each test file is imported, which reaches all three of those paths (and the child processes, because
  the values are simply gone from `process.env`). `docs/testing.md` says so and gives the check:
  `PI_TAKEOVER_MAX_CHAIN=100 PI_MEMORY_FILENAME=HOST-NOTES.md PI_BG_TASKS_KEEP_RUNNING=0 npm test` —
  measured 301/301, as green as a clean shell.
- **Against rot:** `test/repo.test.ts` greps `process.env.PI_*` out of every package's `src` and fails if a
  key is in neither harness list (`EXTENSION_CONFIG_ENV_KEYS`, or `HOST_ENV_KEYS` — Pi's own variables, which
  `pi-bg-tasks` clears from its children itself) **or** if a scrubbed key is read by no extension. Both
  directions, so the list cannot grow stale in either.

### MEMORY.md

No line added or changed. The two host facts this pass needed were already put there by the tester — the
`getShellEnv` hand-off and the session-header cwd — and both are still exactly what the code now follows.
What changed is in the code comments, the package README and `docs/testing.md`, which is where the harness
conventions live; a line here duplicating them would cost prompt space in every session.

### Tests I touched, and why

- `test/sidecar-record-shapes.test.ts`: the body of the tester's `it.each` was moved **verbatim** into a named
  function (`leavesTheReaderAlone`) so the new wrong-field-types `it.each` runs the same steps; assertions,
  messages and the 197 marker are unchanged. No test assertion changed.
- `test/log-dir-unusable.test.ts`: the `attempt()` helper now takes `string | Record<string, unknown>` so a
  test can send `timeout: 0`; the tester's call sites are unchanged.
- Nothing else of theirs. The other four red files (`shell-path-cwd`, `wait-listing-overflow`,
  `env-hermetic`) were left exactly as written and made green by the source and harness changes.

### New pins, all green

- `test/shell-path-cwd.test.ts` (3). A **relative `PATH` entry** means the command's directory, as it does
  for the child. One runtime, two command directories, one relative `shellPath`: the directory that has the
  file runs, the one that does not answers `not found`, and the first answer is still there afterwards. And
  the file that was found is the file that is spawned: a bare name resolved in one `PATH`, then a second
  program of the same name put on the runtime's `PATH`, does not change which shell answers the next
  command.
- `test/log-dir-unusable.test.ts` (2). `timeout: 0` is refused the same way and leaves the log dir exactly as
  it was — no log, no sidecar, no task in `bg_wait`. A file where the log dir belongs survives `session_start`
  (adoption and the retention walk both catch the errno) and the command still answers with the directory.
- `test/wait-listing-overflow.test.ts` (2). 15 running + 34 finished: all 15 running have rows, exactly the
  30 **newest** finished have rows, and the note says "(4 older finished tasks not listed…)". 104 running:
  the heading says 104, the table has 100 rows, and the note says "(4 running tasks not listed…)" — never
  "finished".
- `test/sidecar-record-shapes.test.ts` (3). `{"pid":"123456"}`, `{"pid":null}`, `{"command":"sleep"}` on a
  live task's sidecar: left in place, not adopted, the command stays its owner's, and the age rule collects
  it.
- `test/env-hermetic.test.ts` (2). A variable a test names in `env:` beats the shell's value (needs
  `vi.resetModules()`: pi-takeover takes its cap at module load, and the first test in the file already
  imported it). And with two live loads, disposing the first does not put the shell's value back under the
  second.
- `test/repo.test.ts` (2). The scrub list covers everything the packages read, and contains nothing they do
  not.

### For pass 5 — what to attack

- **F22's remaining boundary.** `HOST_ENV_KEYS` is an allowlist, not a scrub: a real `pi` child started by a
  test still inherits `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_MODEL`, `PI_PROVIDER`, `PI_REASONING_LEVEL` —
  and `PI_CACHE_RETENTION`, `PI_MANAGED_INSTALL_ROOT`, `PI_CODING_AGENT` — from the pi that ran the suite.
  Green today; same class of leak as F22 with a different owner. If it is closed, the list to extend is
  `HOST_ENV_KEYS` (and `hermetic-env.ts` follows it), and `test/load.test.ts` plus
  `pi-takeover/test/session.test.ts` are where it would show.
- **The `#!` hole is documented, not closed.** A mode-0755 script with a missing interpreter is a runnable
  file by every question a `stat`/`access` pair can ask, and arrives as exit 127. Closing it means actually
  spawning the shell once per resolution (`-c 'exit 0'`) and deciding what a probe process costs, and what it
  does to a shell that reads stdin or takes an argv.
- **F18's cache is a Map with no bound.** One entry per working directory a module instance has been asked
  about, and a process keeps its module instance across every replacement (`bindExtensions`), so the entries
  accumulate across sessions in one `pi`. A session has one or two; nothing caps it. `commandSearchDirs` also
  re-splits and re-`resolve()`s the PATH on every resolution — cheap, and only per new directory.
- **F18's message for a relative value still does not name the directory it resolved against**, and a `~` in
  a configured value is expanded in the message (pass 3's cosmetic note, unchanged). `./x` refused in a
  session whose cwd the user did not choose is the case where that matters.
- **F20's numbers are chosen, not derived.** 100 running rows, 30 finished ones. And when running rows are
  dropped, the ones kept are the first in the table — the oldest — which is a decision with no test saying it
  is wrong either way. `details.tasks`/`structuredContent.tasks` are still uncapped: 300 tasks is 300
  structured entries for a codemode caller, and nothing bounds that.
- **F21's `pid: -1`.** `writeMeta` records `proc.pid ?? -1`; such a record is "usable" under the new rule,
  reads as dead with no group, and is deleted. If "we never knew the pid" should be left alone rather than
  deleted, `-1` is the case to argue about, and it is one comparison away.
- **F19's one silent path is unchanged:** `appendToLog` swallows its failure, so the `failed to start command
  with …` note for a session whose log dir broke _between_ the check and the spawn is lost entirely and the
  command reports 127 with no explanation. Also: `unusableLogDir` runs `ensureLogDir()` per command, which
  runs `tightenPrivate(LOG_DIR)` — a chmod on a file sitting in the log dir's place.
- Carried forward, unchanged: everything in pass 3's list that is still open, including
  `stopLeftoverGroup`'s early `return false`, `tightenPrivate` on another live runtime's files, the
  recycled-`ownerPid` rule, Pi's `/bin/bash` → `bash` → `sh` fallback, retention driven by completions, the
  numbers in a sidecar being trusted by the report, and Windows being POSIX-shaped and unexercised
  (`PATHEXT` is still not consulted, so a configured `shellPath: "bash"` there finds only a file literally
  named `bash`).

### Harness notes

- **Marker sleeps added this pass: 201 (`log-dir-unusable`), 205 (`wait-listing-overflow`), 209
  (`env-hermetic`).** The sidecar file reuses 197 for its new `it.each` (same file, same shape).
- **A Vitest `setupFiles` entry runs before the test file is imported**, which is what makes it able to
  affect a module-level `process.env` read in the extension a test file imports statically. If a pass wants
  to add to the scrubbed list, do it in `EXTENSION_CONFIG_ENV_KEYS` and the two consumers follow.
- **A second load of a package that reads configuration at module load needs `vi.resetModules()` in the same
  file**, even for harness-level tests: the first `loadExtension` in the file already imported the module, and
  a `env:` value given to a later load is simply ignored. That is how the new `env-hermetic` pin was found.
- **`wait-listing-overflow` now holds 104 concurrent `sleep 205` tasks.** The quit shutdown signals them all
  before awaiting any, so it costs one grace window, not 104: that test — 104 spawns, the listing, the
  shutdown — runs in under 0.9 s. If a future pass pushes the number up, that is the property to re-measure
  rather than assume.
- **Run the suite in a hostile shell too** (`PI_TAKEOVER_MAX_CHAIN=100 PI_MEMORY_FILENAME=HOST-NOTES.md
  PI_BG_TASKS_KEEP_RUNNING=0 npm test`). It is the only way to see a hermeticity regression, and one test
  file's leak (a load never disposed) now shows up as another package's failure rather than as nothing.

---

## Pass 5 — tester

Baseline: `016aeb5`, **301/301 green in 47 files** (145 in the package, 33 files), and re-measured at the
start of this pass: the hostile shell (`PI_TAKEOVER_MAX_CHAIN=100 PI_MEMORY_FILENAME=HOST-NOTES.md
PI_BG_TASKS_KEEP_RUNNING=0 npm test`) is as green as a clean one, and a clean run leaves 0 `/tmp/pi-ext-*`
directories and no marker processes. `pi-takeover`'s chain logic is green in that shell, so hermeticity has
not regressed and nothing in it was touched.

After the pass: **305 green, 8 red in 4 files** — 12 tests added, 8 of them red. In the package: **149 green,
8 red, 157 tests, 36 files**. `tsc` and biome are clean; `npm run check` fails only on the 8. Reproduce with
`npx vitest --run packages/pi-bg-tasks`.

The four pass-4 fixes hold in every shape I could reach: the PATH hand-off is a line-for-line copy of Pi's,
`shellsByCwd` answers where the child answers and what it found is what it spawns, the log-dir refusal is a
result and recovers, the record rules delete only on an affirmative answer, and the harness keeps a hostile
shell out of every package. What this pass found is not in those fixes: it is in the fourth precondition
nobody wrote a check for, in what the tool says when `spawn` never produced a process, and in one window that
cuts a character in half.

### F23 — a command too big for the shell ends the call as a thrown `spawn E2BIG`

Three environment preconditions answer as tool results — the working directory (F6), a configured shell
(F11/F15), the log directory (F19) — because a thrown errno reaches the model as `createErrorToolResult`:
`pi-agent-core/dist/agent-loop.js` turns whatever `execute` throws into
`content: [{ text: error.message }]`. The fourth way the same call can fail is unhandled: `spawn` throwing
**synchronously**.

`child_process.spawn` throws rather than emitting `error` when the failure is detected before the fork. One is
reachable from the command itself: `E2BIG`, the kernel's per-argument limit (`MAX_ARG_STRLEN`, 131072 bytes on
Linux). The command goes to the shell as a single `-c` argument, so a command past that size cannot be started
at all — measured here: 131071 bytes spawns, 131072 throws. `shellCommandPrefix` counts toward the same
argument. A model writing a large heredoc or a base64 blob gets there. The other one is
`ERR_INVALID_ARG_VALUE`, Node refusing an argument with a NUL byte.

The whole spawn path is bypassed: `spawnJob`'s catch unlinks the log (good, pinned) and rethrows, so there is
no job, no sidecar, no `proc.on("error")` note, no `structuredContent`, and the model reads the bare string
`spawn E2BIG` — which names no limit, no argument and nothing to do about it. `timeout: 0` throws too. Pi's
own tool throws for the same two inputs, so this is not a divergence from the host; it is the one remaining
case where this extension answers with an errno after deciding, three times over, that it answers with a
sentence.

Red: `test/spawn-refused.test.ts` — three red tests (foreground, `timeout: 0`, and the NUL byte), each of
which today fails with `the tool call rejected instead of answering: Error: spawn E2BIG` /
`TypeError [ERR_INVALID_ARG_VALUE] …`. The foreground test also asserts the answer says `too long`: that
wording is this pass's choice, because it is the shortest thing that tells a model what to do (split the
command into a file). If a different wording lands and the README states the limit, the regex is the thing to
change — say so here rather than bending the assertion to a bare errno.

Direction: one catch around the log-open plus the spawn, next to the other three checks, returning an error
result that names what was refused and why. That also covers the `openPrivate(logPath)` failure F19's check
cannot see (ENOSPC, EMFILE, a filesystem that changed under the check) — the same hole, one function over, and
the same fix.

### F24 — a background spawn that produced no process is reported as a running task with `pid -1`

`spawnJob` records `proc.pid ?? -1`. `child.pid` is `undefined` exactly when `spawn` failed before the fork,
which is when there is definitively no process — a different thing from a process that started and failed,
which is what the `error` handler and the 127 exit are for. The background path then answers:

```text
Command running in background with ID: bg-sb0f2p9w (pid -1).
```

with `details.status: "running"` and `details.pid: -1`, for a command that never existed. `bg_wait` corrects
it one call later (`failed (exit 127)`), so the model has to disbelieve the message it was just given. Two
reachable ways: a session whose `PATH` has no `bash` — the default shell, which is deliberately never checked —
and a `shellPath` that is a runnable script with a missing `#!` interpreter, the hole the README says no
`stat`/`access` pair can see. Both answer `spawn … ENOENT` with no pid (measured directly: `pid` undefined,
one `error` event, no `exit` event).

Red: `test/spawn-failed-background.test.ts` — two red tests (one per shape): no `pid -1` in the text, no `-1`
in `details.pid`, no claim of a background task that is running, and the result is an error.

Direction: `proc.pid === undefined` is not a job, and F23's catch already carries the reason. A `-1` in the
model's face is never right: report the failure, or say there is no pid, but do not print one the OS did not
hand out. While there: the `-1` sidecar that is written before the `error` event lands is what F21's
`pid: -1` question is about — see "Attacked, no finding" for why deleting it is correct.

### F25 — a preview can start in the middle of a character

`readTail(path, 4096)` reads the last 4096 _bytes_ and decodes them, and where the window starts is whatever
the file size makes it. If it starts on a continuation byte, the model is shown `U+FFFD` as the first
character of the preview, and the label next to it is wrong by the same accident (`backgroundResult` prints
`Buffer.byteLength(read)`, which counts the three bytes the replacement character took for the one byte that
was read):

```text
Preview (last 4.0KB of 7.8KB):
<U+FFFD>éééééééééééé…
```

One function over, `readLogWindow` already strips exactly this (`replace(/^\uFFFD+/, "")`, with a comment
about split codepoints) before showing the tail of a log over 8 MB. `readTail` — used in exactly two places,
the preview of a command that moved to the background and the partial output streamed while one runs — does
not.

Red: `test/preview-codepoint.test.ts` (2): a payload of `x`, 4000 two-byte characters, then `M` — 8002 bytes,
so the window starts mid-character, verified against `tail -c 4096`, which starts `a9 c3 a9 …`. One test reads
the preview in the moved-to-background result, one reads the partials streamed through `onUpdate`; both assert
no `U+FFFD` anywhere in the text.

Direction: strip leading replacement characters the way `readLogWindow` does, or move the window start back to
a character boundary and say in the label how many bytes were actually read. Same family, worth deciding at the
same time: `readStructuredOutput` cuts at 1 MiB and can leave a split character at the _end_ of
`structuredContent.output` — not model-facing, so it is a judgement call, but it is the same three lines of
thinking.

### F26 — when the running cap bites, the tasks that disappear are the newest ones

`taskSection` keeps `runningInfos.slice(0, LISTING_MAX_RUNNING_TASKS)` — the 100 that started _first_ — while
the finished rows are kept with `finishedInfos.slice(-LISTING_MAX_FINISHED_TASKS)`, the newest. So of 104
running tasks the four that disappear are the four the model just started and has no other way to ask about:
the note says only "4 running tasks not listed", which of them is not stated, and `details.tasks` is not
something a model can read. The README says "Every running task gets a row — up to 100 of them", which is true
of no particular 100.

Red: one test added to `test/wait-listing-overflow.test.ts`: 104 running tasks, 100 rows, and the rows kept
must be `running.slice(-100)`. It fails today with the first 100 against the last 100.

Direction: this is a decision, not a bug in the arithmetic — but it should be a _made_ one, and the
asymmetry with the finished rows has no reason behind it in the comment ("a table truncated in the middle
reads as a gap" argues for a different thing: keeping the newest running rows cuts the table at its start, not
in its middle). Keep the newest running rows, or write the rule into the sentence under the table and the
README. If the second is chosen, delete this test and say so here.

### New pins, all green

- `test/spawn-refused.test.ts` (2). A refused oversized command leaves the log dir exactly as it was — the log
  opened before the spawn is taken back with it — and the blocking mutex survives a call that threw, which is
  the thing that would silently wedge every later default `blocking` command of the session.
- `test/spawn-failed-background.test.ts` (2). Once the error has landed, `bg_wait` lists no running row and no
  running ID for the task, whatever the first answer ends up saying; and the foreground answer for the same
  shell stays what it is — exit 127 with `[bg-tasks] failed to start command with …` in the output, so a fix
  for the background path cannot quietly drop the reason.
- The four pass-4 listing tests still pass with the new one in the file (104 spawns, one overlapping grace
  window at shutdown).

### Attacked, no finding

Recorded so pass 6 does not spend time here.

- **F22's remaining boundary is real but harmless, and the host owns it.** Pi reads only
  `PI_OFFLINE`, `PI_PACKAGE_DIR`, `PI_STARTUP_BENCHMARK`, `PI_SKIP_VERSION_CHECK`, `PI_SHARE_VIEWER_URL`,
  `PI_MANAGED_INSTALL_ROOT` and `PI_CODING_AGENT` from the environment (`grep -o 'process\.env\.PI_[A-Z_]*'`
  over `pi-coding-agent/dist`); `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_MODEL`, `PI_PROVIDER` and
  `PI_REASONING_LEVEL` are only ever written by it, and `pi-bg-tasks` clears them from every command and
  re-derives them from the context. Nothing in the suite makes a model call, so `PI_CACHE_RETENTION` is inert.
  The hostile run is 301/301.
- **The fixtures' own `PI_*` knobs are not a hole either.** `PI_FAKE_LOG`/`PI_FAKE_RULES` (read by
  `test/fixtures/fake-model.ts`) are ambient and are in neither harness list — and cannot be, since
  `repo.test.ts`'s second direction forbids scrubbed keys no extension reads. Measured with both exported in
  the shell: 8 failures, and they are exactly this pass's 8 reds. Every test that uses them names them itself.
- **`commandPathValue` is Pi's `getShellEnv` line for line**, checked against the installed sources rather
  than against `MEMORY.md`: same case-insensitive key choice (`Object.keys(process.env).find(k =>
  k.toLowerCase() === "path") ?? "PATH"`), same `filter(Boolean)` used only for the "is the bin dir already
  there" answer, same `[binDir, currentPath].filter(Boolean).join(delimiter)`, same
  `{...process.env, [pathKey]: updatedPath}`; and `getBinDir()` is `join(getAgentDir(), "bin")`. The quirk the
  key choice imports: with both `Path` and `PATH` in the environment, only the first one found gets the bin
  dir, and the child's `$PATH` is untouched — verified with a session whose env has `Path` and no `PATH`
  (bash then uses its own compiled default, and `$Path` carries the bin dir). Copying it is right; diverging
  would be the finding.
- **F18's "spawn what was found" does not change `argv[0]`.** libuv already hands the _resolved absolute path_
  as `argv[0]` when it resolves a bare name on `PATH` — a script printing `$0` said
  `argv0=/tmp/pi-ext-cwd-x4GdoX/argv0-sh` for `spawn("argv0-sh", …)` with a PATH holding it, identical to what
  the extension's absolute path produces. So nothing that keys on its own name (bash's `sh` mode, a busybox
  multi-call binary, a wrapper doing `dirname $0`) sees a change.
- **F19's un-coverable cases.** Every way past `statSync`+`accessSync(W_OK|X_OK)` is the filesystem changing
  under the check — ENOSPC, EDQUOT, EMFILE, a chmod from another process — and none can be produced
  deterministically in this harness (`RLIMIT_NOFILE` is not reachable from inside the process). `appendToLog`'s
  swallowed failure only hides the `[bg-tasks] failed to start command with …` note in a session whose log dir
  broke between the check and the spawn, which needs the same unreachable interleaving. F23's direction —
  converting the open-and-spawn block's throw into a result — is what closes the reachable half.
- **F21's `pid: -1` should be deleted, not protected.** `-1` means `spawn` produced no pid, so no process and
  no group: `isAlive(-1)` and `processGroupExists(-1)` are both false by their own `pid <= 0` guards, so a
  reader that finds one unlinks it without signalling anything, and `releaseJobRecord` unlinks it in the
  runtime that wrote it a moment later. The window in which such a record exists is between `writeMeta` at
  spawn and the `error` event; nothing in it is stoppable, so nothing is lost.
- **The record protections still pair up correctly.** `pruneRetention`'s protected-id scan needs a finite
  `pid` to protect a live group, and a record without one names no group anyone could stop; foreign,
  running and live-group ids are collected in one pass and applied per file, so a log and its sidecar are
  always protected or removed together. Temps: never adopted, never counted as logs, tightened, collected past
  60 s — re-checked against `adoptJobs`'s walk.
- **F20's arithmetic and the caps' reach.** `droppedRunning`/`droppedFinished` match the rows kept in all four
  combinations (≤cap both, running only, finished only, both over), the heading counts everything, and
  `details.tasks`/`structuredContent.tasks` staying uncapped is not a model-facing cost: pi builds the
  transcript from `content` only (`details` and `structuredContent` go to the UI), which is also why a thrown
  tool error arrives as plain text and a `structuredContent` one never does.
- **The harness's two layers hold under the attacks listed in pass 4.** The refcount cannot leak across test
  files: with `pool: "forks"` and `isolate: true` each file runs in its own process (two files in one run
  printed different `process.pid`s), so a leaked load cannot poison another package's file. No test writes one
  of the ten variables to `process.env` (grep over `test/` and `packages/*/test`) — they all arrive through
  `loadExtension({ env })` or `withEnv` around a _call_, which is not scrubbed; a `withEnv` wrapped around a
  `loadExtension` would be, and no test does that. No package reads configuration through a bracket or computed
  key, so `repo.test.ts`'s `process\.env\.(PI_[A-Z0-9_]+)` grep sees every read — worth knowing if a future
  package refactors them behind a helper.
- **The stop, adoption and ownership machinery**: unchanged from pass 2/3/4's records; nothing new reached it.

### For pass 6 — what to attack

- **F23's catch is a design decision, not just a try/catch.** It decides what a `bash` call may throw at all:
  `Command is empty.` and `Invalid timeout:` still throw today (and Pi catches them the same way), so either
  the rule is "the tool answers, it does not throw" and those two move too, or the README says which answers
  arrive as thrown errors. Also decide whether the limit is a _checked_ precondition (a size test before
  spawning, with the number in the README) or a caught errno.
- **F24's boundary against F23's fix.** If `spawnJob` throws on a missing pid, `spawnBackground`/`runWithTimeout`
  both have to convert it, and the `error` event that follows belongs to a job nobody registered — check that no
  second report appears, and that `bg_stop` on the ID from a refused background start says "Unknown task"
  rather than something about a group.
- **The `#!` hole is still only documented.** Closing it means actually spawning the shell once per resolution
  and deciding what a probe process costs — and now there is a second reason to look: F24's second red test is
  exactly that hole producing a nonsense report.
- **F18's cache is unbounded and its message still names no directory** (`Custom shell path not found: ./x`
  from a session whose cwd the user did not choose). A Map keyed by directory, one entry per directory a module
  instance has been asked about, across every session replacement in one process. Nothing caps it; nothing
  needs to yet.
- **F20's numbers (100 running, 30 finished) and F26's outcome.** If the newest-running decision is taken, the
  README's "Every running task gets a row — up to 100 of them" and the sentence under the table both want a
  look; if the oldest are defended, this pass's test goes and the README gains the rule.
- **F22's fixture knobs** (`PI_FAKE_LOG`, `PI_FAKE_RULES`, `FAKE_PI_*`): ambient today, harmless because every
  test names them. If anyone wants the guard to cover them, it needs a third list (`hermetic-env.ts` deletes
  what is not extension configuration either) and `repo.test.ts` scanning `test/fixtures` too — currently it
  scans `packages/*/src` only, which is why `PI_BIN` (read by `pi-takeover`'s session test) is invisible to it.
- Carried forward, unchanged: everything still open in pass 3's and pass 4's lists —
  `stopLeftoverGroup`'s early `return false`, `tightenPrivate` on files another live runtime owns, the
  recycled-`ownerPid` rule, Pi's `/bin/bash` → `bash` → `sh` fallback (and this pass's default-shell red tests
  sit right on top of it: an unfindable default shell is documented, the _report_ is not), retention driven by
  completions, the numbers in a sidecar being trusted by the report, Windows being POSIX-shaped and
  unexercised (`PATHEXT`, and `findConfiguredShell`'s backslash test treating a Linux filename containing `\`
  as a path).

### Harness notes

- **Marker sleeps added this pass: 213 (`wait-listing-overflow`'s new test), 217 (`preview-codepoint`).**
  `spawn-refused` and `spawn-failed-background` spawn nothing that survives their own call.
- **`spawn` throws synchronously — it does not emit `error` — for two reachable inputs**: `E2BIG` at exactly
  131072 bytes of one argument (131071 spawns), and `ERR_INVALID_ARG_VALUE` for a NUL byte in an argument. Both
  are outside `proc.on("error")`, which is where the extension's spawn-failure handling lives.
- **A failed `execve` is the opposite case**: a bare name not on `PATH`, or a script whose `#!` interpreter is
  missing, gives an `error` event with **`child.pid === undefined`** and _no_ `exit` event. That is the only
  way `-1` reaches a job's `pid`, and it is why the F24 tests use those two shapes.
- **For byte-exact multi-byte payloads**, `printf 'x'; printf '\303\251%.0s' {1..4000}; printf 'M'` writes 8002
  bytes with the shell alone — `tail -c 4096` on it starts `a9 c3 a9`, which is the split. Keep the payload's
  total size even and the 4096-byte window starts on a continuation byte.
- **`pi` turns a thrown tool error into a model-facing text result** (`createErrorToolResult(error.message)` in
  `pi-agent-core/dist/agent-loop.js`), and builds the transcript from `content` alone. That is the reason this
  file keeps saying "a result, not a throw", and the reason uncapped `details` cost nothing.
- The new listing test spawns 104 tasks like its neighbour; with the marker comment
  (`sleep 213 # listing-marker-213-<i>`) they stay distinguishable if a future pass needs to find one.
