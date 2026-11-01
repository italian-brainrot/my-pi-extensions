/**
 * The two settings are read from two files, and either file may be missing, unreadable, malformed, or
 * holding something that is not a string. Pi does not validate settings, so this extension has to decide
 * what a value it cannot use means, and it has to decide without failing the command or losing the scope
 * that _is_ readable. All of it is resolved once per runtime, which is why the settings are on disk before
 * each load in these tests.
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

function settings(dir: string, contents: string): void {
  writeFileSync(join(dir, "settings.json"), contents);
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

describe("settings files that are not well-formed", () => {
  it("still takes the agent scope when the project file is not valid JSON", async () => {
    settings(agentDir.path, JSON.stringify({ shellCommandPrefix: `echo ${AGENT_PREFIX_LINE}` }));
    settings(join(project.path, ".pi"), '{ "shellCommandPrefix": ');

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result), "a broken project file must not break the command").toContain("the-command");
    expect(text(result), "and must not hide the scope that is readable").toContain(AGENT_PREFIX_LINE);
  });

  it("still runs the command when the project file holds the JSON value null", async () => {
    // `JSON.parse` answers `null` without throwing, and a scope that parses to null mentions no keys —
    // Pi's loader treats that as an empty scope and reports the problem. `Object.hasOwn(null, key)`
    // throws, and it throws out of the tool, so every command of the session fails with a TypeError.
    settings(agentDir.path, JSON.stringify({ shellCommandPrefix: `echo ${AGENT_PREFIX_LINE}` }));
    settings(join(project.path, ".pi"), "null");

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result), "a null scope answers nothing for either key").toContain("the-command");
    expect(text(result)).toContain(AGENT_PREFIX_LINE);
  });

  it("still runs the command when the agent file holds the JSON value null", async () => {
    settings(join(project.path, ".pi"), JSON.stringify({ shellCommandPrefix: `echo ${AGENT_PREFIX_LINE}` }));
    settings(agentDir.path, "null");

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result)).toContain("the-command");
    expect(text(result), "and the project scope still applies").toContain(AGENT_PREFIX_LINE);
  });

  it("falls through a value that is neither a string nor null", async () => {
    settings(agentDir.path, JSON.stringify({ shellPath: "sh" }));
    settings(join(project.path, ".pi"), JSON.stringify({ shellPath: 42 }));

    const result = await ext!.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}-the-command" });

    expect(text(result)).toContain("the-command");
    expect(text(result), "a number is not a shell, so the agent scope answers for the key").toContain("BASH=none");
  });
});
