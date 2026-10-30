#!/usr/bin/env node
/**
 * Keep the root package.json `pi.extensions` list in sync with the packages.
 *
 *   node scripts/sync-manifest.mjs          rewrite
 *   node scripts/sync-manifest.mjs --check  fail if it is out of date (used by `npm run check`)
 *
 * Without the root list, `pi install <repo>` would only pick up the conventional
 * `extensions/` directory, which this repo does not use.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const check = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const packagesRoot = join(repoRoot, "packages");
const packageNames = existsSync(packagesRoot)
  ? readdirSync(packagesRoot).filter((name) => existsSync(join(packagesRoot, name, "package.json")))
  : [];

const entries = [];
const problems = [];

for (const name of packageNames) {
  const manifest = readJson(join(packagesRoot, name, "package.json"));
  const declared = manifest.pi?.extensions;

  if (!Array.isArray(declared) || declared.length === 0) {
    problems.push(`${name}: package.json needs a "pi.extensions" array listing its entry points`);
    continue;
  }

  for (const entry of declared) {
    if (!entry.startsWith("./")) {
      problems.push(`${name}: entry "${entry}" must be relative to the package and start with "./"`);
      continue;
    }
    if (!existsSync(join(packagesRoot, name, entry))) {
      problems.push(`${name}: entry "${entry}" does not exist on disk`);
      continue;
    }
    entries.push(`./packages/${name}/${entry.replace(/^\.\//, "")}`);
  }
}

entries.sort();

const rootPath = join(repoRoot, "package.json");
const root = readJson(rootPath);
const current = root.pi?.extensions ?? [];

// Skills are not generated from packages, but a `skills/` directory that is not declared in the
// manifest would silently not ship, and a declared path that moved would silently load nothing.
const skillEntries = existsSync(join(repoRoot, "skills")) ? ["./skills"] : [];
for (const entry of root.pi?.skills ?? []) {
  if (!existsSync(join(repoRoot, entry))) problems.push(`root manifest: skill path "${entry}" does not exist on disk`);
}

if (problems.length > 0) {
  console.error("Package manifests are not usable:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const same = current.length === entries.length && current.every((entry, index) => entry === entries[index]);
const skillsMatch = JSON.stringify(root.pi?.skills ?? []) === JSON.stringify(skillEntries);

if (same && skillsMatch) {
  console.log(`Root manifest is in sync: ${entries.length} extension entries, ${(root.pi?.skills ?? []).length} skill path(s).`);
  process.exit(0);
}

if (check) {
  console.error("Root package.json pi manifest is out of date.");
  console.error(`  extensions current:  ${JSON.stringify(current)}`);
  console.error(`  extensions expected: ${JSON.stringify(entries)}`);
  console.error(`  skills current:  ${JSON.stringify(root.pi?.skills ?? [])}`);
  console.error(`  skills expected: ${JSON.stringify(skillEntries)}`);
  console.error("Run: npm run manifest");
  process.exit(1);
}

root.pi = { ...root.pi, extensions: entries };
if (skillEntries.length > 0) root.pi.skills = skillEntries;
else delete root.pi.skills;
writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
console.log(`Wrote ${entries.length} extension entries and ${skillEntries.length} skill paths into the root manifest.`);
