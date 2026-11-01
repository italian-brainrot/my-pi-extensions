/**
 * The `shellPath` check is only worth having if it answers the question the child asks — *would a command
 * of this session run this?* — and says which half of the answer is no.
 *
 * `shell-path-lookup.test.ts` pins the two failures. These are the pins around them, so a rewrite of the
 * check cannot trade one wrong answer for another: the PATH searched is the one commands get, in the order
 * the child searches it; a broken value is named as "not found" or "not executable" and never reaches
 * `spawn`; and a default that nobody configured is not checked at all.
 */

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const originalCwd = process.cwd();

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;
let project: ReturnType<typeof makeTempDir>;
let extraBin: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function settings(dir: string, values: Record<string, unknown>): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(values));
}

/** A program that announces which file ran, and echoes the command it was handed. */
function writeProgram(dir: string, name: string, marker: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ${marker} "$*"\n`);
  chmodSync(path, mode);
  return path;
}

/** A runtime whose commands see exactly `pathValue` as PATH (`undefined` removes it). */
async function startRuntime(pathValue: string | undefined): Promise<void> {
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path, env: { PATH: pathValue } });
  await ext.emit({ type: "session_start", reason: "startup" });
}

beforeEach(async () => {
  agentDir = makeTempDir("pi-ext-agent-");
  project = makeTempDir("pi-ext-project-");
  extraBin = makeTempDir("pi-ext-bin-");
  mkdirSync(join(project.path, ".pi"), { recursive: true });
  process.chdir(project.path);
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  process.chdir(originalCwd);
  extraBin?.dispose();
  project?.dispose();
  agentDir?.dispose();
});

describe("the PATH a bare shellPath is resolved against", () => {
  it("resolves <agent-dir>/bin before the rest of PATH, which is the order commands resolve in", async () => {
    // `<agent-dir>/bin` is prepended to the PATH handed to every command, so it has to be searched first
    // here too — otherwise the check and the child pick different programs for the same name.
    writeProgram(extraBin.path, "pin-sh", "ELSEWHERE");
    writeProgram(join(agentDir.path, "bin"), "pin-sh", "BINDIR");
    settings(agentDir.path, { shellPath: "pin-sh" });

    await startRuntime(extraBin.path);
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result)).toContain("BINDIR");
    expect(text(result), "the entry further down PATH loses, as it does for the child").not.toContain("ELSEWHERE");
    expect(text(result)).toContain("the-command");
  });

  it("walks past a PATH entry holding a file that cannot be executed, as the child does", async () => {
    const blocked = join(extraBin.path, "blocked");
    const good = join(extraBin.path, "good");
    writeProgram(blocked, "walk-sh", "BLOCKED", 0o644);
    writeProgram(good, "walk-sh", "LATER");
    settings(agentDir.path, { shellPath: "walk-sh" });

    await startRuntime([blocked, good].join(delimiter));
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError, "the second entry is runnable, so nothing is broken").toBeFalsy();
    expect(text(result)).toContain("LATER");
  });

  it("follows a symlink, because the child executes what the link points at", async () => {
    const target = writeProgram(extraBin.path, "real-sh", "TARGET");
    mkdirSync(join(agentDir.path, "bin"), { recursive: true });
    symlinkSync(target, join(agentDir.path, "bin", "link-sh"));
    settings(agentDir.path, { shellPath: "link-sh" });

    await startRuntime(extraBin.path);
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("TARGET");
  });

  it("answers not found when a bare name is nowhere on the PATH commands get", async () => {
    settings(agentDir.path, { shellPath: "nowhere-sh" });

    await startRuntime(extraBin.path);
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Custom shell path not found: nowhere-sh/);
    expect(text(result)).not.toMatch(/exited with code/);
  });

  it("answers not found with no PATH at all, because the child would not find it either", async () => {
    settings(agentDir.path, { shellPath: "sh" });

    await startRuntime(undefined);
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError, "the only directory the child can see is pi's bin dir").toBe(true);
    expect(text(result)).toMatch(/Custom shell path not found/);
  });

  it("answers not executable when the name is on PATH but cannot be run", async () => {
    writeProgram(extraBin.path, "stuck-sh", "STUCK", 0o644);
    settings(agentDir.path, { shellPath: "stuck-sh" });

    await startRuntime(extraBin.path);
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Custom shell path not executable: stuck-sh/);
    expect(result.structuredContent?.exit_code, "no command ever ran, so there is no exit code").toBeUndefined();
  });

  it("checks nothing when shellPath is unset, because nobody configured the value", async () => {
    // The check answers for a value the user pointed at deliberately. The default is `bash`, and refusing
    // it by name would blame a setting that was never set — the README documents that this extension does
    // not fall back to `sh` the way Pi does, and shows that as a spawn failure instead.
    await startRuntime(extraBin.path);
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result), "the default is spawned, and its own failure is what is reported").toContain("failed to start command with bash");
    expect(text(result)).not.toMatch(/Custom shell path/);
  });
});
