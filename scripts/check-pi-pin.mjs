#!/usr/bin/env node
/**
 * Fail when a module Pi provides to extensions is not pinned to exactly what the pinned Pi ships.
 *
 *   node scripts/check-pi-pin.mjs
 *
 * Pi never loads our copy of these modules. Its extension loader aliases every `typebox`, `typebox/compile`
 * and `@earendil-works/*` specifier to a path resolved out of Pi's own tree (`getAliases` in
 * dist/core/extensions/loader.js), so the copies in our node_modules feed `tsc --noEmit` and Vitest and
 * nothing else. A pin that drifts from the host therefore breaks nothing at load time — it only makes the
 * types describe a module the extension never runs.
 *
 * Both directions are mistakes, and they arrive by different routes:
 *
 *  - ahead of the host (a dependency PR bumping `typebox` past what Pi ships): npm installs the newer copy
 *    at the root and a second one under node_modules/@earendil-works/pi-coding-agent, typecheck reads ours,
 *    the extension runs the host's. Checked against the installed tree, so CI sees it.
 *  - behind the host (`pi update` without re-pinning): the types describe an older Pi than the one loading
 *    the extension. Checked against the managed install on this machine when there is one.
 *
 * Pi pins all of these to exact versions, so the fix is an exact pin in both directions:
 *
 *   npm install -D typebox@1.3.27 @earendil-works/pi-coding-agent@1.4.0 ...
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * Modules whose copy Pi controls. The first five are the specifiers the loader aliases; jiti is the
 * compiler Pi loads our TypeScript with, and packages/pi-bg-tasks/test/fixtures/foreign-runtime.mjs
 * imitates that loader, so it has to be the same jiti or the test exercises a different one.
 */
const HOST_MODULES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "typebox",
  "jiti",
];

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The version installed for us at the root of node_modules, or null when it is not installed at all. */
function installedVersion(name) {
  const path = join(repoRoot, "node_modules", name, "package.json");
  return existsSync(path) ? (readJson(path).version ?? null) : null;
}

/** Where the host's own copy lives once npm has had to keep two: nested under the Pi package. */
function hostCopyPath(name) {
  return join("node_modules", "@earendil-works", "pi-coding-agent", "node_modules", name);
}

/**
 * The Pi installed on this machine, from the managed-install layout (~/.pi/agent/install). Returns null
 * when there is none, which is the normal case in CI.
 */
function installedPiRelease() {
  const configured = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
  const candidates = configured
    ? [resolve(configured)]
    : [join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "install")];

  for (const root of candidates) {
    const marker = join(root, "current-version");
    if (!existsSync(marker)) continue;
    const version = readFileSync(marker, "utf8").trim();
    const manifest = join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    if (existsSync(manifest)) return { root, from: version, version: readJson(manifest).version };
  }
  return null;
}

const problems = [];
/** Which modules the "fix it" line has to name, in HOST_MODULES order. */
const drifted = new Set();

const rootManifest = readJson(join(repoRoot, "package.json"));
const declared = rootManifest.devDependencies ?? {};

const hostManifestPath = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
if (!existsSync(hostManifestPath)) {
  console.error("Pi is not installed in node_modules, so there is nothing to compare against. Run: npm ci");
  process.exit(1);
}
const host = readJson(hostManifestPath);
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
const hostPins = { ...host.dependencies, ...host.peerDependencies, [HOST_PACKAGE]: host.version };

const checked = [];

for (const name of HOST_MODULES) {
  const spec = declared[name];
  if (spec === undefined) continue;

  const wanted = hostPins[name];
  if (wanted === undefined) {
    problems.push(`${name}: Pi ${host.version} does not depend on it, so this repository cannot be typechecked against that Pi`);
    continue;
  }

  if (!EXACT.test(wanted)) {
    if (spec !== wanted)
      problems.push(`${name}: Pi ${host.version} declares "${wanted}" for it; copy that range into package.json instead of inventing one`);
    continue;
  }

  checked.push(`${name}@${wanted}`);

  if (spec !== wanted) {
    drifted.add(name);
    problems.push(`${name}: package.json declares "${spec}" but Pi ${host.version} pins it exactly at "${wanted}"`);
  }

  const installed = installedVersion(name);
  if (installed === null) {
    drifted.add(name);
    problems.push(`${name}: declared in package.json but not installed. Run: npm ci`);
  } else if (installed !== wanted) {
    drifted.add(name);
    const nested = existsSync(join(repoRoot, hostCopyPath(name))) ? `, while Pi's own ${wanted} sits in ${hostCopyPath(name)}` : "";
    problems.push(
      `${name}: node_modules holds ${installed}, but the extension loads Pi's ${wanted}${nested}. ` +
        "Typecheck and runtime would be reading different modules.",
    );
  }
}

const localPi = installedPiRelease();
if (localPi) {
  const ours = installedVersion(HOST_PACKAGE);
  if (ours && localPi.version !== ours) {
    // A pi update moves everything it ships, so the whole list has to move with it.
    for (const name of HOST_MODULES) drifted.add(name);
    problems.push(
      `the Pi on this machine is ${localPi.version} (${join(localPi.root, "current-version")}) but this repository typechecks ` +
        `against ${ours}. Re-pin the host packages to the Pi that will load the extensions.`,
    );
  }
}

if (problems.length > 0) {
  console.error("Pi-provided modules are not pinned to what the host ships:");
  for (const problem of problems) console.error(`  - ${problem}`);
  const fix = HOST_MODULES.filter((name) => drifted.has(name) && declared[name] !== undefined)
    .map((name) => `${name}@${hostPins[name] ?? declared[name]}`)
    .join(" ");
  console.error(`\nFix it: npm install -D ${fix}`);
  process.exit(1);
}

const local = localPi ? `, local Pi ${localPi.version}` : ", no Pi installed on this machine";
console.log(`Host pins are in sync: Pi ${host.version} pins ${checked.length} module(s) (${checked.join(", ")})${local}.`);
