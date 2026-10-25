import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterAll(async () => {
  // Leaving jobs running would leak processes out of the test, and the extension's own
  // shutdown handler is what stops them in a real session.
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

async function startBackground(command: string): Promise<{ id: string; pid: number; logPath: string }> {
  const result = await ext.callTool("bash", { command, timeout: 0 });
  return { id: result.details.id, pid: result.details.pid, logPath: result.details.logPath };
}

describe("background commands", () => {
  it("moves a slow command to the background when the timeout expires", async () => {
    const started = Date.now();
    const result = await ext.callTool("bash", { command: "sleep 30", timeout: 1 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2500);
    expect(text(result)).toContain("timed out after 1s and moved to background");
    expect(result.details.id).toMatch(/^bg-[0-9a-z]{8}$/);
    expect(result.details.status).toBe("running");
    expect(isAlive(result.details.pid)).toBe(true);
    expect(existsSync(result.details.logPath)).toBe(true);
    expect(text(result)).toContain(`Output is being written to: ${result.details.logPath}`);

    const stop = await ext.callTool("bg_stop", { task_id: result.details.id, reason: "test cleanup" });
    expect(text(stop)).toContain("stopped");
    await waitFor(() => !isAlive(result.details.pid), "the stopped process to exit");
  });

  it("starts a command in the background immediately for timeout 0", async () => {
    const job = await startBackground("sleep 30");

    expect(isAlive(job.pid)).toBe(true);
    await waitFor(() => readLogIfPresent(job.logPath) !== null, "the log file to exist");

    const stop = await ext.callTool("bg_stop", { task_id: job.id, reason: "test cleanup" });
    expect(stop.details.status).toBe("killed");
    expect(text(stop)).toContain(`Task ${job.id} stopped`);
  });

  it("captures output written after the command was backgrounded", async () => {
    const job = await startBackground("echo early; sleep 0.4; echo late");

    const wait = await ext.callTool("bg_wait", { timeout: 15 });
    expect(text(wait)).toContain("1 task(s) finished");
    expect(wait.details.running).toEqual([]);
    expect(readFileSync(job.logPath, "utf8")).toContain("early");
    expect(readFileSync(job.logPath, "utf8")).toContain("late");
  });

  it("says so when there is nothing to wait for", async () => {
    const wait = await ext.callTool("bg_wait", { timeout: 5 });

    expect(text(wait)).toContain("No background tasks are running.");
    expect(wait.details.running).toEqual([]);
  });

  it("reports a wait timeout and lists the jobs still running", async () => {
    const job = await startBackground("sleep 30");

    const wait = await ext.callTool("bg_wait", { timeout: 1 });
    expect(text(wait)).toContain("Timeout reached (1 sec)");
    expect(text(wait)).toContain(job.id);
    expect(wait.details.running).toContain(job.id);

    await ext.callTool("bg_stop", { task_id: job.id, reason: "test cleanup" });
  });

  it("returns an error result when the wait itself is aborted", async () => {
    const job = await startBackground("sleep 30");
    const controller = new AbortController();
    const waiting = ext.callTool("bg_wait", { timeout: 30 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);

    const wait = await waiting;
    expect(wait.isError).toBe(true);
    expect(text(wait)).toContain("Wait aborted");
    expect(isAlive(job.pid)).toBe(true);

    await ext.callTool("bg_stop", { task_id: job.id, reason: "test cleanup" });
  });

  it("rejects an unknown task id", async () => {
    await expect(ext.callTool("bg_stop", { task_id: "bg-deadbeef" })).rejects.toThrow(/Unknown task/);
  });

  it("reports a finished task instead of pretending to stop it, and hides a deleted log", async () => {
    const finished = await ext.callTool("bash", { command: "echo done-fast" });
    const stop = await ext.callTool("bg_stop", { task_id: finished.details.id });

    expect(text(stop)).toContain(`Task ${finished.details.id} is already completed (exit 0)`);
    expect(stop.details.logPath).toBeUndefined();
    expect(stop.details.status).toBe("completed");
  });

  it("runs blocking commands one at a time and non-blocking ones together", async () => {
    const parallelStart = Date.now();
    await Promise.all([
      ext.callTool("bash", { command: "sleep 0.6", timeout: 10, blocking: false }),
      ext.callTool("bash", { command: "sleep 0.6", timeout: 10, blocking: false }),
    ]);
    const parallelMs = Date.now() - parallelStart;

    const serialStart = Date.now();
    await Promise.all([
      ext.callTool("bash", { command: "sleep 0.6", timeout: 10 }),
      ext.callTool("bash", { command: "sleep 0.6", timeout: 10 }),
    ]);
    const serialMs = Date.now() - serialStart;

    expect(parallelMs).toBeLessThan(1100);
    expect(serialMs).toBeGreaterThanOrEqual(1150);
  });
});

function readLogIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
