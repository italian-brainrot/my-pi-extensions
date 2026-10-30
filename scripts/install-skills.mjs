#!/usr/bin/env node
/**
 * Ship this repository's skills to the user skill directory Pi auto-discovers.
 *
 *   node scripts/install-skills.mjs                 copy skills/* into the target
 *   node scripts/install-skills.mjs --check         fail if the installed copy differs (used by `npm run check`)
 *   node scripts/install-skills.mjs --force         also replace a target directory the script did not create
 *
 * The skills here are not declared in the root Pi manifest: the repo package is installed once and
 * the skills are installed as user skills, under `~/.agents/skills/<name>` (or `PI_SKILLS_DIR`), which
 * Pi reads for every session in every project. That also means a skill edit is invisible until it is
 * copied, and a stale copy keeps being used quietly — hence `--check`, which is in `npm run check`.
 *
 * One skill must exist in exactly one place. A second copy under the same name makes Pi warn about a
 * collision and the first one it finds wins, so this script replaces its own target directory rather
 * than merging into it, and refuses to touch a target it did not create.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const skillsRoot = join(repoRoot, "skills");
const check = process.argv.includes("--check");
const force = process.argv.includes("--force");

const targetRoot = resolve(process.env.PI_SKILLS_DIR ?? join(homedir(), ".agents", "skills"));
/** Marks a directory this script owns, so `--check` and the copy never fight a hand-made skill. */
const MARKER = ".pi-repo-skills.json";

function skillDirs() {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/** Every file under a directory, as `path → sha256`, sorted by path. Marker files are ignored. */
function fingerprint(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== MARKER) files.set(relative(dir, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(dir);
  return new Map([...files].sort());
}

function diff(source, target) {
  const problems = [];
  if (!existsSync(target)) return ["not installed"];
  const a = fingerprint(source);
  const b = fingerprint(target);
  for (const [path, hash] of a) {
    if (!b.has(path)) problems.push(`${path}: missing in the installed copy`);
    else if (b.get(path) !== hash) problems.push(`${path}: differs from skills/${path}`);
  }
  for (const path of b.keys()) if (!a.has(path)) problems.push(`${path}: not in the repository (stale file?)`);
  return problems;
}

const names = skillDirs();
if (names.length === 0) {
  console.log("No skills in skills/ (a skill is a directory with a SKILL.md); nothing to do.");
  process.exit(0);
}

if (!existsSync(targetRoot) && check) {
  // A machine with no user skill directory at all — CI, a fresh checkout. Not drift, just not installed.
  console.log(`No skill directory at ${targetRoot}; skipping the drift check. Run: npm run install:skills`);
  process.exit(0);
}

/** True when the directory carries this repository's marker, i.e. the copy here is ours to replace. */
function owned(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), "utf8")).repo === repoRoot;
  } catch {
    return false;
  }
}

const blocked = [];
const drift = [];
const identicalUnmanaged = [];
for (const name of names) {
  const target = join(targetRoot, name);
  if (existsSync(target) && !owned(target) && !force) {
    // Somebody put a skill of this name here by hand. Compare it, but do not overwrite it.
    const differences = diff(join(skillsRoot, name), target);
    if (differences.length === 0) identicalUnmanaged.push(name);
    else blocked.push(`${name}: ${target} is not managed by this script and differs from skills/${name} — use --force to replace it`);
    continue;
  }
  drift.push(...diff(join(skillsRoot, name), target).map((problem) => `${name}: ${problem}`));
}

if (check) {
  if (blocked.length > 0 || drift.length > 0) {
    console.error("Installed skills are out of date:");
    for (const problem of blocked) console.error(`  - ${problem}`);
    for (const problem of drift) console.error(`  - ${problem}`);
    console.error("Run: npm run install:skills   (then /reload, or a new session, to load them)");
    process.exit(1);
  }
  for (const name of identicalUnmanaged) console.log(`${name}: installed copy is unmanaged but identical to the repository.`);
  console.log(`Skills in ${targetRoot} match the repository: ${names.join(", ")}.`);
  process.exit(0);
}

if (blocked.length > 0) {
  // Refuse to half-install: leaving one skill stale is exactly the drift being prevented.
  console.error("Not installing, because a target needs a decision:");
  for (const problem of blocked) console.error(`  - ${problem}`);
  process.exit(1);
}

mkdirSync(targetRoot, { recursive: true });
for (const name of names) {
  const target = join(targetRoot, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(skillsRoot, name), target, { recursive: true });
  const files = [...fingerprint(target).keys()];
  writeFileSync(join(target, MARKER), `${JSON.stringify({ repo: repoRoot, installedAt: new Date().toISOString(), files }, null, 2)}\n`);
  console.log(`${name} → ${target} (${files.length} files)`);
}

// A skill that used to be here and is gone from the repository should stop loading.
for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || names.includes(entry.name)) continue;
  if (owned(join(targetRoot, entry.name))) {
    rmSync(join(targetRoot, entry.name), { recursive: true, force: true });
    console.log(`removed ${entry.name}: no longer in skills/`);
  }
}
