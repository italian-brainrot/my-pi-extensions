/**
 * The shape the pass-2 fix is built for: a task whose shell dies on SIGTERM while something else in its
 * process group refuses to die. Two things have to hold, and both are easy to lose again.
 *
 *  - Reach. A member that cannot be terminated by SIGTERM has to die anyway. A stopped (`SIGSTOP`)
 *    process is the strongest version reachable from a test: its pending SIGTERM is never delivered, so
 *    only the escalation to SIGKILL can end it.
 *  - Cost. The two windows (the leader's SIGTERM grace, then the group on its own account) overlap,
 *    because the escalation fires while the leader's window is still open. Many such groups at once must
 *    still be swept by one shutdown, promptly — a shutdown that paid both windows in full would sit past
 *    the Vitest teardown timeout and past any user's patience.
 */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const MANY_MARKER = "167";
const STOPPED_MARKER = "169";

let ext: LoadedExtension;

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

/** The leader dies on SIGTERM; the worker it started ignores it. */
function leaderDiesWorkerStays(seconds: string): string {
  return `trap '' TERM; sleep ${seconds} & echo started; trap - TERM; wait`;
}

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  killAll(MANY_MARKER);
  killAll(STOPPED_MARKER);
  ext?.dispose();
});

describe.skipIf(process.platform !== "linux")("a group that will not terminate", () => {
  it("stops every immune group at once, inside one grace window", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const started = await ext.callTool("bash", { command: leaderDiesWorkerStays(MANY_MARKER), timeout: 0, blocking: false });
      ids.push(started.details.id as string);
    }
    await waitFor(() => pidsRunningFor(MANY_MARKER).length >= ids.length, "one worker per task");

    try {
      const at = Date.now();
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      const waitedMs = Date.now() - at;

      await waitFor(() => pidsRunningFor(MANY_MARKER).length === 0, "every immune worker to be gone", 12_000);
      // The group's SIGKILL lands while the leaders' grace is still open, so eight such groups cost the
      // same as one. Two full windows would be ~10s, past the suite's teardown timeout.
      expect(waitedMs, "one shutdown still sweeps them all within about one grace window").toBeLessThan(8000);
    } finally {
      killAll(MANY_MARKER);
    }
  });

  it("kills a member that a SIGTERM can never reach, because it is stopped", async () => {
    const started = await ext.callTool("bash", { command: leaderDiesWorkerStays(STOPPED_MARKER), timeout: 0 });
    await waitFor(() => pidsRunningFor(STOPPED_MARKER).length > 0, "the worker to be running");

    // Stop the worker before asking for the stop: its SIGTERM stays pending, and only an escalation
    // can end a process that is not running.
    for (const pid of pidsRunningFor(STOPPED_MARKER)) process.kill(pid, "SIGSTOP");

    try {
      const stop = await ext.callTool("bg_stop", { task_id: started.details.id, reason: "stopped member" });
      expect(text(stop), "the stop says what it did to the group").toMatch(/process group/);
      await waitFor(() => pidsRunningFor(STOPPED_MARKER).length === 0, "the SIGKILL escalation to end a stopped process", 12_000);
    } finally {
      killAll(STOPPED_MARKER);
    }
  });
});
