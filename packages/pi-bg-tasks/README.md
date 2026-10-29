# pi-bg-tasks

Give Pi's `bash` tool a per-command timeout that **moves long commands to the background
instead of failing them**, plus two tools for working with those background jobs.

## What it adds

| Tool                               | What it does                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash` (replaces the built-in one) | Runs a command. Adds `timeout` (seconds, default 60) and `blocking`. When the timeout expires the command keeps running in the background and the tool returns its task ID and log path. `timeout: 0` starts it in the background immediately. |
| `bg_wait`                          | Wait for **any** running background command to finish (like `wait -n`). Default timeout 3600s.                                                                                                                                                 |
| `bg_stop`                          | Stop a background task by ID: SIGTERM, then SIGKILL after a 5s grace period.                                                                                                                                                                   |

```text
> build the project                       bash { command: "npm run build", timeout: 5 }
  Command timed out after 5s and moved to background with ID: bg-1a2b3c4d (pid 4242).
  Output is being written to: ~/.pi/agent/bg-tasks/bg-1a2b3c4d.log
> ... keep working on something else ...
> bg_wait {}                              1 task(s) finished: bg-1a2b3c4d: completed (exit 0)
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

A command that was moved to the background returns the task ID, the pid, and the log path. The
model is told to keep working rather than wait.

Finished results also carry `structuredContent` (`output`, `truncated`, `exit_code`,
`wall_time_seconds`, and `full_output_path` when truncated) so programmatic callers such as
codemode scripts can read them. Commands that were moved to the background have no result yet, so
they return only the task text.

### Reading and stopping jobs

- Read the log file with the `Read` tool; it is a plain file that keeps growing while the job runs.
- `bg_wait` returns as soon as one job finishes, and lists what is still running.
- `bg_stop` on an already-finished job reports its final status rather than pretending to stop it.

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

The tests spawn real processes, so they cover timeout release, killing, re-adoption after a reload,
log retention, and the environment handed to commands. See [docs/testing.md](../../docs/testing.md).
