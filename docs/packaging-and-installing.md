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

That list of extensions is generated: run `npm run manifest` after adding or renaming a package, and
`npm run check` fails when it drifts.

Skills are deliberately not in that list. They live in `skills/` and are installed as user skills with
`npm run install:skills`, which copies them to `~/.agents/skills` so every project sees them; declaring
the same skills in the manifest as well would give Pi two directories with one skill name, and it warns
about the collision and keeps whichever it finds first. `npm run skills:check`, also part of
`npm run check`, fails when the installed copy no longer matches the repository. See
[adding-a-skill.md](./adding-a-skill.md).

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
`tsc --noEmit` and Vitest real types. Pi never loads those copies: its extension loader aliases every
`typebox` and `@earendil-works/*` specifier to a path resolved out of Pi's own tree (`getAliases` in
`dist/core/extensions/loader.js`). Our pins are therefore only ever the types of the Pi that will load
the extension, and they are only right when they are the versions that Pi ships. Pin them exactly, the
way Pi pins them itself, and update them together when `pi update` moves the host:

```bash
pi --version
npm install -D @earendil-works/pi-coding-agent@<that version> \
  @earendil-works/pi-ai@<that version> \
  @earendil-works/pi-agent-core@<that version> \
  @earendil-works/pi-tui@<that version>
```

`npm run deps:check` also runs `scripts/check-pi-pin.mjs`, which enforces this from both sides: it reads
the pinned Pi's own `package.json` and fails when any of those pins is a range instead of the host's
exact version, or when npm has installed a copy the host will not load (the second copy then sits under
`node_modules/@earendil-works/pi-coding-agent`, which the failure names). When a Pi is installed on the
machine — `~/.pi/agent/install/current-version`, or `PI_MANAGED_INSTALL_ROOT` — it also fails when that
Pi is a different version than the one being typechecked against, which is what a `pi update` without a
re-pin looks like. CI has no Pi, so it only runs the first half.

A dependency PR that bumps `typebox` or `jiti` on their own is exactly the mistake that check exists to
catch, and it fails CI rather than needing a human to notice; `.github/dependabot.yml` ignores those two
for the same reason. A PR bumping the Pi packages themselves is only correct once the Pi on this machine
matches, which is the half CI cannot see.

Third-party runtime dependencies are allowed, but they have to be real `dependencies` and reachable
from the installed tree; nothing in this repository needs one today.

### The lockfile has to be committed and in sync

CI installs with `npm ci`, which refuses to run when `package-lock.json` does not describe every
workspace — adding a package without running `npm install` fails the build at the install step, with
no test output at all. `npm run deps:check` (part of `npm run check`) compares the two files and names
the same drift in milliseconds, so it is caught before the push. `npm run new` runs the install for you.

Do not write that check as `npm ci --dry-run`: `npm ci` deletes `node_modules` as its first step, and
`--dry-run` never puts it back. `scripts/check-lock.mjs` only reads files.

Regenerate the lock with an npm as new as the one that wrote it. CI runs npm 10 and 11; an older npm
rewrites the lockfile and drops fields it does not know about, which buries the real change in churn:

```bash
npx npm@11 install
```

## No build step

Extensions ship as TypeScript. Pi compiles them with jiti, and Vitest transforms them for tests, so
the only compiler in the loop is `tsc --noEmit` for typechecking. Do not add a bundler unless an
extension genuinely needs one: it would double the number of ways the shipped code can differ from the
code under test.

`tsc` here is TypeScript 7, the native compiler: `npm ci` pulls in one platform binary as an optional
dependency and typechecking takes under a second. It is a compiler, not the `typescript` JavaScript
library, so nothing in this repository can `import "typescript"` to inspect or rewrite source — if a
script ever needs the compiler API, that is a separate dependency and a decision, not a detail.

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
