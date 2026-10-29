# pi-memory

Puts a **`MEMORY.md`** into the system prompt beside the user's `AGENTS.md`, in a `<memory path="…">`
block of its own rather than in the `<project_instructions>` tag that holds the spec, and tells the
assistant that this file is its own to keep current.

The split it exists for: `AGENTS.md` is yours. You write the spec there, and you can say "do not edit
this file". `MEMORY.md` is the assistant's. Whatever it wants the next session to know — decisions,
constraints, gotchas, commands, invariants — it writes there instead, and `pi-memory` loads it back on
the next run.

## What it adds

No tools, no commands, no widgets. It handles two lifecycle events:

| Event                | What it does                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| `before_agent_start` | puts the memory files it found into `systemPromptOptions.sections.assistant_memory`;    |
| `session_start`      | forgets what the current session rendered, so the next run of it reads the files again. |

Keeping the memory out of Pi's project-context files is the point: the user's spec and the
assistant's notes carry different tags, and Pi's own `<project_context>` is left holding only
`AGENTS.md`.

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

The next run injects it. In the system prompt it is a section apart from the project context that
holds `AGENTS.md`:

```text
<assistant_memory>
Assistant-maintained memory. This file is owned by you (the assistant) and is injected at the start of
every session. Keep it up to date, and keep it short. Use the normal file tools on these paths to
change it; edits land in later sessions, not this one.

<memory path="/repo/MEMORY.md">
# Notes
…
</memory>
</assistant_memory>
```

That note is added by the extension at load time; it is not stored in the file, and `read` of the path
shows the file exactly as it is on disk. It opens the section, outside the `<memory>` tags and before
them, the way Pi's own "Project-specific instructions and guidelines:" line opens
`<project_context>`, and each block names the path it came from so the assistant knows what to edit.
Pi puts an extension's section at the end of the prompt, after `<cwd>`, so the assistant reads its own
notes last.

### When the files are read

`MEMORY.md` is read once per session, on that session's first run, and stays exactly that way until
the session ends. That is what Pi does with `AGENTS.md`: a context file is a startup input, not a
running one.

| Change                                     | Reaches the model                           |
| ------------------------------------------ | ------------------------------------------- |
| an edit to `MEMORY.md` by the assistant    | the next session, not the one editing it    |
| an edit to `MEMORY.md` by you, by hand     | the next session                            |
| a new session (`/new`, `/resume`, `/fork`) | yes, that session reads it on its first run |
| `/reload`                                  | yes                                         |
| `MEMORY.md` appearing or disappearing      | the next session                            |

Nothing about memory moves the prompt once a session has started. Pi patches a prompt section only
when its text differs from what it is replaying, so a section that reads the same every run is never
patched: no new system message lands between the messages it already follows, and the upstream prompt
cache stays intact. A section rebuilt from what the file says now would do both, and would rewrite
context the assistant has already acted on — the assistant knows what it edited, so a fresh copy of
its own edit is not information, it is a surprise.

### Which files are loaded, and in what order

Pi resolves `AGENTS.md` from the agent directory and from the current directory's ancestors;
`MEMORY.md` is resolved the same way, and the blocks appear in that order:

| Scope                  | Path                                   | Position in the section |
| ---------------------- | -------------------------------------- | ----------------------- |
| Global (this install)  | `<agent-dir>/MEMORY.md`                | first                   |
| Repository and parents | `MEMORY.md` in each ancestor directory | middle, outermost first |
| This checkout          | `MEMORY.md` in the working directory   | last                    |

The file name is the single directory entry `MEMORY.md` — never a path — and the same file reached by
two routes (a symlink, or an agent directory inside the searched tree) is injected once. Files are read
when the session starts, not before it, so a file created or emptied mid-session is picked up by the
session that follows.

### Configuration

Read when the extension loads, so changes need a restart rather than `/reload`.

| Variable              | Default     | Effect                                                                                                                                                  |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_MEMORY_FILENAME`  | `MEMORY.md` | File name to look for in each scope. Use it if `MEMORY.md` collides with something else; a value containing a path separator is ignored with a warning. |
| `PI_MEMORY_MAX_BYTES` | `16384`     | Most of one memory file's own text to inject. Longer files are cut on a line boundary and the block says so.                                            |
| `PI_MEMORY_DEBUG`     | off         | `1` writes stderr lines: what was injected, what was skipped and why, and which session's memory was forgotten at a session boundary.                   |

### Nothing happens when there is nothing to inject

| Situation                                      | What happens                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No `MEMORY.md` in any scope                    | The extension changes nothing — it is a no-op, the section is absent, and no file is ever created.                       |
| `MEMORY.md` is empty or whitespace only        | Skipped.                                                                                                                 |
| `MEMORY.md` is a directory, or cannot be read  | Skipped.                                                                                                                 |
| The file is larger than `PI_MEMORY_MAX_BYTES`  | Injected up to the limit, cut at a line boundary, with `[… pi-memory truncated this file at N of M bytes …]` at the end. |
| Another extension already loaded the same path | Not injected again.                                                                                                      |
| Pi itself loaded the file as a context file    | Not injected again — the extension's guard is on the resolved path.                                                      |

Because it never creates or rewrites the file, the mechanism is opt-in per directory, and a repository
that does not want it pays nothing.

> [!NOTE]
> The file is context, not configuration. It is part of the system prompt, so it is in the context
> size of every request in that scope — which is the point, and the reason to keep it short and to
> delete what stops being true.

### What it does not do

Pi's startup listing (`[Context] …`) is built from the resources Pi itself discovers: `SYSTEM.md`,
`APPEND_SYSTEM.md`, and the `AGENTS.md`/`CLAUDE.md` in scope. A file Pi never discovers is never
listed, so `MEMORY.md` does not appear there — showing it would mean reaching into Pi's resource
loader and changing what it loads, which is not something an extension should do to a runtime it was
only handed. `MEMORY.md` is in the prompt, and `read` of the path works; the listing is where it stays
missing.

## Development

```bash
npm run dev              # pi with this repo's extensions loaded from source
npm test                 # the whole monorepo suite
npx vitest --run packages/pi-memory
PI_MEMORY_DEBUG=1 npm run dev
```

Tests drive the extension through the lifecycle events the harness records
(`test/helpers/extension.ts`) and assert against real files in a temp directory: discovery order,
deduplication, the shape of the section — the note ahead of the `<memory>` tags, one block per file,
paths as attributes — and that a session reads the files once: editing them mid-session leaves the
section byte-identical, while `session_start` reopens it. Runs inside one test file are separate
sessions unless a test names the session it is continuing, which is how the per-session contract is
exercised. The note's wording is imported from `src/index.ts` rather than repeated in a test, so
rewording it is an edit to the extension, not a test failure. See [docs/testing.md](../../docs/testing.md).

The cheap end-to-end check is a scratch directory with a canary line in its `MEMORY.md` and
`pi --no-session -e ./packages/pi-memory/src/index.ts -p "print verbatim every part of your system
prompt between and including the tags whose name contains memory or instructions; no tools"`: the
`<assistant_memory>` section comes back with the note ahead of a `<memory path="/abs/MEMORY.md">`
block, `<project_instructions>` holds only `AGENTS.md`, and the same run in a directory with no
`MEMORY.md` reports no memory section at all — that is the no-op contract. Pi's section rendering is
not exported, so no unit test can assert the final prompt text.
