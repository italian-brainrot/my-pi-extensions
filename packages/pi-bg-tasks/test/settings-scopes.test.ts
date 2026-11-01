/**
 * Pi merges its settings scopes key by key: `settings = deepMerge(global, project)`. So the two keys
 * the shell tool reads are resolved separately — a project that sets only `shellCommandPrefix` still
 * gets the agent's `shellPath`, and the other way round. Reading the first file that exists, or the
 * first file with either key set, gets that wrong.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const originalCwd = process.cwd();

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;
let project: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function settings(dir: string, values: Record<string, unknown>): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(values));
}

beforeEach(async () => {
  agentDir = makeTempDir("pi-ext-agent-");
  project = makeTempDir("pi-ext-project-");
  mkdirSync(join(project.path, ".pi"), { recursive: true });
  process.chdir(project.path);

  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  process.chdir(originalCwd);
  project?.dispose();
  agentDir?.dispose();
});

describe("settings scopes", () => {
  it("takes the shell from the agent settings and the prefix from the project's", async () => {
    settings(agentDir.path, { shellPath: "sh" });
    settings(join(project.path, ".pi"), { shellCommandPrefix: "echo prefix-ran" });

    const result = await ext!.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}-the-command" });

    // Both settings applied to the same command: `sh` ran it, and the prefix line ran inside it.
    expect(text(result)).toContain("prefix-ran");
    expect(text(result)).toContain("BASH=none-the-command");
  });

  it("takes the shell from the project settings and the prefix from the agent's", async () => {
    settings(agentDir.path, { shellCommandPrefix: "echo prefix-ran" });
    settings(join(project.path, ".pi"), { shellPath: "sh" });

    const result = await ext!.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}-the-command" });

    expect(text(result)).toContain("prefix-ran");
    expect(text(result)).toContain("BASH=none-the-command");
  });
});
