# pi-subagent

Delegate a prompt to a **subagent**: a nested `pi` process running the same model and tools, whose
reasoning happens outside your main conversation and whose answer comes back as one tool result.

Use it for work that would otherwise fill your context: reading a lot of files, summarising a
subtree, checking an assumption. The subagent's tokens and cost still land in the session totals.

## What it adds

| Tool       | Parameters                  | Result                                                                                                       |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `subagent` | `prompt` (non-empty string) | The subagent's final text answer, plus details: its messages, exit code, stop reason, and token/cost totals. |

The subagent runs:

```bash
pi --mode json -p --no-session [--model <provider>/<id>] [--thinking <level>]   # prompt on stdin
```

so it is a fresh session with the current model and thinking level, not a fork of your context.

## Install

Load every extension in this repository:

```bash
pi install .
```

Or only this one:

```bash
pi install ./packages/pi-subagent
```

Try it for a single run:

```bash
pi -e ./packages/pi-subagent/src/index.ts
```

> [!IMPORTANT]
> The subagent runs a nested Pi with the same permissions and the same model credentials. Its cost
> is real: watch it with Pi's cost breakdown, which includes what subagents spent.

## Usage

```text
> use the subagent tool to read packages/pi-bg-tasks/src/index.ts and list every env var it reads
  ✓ subagent  read packages/pi-bg-tasks/src/index.ts and list …
    1 turn · 4.2k in / 610 out · fake/model
    <the subagent's answer>
```

In the terminal UI the result collapses to the last few steps of the subagent's work; expand it for
the full transcript and per-component costs.

### Nesting

A subagent runs a nested Pi, which loads this extension again. By default the nested run is **not**
given the `subagent` tool, so delegation cannot cascade and a runaway tree is impossible.

| Variable                | Default                                | Effect                                                                                       |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `PI_SUBAGENT_MAX_DEPTH` | `1`                                    | How many levels of delegation are allowed. `0` disables the tool entirely.                   |
| `PI_SUBAGENT_DEPTH`     | `0` (set to `parent + 1` for children) | Depth of the current Pi process. Read by the extension; usually set by the extension itself. |

Read at startup, so changes need a restart rather than `/reload`.

### Cost reporting

The subagent's model calls happen in another process, which Pi cannot see. The extension returns
them as the tool result's `usage`, which is what keeps your session total and per-model breakdown
accurate: summed input, output, cache read/write, and cost, with context size taken from the largest
single subagent response rather than the sum.

### Failure cases

| Situation                            | What the model sees                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Empty prompt                         | `Subagent needs a non-empty prompt.` and no process is started.              |
| Nested `pi` cannot be started        | `Subagent failed: Failed to start subagent: …`                               |
| Subagent exited non-zero             | `Subagent failed (exit code N): …` with its stderr or last output.           |
| Subagent reported an error stop      | `Subagent error: <message>`                                                  |
| You cancelled the tool call          | The nested process is sent SIGTERM, then SIGKILL; the result says `aborted`. |
| Subagent hit its output length limit | The answer is returned with a note that it may be cut off.                   |

## Development

```bash
npm run dev          # pi with this repo's extensions loaded from source
npm test             # the whole monorepo suite
npm run test -- --run packages/pi-subagent
```

Tests drive the tool against `test/fixtures/fake-pi.mjs`, a stand-in that speaks the same
`pi --mode json` slice the extension parses, so usage aggregation, stream reassembly, aborts, and
the nesting guard are covered without spending tokens. See [docs/testing.md](../../docs/testing.md).
