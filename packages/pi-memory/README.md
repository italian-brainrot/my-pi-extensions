# pi-memory

Puts a **`MEMORY.md`** into the system prompt the way Pi puts `AGENTS.md` there — inside
`<project_context>` — and tells the assistant that this file is its own to keep current.

The split it exists for: `AGENTS.md` is yours. You write the spec there, and you can say "do not
edit this file". `MEMORY.md` is the assistant's. Whatever it wants the next session to know —
decisions, constraints, gotchas, commands, invariants — it writes there instead, and `pi-memory`
loads it back on the next run.

## What it adds

No tools, no commands, no widgets. It listens for `before_agent_start` (the event Pi fires before
every run) and appends the memory files it finds to the prompt's project-context files.

## Install

Load every extension in this repository:

```bash
pi install .
```

Or only this one:

```bash
pi install ./packages/pi-memory
```

Try it for a single run:

```bash
pi -e ./packages/pi-memory/src/index.ts
```

## Usage

It does nothing until you create the file. To turn it on for a repository:

```bash
echo "# Notes" > MEMORY.md
```

The next run injects it. In the system prompt the block appears after the `AGENTS.md` block:

```text
<project_instructions path="/repo/MEMORY.md">
Note from the pi-memory extension: this file is the assistant's own memory, injected from this path
at the start of every run, and this note is not part of the file. Keep it up to date as you work:
record what future sessions need (decisions, constraints, gotchas, commands, invariants), delete
what is stale or wrong, and keep it short, because it is loaded into every later session. Use the
normal file tools on this path to change it.

# Notes
…
</project_instructions>
```

That note is added by the extension at load time; it is not stored in the file, and `read` of the
path shows the file exactly as it is on disk. The note comes first so the model reads the ownership
rules before the notes themselves, and it names the path so the assistant knows what to edit.

### Which files are loaded, and in what order

Pi resolves `AGENTS.md` from the agent directory and from the current directory's ancestors;
`MEMORY.md` is resolved the same way, and the blocks appear in that order:

| Scope                  | Path                                   | Position in the prompt  |
| ---------------------- | -------------------------------------- | ----------------------- |
| Global (this install)  | `<agent-dir>/MEMORY.md`                | first                   |
| Repository and parents | `MEMORY.md` in each ancestor directory | middle, outermost first |
| This checkout          | `./MEMORY.md` in the working directory | last                    |

The file name is the single directory entry `MEMORY.md` — never a path — and the same file reached
by two routes (a symlink, or an agent directory inside the searched tree) is injected once. Every
file is read again before every run, so an edit made during a session reaches the model on its next
prompt as a system-prompt section delta, and a file created mid-session is picked up without a
reload.

### Configuration

Read when the extension loads, so changes need a restart rather than `/reload`.

| Variable              | Default     | Effect                                                                                                                                                  |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_MEMORY_FILENAME`  | `MEMORY.md` | File name to look for in each scope. Use it if `MEMORY.md` collides with something else; a value containing a path separator is ignored with a warning. |
| `PI_MEMORY_MAX_BYTES` | `16384`     | Most of one memory file's own text to inject. Longer files are cut on a line boundary and the block says so.                                            |
| `PI_MEMORY_DEBUG`     | off         | `1` writes one stderr line per run: what was injected, what was skipped and why.                                                                        |

### Nothing happens when there is nothing to inject

| Situation                                      | What happens                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No `MEMORY.md` in any scope                    | The extension changes nothing — it is a no-op, and no file is ever created.                                              |
| `MEMORY.md` is empty or whitespace only        | Skipped.                                                                                                                 |
| `MEMORY.md` is a directory, or cannot be read  | Skipped.                                                                                                                 |
| The file is larger than `PI_MEMORY_MAX_BYTES`  | Injected up to the limit, cut at a line boundary, with `[… pi-memory truncated this file at N of M bytes …]` at the end. |
| Another extension already loaded the same path | Not injected again.                                                                                                      |
| Pi itself loaded the file as a context file    | Not injected again — the extension's guard is on the resolved path.                                                      |

Because it never creates or rewrites the file, the mechanism is opt-in per directory, and a
repository that does not want it pays nothing.

> [!NOTE]
> The file is context, not configuration. It is part of the system prompt, so it is in the context
> size of every request in that scope — which is the point, and the reason to keep it short and to
> delete what stops being true.

## Development

```bash
npm run dev              # pi with this repo's extensions loaded from source
npm test                 # the whole monorepo suite
npm run test -- --run packages/pi-memory
PI_MEMORY_DEBUG=1 npm run dev
```

Tests drive the extension through the `before_agent_start` event the harness records
(`test/helpers/extension.ts`) and assert against real files in a temp directory: discovery order,
deduplication, re-reading between runs, empty and unreadable files, truncation, and the exact
model-facing note. See [docs/testing.md](../../docs/testing.md).
