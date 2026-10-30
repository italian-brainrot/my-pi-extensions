#!/usr/bin/env node
/**
 * Fail when package-lock.json does not describe the workspaces and root dependencies that
 * package.json declares, which is exactly the state in which `npm ci` refuses to run.
 *
 *   node scripts/check-lock.mjs
 *
 * `npm run check` runs this first, so a package added without `npm install` fails here rather than
 * at the install step of CI. It deliberately does not shell out to npm: `npm ci --dry-run` is the
 * obvious version of this check and it deletes node_modules as its first step, then leaves it gone
 * because --dry-run skips the install it had promised. This only reads files.
 *
 * What it checks is what npm compares: the root entry, one entry per workspace, and the link from
 * node_modules to each workspace. Version *ranges* must match string-for-string; whether a resolved
 * version satisfies a range is npm's business, and CI still runs the real `npm ci`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const root = readJson(join(repoRoot, "package.json"));
const lockPath = join(repoRoot, "package-lock.json");

if (!existsSync(lockPath)) {
  console.error("package-lock.json is missing. Run: npm install");
  process.exit(1);
}

const lock = readJson(lockPath);
const packages = lock.packages;

if (!packages) {
  console.error(`package-lock.json has no "packages" map (lockfileVersion ${lock.lockfileVersion}).`);
  console.error("Regenerate it: npx npm@11 install");
  process.exit(1);
}

const problems = [];

// Compare the dependency maps npm mirrors into the root entry. An edited range in package.json with
// a lock still holding the old one is the other way CI's npm ci fails.
function compareDeps(where, manifest, entry) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const declared = manifest[field] ?? {};
    const recorded = entry?.[field] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (recorded[name] === undefined) problems.push(`${where}: ${field} "${name}" is missing from the lock file`);
      else if (recorded[name] !== spec)
        problems.push(`${where}: ${field} "${name}" is "${recorded[name]}" in the lock file, "${spec}" in package.json`);
    }
    for (const name of Object.keys(recorded)) {
      if (declared[name] === undefined) problems.push(`${where}: ${field} "${name}" is in the lock file but not in package.json`);
    }
  }
}

compareDeps("root", root, packages[""]);

if (packages[""]?.name !== root.name) problems.push(`root: lock name "${packages[""]?.name}" != "${root.name}"`);
if (packages[""]?.version !== root.version) problems.push(`root: lock version "${packages[""]?.version}" != "${root.version}"`);

const workspaceGlobs = root.workspaces ?? [];
if (JSON.stringify(packages[""]?.workspaces ?? []) !== JSON.stringify(workspaceGlobs)) {
  problems.push(`root: lock workspaces ${JSON.stringify(packages[""]?.workspaces)} != ${JSON.stringify(workspaceGlobs)}`);
}

// Workspaces: every package directory npm would pick up has to have an entry and a node_modules link.
const packagesRoot = join(repoRoot, "packages");
const workspaceDirs =
  workspaceGlobs.includes("packages/*") && existsSync(packagesRoot)
    ? readdirSync(packagesRoot).filter((name) => existsSync(join(packagesRoot, name, "package.json")))
    : [];
const workspaceNames = new Set();

for (const dir of workspaceDirs) {
  const manifest = readJson(join(packagesRoot, dir, "package.json"));
  workspaceNames.add(manifest.name);

  if (manifest.name !== dir) {
    problems.push(`packages/${dir}: package.json name "${manifest.name}" does not match its directory`);
    continue;
  }

  const entry = packages[`packages/${dir}`];
  if (!entry) {
    problems.push(`packages/${dir}: missing from the lock file`);
    continue;
  }
  if (entry.version !== manifest.version) problems.push(`packages/${dir}: lock version "${entry.version}" != "${manifest.version}"`);

  compareDeps(`packages/${dir}`, manifest, entry);

  const link = packages[`node_modules/${dir}`];
  if (link?.resolved !== `packages/${dir}` || link?.link !== true)
    problems.push(`packages/${dir}: node_modules/${dir} is not linked to it in the lock file`);
}

// A lock that still describes a removed package makes npm ci rewrite it; a workspace renamed away
// without an install is the same mistake as forgetting one.
for (const key of Object.keys(packages)) {
  if (!key.startsWith("packages/")) continue;
  const dir = key.slice("packages/".length);
  if (!workspaceNames.has(dir)) problems.push(`${key}: in the lock file but packages/${dir} does not exist`);
  if (!existsSync(join(packagesRoot, dir, "package.json"))) problems.push(`${key}: in the lock file but has no package.json`);
}

if (problems.length > 0) {
  console.error("package-lock.json is out of sync; npm ci would refuse to install:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nFix it: npm install   (with an npm as new as the one that wrote the lock: npx npm@11 install)");
  process.exit(1);
}

console.log(`Lock file is in sync: ${workspaceDirs.length} workspace(s), ${Object.keys(packages).length} entries.`);
