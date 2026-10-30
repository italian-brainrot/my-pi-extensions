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

The skills in `skills/` are not declared in the root Pi manifest. They are installed as user skills:

```bash
npm run install:skills        # copy skills/* into ~/.agents/skills (PI_SKILLS_DIR to change it)
npm run skills:check          # fail if that copy has drifted; runs inside npm run check
```

`~/.agents/skills/<name>` is one of the places Pi discovers skills automatically — package paths, the
agent directory (`~/.pi/agent/skills/`), `~/.agents/skills/`, and `.pi/skills/` are the rest — so one
install serves every project, and a repo checkout is not needed for a session to use a skill. The cost
is a second copy that can go stale, which is what `skills:check` is for: it compares file by file, and
the install replaces the whole directory rather than merging, and records a marker so it knows which
copies are its own. A skill edit is live after `npm run install:skills` plus `/reload` or a new session.

One skill must exist in one place. Two directories with the same name make Pi warn about a collision
and the first one found wins, so do not also declare `pi.skills` in the root manifest or symlink into
the agent directory; `install:skills` refuses to overwrite a target it did not create unless you pass
`--force`.

To confirm discovery without a model:

```bash
pi --mode rpc            # then send {"type":"get_commands"} and look for skill:<name>
```

or type `/skill:<name>` in an interactive session, which forces the skill into the conversation even
when the model would not have loaded it.
