/**
 * What a background task is told about itself: the "(no output yet)" note when a command goes to the
 * background silent, and the table of every background task that each bg_wait answer carries.
 *
 * Each test gets its own runtime (`vi.resetModules()` between loads), because the job registry is
 * module state and the listing is exactly that registry.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

let ext: LoadedExtension | undefined;

async function stopRuntime(): Promise<void> {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
}

beforeEach(async () => {
  await stopRuntime();
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterEach(stopRuntime);

function runtime(): LoadedExtension {
  if (!ext) throw new Error("No runtime loaded for this test.");
  return ext;
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function lineFor(report: string, id: string): string {
  const line = report.split("\n").find((entry) => entry.includes(id));
  if (!line) throw new Error(`No line for ${id} in:\n${report}`);
  return line;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startBackground(command: string): Promise<{ id: string; pid: number; logPath: string }> {
  const result = await runtime().callTool("bash", { command, timeout: 0 });
  return { id: result.details.id, pid: result.details.pid, logPath: result.details.logPath };
}

describe("background task results", () => {
  it("says there is no output yet when a command goes to the background silent", async () => {
    const result = await runtime().callTool("bash", { command: "sleep 30", timeout: 0 });

    expect(text(result)).toContain("(no output yet)");
    expect(text(result)).not.toContain("Preview:");

    await runtime().callTool("bg_stop", { task_id: result.details.id, reason: "test cleanup" });
  });

  it("previews the output a timeout left behind", async () => {
    const started = Date.now();
    const result = await runtime().callTool("bash", { command: "echo already-here; sleep 30", timeout: 1 });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(text(result)).toContain("timed out after 1s and moved to background");
    expect(text(result)).toContain("Preview:");
    expect(text(result)).toContain("already-here");
    expect(text(result)).not.toContain("(no output yet)");

    await runtime().callTool("bg_stop", { task_id: result.details.id, reason: "test cleanup" });
  });

  it("says how much of a long log the preview covers", async () => {
    const result = await runtime().callTool("bash", { command: "seq 1 2000; sleep 30", timeout: 1 });

    expect(text(result)).toMatch(/Preview \(last [\d.]+[KM]B of [\d.]+[KM]B\):/);
    expect(text(result)).toContain("1999");

    await runtime().callTool("bg_stop", { task_id: result.details.id, reason: "test cleanup" });
  });

  it("keeps a backgrounded task alive when the run is aborted afterwards", async () => {
    // Pi hands one signal to every tool call in a run, so the listener that kills a foreground
    // command has to go away once that command was deliberately backgrounded.
    const controller = new AbortController();
    const result = await runtime().callTool("bash", { command: "sleep 30", timeout: 1 }, { signal: controller.signal });
    const { id, pid } = result.details;
    expect(isAlive(pid)).toBe(true);

    controller.abort();
    await sleep(700);

    expect(isAlive(pid)).toBe(true);
    expect(text(await runtime().callTool("bg_wait", { timeout: 1 }))).toContain(id);

    await runtime().callTool("bg_stop", { task_id: id, reason: "test cleanup" });
    await waitFor(() => !isAlive(pid), "the stopped process to exit");
  });
});

describe("bg_wait task listing", () => {
  const command = "sleep 0.7; printf 'one\\ntwo'";

  it("reports status, run time, output size, exit code, and log path for every background task", async () => {
    const finished = await startBackground(command);
    const running = await startBackground("sleep 30");
    await waitFor(() => !isAlive(finished.pid), "the first command to finish");
    // Let the exit event land, so this wait has nothing left to see finish and times out.
    await sleep(200);

    const wait = await runtime().callTool("bg_wait", { timeout: 1 });
    const report = text(wait);

    expect(report).toContain("Timeout reached (1 sec)");
    expect(report).toContain("Background tasks in this session (2 tracked, 1 running):");
    expect(report).toContain(`  $ ${command}`);

    expect(lineFor(report, finished.id)).toContain("completed (exit 0)");
    expect(lineFor(report, finished.id)).toContain("2 lines");
    expect(lineFor(report, finished.id)).toContain("7 chars");
    expect(lineFor(report, finished.id)).toContain(finished.logPath);
    expect(lineFor(report, running.id)).toContain("running (pid ");
    expect(lineFor(report, running.id)).not.toContain("exit ");

    // Running tasks first: they are what the model still has to do something about.
    const structured = wait.structuredContent.tasks;
    expect(structured.map((task: any) => task.id)).toEqual([running.id, finished.id]);
    expect(structured[0]).toMatchObject({ id: running.id, status: "running", exit_code: null, lines: 0, chars: 0 });
    expect(structured[1]).toMatchObject({
      id: finished.id,
      status: "completed",
      exit_code: 0,
      lines: 2,
      chars: 7,
      bytes: 7,
      log_path: finished.logPath,
      log_exists: true,
      counts_partial: false,
    });
    expect(structured[1].runtime_seconds).toBeGreaterThanOrEqual(0.7);

    // Run time of a finished task is its own lifetime, not how long the runtime has known about it.
    const again = await runtime().callTool("bg_wait", { timeout: 1 });
    const repeated = again.structuredContent.tasks.find((task: any) => task.id === finished.id);
    expect(repeated.runtime_seconds).toBe(structured[1].runtime_seconds);

    expect(wait.details.tasks.map((task: any) => task.id)).toEqual([running.id, finished.id]);
    expect(wait.details.running).toEqual([running.id]);

    await runtime().callTool("bg_stop", { task_id: running.id, reason: "test cleanup" });
  });

  it("counts characters and lines the way pi counts them: a final line without a newline counts", async () => {
    const job = await startBackground("printf 'a\\tb\\n\\nend'");
    await waitFor(() => !isAlive(job.pid), "the command to finish");

    const wait = await runtime().callTool("bg_wait", { timeout: 5 });
    const content = readFileSync(job.logPath, "utf8");
    const task = wait.structuredContent.tasks.find((entry: any) => entry.id === job.id);

    expect(content).toBe("a\tb\n\nend");
    expect(task.lines).toBe(3);
    expect(task.chars).toBe(content.length);
    expect(task.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("counts a task that failed by its exit code", async () => {
    const job = await startBackground("echo oops; exit 3");

    const wait = await runtime().callTool("bg_wait", { timeout: 10 });
    expect(text(wait)).toContain("1 task(s) finished");
    expect(lineFor(text(wait), job.id)).toContain("failed (exit 3)");
    expect(wait.structuredContent.finished).toEqual([job.id]);
    expect(wait.structuredContent.tasks[0]).toMatchObject({ status: "failed", exit_code: 3, lines: 1 });
  });

  it("lists finished background tasks even when nothing is running", async () => {
    const job = await startBackground("echo done-at-last");
    await waitFor(() => !isAlive(job.pid), "the command to finish");

    const wait = await runtime().callTool("bg_wait", { timeout: 1 });
    expect(text(wait)).toContain("No background tasks are running.");
    expect(text(wait)).toContain(job.id);
    expect(wait.details.running).toEqual([]);
  });

  it("does not list a command that finished in the foreground", async () => {
    const fast = await runtime().callTool("bash", { command: "echo quick" });

    const wait = await runtime().callTool("bg_wait", { timeout: 1 });
    expect(text(wait)).toContain("No background tasks are running.");
    expect(wait.structuredContent.tasks).toEqual([]);
    expect(text(wait)).not.toContain(fast.details.id);
  });

  it("waits for a task that is backgrounded while the wait is already running", async () => {
    const slow = await startBackground("sleep 30");

    const waiting = runtime().callTool("bg_wait", { timeout: 20 });
    await sleep(200);
    // Foreground for its first second, released to the background, then it finishes.
    const late = runtime().callTool("bash", { command: "echo late-start; sleep 1.5", timeout: 1, blocking: false });

    const wait = await waiting;
    const lateResult = await late;

    expect(text(wait)).toContain("1 task(s) finished");
    expect(wait.structuredContent.finished).toContain(lateResult.details.id);
    expect(wait.structuredContent.running).toEqual([slow.id]);
    expect(text(wait)).toContain(lateResult.details.id);
    expect(readFileSync(lateResult.details.logPath, "utf8")).toContain("late-start");

    await runtime().callTool("bg_stop", { task_id: slow.id, reason: "test cleanup" });
  });
});
