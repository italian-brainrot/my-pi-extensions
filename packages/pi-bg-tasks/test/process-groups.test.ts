/**
 * Commands are spawned `detached`, so the shell is a process-group leader and every process it starts
 * shares that group. That is what makes stopping a task mean something: `bg_stop` signals the group, and
 * a quit shutdown is supposed to take the whole tree with it ("Jobs always stop on real shutdown").
 *
 * A task that daemonises — `npm run dev &`, `foo &`, anything that forks a worker and lets the wrapper
 * shell exit — finishes immediately while its worker keeps running in the task's own group. The task is
 * then reported as completed, `bg_stop` refuses to touch it, and nothing else signals the group, so the
 * worker outlives the session, the runtime and the stop request.
 */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const TREE_MARKER = "131";
const DAEMON_MARKER = "132";
const RUNNING_MARKER = "133";

let ext: LoadedExtension;

/** Live processes whose whole command line is `sleep <seconds>`. */
function pidsRunningFor(seconds: string): number[] {
  const wanted = new RegExp(`^sleep ${seconds}$`);
  const found: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
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

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  killAll(TREE_MARKER);
  killAll(DAEMON_MARKER);
  killAll(RUNNING_MARKER);
  ext?.dispose();
});

describe.skipIf(process.platform !== "linux")("what a stop reaches", () => {
  it("kills every process a running task started, not only its shell", async () => {
    // Pinned first: this already works, and the fix for the finished-task case must not lose it.
    const started = await ext.callTool("bash", { command: `sleep ${RUNNING_MARKER} & sleep ${RUNNING_MARKER}`, timeout: 1 });
    await waitFor(() => pidsRunningFor(RUNNING_MARKER).length > 0, "both sleeps to be running");

    await ext.callTool("bg_stop", { task_id: started.details.id, reason: "test cleanup" });

    await waitFor(() => pidsRunningFor(RUNNING_MARKER).length === 0, "the whole process group to be stopped");
  });

  it("stops the worker a finished task left running in its own process group", async () => {
    const started = await ext.callTool("bash", { command: `sleep ${DAEMON_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(DAEMON_MARKER).length > 0, "the daemonised worker to be running");

    try {
      await ext.callTool("bg_stop", { task_id: started.details.id, reason: "audit" });
      await waitFor(() => pidsRunningFor(DAEMON_MARKER).length === 0, "bg_stop to reach the task's process group");
    } finally {
      killAll(DAEMON_MARKER);
    }
  });

  it("stops the worker a finished task left running when the session quits", async () => {
    const started = await ext.callTool("bash", { command: `sleep ${TREE_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(TREE_MARKER).length > 0, "the daemonised worker to be running");

    try {
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      await waitFor(() => pidsRunningFor(TREE_MARKER).length === 0, "a quit shutdown to stop everything the task started");
    } finally {
      killAll(TREE_MARKER);
    }
  });
});
