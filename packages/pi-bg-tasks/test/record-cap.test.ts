/**
 * The record of a process group outlives its task on purpose — the sidecar is the only place the group
 * id is written down, and somebody still has to stop that group. The in-memory job is what carries that
 * obligation: `killAllJobs` reaches it through the registry, and so does `bg_stop`.
 *
 * `enforceRegistryCap` drops the oldest finished job once the registry passes `MAX_REGISTRY_SIZE` (200).
 * A session does that without doing anything unusual, because every command it runs is a registry entry,
 * foreground ones included. So the obligation is dropped while the file that exists to record it is kept
 * on purpose: the task disappears from `bg_wait`, `bg_stop` answers "Unknown task", and the quit shutdown
 * signals nothing. The worker outlives the runtime that started it — which is the hole the record was
 * added to close, reopened by the cap.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const SHUTDOWN_MARKER = "163";
const STOP_MARKER = "165";

/** More than `MAX_REGISTRY_SIZE`, so the cap has to evict something. */
const FILLER_COMMANDS = 201;

let agentDir: ReturnType<typeof makeTempDir>;
let ext: LoadedExtension | undefined;

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

function newAgentDir(): void {
  agentDir?.dispose();
  agentDir = makeTempDir("pi-ext-agent-");
}

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

/**
 * A task that daemonised, followed by enough finished commands to push the registry over its cap. The
 * leftovers record is the oldest finished job, so it is the first eviction candidate.
 */
async function startLeftoverThenFillTheRegistry(runtime: LoadedExtension, marker: string): Promise<string> {
  const started = await runtime.callTool("bash", { command: `sleep ${marker} & echo started`, timeout: 5 });
  expect(started.details.status).toBe("completed");
  await waitFor(() => pidsRunningFor(marker).length > 0, "the daemonised worker to be running");

  // Commands that finish in the foreground: they leave no log or sidecar behind, so the only record in
  // the log dir is the leftover group's, and nothing but the registry cap is in play here.
  for (let i = 0; i < FILLER_COMMANDS; i++) {
    await runtime.callTool("bash", { command: "true" });
  }
  return started.details.id as string;
}

beforeAll(newAgentDir);

afterEach(async () => {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
});

afterAll(() => {
  killAll(SHUTDOWN_MARKER);
  killAll(STOP_MARKER);
  agentDir?.dispose();
});

describe("a leftover-group record under registry pressure", () => {
  it("is still stopped by the shutdown of the runtime that started it", async () => {
    newAgentDir();
    const runtime = await startRuntime();
    ext = runtime;
    const id = await startLeftoverThenFillTheRegistry(runtime, SHUTDOWN_MARKER);

    const sidecar = join(agentDir.path, "bg-tasks", `${id}.json`);
    expect(existsSync(sidecar), "the record itself is kept while the group lives").toBe(true);

    try {
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      await waitFor(
        () => pidsRunningFor(SHUTDOWN_MARKER).length === 0,
        "the shutdown to stop the group the evicted record still stands for",
        12_000,
      );
    } finally {
      killAll(SHUTDOWN_MARKER);
    }
  });

  it("is still stoppable by ID after the registry has been capped", async () => {
    newAgentDir();
    const runtime = await startRuntime();
    ext = runtime;
    const id = await startLeftoverThenFillTheRegistry(runtime, STOP_MARKER);

    try {
      const stop = await ext.callTool("bg_stop", { task_id: id, reason: "capped registry" });
      expect(text(stop), "the task is still known to the session that started it").toContain(id);
      await waitFor(() => pidsRunningFor(STOP_MARKER).length === 0, "the stop by ID to reach the group", 12_000);
    } finally {
      killAll(STOP_MARKER);
    }
  });
});
