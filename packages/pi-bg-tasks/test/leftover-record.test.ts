/**
 * What one runtime hands to the next.
 *
 * A task that daemonises leaves its worker in the process group its shell led, and the only handle on
 * that group is the group id — the dead shell's pid. The sidecar is the only place that id is written
 * down, so keeping it for a task whose group is still alive is what lets a replacement runtime honour
 * "a real shutdown stops what the jobs left running". These tests pin the edges of that decision: the
 * record survives, is taken over as a finished task and not a running one, is enough to stop the group by
 * ID, is dropped once the group is gone, and is not swept by a retention pass while the group lives. The
 * other half is the cost: an ordinary task, whose group went empty with its shell, must still leave no
 * file behind.
 */

import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const HANDOVER_MARKER = "155";
const RETENTION_MARKER = "157";

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

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

/**
 * A fresh agent dir per test: the assertions are on files in it, and the extension derives its log dir
 * from `getAgentDir()` at load time.
 */
function newAgentDir(): void {
  agentDir?.dispose();
  agentDir = makeTempDir("pi-ext-agent-");
}

/** One runtime, on the current agent dir. Call it twice for a session replacement. */
async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

function sidecarOf(id: string): string {
  return join(logDir(), `${id}.json`);
}

beforeAll(newAgentDir);

afterEach(async () => {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
});

afterAll(async () => {
  killAll(HANDOVER_MARKER);
  killAll(RETENTION_MARKER);
  agentDir?.dispose();
});

describe("the record of a process group that outlived its task", () => {
  it("survives its own runtime and is enough for the next one to stop the group by ID", async () => {
    newAgentDir();
    const first = await startRuntime();
    const started = await first.callTool("bash", { command: `sleep ${HANDOVER_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(HANDOVER_MARKER).length > 0, "the daemonised worker to be running");

    const sidecar = sidecarOf(started.details.id);
    expect(existsSync(sidecar), "the group id outlives the runtime that started the task").toBe(true);

    // A replacement session: the runtime that started the worker goes away without stopping it.
    await first.emit({ type: "session_shutdown", reason: "reload" });
    first.dispose();

    ext = await startRuntime();

    // What it inherits is a finished task, not a running one: the task is over, and what is left to do
    // is stop the group.
    const wait = await ext.callTool("bg_wait", { timeout: 1 });
    expect(wait.details.running, "an inherited record is not a running task").toEqual([]);

    const stop = await ext.callTool("bg_stop", { task_id: started.details.id, reason: "handover" });
    expect(text(stop), "the new runtime knows the task by its ID").toContain(`Task ${started.details.id} is already`);
    expect(text(stop)).toContain("process group");
    await waitFor(() => pidsRunningFor(HANDOVER_MARKER).length === 0, "the takeover runtime to stop the group by ID", 12_000);

    expect(existsSync(sidecar), "and to drop the record once the group is gone").toBe(false);
  });

  it("leaves the record alone while its group is alive, and the pass still runs", async () => {
    newAgentDir();
    ext = await startRuntime();
    const started = await ext.callTool("bash", { command: `sleep ${RETENTION_MARKER} & echo started`, timeout: 5 });
    expect(started.details.status).toBe("completed");
    await waitFor(() => pidsRunningFor(RETENTION_MARKER).length > 0, "the daemonised worker to be running");

    const sidecar = sidecarOf(started.details.id);
    // Enough stale logs to be what asks for a pass, distinctly older than anything written below so the
    // count sweep has a determinate choice of what to drop.
    for (let i = 0; i < 105; i++) {
      const filler = join(logDir(), `bg-older${String(i).padStart(3, "0")}.log`);
      writeFileSync(filler, "older output\n");
      const when = new Date(Date.now() - (105 - i) * 1000);
      utimesSync(filler, when, when);
    }

    // A completion is what triggers a mid-session pass, and this one truncates, so it also leaves a log.
    const truncated = await ext.callTool("bash", { command: "seq 1 3000" });

    expect(existsSync(truncated.details.fullOutputPath), "the pass ran").toBe(true);
    expect(
      readdirSync(logDir()).filter((name) => name.endsWith(".log")).length,
      "the cap holds for everything a pass may touch",
    ).toBeLessThanOrEqual(101);
    expect(existsSync(sidecar), "a record whose group is still alive is not stale").toBe(true);
    expect(pidsRunningFor(RETENTION_MARKER), "and a pass stops nothing").not.toHaveLength(0);

    await ext.callTool("bg_stop", { task_id: started.details.id, reason: "retention test" });
    await waitFor(() => pidsRunningFor(RETENTION_MARKER).length === 0, "the group to be stopped");
  });

  it("leaves no record for a task whose group went empty with its shell", async () => {
    newAgentDir();
    ext = await startRuntime();
    const result = await ext.callTool("bash", { command: "echo nothing-left-behind" });

    expect(result.details.status).toBe("completed");
    expect(readdirSync(logDir()), "the common case must not litter the log dir").toEqual([]);
  });
});
