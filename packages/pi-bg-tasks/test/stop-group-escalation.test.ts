/**
 * A stop promises SIGTERM to the process group and SIGKILL after a grace window, and pass 1 established
 * that a worker left behind in a finished task's group is reached. The same promise has to hold while the
 * task is *running*, which is a different code path: there the escalation is decided by whether the job's
 * shell is still alive, and the shell is only one member of the group it leads.
 *
 * So: a task whose shell dies on SIGTERM while a worker in the same group ignores SIGTERM. The job goes to
 * "killed" the moment its leader is reaped, every wait for the job resolves, and if the escalation only
 * looks at the job's status it is skipped — the tool answers "stopped" and the worker outlives the stop
 * request, the session and the runtime.
 */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const BG_STOP_MARKER = "147";
const SHUTDOWN_MARKER = "149";
const ABORT_MARKER = "151";

let ext: LoadedExtension;
let agentDir: ReturnType<typeof makeTempDir>;

/** Live processes whose whole command line is `sleep <seconds>`. */
function pidsRunningFor(seconds: string): number[] {
  const wanted = new RegExp(`^sleep ${seconds}$`);
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0+$/, "").replaceAll("\0", " ");
      if (wanted.test(command.trim())) found.push(Number(entry));
    } catch {
      // Exited between the listing and the read.
    }
  }
  return found;
}

function killAll(seconds: string): void {
  for (const pid of pidsRunningFor(seconds)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

/**
 * A worker that ignores SIGTERM behind a shell that does not: `trap '' TERM` before the fork makes the
 * disposition inherited by the worker, `trap - TERM` puts the shell back to default termination, and
 * `wait` keeps the shell alive so the task is running when it is stopped.
 */
function leaderDiesWorkerStays(seconds: string): string {
  return `trap '' TERM; sleep ${seconds} & echo started; trap - TERM; wait`;
}

beforeAll(async () => {
  agentDir = makeTempDir("pi-ext-agent-");
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  killAll(BG_STOP_MARKER);
  killAll(SHUTDOWN_MARKER);
  killAll(ABORT_MARKER);
  ext?.dispose();
  agentDir?.dispose();
});

describe.skipIf(process.platform !== "linux")("escalation while the task is running", () => {
  it("kills a worker that ignores SIGTERM when bg_stop stops a running task", async () => {
    const started = await ext.callTool("bash", { command: leaderDiesWorkerStays(BG_STOP_MARKER), timeout: 0 });
    await waitFor(() => pidsRunningFor(BG_STOP_MARKER).length > 0, "the worker to be running");

    try {
      const stop = await ext.callTool("bg_stop", { task_id: started.details.id, reason: "audit" });
      expect(text(stop), "the leader is dead, so the task is over as far as its leader knows").toMatch(/stopped|shutting down/);

      await waitFor(
        () => pidsRunningFor(BG_STOP_MARKER).length === 0,
        "the group's SIGKILL escalation to reach the worker that ignored SIGTERM",
        12_000,
      );
    } finally {
      killAll(BG_STOP_MARKER);
    }
  });

  it("kills it during a quit shutdown, which promises to stop what jobs left running", async () => {
    const started = await ext.callTool("bash", { command: leaderDiesWorkerStays(SHUTDOWN_MARKER), timeout: 0 });
    expect(started.details.status, "a task that is running when the runtime goes away").toBe("running");
    await waitFor(() => pidsRunningFor(SHUTDOWN_MARKER).length > 0, "the worker to be running");

    try {
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      await waitFor(() => pidsRunningFor(SHUTDOWN_MARKER).length === 0, "the shutdown to leave no worker behind", 12_000);
    } finally {
      killAll(SHUTDOWN_MARKER);
    }
  });

  it("kills it when the run is aborted, which is the other thing that kills a running job", async () => {
    const controller = new AbortController();
    const call = ext.callTool("bash", { command: leaderDiesWorkerStays(ABORT_MARKER), timeout: 60 }, { signal: controller.signal });
    await waitFor(() => pidsRunningFor(ABORT_MARKER).length > 0, "the worker to be running");

    try {
      controller.abort();
      const result = await call;
      expect(text(result)).toContain("Command aborted");

      await waitFor(() => pidsRunningFor(ABORT_MARKER).length === 0, "the abort's escalation to reach the worker", 12_000);
    } finally {
      killAll(ABORT_MARKER);
    }
  });
});
