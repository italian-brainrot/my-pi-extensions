# pi-bg-tasks

Give Pi's `bash` tool a per-command timeout that **moves long commands to the background
instead of failing them**, plus two tools for working with those background jobs.

## What it adds

| Tool                               | What it does                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash` (replaces the built-in one) | Runs a command. Adds `timeout` (seconds, default 60) and `blocking`. When the timeout expires the command keeps running in the background and the tool returns its task ID and log path. `timeout: 0` starts it in the background immediately. |
| `bg_wait`                          | Wait for **any** running background task to finish (like `wait -n`), then list every background task of the session with its status, run time, output size, exit code, and log path. Default timeout 3600s.                                    |
| `bg_stop`                          | Stop a background task by ID: SIGTERM, then SIGKILL after a 5s grace period.                                                                                                                                                                   |

```text
> build the project                       bash { command: "npm run build", timeout: 5 }
  Command timed out after 5s and moved to background with ID: bg-1a2b3c4d (pid 4242).
  Output is being written to: ~/.pi/agent/bg-tasks/bg-1a2b3c4d.log

  (no output yet)

  Read the log file to inspect output, bg_wait to wait for it to finish, bg_stop to kill it.
> start the dev server as well           bash { command: "npm run dev", timeout: 0 }
  Command running in background with ID: bg-7f3k2m1q (pid 4300).
> ... keep working on something else ...
> bg_wait {}                              1 task(s) finished: bg-1a2b3c4d: completed (exit 0)

  Background tasks in this session (2 tracked, 1 running):

  bg-7f3k2m1q  running (pid 4300)    1m12s   42 lines   3096 chars   ~/.pi/agent/bg-tasks/bg-7f3k2m1q.log
    $ npm run dev
  bg-1a2b3c4d  completed (exit 0)    34.2s  318 lines  21402 chars   ~/.pi/agent/bg-tasks/bg-1a2b3c4d.log
    $ npm run build
> Read ~/.pi/agent/bg-tasks/bg-1a2b3c4d.log
```

## Install

Load every extension in this repository:

```bash
pi install .
```

Or only this one:

```bash
pi install ./packages/pi-bg-tasks
```

Try it for a single run, without touching your settings:

```bash
pi -e ./packages/pi-bg-tasks/src/index.ts
```

Do not install both the repository and this package: the `bash` override would be claimed twice.
Run `pi list` to see what is configured and `pi config` to choose which resources load.

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Read the source before loading it, and note
> that this extension replaces the built-in `bash` tool.

## Usage

### `bash` parameters

| Parameter  | Type    | Default  | Meaning                                                                                                                                          |
| ---------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`  | string  | required | Shell command to run.                                                                                                                            |
| `timeout`  | number  | `60`     | Seconds before the command is moved to the background. `0` backgrounds it immediately.                                                           |
| `blocking` | boolean | `true`   | `true` runs commands one at a time so commands that share mutable state do not interleave. `false` spawns immediately and lets commands overlap. |

A command that finishes inside the timeout behaves like the built-in tool: output is truncated to
Pi's own limits (last 2000 lines or 50 KB) and the temporary log is deleted, because the model
already has everything. Output that had to be truncated keeps its log, and the result points at it.

A command that was moved to the background returns the task ID, the pid, the log path, and the last
4 KB of output printed so far — or `(no output yet)` when the command has printed nothing. The
model is told to keep working rather than wait.

Finished results also carry `structuredContent` (`output`, `truncated`, `exit_code`,
`wall_time_seconds`, and `full_output_path` when truncated) so programmatic callers such as
codemode scripts can read them. Commands that were moved to the background have no result yet, so
they return only the task text.

### What `bg_wait` reports

`bg_wait` waits, then answers with one line about the wait — what finished, or that it timed out —
followed by a table of **every background task this session knows about**, running ones first:

```text
bg-1a2b3c4d  completed (exit 0)  34.2s  318 lines  21402 chars  ~/.pi/agent/bg-tasks/bg-1a2b3c4d.log
  $ npm run build
bg-7f3k2m1q  running (pid 4300)  1m12s  42 lines   3096 chars   ~/.pi/agent/bg-tasks/bg-7f3k2m1q.log
  $ npm run dev
```

- **status** — `running (pid …)`, `completed (exit 0)`, `failed (exit 3)`, `killed (signal SIGTERM)`,
  and `(…, adopted)` for a job taken over from a previous runtime.
- **run time** — from spawn to exit for a finished task, so it does not keep growing; from spawn to
  now while it runs.
