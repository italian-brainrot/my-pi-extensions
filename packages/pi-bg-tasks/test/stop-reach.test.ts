/**
 * How far a stop reaches.
 *
 * A stop signals the task's process group — that is what "everything the task started" means here, and
 * for a task whose shell has already exited the group id is the only handle left. Two edges of that
 * promise, both worth pinning while the finished-task case is new code:
 *
 *  - a leftover worker that ignores SIGTERM gets escalated to SIGKILL, the same grace a running task
 *    gets, and a quit shutdown waits for it rather than exiting with the worker behind it;
 *  - a process that deliberately left the group (`setsid`, `systemd-run`) is not stopped: the group is
 *    the boundary, and once a process has started its own session there is nothing left to walk.
 */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const IGNORANT_MARKER = "139";
const STUBBORN_MARKER = "143";
const NEW_SESSION_MARKER = "141";

let ext: LoadedExtension;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  killAll(IGNORANT_MARKER);
  killAll(STUBBORN_MARKER);
  killAll(NEW_SESSION_MARKER);
  ext?.dispose();
});

describe.skipIf(process.platform !== "linux")("the reach of a stop", () => {
  it("escalates a leftover worker that ignores SIGTERM to SIGKILL", async () => {
    // The disposition is inherited by the forked worker, so the worker ignores SIGTERM while the
    // wrapper shell exits normally: only the escalation can reach it.
    const started = await ext.callTool("bash", { command: `trap '' TERM; sleep ${IGNORANT_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(IGNORANT_MARKER).length > 0, "the worker to be running");

    try {
      const stop = await ext.callTool("bg_stop", { task_id: started.details.id, reason: "audit" });
      expect(text(stop)).toContain(`Task ${started.details.id} is already completed`);
      await waitFor(() => pidsRunningFor(IGNORANT_MARKER).length === 0, "the escalation to kill what ignored SIGTERM", 12_000);
    } finally {
      killAll(IGNORANT_MARKER);
    }
  });

  it("escalates a leftover worker that ignores SIGTERM during a quit shutdown", async () => {
    // Same command shape as the test above, through the shutdown path: a runtime that exited without
    // waiting would leave a worker that traps SIGTERM running past the process that started it.
    const started = await ext.callTool("bash", { command: `trap '' TERM; sleep ${STUBBORN_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(STUBBORN_MARKER).length > 0, "the worker to be running");

    try {
      const at = Date.now();
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      const waitedMs = Date.now() - at;

      expect(waitedMs, "the shutdown waited for the grace window instead of exiting around it").toBeGreaterThanOrEqual(4000);
      expect(pidsRunningFor(STUBBORN_MARKER), "and killed what ignored SIGTERM before returning").toHaveLength(0);
    } finally {
      killAll(STUBBORN_MARKER);
    }
  });

  it("leaves a process that started its own session alone at a quit shutdown", async () => {
    const started = await ext.callTool("bash", { command: `setsid sleep ${NEW_SESSION_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(NEW_SESSION_MARKER).length > 0, "the detached worker to be running");

    try {
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      await sleep(400);

      // The task's own group went away with its shell, so the stop found nothing there — and a process
      // that called setsid() was never in it. The group, not the session tree, is what a stop reaches.
      expect(pidsRunningFor(NEW_SESSION_MARKER), "a process that started its own session is out of reach").not.toHaveLength(0);
    } finally {
      killAll(NEW_SESSION_MARKER);
    }
  });
});
