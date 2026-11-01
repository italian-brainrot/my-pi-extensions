/**
 * `shellPath` is checked before anything spawns, so the check has to answer the same question the
 * child will: *can this program be run by a command of this session?*
 *
 * It currently answers a different question in two ways.
 *
 * 1. A bare name is looked up on `process.env.PATH`. Commands do not get that PATH: `buildEnv` puts
 *    `<agent-dir>/bin` in front of it, exactly as Pi's built-in tool does, and the spawn uses that
 *    environment — so a shell installed in pi's own bin dir (the documented place for user scripts,
 *    and on every command's PATH) is refused, as every command of the session, while the child would
 *    have run it quite happily.
 * 2. The check is `F_OK`, which a directory and a non-executable file both pass. The setting then
 *    reaches `spawn`, which answers EACCES, and the session is told its command exited 127 — the
 *    failure mode the check exists to avoid.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

describe("which PATH a configured shell name is looked up on", () => {
  it("runs a shell that lives in <agent-dir>/bin, which every command has on PATH", async () => {
    // `<agent-dir>/bin` is prepended to the PATH handed to every command, so a name that resolves there
    // is a program this session's commands can run.
    mkdirSync(join(agentDir.path, "bin"), { recursive: true });
    const shellPath = join(agentDir.path, "bin", "audit-session-shell");
    writeFileSync(shellPath, '#!/bin/sh\necho AUDIT-SHELL-RAN "$*"\n');
    chmodSync(shellPath, 0o755);
    settings(agentDir.path, { shellPath: "audit-session-shell" });

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(text(result), "the configured shell is the one that runs").toContain("AUDIT-SHELL-RAN");
    expect(text(result)).toContain("the-command");
    expect(result.isError).toBeFalsy();
  });
});

describe("a configured shell that exists but cannot be executed", () => {
  /** A broken setting must not arrive as the command's own exit status. */
  function expectItBlamesTheSetting(result: any): void {
    expect(result.isError, "a broken setting is an error").toBe(true);
    expect(text(result), "it must not read as a command that failed").not.toMatch(/exited with code 127/);
    expect(result.structuredContent?.exit_code, "and must not report an exit code for the command").not.toBe(127);
    expect(text(result), "it must say something about the configured shell").toMatch(/shell/i);
  }

  it("names a shellPath that is a directory instead of reporting exit 127", async () => {
    settings(join(project.path, ".pi"), { shellPath: join(project.path, ".pi") });

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expectItBlamesTheSetting(result);
  });

  it("names a shellPath that is not executable instead of reporting exit 127", async () => {
    const notAShell = join(project.path, "notes.txt");
    writeFileSync(notAShell, "not a shell\n");
    chmodSync(notAShell, 0o644);
    settings(join(project.path, ".pi"), { shellPath: notAShell });

    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expectItBlamesTheSetting(result);
  });
});
