/**
 * A spawn that produced no process is not a task.
 *
 * `child.pid` is `undefined` exactly when the exec failed: the fork happened (or did not) and there is no
 * process to give an id to. Two reachable shapes, both with a shell the checks cannot fault — a default `bash`
 * that is not on the child's `PATH`, and a configured script whose `#!` interpreter is missing, the hole the
 * README says no `stat`/`access` pair can see. What used to come out was:
 *
 *   Command running in background with ID: bg-… (pid -1).
 *
 * with `details.status: "running"` and `details.pid: -1`, for a command that never existed. Now such a job
 * never enters the registry, never gets a sidecar (`writeMeta` refuses a record with no pid to name), and is
 * never announced to a wait, so there is no ID for `bg_stop` to be given or `bg_wait` to list. The answer is the
 * reason the exec failed, in the shape every other refusal of a call takes.
 *
 * The foreground answer for the same broken shell is pinned by the tester in `spawn-failed-background.test.ts`:
 * a command that exited 127 with the reason in its output. That is the other half of the same rule — the reason
 * is always said, and no pid is ever invented.
 */

import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;
let sessionDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function logDirFiles(): string[] {
  try {
    return readdirSync(join(agentDir.path, "bg-tasks"));
  } catch {
    return [];
  }
}

beforeEach(() => {
  agentDir = makeTempDir("pi-ext-agent-");
  sessionDir = makeTempDir("pi-ext-cwd-");
  vi.resetModules();
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
  sessionDir?.dispose();
});

async function start(env?: Record<string, string>): Promise<void> {
  ext = await loadExtension({
    packageDir: packageDir("pi-bg-tasks"),
    agentDir: agentDir.path,
    cwd: sessionDir.path,
    env,
  });
  await ext.emit({ type: "session_start", reason: "startup" });
}

/** A perfectly runnable file that names an interpreter which does not exist. */
function brokenInterpreterShell(): string {
  const path = join(sessionDir.path, "no-interp-sh");
  writeFileSync(path, "#!/definitely/not/an/interpreter\necho hi\n");
  chmodSync(path, 0o755);
  writeFileSync(join(agentDir.path, "settings.json"), JSON.stringify({ shellPath: "./no-interp-sh" }));
  return path;
}

describe("a background command whose process was never created", () => {
  it("names the program that could not be run, and hands back no task", async () => {
    brokenInterpreterShell();
    await start();

    const result = await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    const body = text(result);

    expect(result.isError, `the command did not start: ${body}`).toBe(true);
    expect(body).toMatch(/failed to start/i);
    expect(body, "the reason names the program that failed to exec").toMatch(/no-interp-sh/);
    expect(body, "and says that nothing is running").toMatch(/nothing was started/i);
    // No ID: there is nothing for `bg_stop` or `bg_wait` to be pointed at, and an ID the model cannot use is a
    // worse answer than no ID.
    expect(body, `no task ID in the answer: ${body}`).not.toMatch(/bg-[0-9a-z]{8}/);
    expect(result.details?.id, "and none in the details").toBeUndefined();
    expect(result.details?.pid, "no pid, not a placeholder one").toBeUndefined();
  });

  it("says so for a default shell that is not on PATH, and names bash", async () => {
    await start({ PATH: "/nonexistent-dir" });

    const result = await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    const body = text(result);

    expect(result.isError).toBe(true);
    expect(body, `the answer names the shell: ${body}`).toMatch(/spawn bash ENOENT/);
    expect(body).not.toMatch(/pid/);
    expect(logDirFiles(), "a command that never started leaves no log and no sidecar").toEqual([]);
  });

  it("leaves the session with nothing to wait for, stop, or adopt", async () => {
    brokenInterpreterShell();
    await start();

    await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    const body = text(report);

    expect(body, `the wait finds no task: ${body}`).toContain("No background tasks are running.");
    expect(report.structuredContent?.tasks, "no task row either").toEqual([]);
    expect(report.structuredContent?.running).toEqual([]);

    // And a stop asked for anyway is answered as an unknown ID, not as something about a process group: the
    // job is not in the registry, so it has no leftover group to claim.
    await expect(ext!.callTool("bg_stop", { task_id: "bg-nosuch1" })).rejects.toThrow(/Unknown task/);
    expect(logDirFiles(), "and nothing was written for it to find").toEqual([]);
  });

  it("re-adopts nothing from a failed start after a replacement", async () => {
    // The registry is not the only place a phantom could come back: a sidecar naming no process would be read
    // by the next runtime. There is no such record, so the next runtime sees an empty directory.
    brokenInterpreterShell();
    await start();
    await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    await ext!.emit({ type: "session_shutdown", reason: "quit" });
    ext!.dispose();
    vi.resetModules();

    expect(logDirFiles(), "no log and no sidecar survived the failed start").toEqual([]);
    await start();
    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    expect(report.structuredContent?.tasks).toEqual([]);
  });
});
