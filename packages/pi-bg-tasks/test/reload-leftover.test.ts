/**
 * A task that daemonises leaves its worker in the process group its shell led, and pass 1 made a stop
 * reach that group: `bg_stop` and a quit shutdown in the runtime that started the task both sweep it.
 * That is the whole of the promise as written — "Jobs always stop on real shutdown (quit), together with
 * whatever they left running in their process group" — and the sentence has no runtime boundary in it.
 *
 * There is one. When a finished job's shell is reaped, `markDone` removes its sidecar, so the record of
 * which group id to signal is gone with the runtime that started it. A `/reload` (or `/new`, `/fork`,
 * `/resume`) deliberately leaves everything running, and the runtime that takes over the session reads
 * sidecars to decide what to manage: there is none, so the worker is nobody's. `bg_wait` lists nothing,
 * `bg_stop` has no ID to take, and the new runtime's quit shutdown signals nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const RELOAD_MARKER = "153";

let agentDir: ReturnType<typeof makeTempDir>;
let ext: LoadedExtension | undefined;

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

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

beforeAll(() => {
  agentDir = makeTempDir("pi-ext-agent-");
});

afterAll(async () => {
  if (ext) {
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
    ext = undefined;
  }
  killAll(RELOAD_MARKER);
  agentDir?.dispose();
});

describe.skipIf(process.platform !== "linux")("a leftover group across a runtime boundary", () => {
  it("is stopped by the quit of the runtime that took the session over", async () => {
    // The runtime that starts it is already covered (process-groups.test.ts, stop-reach.test.ts): a
    // finished task's group is swept by that runtime's own shutdown. This is the handover.
    const first = await startRuntime();
    const started = await first.callTool("bash", { command: `sleep ${RELOAD_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(RELOAD_MARKER).length > 0, "the daemonised worker to be running");

    // A replacement session, which keeps jobs running by default — that is the documented behaviour.
    await first.emit({ type: "session_shutdown", reason: "reload" });
    first.dispose();

    ext = await startRuntime();

    // And the new runtime shuts down for real. Whatever started the worker is gone, but the worker is
    // still in a process group, and this is the last runtime that shares the agent dir it wrote to.
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => pidsRunningFor(RELOAD_MARKER).length === 0, "the takeover runtime to stop the orphaned group", 10_000);
  });
});
