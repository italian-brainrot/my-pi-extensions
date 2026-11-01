/**
 * Retention runs while a session runs, so it has to carry every protection that the pass at
 * `session_start` carries. A pass that fires mid-session — triggered by some other command finishing —
 * must leave a command this runtime is running, and one another runtime owns, exactly where they are:
 * losing their sidecars mid-session is the same loss the adopt-before-prune order avoids at reload,
 * just reachable an hour in.
 *
 * The cap and the protections have to hold at the same time: the dir stays inside the retained count,
 * and the one number it may exceed it by is the number of jobs that are still running.
 */

import { chmodSync, existsSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same cap the extension enforces; the tests have to be over it to trigger a pass. */
const MAX_RETAINED_LOGS = 100;

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

function logNames(): string[] {
  return readdirSync(logDir()).filter((name) => name.endsWith(".log"));
}

function backdate(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

function sharedBits(path: string): number {
  return statSync(path).mode & 0o077;
}

async function startRuntime(): Promise<LoadedExtension> {
  agentDir = makeTempDir("pi-ext-agent-");
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

beforeEach(async () => {
  ext = await startRuntime();
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
});

describe("retention while a session runs", () => {
  it("holds the cap without touching a task that is still running", async () => {
    const started = await ext!.callTool("bash", { command: "sleep 120", timeout: 0 });
    const task = { id: started.details.id as string, pid: started.details.pid as number, logPath: started.details.logPath as string };
    const sidecar = join(logDir(), `${task.id}.json`);

    // Past the retention age as well as outside the count: a pass that forgot a running job would
    // hit it through either rule.
    backdate(task.logPath, 4 * DAY_MS);
    backdate(sidecar, 4 * DAY_MS);

    // Enough files for the count rule to be what asks for a pass, without a reload in sight.
    for (let i = 0; i < MAX_RETAINED_LOGS + 5; i++) {
      writeFileSync(join(logDir(), `bg-older${String(i).padStart(3, "0")}.log`), "older output\n");
    }

    await ext!.callTool("bash", { command: "seq 1 3000" });

    try {
      expect(existsSync(task.logPath), "the log of a command that is still writing").toBe(true);
      expect(existsSync(sidecar), "and the sidecar that makes it stoppable").toBe(true);

      const wait = await ext!.callTool("bg_wait", { timeout: 1 });
      expect(wait.details.running, "the task is still a task this session can see").toContain(task.id);

      const stop = await ext!.callTool("bg_stop", { task_id: task.id, reason: "retention test" });
      expect(text(stop)).toContain(`Task ${task.id} stopped`);
      await waitFor(() => !isAlive(task.pid), "the task with the stale-looking files to be stoppable");

      // The cap holds for everything it is allowed to touch: the cap itself, plus the one running job.
      expect(logNames().length).toBeLessThanOrEqual(MAX_RETAINED_LOGS + 1);
    } finally {
      try {
        process.kill(-task.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("tightens logs an older install left group-writable, and ages out what is stale", async () => {
    // The directory is what gates the files inside it, and permissions.test.ts pins that it gets
    // tightened. This is about the files: a pass clears the shared bits of whatever it finds, so an
    // install that predates the private modes stops leaking without waiting for a reload. What asks
    // for the pass here is the count — the same thing that asks for one mid-session in a busy run.
    for (let i = 0; i < MAX_RETAINED_LOGS; i++) {
      const filler = join(logDir(), `bg-fill${String(i).padStart(3, "0")}.log`);
      writeFileSync(filler, "filler\n");
      // Distinctly older than everything written below, so the count sweep has a determinate choice
      // of what to drop and the files this test asserts on survive it.
      backdate(filler, 60_000);
    }

    const legacyLog = join(logDir(), "bg-legacy1.log");
    const legacySidecar = join(logDir(), "bg-legacy1.json");
    writeFileSync(legacyLog, "output from before the fix\n");
    writeFileSync(legacySidecar, JSON.stringify({ pid: 2_147_483_000, command: "gone" }));
    chmodSync(legacyLog, 0o664);
    chmodSync(legacySidecar, 0o664);

    const ancientLog = join(logDir(), "bg-ancient.log");
    const ancientSidecar = join(logDir(), "bg-ancient.json");
    writeFileSync(ancientLog, "old output\n");
    writeFileSync(ancientSidecar, "{}");
    backdate(ancientLog, 4 * DAY_MS);
    backdate(ancientSidecar, 4 * DAY_MS);

    await ext!.callTool("bash", { command: "echo x" });

    expect(sharedBits(legacyLog), "a log from before the fix").toBe(0);
    expect(sharedBits(legacySidecar), "and its sidecar").toBe(0);
    expect(existsSync(ancientLog), "the age rule runs mid-session too").toBe(false);
    expect(existsSync(ancientSidecar)).toBe(false);
  });
});
