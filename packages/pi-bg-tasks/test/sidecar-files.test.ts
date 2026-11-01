/**
 * The files in `<agent-dir>/bg-tasks` other than the logs.
 *
 * A sidecar is read by every pi process that shares the agent dir, at its own `session_start`, and the
 * reader cannot tell whose record it was from anything but what is inside it. So two things are
 * load-bearing: a write is atomic — a temp name in the same directory, then a rename — so no reader can
 * see half a record; and a reader that cannot parse a record leaves it alone, because removing another
 * session's record strands a live command that nothing will adopt, protect, or stop. Both can leave
 * garbage behind, so the retention walk collects it: it already ages out stale sidecars, and it does the
 * same for a temp a crash left.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

function temps(): string[] {
  return readdirSync(logDir()).filter((name) => name.endsWith(".tmp"));
}

function sidecarOf(id: string): string {
  return join(logDir(), `${id}.json`);
}

function backdate(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

async function startRuntime(): Promise<LoadedExtension> {
  vi.resetModules();
  const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await loaded.emit({ type: "session_start", reason: "startup" });
  return loaded;
}

async function startBackground(runtime: LoadedExtension, command: string) {
  const result = await runtime.callTool("bash", { command, timeout: 0 });
  return { id: result.details.id as string, pid: result.details.pid as number, logPath: result.details.logPath as string };
}

async function stopQuietly(runtime: LoadedExtension, id: string): Promise<void> {
  try {
    await runtime.callTool("bg_stop", { task_id: id, reason: "test cleanup" });
  } catch {
    // Already finished.
  }
}

beforeEach(async () => {
  agentDir = makeTempDir("pi-ext-agent-");
  ext = await startRuntime();
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
});

describe("the sidecar write", () => {
  it("leaves no temp behind, so a normal run has nothing to clean up after", async () => {
    const job = await startBackground(ext!, "sleep 187");

    expect(existsSync(sidecarOf(job.id)), "the record is written when the command starts").toBe(true);
    expect(temps(), "the temp it was written through was renamed away").toEqual([]);

    await stopQuietly(ext!, job.id);
    await waitFor(() => !isAlive(job.pid), "the command to stop");
    expect(temps(), "and so was the one behind the rewrite at the end").toEqual([]);
  });

  it("collects the temp an interrupted write left, and leaves one a live runtime is writing", async () => {
    mkdirSync(logDir(), { recursive: true });
    const stale = join(logDir(), "bg-staletmp.json.tmp");
    const fresh = join(logDir(), "bg-freshtmp.json.tmp");
    writeFileSync(stale, '{"id":"bg-staletmp","pid":12345,');
    writeFileSync(fresh, '{"id":"bg-freshtmp","pi');
    // A temp from a looser install is tightened like every other file in here.
    chmodSync(fresh, 0o664);
    // Older than any write and its rename can take, and than the extension's own grace for a temp.
    backdate(stale, 10 * 60 * 1000);

    await ext!.emit({ type: "session_start", reason: "reload" });

    expect(existsSync(stale), "a temp nobody is writing is garbage, and a pass takes it").toBe(false);
    expect(existsSync(fresh), "a recent one may belong to a runtime mid-write, so it stays").toBe(true);
    expect(statSync(fresh).mode & 0o077, "and it is tightened while it is there").toBe(0);

    expect(temps().sort()).toEqual(["bg-freshtmp.json.tmp"]);
  });
});

describe("a record a runtime cannot parse", () => {
  it("stays where it is, is not adopted, and ages out like any other file", async () => {
    const job = await startBackground(ext!, "sleep 189");
    const sidecar = sidecarOf(job.id);

    // Stand in for whatever produces an unreadable record: a reader that caught an old in-place rewrite,
    // a record written by something else entirely, a disk that filled mid-write.
    writeFileSync(sidecar, readFileSync(sidecar).slice(0, 20));

    // A second runtime on the same agent dir: it must neither adopt the record nor delete it.
    const second = await startRuntime();
    try {
      expect(existsSync(sidecar), "an unreadable record is not the reader's to remove").toBe(true);

      const wait = await second.callTool("bg_wait", { timeout: 1 });
      const ids = ((wait.structuredContent.tasks as any[]) ?? []).map((task) => task.id);
      expect(ids, "a record that cannot be read cannot be adopted either").not.toContain(job.id);

      expect(existsSync(job.logPath), "the log of the command it stood for is left alone too").toBe(true);
      expect(isAlive(job.pid), "and the command stays its owner's to stop").toBe(true);

      // It is not permanent: the retention age rule reaches garbage without anyone guessing at it.
      backdate(sidecar, 4 * DAY_MS);
      await second.emit({ type: "session_start", reason: "reload" });
      expect(existsSync(sidecar), "past the retention age a pass takes it, like any stale record").toBe(false);
    } finally {
      await stopQuietly(ext!, job.id);
      await waitFor(() => !isAlive(job.pid), "the owning runtime to stop its own command");
      await second.emit({ type: "session_shutdown", reason: "quit" });
      second.dispose();
    }
  });
});
