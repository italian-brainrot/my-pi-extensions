/**
 * Pass 3 made the in-memory task list `MAX_REGISTRY_SIZE` plus one entry per process group still waiting
 * to be stopped. This is that shape at a size a long session actually reaches: more live-group records than
 * the cap, filler commands on top of them, and one shutdown that has to sweep all of the groups.
 *
 * Nothing here is a new rule — `record-cap.test.ts` and `registry-cap.test.ts` pin the rule for one record.
 * What is only visible with dozens of them is that the pieces agree: the cap's per-entry `hasLeftoverGroup`
 * re-check does not turn into a stall, retention does not collect a protected record, `bg_wait` still
 * answers, `bg_stop` still knows every one of the IDs, and a shutdown that has to stop a dozen groups at
 * once stops them inside one grace window rather than one per group.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

/** All the workers share one duration, so one scan counts them. */
const MARKER = "193";
const LEFTOVER_TASKS = 12;
/** More than `MAX_REGISTRY_SIZE`, so the cap has to make room. */
const FILLER_COMMANDS = 201;

let agentDir: ReturnType<typeof makeTempDir>;
let ext: LoadedExtension | undefined;

function pidsRunningFor(marker: string): number[] {
  const wanted = new RegExp(`^sleep ${marker}$`);
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

function killAll(marker: string): void {
  for (const pid of pidsRunningFor(marker)) {
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

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

function filesInLogDir(suffix: string): string[] {
  try {
    return readdirSync(logDir()).filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
}

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  ext = loaded;
  return loaded;
}

beforeAll(() => {
  agentDir = makeTempDir("pi-ext-agent-");
});

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

describe("many live-group records under registry pressure", () => {
  it("keeps every record, lists them, and stops every group at one shutdown", async () => {
    const runtime = await startRuntime();
    const ids: string[] = [];
    const leaders: number[] = [];

    for (let i = 0; i < LEFTOVER_TASKS; i++) {
      const started = await runtime.callTool("bash", { command: `sleep ${MARKER} & echo started`, timeout: 0 });
      ids.push(started.details.id as string);
      leaders.push(started.details.pid as number);
    }
    // The shells exit at once and leave their worker behind, which is the shape that keeps a record. The
    // exit handler lands a moment after the process does, so the records are not there until it has run.
    await waitFor(() => leaders.every((pid) => !isAlive(pid)), "every task's shell to exit");
    await waitFor(() => pidsRunningFor(MARKER).length === LEFTOVER_TASKS, "every daemonised worker to be running");
    await waitFor(() => filesInLogDir(".json").length === LEFTOVER_TASKS, "every finished task to keep its record");

    // Sequential foreground commands: each is a finished registry entry, and none of them leaves a log or
    // a sidecar behind, so the log dir holds only the records under test.
    for (let i = 0; i < FILLER_COMMANDS; i++) {
      await runtime.callTool("bash", { command: "true" });
    }

    expect(filesInLogDir(".json").length, "one record per live group, and nothing else").toBe(LEFTOVER_TASKS);
    expect(filesInLogDir(".json.tmp").length, "an atomic write leaves no temp behind").toBe(0);

    // The registry is over its cap, and the entries the cap would rather drop are the ones that carry an
    // obligation. The listing is how a session sees that.
    const report = await runtime.callTool("bg_wait", { timeout: 0 });
    expect(text(report)).toContain(`${LEFTOVER_TASKS} tracked, 0 running`);
    expect(report.structuredContent.tasks.length).toBe(LEFTOVER_TASKS);
    for (const id of ids) expect(report.structuredContent.tasks.map((t: any) => t.id)).toContain(id);

    // One stop by ID still reaches one group, and drops only that record.
    const stopped = await runtime.callTool("bg_stop", { task_id: ids[0]!, reason: "scaled registry" });
    expect(text(stopped)).toContain(ids[0]);
    expect(text(stopped)).toContain("process group");
    await waitFor(() => pidsRunningFor(MARKER).length === LEFTOVER_TASKS - 1, "the stop by ID to reach that group");
    expect(existsSync(join(logDir(), `${ids[0]}.json`)), "the record is dropped with its group").toBe(false);
    expect(filesInLogDir(".json").length).toBe(LEFTOVER_TASKS - 1);

    // One shutdown, a dozen groups. `killAllJobs` signals them together, so this is one grace window and
    // not one per task.
    const began = Date.now();
    await runtime.emit({ type: "session_shutdown", reason: "quit" });
    const elapsed = Date.now() - began;
    // This test ran its own shutdown, so it disposes its own load: afterEach only knows about `ext`.
    runtime.dispose();
    ext = undefined;

    try {
      await waitFor(() => pidsRunningFor(MARKER).length === 0, "the shutdown to stop every remaining group", 12_000);
    } finally {
      killAll(MARKER);
    }
    expect(elapsed, "a dozen groups cost one overlapping grace window").toBeLessThan(3000);
    expect(filesInLogDir(".json").length, "every record went with its group").toBe(0);
  });
});
