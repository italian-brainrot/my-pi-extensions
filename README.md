# my-pi-extensions

My [Pi coding agent](https://pi.dev) extensions, in one monorepo: one package per extension, shared
test harness, shared tooling, and a single install for the whole set.

![CI](https://github.com/italian-brainrot/my-pi-extensions/actions/workflows/ci.yml/badge.svg)
[License: MIT](./LICENSE)

## Extensions

| Package                                 | What it does                                                                                                                                                               | Adds                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`pi-bg-tasks`](./packages/pi-bg-tasks) | Long shell commands move to the background instead of timing out, stay reachable across reloads, and belong to the session that started them.                              | `bash` (replaces the built-in tool, adds `timeout` and `blocking`), `bg_wait`, `bg_stop` |
| [`pi-memory`](./packages/pi-memory)     | Loads `MEMORY.md` into the system prompt beside the user's `AGENTS.md`, in a prompt section of its own, reads it once per session, and tells it to keep that file current. | none — it changes the prompt, not the tool list                                          |
| [`pi-subagent`](./packages/pi-subagent) | Delegate a prompt to a nested Pi on the same model, so the work happens outside the main context.                                                                          | `subagent`                                                                               |
| [`pi-takeover`](./packages/pi-takeover) | Ends the running agent and starts a fresh one on a handoff prompt, so an implement/review loop can run unattended with one live session at a time.                         | `takeover`, `/takeover`, `/takeover-cancel`                                              |

Read each package's README for parameters, environment variables, and behaviour details.

### Context files in this repository

`AGENTS.md` is the spec, and only the user writes it. `MEMORY.md` is what the assistant writes as it
works — decisions, gotchas, commands, what broke and why — and `pi-memory` injects it beside
`AGENTS.md` in a section of its own (`<assistant_memory>`, with one `<memory path="…">` block per
file), and tells the assistant to keep it current. Every Pi session in this checkout gets both, and
each session reads `MEMORY.md` once, the way Pi reads `AGENTS.md`.

## Use them

Install the whole repository as one Pi package (recommended — it is what this repo is designed for):

```bash
pi install .
```

Install a single package instead:

```bash
pi install ./packages/pi-bg-tasks
```

Try an extension for one run, without touching settings:

```bash
pi -e ./packages/pi-bg-tasks/src/index.ts
```

Check what is loaded and manage it:

```bash
pi list
pi config
```

> [!IMPORTANT]
> Pi extensions run with your full user permissions and can read credentials, files, and session
> history. Load only extensions you have read. Note that `pi-bg-tasks` replaces the built-in `bash`
> tool, so do not install the repository and one of its packages at the same time.

## Develop against them

```bash
npm install
npm run dev                     # pi with every extension in the repo loaded from source
npm run dev -- --only pi-bg-tasks   # only one of them
/reload                         # inside that pi session, after editing a file
```

| Command                                    | What it does                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `npm run check`                            | Manifest sync check, typecheck, lint/format check, tests. Run this before you call work done. |
| `npm test`                                 | Vitest suite. Extension tests spawn real processes.                                           |
| `npm run typecheck`                        | `tsc --noEmit` over packages and tests.                                                       |
| `npm run lint`                             | Biome lint and format check.                                                                  |
| `npm run fmt`                              | Apply Biome fixes (format, safe lint fixes, import order).                                    |
| `npm run manifest`                         | Rewrite the root `pi.extensions` list from the packages. `--check` in CI.                     |
| `npm run new -- pi-name --description "…"` | Scaffold a new extension package, test, README, and manifest entry.                           |
| `npm run dev`                              | Pi with the repo's extensions loaded from source.                                             |
| `npm run smoke -- pi-takeover`             | Drive a real Pi with a scripted model, and print what happened.                               |
| `npm run install:personal`                 | `pi install .` — add this repo to your personal Pi settings.                                  |

## Layout

```text
package.json              workspace root + Pi manifest listing every extension entry
AGENTS.md                 how to work here, written by the user (Pi injects it)
MEMORY.md                 how the work actually goes, written by you (pi-memory injects it)
packages/
  pi-bg-tasks/
    package.json          Pi manifest (pi.extensions), peer dependencies, npm metadata
    src/index.ts          the extension
    test/*.test.ts        behaviour tests
    README.md             user-facing documentation
  pi-memory/
    ...
  pi-subagent/
  pi-takeover/
    ...
test/
  helpers/extension.ts    shared harness: load an extension with a recording pi API
  helpers/wait.ts         process polling helpers
  helpers/env.ts          environment scoping
  repo.test.ts            packaging and repository conventions
  load.test.ts            loads every package through Pi's own extension loader
scripts/
  sync-manifest.mjs       keep the root Pi manifest in sync with packages/
  new-extension.mjs       scaffold the next extension
  dev.mjs                 run pi against the repo's sources
docs/                     packaging, testing, and conventions
```

## How it is packaged

Pi discovers resources from the root `pi` manifest, so `pi install .` (or
`pi install git:github.com/italian-brainrot/my-pi-extensions` once public) loads every extension in
`packages/`. Each package also carries its own manifest, so it can be installed on its own. Sources
ship as TypeScript: Pi compiles them with jiti, so there is no build step.

Host-provided Pi packages are declared as `peerDependencies: "*"` and pinned in the root
`devDependencies` for typechecking and tests — never as `dependencies`, which would bundle a second
copy of Pi's modules. Details: [docs/packaging-and-installing.md](./docs/packaging-and-installing.md).

## Adding an extension

```bash
npm run new -- pi-wordcount --description "Count words in the files a session touched"
```

That creates the package, a first test, a README, and the manifest entry. Then read
[docs/adding-an-extension.md](./docs/adding-an-extension.md) for the conventions and the checklist,
and [docs/testing.md](./docs/testing.md) for the harness.

## Status

Packages are `private: true`: they are used from this repository and are not published to npm.
[docs/packaging-and-installing.md](./docs/packaging-and-installing.md#publishing-later) describes
what to change when that flips.

## License

MIT — see [LICENSE](./LICENSE).
