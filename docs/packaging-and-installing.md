# Packaging and installing

## How Pi finds resources in this repository

A Pi package is an ordinary directory or npm package. It can expose conventional directories
(`extensions/`, `skills/`, `prompts/`, `themes/`) or declare paths in its `package.json` under `pi`.
This repository uses the second form, because the extensions live in `packages/*` rather than in one
conventional directory:

```jsonc
// package.json (root)
{
  "pi": {
    "extensions": ["./packages/pi-bg-tasks/src/index.ts", "./packages/pi-subagent/src/index.ts"]
  }
}
```

That list is generated: run `npm run manifest` after adding or renaming a package, and
`npm run check` fails when it drifts.

Each package declares its own entry points too, so it can be installed on its own:

```jsonc
// packages/pi-bg-tasks/package.json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

## Installing

```bash
pi install .                                  # personal settings: the whole repository
pi install ./packages/pi-bg-tasks             # one package
pi install -l .                               # project settings (loaded after project trust)
pi -e ./packages/pi-bg-tasks/src/index.ts     # one run, nothing written to settings
pi list                                       # what is configured
pi config                                     # enable/disable individual resources
pi remove .                                   # drop it again
```

Local sources are loaded from their resolved path without being copied, so an edit plus `/reload` is
the whole update loop. Pi identifies a local package by its resolved absolute path, which is why
installing the repository **and** one of its packages is a mistake worth avoiding: they are different
identities, and `pi-bg-tasks` claims the `bash` tool. `pi list` plus `pi config` show what is loaded.

Once the repository is public, a git source works the same way:

```bash
pi install git:github.com/italian-brainrot/my-pi-extensions
pi install git:github.com/italian-brainrot/my-pi-extensions@v1.0.0   # pinned tag
```

## Concurrent pi processes share the agent directory

Every pi you start loads the same installed extensions against the same agent directory: the
interactive session, a `pi -p` from a script, an RPC session, and the nested pi a `subagent` call
spawns. Nothing in the install chain separates them — there is no per-session or per-project scope to
enable. That is invisible until an extension keeps state under the agent directory.

`pi-bg-tasks` does exactly that, with its job metadata in `<agent-dir>/bg-tasks`. Without ownership
markers every process adopts every live sidecar it finds there, so a nested pi stopped the commands
its parent session was running (fixed in 0.1.1; the behaviour is documented in the
[package README](../packages/pi-bg-tasks/README.md)). The sharpest version of that is circular: the
sidecar for a running foreground command is written before the command even starts, so a `bash` call
that launches a pi had its own sidecar adopted by the pi it launched, and the pi killed its parent
command on the way out. Each sidecar now records `ownerPid`, and adoption, shutdown, and log pruning
all skip entries another live process owns.

The same rule applies to anything added later: mark what you write with its owner, and leave other
owners alone. `adoptJobs` and `pruneRetention` in `packages/pi-bg-tasks/src/index.ts` are the working
example, and `packages/pi-bg-tasks/test/cross-process.test.ts` is how it is guarded.

## Dependencies: peers, never copies

Pi provides these modules to extensions:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Declare the ones a package imports as `peerDependencies` with the range `"*"`, and **never** put them
in `dependencies`: a physical copy can bypass Pi's extension module mapping in compiled ESM and create
duplicate classes, registries, and initialization work. Pi reports a warning when it sees that shape,
and `test/repo.test.ts` fails the build before it gets that far.

For local development the same modules are pinned in the root `devDependencies`, which is what gives
`tsc --noEmit` and Vitest real types. Keep that pin equal to the Pi you run — `pi update` moves it:

```bash
npm view @earendil-works/pi-coding-agent version
npm install -D @earendil-works/pi-coding-agent@<that version> \
  @earendil-works/pi-ai@<that version> \
  @earendil-works/pi-agent-core@<that version> \
  @earendil-works/pi-tui@<that version>
```

Third-party runtime dependencies are allowed, but they have to be real `dependencies` and reachable
from the installed tree; nothing in this repository needs one today.

Dependabot opens monthly PRs and groups the Pi-provided ones together. Merge those only when the local
Pi has been updated to the same version, because the root pin is what typechecks against. See
`.github/dependabot.yml`.

## No build step

Extensions ship as TypeScript. Pi compiles them with jiti, and Vitest transforms them for tests, so
the only compiler in the loop is `tsc --noEmit` for typechecking. Do not add a bundler unless an
extension genuinely needs one: it would double the number of ways the shipped code can differ from the
code under test.

## Publishing later

Everything except publishing is already in place. To publish to npm:

1. Create the npm scope (or rename the packages to unscoped `pi-*` names and confirm they are free).
2. Set `name` to the scoped name, add `repository.directory` (`packages/<name>`) so npm shows the
   right source, and flip `private: true` to `false`.
3. Keep `peerDependencies: "*"` and `files: ["src", "README.md"]`.
4. Add a publish workflow (`npm publish --workspaces --access public` on a tag, after `npm run check`)
   and pin the version in `devDependencies` so a published package is reproducible.
5. Relax the `private: true` assertion in `test/repo.test.ts` into a version/publish readiness check.

Until then, `private: true` is deliberate: `npm publish` from this workspace would otherwise upload
work in progress.

## Loading the same code in development

`npm run dev` starts Pi with `-e` for every entry in the root manifest and writes nothing to your
settings, so development does not depend on install state at all. Use `--only pi-bg-tasks` to load a
subset. Personal installation (`pi install .`) is for when the extensions are good enough to live in
every session.
