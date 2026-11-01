/**
 * What a replacement runtime inherits from the record of a task that left a process group behind.
 *
 * The record is kept while the group lives, and the runtime that takes it over reports the task as it
 * was: a finished task, never a running one, and never a *listed* one if the command finished in the
 * foreground — the README's rule that foreground output never reaches the `bg_wait` table survives the
 * handover through the `backgrounded` field of the record. What is inherited either way is the
 * obligation: the group has to be stopped, whether or not anything lists it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

/** Distinct durations stand in for distinct tasks, so a scan can tell them apart. */
const BACKGROUND_MARKER = "171";
const FOREGROUND_MARKER = "173";

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

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

function sidecarOf(id: string): string {
  return join(agentDir.path, "bg-tasks", `${id}.json`);
}

function tasks(waitResult: any): any[] {
  return waitResult.structuredContent.tasks as any[];
}

beforeAll(newAgentDir);

afterEach(async () => {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
});

afterAll(() => {
  killAll(BACKGROUND_MARKER);
  killAll(FOREGROUND_MARKER);
  agentDir?.dispose();
});

describe("the record a replacement runtime takes over", () => {
  it("is listed as the finished task it was, and its group is stopped at shutdown", async () => {
    newAgentDir();
    const first = await startRuntime();
    const started = await first.callTool("bash", { command: `sleep ${BACKGROUND_MARKER} & echo started`, timeout: 0 });
    const id = started.details.id as string;
    await waitFor(() => pidsRunningFor(BACKGROUND_MARKER).length > 0, "the worker to be running");
    await waitFor(
      () => (JSON.parse(readFileSync(sidecarOf(id), "utf8")).status as string) !== "running",
      "the record to say the task is over",
    );

    await first.emit({ type: "session_shutdown", reason: "reload" });
    first.dispose();

    ext = await startRuntime();
    const wait = await ext.callTool("bg_wait", { timeout: 1 });

    const [inherited] = tasks(wait).filter((task) => task.id === id);
    expect(inherited, "a background task that outlived its runtime stays in the table").toBeTruthy();
    expect(inherited.status, "taken over as finished, never as running").not.toBe("running");
    expect(inherited.status).toBe("completed");
    expect(inherited.exit_code).toBe(0);
    expect(inherited.adopted).toBe(true);
    expect(wait.structuredContent.running, "and it is not a running task").toEqual([]);
    expect(wait.content.map((part: any) => part.text).join("")).toContain(id);

    // The shutdown is asked for here so the assertion below is about the group, not about teardown;
    // afterEach asks again, which is a no-op.
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => pidsRunningFor(BACKGROUND_MARKER).length === 0, "the new runtime to stop the group", 12_000);
    expect(existsSync(sidecarOf(id)), "the record goes with the group").toBe(false);
  });

  it("is not listed when the command finished in the foreground, but its group is still stopped", async () => {
    newAgentDir();
    const first = await startRuntime();
    const started = await first.callTool("bash", { command: `sleep ${FOREGROUND_MARKER} & echo started` });
    const id = started.details.id as string;
    expect(started.details.status, "finished inside the timeout").toBe("completed");
    await waitFor(() => pidsRunningFor(FOREGROUND_MARKER).length > 0, "the worker to be running");
    expect(existsSync(sidecarOf(id)), "the record is kept anyway: the group is alive").toBe(true);

    await first.emit({ type: "session_shutdown", reason: "reload" });
    first.dispose();

    ext = await startRuntime();
    const wait = await ext.callTool("bg_wait", { timeout: 1 });
    expect(
      tasks(wait).filter((task) => task.id === id),
      "a command that finished in the foreground is not in the table, before or after a handover",
    ).toHaveLength(0);

    // The shutdown is asked for here so the assertion below is about the group, not about teardown;
    // afterEach asks again, which is a no-op.
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(
      () => pidsRunningFor(FOREGROUND_MARKER).length === 0,
      "the unlisted record still stands for a group this runtime has to stop",
      12_000,
    );
  });
});
