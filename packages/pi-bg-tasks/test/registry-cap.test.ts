/**
 * What the registry cap may drop.
 *
 * A finished task whose process group is still waiting to be stopped is not eviction material while that
 * group lives — `record-cap.test.ts` pins what dropping it costs. "Never evict an obligation" is only a
 * safe rule if it is neither permanent nor the whole registry, so these pin the other side of it: the cap
 * still evicts everything that carries nothing, an obligation becomes an ordinary finished job the moment
 * its group is gone, and the extra entries stay bounded by the groups themselves.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** A duration no other test uses, so a /proc scan can single this worker out. */
const MARKER = "179";
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

function newAgentDir(): void {
  agentDir?.dispose();
  agentDir = makeTempDir("pi-ext-agent-");
}

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

/** Every background task the runtime still lists. */
async function listedTasks(runtime: LoadedExtension): Promise<any[]> {
  const wait = await runtime.callTool("bg_wait", { timeout: 1 });
  return (wait.structuredContent.tasks as any[]) ?? [];
}

/** Commands that finish in the foreground: no logs, no sidecars, only registry entries. */
async function fillTheRegistry(runtime: LoadedExtension): Promise<void> {
  for (let i = 0; i < FILLER_COMMANDS; i++) await runtime.callTool("bash", { command: "true" });
}

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

beforeAll(newAgentDir);

afterEach(async () => {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
});

afterAll(() => {
  killAll(MARKER);
  agentDir?.dispose();
});

describe("the registry cap around a kept group record", () => {
  it("still evicts finished tasks that carry no obligation", async () => {
    newAgentDir();
    const runtime = await startRuntime();
    ext = runtime;

    // A background task that leaves nothing behind: its shell exits, its group goes with it, so its
    // registry entry is ordinary bookkeeping and the cap is allowed to drop it.
    const started = await runtime.callTool("bash", { command: "true", timeout: 0 });
    expect(started.details.id, "a background task of its own").toBeTruthy();
    expect(await listedTasks(runtime)).toHaveLength(1);

    await fillTheRegistry(runtime);

    expect(await listedTasks(runtime), "the cap is still a cap").toHaveLength(0);
    // The background task's own log is the only file left, and it is under the retention rules like any
    // other: what must not survive is a record or a temp.
    expect(
      readdirSync(logDir()).filter((name) => !name.endsWith(".log")),
      "and the cap left no sidecars or temp files behind",
    ).toEqual([]);
  });

  it("drops the record's protection once its group is stopped", async () => {
    newAgentDir();
    const runtime = await startRuntime();
    ext = runtime;

    const started = await runtime.callTool("bash", { command: `sleep ${MARKER} & echo started`, timeout: 5 });
    const id = started.details.id as string;
    await waitFor(() => pidsRunningFor(MARKER).length > 0, "the daemonised worker to be running");
    const sidecar = join(logDir(), `${id}.json`);
    expect(existsSync(sidecar)).toBe(true);

    // Stopping the group is what ends the obligation: the record goes, and the entry becomes evictable.
    await runtime.callTool("bg_stop", { task_id: id, reason: "cap test" });
    await waitFor(() => pidsRunningFor(MARKER).length === 0, "the group to be stopped", 12_000);
    expect(existsSync(sidecar), "the record goes with the group").toBe(false);

    await fillTheRegistry(runtime);

    expect(await listedTasks(runtime), "so the registry is bounded by the cap plus live groups, not by records").toHaveLength(0);
  });
});
