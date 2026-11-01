/**
 * Two edges of the per-scope settings merge that pass 1 added.
 *
 * Pi reads its two scopes as files and deep-merges them (`deepMergeSettings(global, project)`), where
 * "not set" means the key is *absent* — a key that is present with `""` or `null` overrides, whatever it
 * holds, because "settings files are not validated; a malformed value replaces instead of throwing
 * there". A project that sets `shellCommandPrefix` to the empty string to turn an agent-level prefix off,
 * or `shellPath` to null to fall back to the default shell, means it. Resolving a key as "the first scope
 * with a non-empty string" silently keeps the agent's value, which is the thing the project asked to
 * switch off.
 *
 * And a configured shell that does not exist is a broken setting, not a failed command. Pi's own tool
 * refuses it by name — `Custom shell path not found: <path>` — because the alternative reads as the
 * command exiting non-zero, and the model goes looking for a problem with its command.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const AGENT_PREFIX_LINE = "agent-prefix-ran";

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
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  process.chdir(originalCwd);
  project?.dispose();
  agentDir?.dispose();
});

describe("what counts as a setting being set", () => {
  it("lets a project turn off an agent-level shellCommandPrefix with an empty string", async () => {
    settings(agentDir.path, { shellCommandPrefix: `echo ${AGENT_PREFIX_LINE}` });
    settings(join(project.path, ".pi"), { shellCommandPrefix: "" });

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result)).toContain("the-command");
    expect(text(result), "the project asked for no prefix").not.toContain(AGENT_PREFIX_LINE);
  });

  it("lets a project fall back to the default shell with a null shellPath", async () => {
    settings(agentDir.path, { shellPath: "/definitely/not/a/shell" });
    settings(join(project.path, ".pi"), { shellPath: null });

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError, "Pi's merge leaves shellPath unset, so its default shell runs the command").toBeFalsy();
    expect(text(result)).toContain("the-command");
  });

  it("says which configured shell is missing when the setting points at nothing", async () => {
    settings(join(project.path, ".pi"), { shellPath: "/definitely/not/a/shell" });

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError).toBe(true);
    expect(text(result), "the message must blame the setting, not the command").toMatch(/Custom shell path not found/i);
  });
});