- **output size** — lines and characters counted from the log, which is exact while the log is under
  16 MB; beyond that the counts are prefixed with `>=` and the byte count stays exact.
- **exit code** — for finished tasks; a running task has none.
- **log path** — the file to `Read`, or `(no log: …)` if retention removed it.

Commands that finished in the foreground are deliberately not in this table: their output already
reached the model and their log is gone. The listing shows the 30 newest tasks (running ones are
always included); `details.tasks` and `structuredContent.tasks` carry all of them, with
`id`, `status`, `pid`, `exit_code`, `signal`, `command`, `runtime_seconds`, `log_path`,
`log_exists`, `bytes`, `chars`, and `lines`.

A wait also notices tasks that were backgrounded _while it was running_, so nothing started by a
concurrent `bash` call goes unnoticed.

### Reading and stopping jobs

- Read the log file with the `Read` tool; it is a plain file that keeps growing while the job runs.
- `bg_wait` returns as soon as one job finishes, and lists every task either way — including when it
  times out or the wait itself is aborted.
- `bg_stop` on an already-finished job reports its final status rather than pretending to stop it.
- A task that was deliberately backgrounded is not killed when the run is aborted later. Aborting a
  run stops the command that call was waiting on, and nothing else.

### Background jobs survive a reload

Job state (pid, log path, and owning process) is written next to the log, so `/reload`, `/new`,
`/resume`, and `/fork` re-adopt jobs that are still alive and `bg_stop` and `bg_wait` keep working
afterwards.

| Setting                    | Default              | Effect                                                                                                 |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `PI_BG_TASKS_KEEP_RUNNING` | unset (keep running) | Set to `0` to also stop jobs when the session is replaced. Jobs always stop on real shutdown (`quit`). |

Logs live in `<agent-dir>/bg-tasks` and are pruned when older than 3 days, or beyond the newest
100 of them. A job that this runtime is still tracking is never pruned.

### Commands belong to the session that started them

`<agent-dir>/bg-tasks` is shared by every pi process: a nested `pi -p`, an RPC session, and the
`pi -p` that `subagent` spawns all load this extension against the same directory. Each sidecar
records the pid of the process that started the command, and:

- a session ignores commands another live session owns — it does not adopt them, stop them, or prune
  their logs and metadata;
- a session **does** take over commands whose owning process is gone (the dev server a crashed session
  left behind), claims them, and stops them at its own shutdown;
- a session that re-adopts commands it started itself — after a crash, where the old process died
  without stopping them — claims their sidecars so it can stop them next time.

Sidecars written before 0.1.1 carry no marker, and the process table answers the same question for
them: a command whose parent process is still alive belongs to that runtime, one reparented to init
lost its owner. Where the process table cannot be read, an unmarked command is left alone rather than
guessed at.

Before this, the damage was not limited to background jobs: a sidecar is written the moment a command
starts, foreground calls included, so a nested pi adopted the command that was running it and
SIGTERM'd its own parent as it exited — `pi -p` inside a `bash` call killed the `bash` call, which
arrived as `Command terminated by signal SIGTERM` with no timeout anywhere near the limit. If you run
a pi from a script, from a Makefile, or from an agent's shell, that is the failure you are avoiding.

Before 0.1.1 there was no ownership information, so every runtime adopted everything it found: a
nested pi killed its parent session's running commands when it exited. If you see that on an older
version, upgrade.

### Variables available to commands

Commands get Pi's session description in the environment, and inherit nothing stale from a parent
Pi process:

| Variable                           | Contents                |
| ---------------------------------- | ----------------------- |
| `PI_SESSION_ID`, `PI_SESSION_FILE` | Current session.        |
| `PI_PROVIDER`, `PI_MODEL`          | Current model.          |
| `PI_REASONING_LEVEL`               | Current thinking level. |

`<agent-dir>/bin` is prepended to `PATH`, matching the built-in tool.

### Which shell runs the commands

Resolution is `settings.shellPath`, project settings of the **Pi process** working directory first,
then the agent directory, otherwise `bash`. The choice is made once per runtime, so a settings
change needs `/reload`. On Windows, stopping a task uses `taskkill /T /F`.

## Development

```bash
npm run dev          # pi with this repo's extensions loaded from source
npm test             # the whole monorepo suite
npx vitest --run packages/pi-bg-tasks
```

The tests spawn real processes, so they cover timeout release, killing, the task listing and its
counts, output surviving the handover to the background, re-adoption after a reload, log retention,
and the environment handed to commands. See [docs/testing.md](../../docs/testing.md).
