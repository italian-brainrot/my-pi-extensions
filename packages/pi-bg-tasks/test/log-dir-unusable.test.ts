/**
 * The log dir is a third environment precondition, next to the working directory and the shell.
 *
 * `missingWorkingDirectory` and the `shellPath` check both answer as a tool result, and name what is
 * broken, because a throw reaches the model as an unhandled error and a spawn failure reaches it as a
 * command that exited 127. The log dir gets neither treatment: `ensureLogDir()` swallows the failure to
 * create it ("A directory that cannot be created is reported by whatever writes into it next"), and what
 * writes into it next is `openPrivate(logPath, "w")` in `spawnJob` — which is not wrapped, so an
 * un-writable directory, or a plain file sitting where `<agent-dir>/bg-tasks` should be, ends the call as
 * a rejected promise carrying `EACCES`/`ENOTDIR` and the name of a log file that never existed. The one
 * path a user can act on — the directory — is never named.
 *
 * Nothing here needs a weird filesystem: `<agent-dir>/bg-tasks` existing as a file is what an old install,
 * a stray `touch`, or a half-finished `mv` leaves behind, and a read-only agent dir is a normal thing on a
 * locked-down machine.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  ext = loaded;
  return loaded;
}

/**
 * Run a command and stay a result either way, so the test can say what the tool answered. A rejection is
 * what Pi turns into "Error: …" for the model, and what a caller of the tool sees as a failed call.
 */
async function attempt(runtime: LoadedExtension, command: string): Promise<any> {
  try {
    return await runtime.callTool("bash", { command });
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : String(error) };
  }
}

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

beforeEach(() => {
  agentDir = makeTempDir("pi-ext-agent-");
});

afterEach(async () => {
  if (ext) {
    // Whatever this test did to the log dir, undo it before teardown so the temp agent dir can be removed.
    if (existsSync(logDir())) chmodSync(logDir(), 0o700);
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
    ext = undefined;
  }
  agentDir?.dispose();
});

describe("a log dir that cannot be written to", () => {
  it("names the log dir instead of rejecting with the errno from a log file nobody created", async () => {
    const runtime = await startRuntime();
    // Make the command succeed once, so the directory exists with a file in it before it stops taking writes.
    expect((await attempt(runtime, "echo first")).structuredContent?.exit_code).toBe(0);
    chmodSync(logDir(), 0o500);

    const result = await attempt(runtime, "echo second");

    expect(result.rejected, `a tool result, not a rejection:\n${result.rejected ?? ""}`).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(text(result), "the thing a user can act on is the directory").toContain(logDir());
    expect(text(result)).toMatch(/bg-tasks/);
  });

  it("says what is wrong when something that is not a directory is in the log dir's place", async () => {
    // `mkdirSync(..., { recursive: true })` fails here and `ensureLogDir()` swallows it on purpose, leaving
    // the report to the next write. That write is `openSync("<log dir>/<id>.log")` → ENOTDIR.
    writeFileSync(logDir(), "not a directory\n");

    const runtime = await startRuntime();
    const result = await attempt(runtime, "echo second");

    expect(result.rejected, `a tool result, not a rejection:\n${result.rejected ?? ""}`).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(logDir());
    expect(result.structuredContent?.exit_code, "no command ran, so there is no exit code to report").toBeUndefined();
  });

  it("keeps the rest of the session working after the refusal", async () => {
    const runtime = await startRuntime();
    expect((await attempt(runtime, "echo first")).structuredContent?.exit_code).toBe(0);
    chmodSync(logDir(), 0o500);

    const broken = await attempt(runtime, "echo second");
    expect(broken.rejected).toBeUndefined();

    chmodSync(logDir(), 0o700);
    const working = await attempt(runtime, "echo third");
    expect(working.rejected, `a runtime that refused once is not stuck:\n${working.rejected ?? ""}`).toBeUndefined();
    expect(working.structuredContent?.exit_code).toBe(0);
    expect(text(working)).toContain("third");
  });
});

describe("a log dir that has to be created", () => {
  it("creates it privately and runs the command, as it did before this pass", async () => {
    // The control: nothing in this file may break the ordinary case, where the agent dir exists and the
    // log dir does not.
    mkdirSync(agentDir.path, { recursive: true });
    const runtime = await startRuntime();
    const result = await attempt(runtime, "echo made-the-dir");

    expect(result.rejected).toBeUndefined();
    expect(result.structuredContent?.exit_code).toBe(0);
    expect(text(result)).toContain("made-the-dir");
    expect(existsSync(logDir()), "the log dir is created on the first command").toBe(true);
  });
});
