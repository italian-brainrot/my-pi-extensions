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
- A full suite still leaves ~6 `/tmp/pi-ext-*` directories. They are not from this pass: several loads in
  `test/lifecycle.test.ts` (the ones for live jobs, quit shutdown, `KEEP_RUNNING=0`, and the tracked-log
  pin) neither reset modules nor pass an `agentDir`, so they reuse the module instance an earlier test
  imported and write into _that_ load's agent dir — which the earlier test already deleted, so
  `spawnJob`'s `ensureLogDir()` recreates it. Same reason a `backdate()` in one of those tests moves a file
  in another test's directory. Fix by giving those loads `vi.resetModules()` and their own `agentDir`.

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
