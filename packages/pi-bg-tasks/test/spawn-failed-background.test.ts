/**
 * When `spawn` fails before the fork, `child.pid` is `undefined`, and `spawnJob` records that as `pid: -1`
 * (`proc.pid ?? -1`). There is then no process — that is what a missing pid from `spawn` means, as opposed to
 * a pid whose process then failed to start — and `-1` is what the model is told:
 *
 *   Command running in background with ID: bg-sb0f2p9w (pid -1).
 *
 * for a task that was never running. `details.pid` carries `-1` too, and `details.status` says `"running"`.
 * The correction only arrives on the next call: `bg_wait` reports the same ID as `failed (exit 127)` once the
 * `error` event lands.
 *
 * Two reachable ways to get there, both with the *default* shell, which is deliberately never checked:
 * a session whose `PATH` does not contain `bash`, and a configured `shellPath` that is an executable script
 * whose `#!` interpreter is missing — the hole the README says no `stat`/`access` pair can see. Both answer
 * `spawn … ENOENT` with no pid.
 *
 * The foreground path handles the same failure acceptably: the note lands in the log and the result is
 * `Command exited with code 127` with that output, pinned below. The background path is the one that claims a
 * running task with a pid the operating system never handed out.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;
let sessionDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
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

/** A script that is a perfectly runnable file and names an interpreter that does not exist. */
function shellWithMissingInterpreter(): string {
  const path = join(sessionDir.path, "missing-interp-sh");
  writeFileSync(path, "#!/definitely/not/an/interpreter\necho hi\n");
  chmodSync(path, 0o755);
  writeFileSync(join(agentDir.path, "settings.json"), JSON.stringify({ shellPath: "./missing-interp-sh" }));
  return path;
}

describe("a background command whose process was never created", () => {
  it("does not report a running task with pid -1 when the default shell is not on PATH", async () => {
    await start({ PATH: "/nonexistent-dir" });

    const result = await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    const body = text(result);

    expect(body, "there is no process, so there is no pid to print").not.toMatch(/pid -1/);
    expect(result.details?.pid, "details must not carry a pid that does not exist").not.toBe(-1);
    expect(body, `the answer must not claim a task that is running: ${body}`).not.toMatch(/running in background/i);
    expect(result.isError, `and it has to be an error: ${body}`).toBe(true);
  });

  it("says so for a configured shell whose #! interpreter is missing", async () => {
    // The check cannot see this one, and the README says so; what it must not do is answer that the command
    // is running.
    shellWithMissingInterpreter();
    await start();

    const result = await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    const body = text(result);

    expect(body, "no pid the OS never gave").not.toMatch(/pid -1/);
    expect(result.details?.pid).not.toBe(-1);
    expect(result.isError, `the command did not start: ${body}`).toBe(true);
  });

  it("does not leave the task in the listing as a running one", async () => {
    // Whatever the first answer ends up saying, the correction has to be that nothing is running: either the
    // task is listed as over, or there is no task at all.
    shellWithMissingInterpreter();
    await start();

    await ext!.callTool("bash", { command: "echo hi", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    const body = text(report);

    expect(body, `no row may claim a running process: ${body}`).not.toMatch(/running \(pid/);
    expect(report.structuredContent?.running, "and no ID may be listed as running").toEqual([]);
  });

  it("keeps the foreground answer as it is: exit 127 with the reason in the output", async () => {
    // The half that already works, pinned so a fix for the background path does not move it. The note goes
    // into the log, the log is the output, and the exit code is the shell's 127.
    shellWithMissingInterpreter();
    await start();

    const result = await ext!.callTool("bash", { command: "echo hi", timeout: 5 });
    const body = text(result);

    expect(result.isError).toBe(true);
    expect(body).toMatch(/failed to start command with/);
    expect(result.structuredContent?.exit_code).toBe(127);
  });
});
