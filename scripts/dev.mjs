#!/usr/bin/env node
/**
 * Run pi with every extension in this repository loaded from source, without installing
 * anything into your settings: `npm run dev`.
 *
 * Extra arguments go to pi, so `npm run dev -- -p "hello"` runs print mode, and
 * `npm run dev -- --model some/model` picks a model.
 *
 * Load a subset with `--only` (repeatable) or PI_DEV_PACKAGES="pi-bg-tasks pi-subagent".
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const passthrough = process.argv.slice(2);
const filter = (process.env.PI_DEV_PACKAGES ?? "")
  .split(/[\s,]+/)
  .map((name) => name.trim())
  .filter(Boolean);

for (let i = 0; i < passthrough.length; i++) {
  if (passthrough[i] === "--only") {
    const value = passthrough[i + 1];
    if (!value) {
      console.error("--only needs a package name, for example --only pi-bg-tasks");
      process.exit(1);
    }
    filter.push(value);
    passthrough.splice(i, 2);
    i--;
  }
}

const entries = (root.pi?.extensions ?? [])
  .map((entry) => ({ entry, path: resolve(repoRoot, entry) }))
  .filter(({ entry, path }) => {
    if (!existsSync(path)) {
      console.error(`Root manifest points at a missing file: ${entry}`);
      process.exit(1);
    }
    if (filter.length === 0) return true;
    const packageName = entry.split("/")[2];
    return filter.includes(packageName);
  });

if (entries.length === 0) {
  console.error("No extensions matched PI_DEV_PACKAGES.");
  process.exit(1);
}

const args = [];
for (const { path } of entries) args.push("-e", path);
args.push(...passthrough);

console.error(`Loading ${entries.length} extension(s): ${entries.map((entry) => entry.entry).join(", ")}`);

const result = spawnSync("pi", args, { cwd: process.cwd(), stdio: "inherit" });

if (result.error) {
  console.error(`Could not run pi: ${result.error.message}`);
  console.error("Is pi installed and on PATH?");
  process.exit(1);
}
process.exit(result.status ?? 0);
