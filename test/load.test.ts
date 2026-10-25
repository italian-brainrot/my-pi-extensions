/**
 * Load every extension through Pi's own loader (jiti + package manifest resolution).
 *
 * This is the closest thing to `pi install <repo>` that runs without a model: it proves the
 * manifests point at real entry points, that the modules evaluate against Pi's host packages,
 * and that no two extensions claim the same tool.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeTempDir, packageDir, repoRoot } from "./helpers/extension.ts";

const EXPECTED = [
  { package: "pi-bg-tasks", tools: ["bash", "bg_stop", "bg_wait"], events: ["session_shutdown", "session_start"] },
  { package: "pi-memory", tools: [], events: ["before_agent_start"] },
  { package: "pi-subagent", tools: ["subagent"], events: [] },
];

const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

async function load(paths: string[]) {
  const cwd = makeTempDir("pi-load-cwd-");
  const agentDir = makeTempDir("pi-load-agent-");
  try {
    return await discoverAndLoadExtensions(paths, cwd.path, agentDir.path);
  } finally {
    cwd.dispose();
    agentDir.dispose();
  }
}

describe("Pi loads the packages", () => {
  it("keeps this test's expectations in step with the packages on disk", () => {
    const onDisk = readdirSync(resolve(repoRoot, "packages"));
    const covered = EXPECTED.map((entry) => entry.package);

    const missing = onDisk.filter((name) => !covered.includes(name));
    expect(
      missing,
      `Add an entry for ${missing.join(", ")} to EXPECTED in test/load.test.ts: the tools and lifecycle events it registers.`,
    ).toEqual([]);
    const stale = covered.filter((name) => !onDisk.includes(name));
    expect(stale, `Remove the entries for packages that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });

  it.each(EXPECTED)("$package loads through its package manifest", async ({ package: name, tools, events }) => {
    const result = await load([packageDir(name)]);

    expect(result.errors).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
    expect(result.extensions).toHaveLength(1);

    const [extension] = result.extensions;
    expect(extension).toBeDefined();
    expect(extension!.resolvedPath).toBe(resolve(packageDir(name), "src", "index.ts"));
    expect([...extension!.tools.keys()].sort()).toEqual(tools);
    expect([...extension!.handlers.keys()].sort()).toEqual(events);
  });

  it("loads everything declared by the root manifest in one run", async () => {
    const entries = (rootManifest.pi.extensions as string[]).map((entry) => resolve(repoRoot, entry));
    const result = await load(entries);

    expect(result.errors).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);

    const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(names.sort()).toEqual(EXPECTED.flatMap((entry) => entry.tools).sort());
  });
});
