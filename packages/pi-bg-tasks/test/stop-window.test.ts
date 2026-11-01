/**
 * A stop now has two windows: the leader's SIGTERM grace, and the group of a leader that died while a
 * member of its group ignored the signal. The second one is what fixes the leaked worker, and it is only
 * ever entered when a group is still there — a task whose whole group dies on SIGTERM must still come back
 * promptly, from `bg_stop` and from a shutdown, or the fix would cost every stop five seconds.
 */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const COOPERATIVE_MARKER = "159";
const SHUTDOWN_MARKER = "161";

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

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  killAll(COOPERATIVE_MARKER);
  killAll(SHUTDOWN_MARKER);
  ext?.dispose();
});

describe.skipIf(process.platform !== "linux")("the cost of a stop", () => {
  it("comes back promptly from bg_stop when the whole group dies on SIGTERM", async () => {
    const started = await ext.callTool("bash", {
      command: `sleep ${COOPERATIVE_MARKER} & sleep ${COOPERATIVE_MARKER}`,
      timeout: 0,
    });
    await waitFor(() => pidsRunningFor(COOPERATIVE_MARKER).length > 0, "both sleeps to be running");

    try {
      const at = Date.now();
      const stop = await ext.callTool("bg_stop", { task_id: started.details.id, reason: "timing" });
      const waitedMs = Date.now() - at;

      expect(text(stop)).toContain("stopped");
      expect(waitedMs, "nothing ignored the first SIGTERM, so there is no second window to wait out").toBeLessThan(2500);
      await waitFor(() => pidsRunningFor(COOPERATIVE_MARKER).length === 0, "the group to be stopped");
    } finally {
      killAll(COOPERATIVE_MARKER);
    }
  });

  it("comes back promptly from a shutdown when nothing was left behind", async () => {
    await ext.callTool("bash", { command: `sleep ${SHUTDOWN_MARKER}`, timeout: 0 });
    await waitFor(() => pidsRunningFor(SHUTDOWN_MARKER).length > 0, "the task to be running");

    try {
      const at = Date.now();
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      const waitedMs = Date.now() - at;

      expect(waitedMs, "a shutdown whose jobs die on SIGTERM is not held by the two-window cap").toBeLessThan(2500);
      expect(pidsRunningFor(SHUTDOWN_MARKER), "and it still leaves nothing running").toHaveLength(0);
    } finally {
      killAll(SHUTDOWN_MARKER);
    }
  });
});
