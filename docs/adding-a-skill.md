# Adding a skill

A skill is a directory under `skills/` with a `SKILL.md`. Pi advertises only its name, description, and
path at startup, and reads the file when a task matches, so the description does the routing and the
body should read like a short runbook rather than a manual.

```text
skills/<name>/
  SKILL.md          frontmatter (name, description) plus the instructions the model follows
  scripts/          helpers the instructions tell the model to run
  references/       deeper material, read only when the instructions point at it
```

## Conventions here

- `name` in the frontmatter matches the directory name; the description says what the skill does **and**
  when to reach for it, in plain language a model can route on.
- Keep `SKILL.md` near 80 lines. Command flags, protocol notes, and edge cases go to `references/`.
- Scripts take the boring parts off the model: finding the external binary, bounding output, exit codes,
  a usage block when called with no arguments.
- Anything a script prints lands in the model's context. Big output goes to a cache directory with a
  bounded preview and a path, so the model can `read` or `grep` the file instead.
- Scripts are executable and shebang'd; name Node scripts `.mjs` so the extension is unambiguous.
- `test/skills.test.ts` loads `skills/` through Pi's own skill loader (a malformed skill fails the
  build) and checks that every script is executable, parses, prints usage with no arguments, and fails
  loudly when its external binary is missing. Extend it when a skill gains a script.

## Shipping and checking it

`npm run manifest` keeps `pi.skills` in the root manifest, so `pi install .` ships skills alongside the
extensions. Installs from a local path load from the working tree, so editing a skill plus `/reload` is
the whole update loop.

Pi discovers skills from the package, the agent directory (`~/.pi/agent/skills/`), and `.pi/skills/`.
Declare the package path (`"skills": ["./skills"]`) once and skip symlinks into the agent directory —
two copies of one skill produce a name-collision warning and the first one found wins.

To confirm discovery without a model:

```bash
pi --mode rpc            # then send {"type":"get_commands"} and look for skill:<name>
```

or type `/skill:<name>` in an interactive session, which forces the skill into the conversation even
when the model would not have loaded it.
