/**
 * Pi's own shell tool reads two settings: `shellPath` (covered in shell-precedence.test.ts) and
 * `shellCommandPrefix`, "prefix prepended to every bash command, for example to enable shell aliases".
 * A replacement for the bash tool has to honour both, or a command that works with the built-in tool —
 * because it relies on an alias, a shell function, or an environment the prefix sets up — fails with
 * pi-bg-tasks installed, with no timeout anywhere near the failure.
 *
 * The prefix is on disk before the runtime loads, so a fix may read it whenever it likes: at module
 * load, with the cached shell, or per call.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const PREFIX_LINE = "prefix-ran-here";
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

async function runtime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

async function stopRuntime(): Promise<void> {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
}

beforeEach(async () => {
  await stopRuntime();
  agentDir = makeTempDir("pi-ext-agent-");
  project = makeTempDir("pi-ext-project-");
});

afterEach(async () => {
  await stopRuntime();
  process.chdir(originalCwd);
  project?.dispose();
  agentDir?.dispose();
});

describe("settings the replacement bash tool shares with the built-in one", () => {
  it("prepends the agent-level shellCommandPrefix to a command", async () => {
    settings(agentDir.path, { shellCommandPrefix: `echo ${PREFIX_LINE}` });
    ext = await runtime();

    const result = await ext.callTool("bash", { command: "echo the-command" });

    expect(text(result)).toContain(PREFIX_LINE);
    expect(text(result)).toContain("the-command");
  });

  it("prepends it to a command that goes to the background as well", async () => {
    settings(agentDir.path, { shellCommandPrefix: `echo ${PREFIX_LINE}` });
    ext = await runtime();

    const started = await ext.callTool("bash", { command: "echo the-command", timeout: 0 });
    const wait = await ext.callTool("bg_wait", { timeout: 10 });
    const task = wait.structuredContent.tasks.find((entry: any) => entry.id === started.details.id);

    expect(readFileSync(task.log_path, "utf8")).toContain(PREFIX_LINE);
    expect(readFileSync(task.log_path, "utf8")).toContain("the-command");
  });

  it("prefers the project prefix, the way Pi merges project settings over the agent's", async () => {
    settings(agentDir.path, { shellCommandPrefix: `echo ${AGENT_PREFIX_LINE}` });
    mkdirSync(join(project.path, ".pi"), { recursive: true });
    settings(join(project.path, ".pi"), { shellCommandPrefix: `echo ${PREFIX_LINE}` });
    process.chdir(project.path);
    ext = await runtime();

    const result = await ext.callTool("bash", { command: "echo the-command" });

    expect(text(result)).toContain(PREFIX_LINE);
    expect(text(result)).not.toContain(AGENT_PREFIX_LINE);
  });
});
