import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

async function startBackground(ext: LoadedExtension, command: string) {
  const result = await ext.callTool("bash", { command, timeout: 0 });
  return { id: result.details.id as string, pid: result.details.pid as number, logPath: result.details.logPath as string };
}

function backdate(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

/** End a command the test started, whatever the assertions did. */
function stopHard(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function logNames(agentDir: string): string[] {
  return readdirSync(join(agentDir, "bg-tasks")).filter((name) => name.endsWith(".log"));
}

describe("reload and re-adoption", () => {
  it("re-adopts live jobs so bg_stop still reaches them after a reload", async () => {
    const first = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    const job = await startBackground(first, "sleep 120");
    const metaPath = join(first.agentDir, "bg-tasks", `${job.id}.json`);
    expect(existsSync(metaPath)).toBe(true);

    // A reload drops module state but keeps the agent dir, which is what re-adoption depends on.
    vi.resetModules();
    const second = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: first.agentDir });
    await second.emit({ type: "session_start", reason: "reload" });

    // Adoption claims the sidecar, so the job is now owned by this runtime and the next reload
    // will find it again.
    expect(JSON.parse(readFileSync(metaPath, "utf8")).ownerPid).toBe(process.pid);

    const stop = await second.callTool("bg_stop", { task_id: job.id, reason: "reload test" });
    expect(text(stop)).toContain(`Task ${job.id} stopped`);
    await waitFor(() => !isAlive(job.pid), "the adopted process to exit");
    await waitFor(() => !existsSync(metaPath), "the metadata sidecar to be removed");

    await second.emit({ type: "session_shutdown", reason: "quit" });
    second.dispose();
    first.dispose();
  });

  it("drops sidecars whose process is gone", async () => {
    const agentDir = makeTempDir("pi-ext-agent-");
    const logDir = join(agentDir.path, "bg-tasks");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "bg-zombie.log"), "old output\n");
    writeFileSync(
      join(logDir, "bg-zombie.json"),
      JSON.stringify({
        pid: 2_147_483_000,
        command: "gone",
        cwd: agentDir.path,
        logPath: join(logDir, "bg-zombie.log"),
        startedAt: Date.now(),
      }),
    );

    vi.resetModules();
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    await ext.emit({ type: "session_start", reason: "startup" });

    const wait = await ext.callTool("bg_wait", { timeout: 1 });
    expect(text(wait)).toContain("No background tasks are running.");
    expect(existsSync(join(logDir, "bg-zombie.json"))).toBe(false);

    ext.dispose();
    agentDir.dispose();
  });

  it("stops jobs on quit, and keeps them across a session replacement by default", async () => {
    const replacement = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    const kept = await startBackground(replacement, "sleep 120");
    await replacement.emit({ type: "session_shutdown", reason: "new" });
    expect(isAlive(kept.pid)).toBe(true);

    const quit = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    const killed = await startBackground(quit, "sleep 120");
    await quit.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => !isAlive(killed.pid), "quit shutdown to stop the process");

    await replacement.callTool("bg_stop", { task_id: kept.id, reason: "test cleanup" });
    replacement.dispose();
    quit.dispose();
  });

  it("stops everything on session replacement when PI_BG_TASKS_KEEP_RUNNING=0", async () => {
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), env: { PI_BG_TASKS_KEEP_RUNNING: "0" } });
    const job = await startBackground(ext, "sleep 120");

    await ext.emit({ type: "session_shutdown", reason: "new" });
    await waitFor(() => !isAlive(job.pid), "the process to be stopped");
    ext.dispose();
  });
});

describe("log retention", () => {
  it("removes logs and sidecars older than the retention window", async () => {
    const agentDir = makeTempDir("pi-ext-agent-");
    const logDir = join(agentDir.path, "bg-tasks");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "bg-old.log"), "ancient\n");
    writeFileSync(join(logDir, "bg-old.json"), "{}");
    writeFileSync(join(logDir, "bg-fresh.log"), "recent\n");
    backdate(join(logDir, "bg-old.log"), 4 * DAY_MS);
    backdate(join(logDir, "bg-old.json"), 4 * DAY_MS);

    vi.resetModules();
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    await ext.emit({ type: "session_start", reason: "startup" });

    expect(existsSync(join(logDir, "bg-old.log"))).toBe(false);
    expect(existsSync(join(logDir, "bg-old.json"))).toBe(false);
    expect(existsSync(join(logDir, "bg-fresh.log"))).toBe(true);

    ext.dispose();
    agentDir.dispose();
  });

  it("keeps only the newest logs past the retained-count cap", async () => {
    const agentDir = makeTempDir("pi-ext-agent-");
    const logDir = join(agentDir.path, "bg-tasks");
    mkdirSync(logDir, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 105; i++) {
      const name = `bg-count${String(i).padStart(3, "0")}.log`;
      writeFileSync(join(logDir, name), `output ${i}\n`);
      const when = new Date(Date.now() - (105 - i) * 1000);
      utimesSync(join(logDir, name), when, when);
      names.push(name);
    }

    vi.resetModules();
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    await ext.emit({ type: "session_start", reason: "startup" });

    const remaining = logNames(agentDir.path);
    expect(remaining.length).toBe(100);
    // The five oldest are the ones that go.
    expect(remaining).not.toContain(names[0]);
    expect(remaining).not.toContain(names[4]);
    expect(remaining).toContain(names[104]);

    ext.dispose();
    agentDir.dispose();
  });

  it("never deletes the log of a job this runtime is still tracking", async () => {
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    const job = await startBackground(ext, "sleep 120");
    backdate(job.logPath, 4 * DAY_MS);
    expect(statSync(job.logPath).isFile()).toBe(true);

    await ext.emit({ type: "session_start", reason: "reload" });
    expect(existsSync(job.logPath)).toBe(true);

    await ext.callTool("bg_stop", { task_id: job.id, reason: "test cleanup" });
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });

  it("re-adopts a live command whose files have gone past the retention age", async () => {
    // A dev server that has been quiet for longer than the retention window, then /reload: the fresh
    // runtime has not adopted anything yet, so a prune that runs first sees only untracked files and
    // sweeps the sidecar of a command that is still running. The command becomes invisible - no
    // bg_wait, no bg_stop, and it survives the session's own shutdown.
    const agentDir = makeTempDir("pi-ext-agent-");
    vi.resetModules();
    const first = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    const job = await startBackground(first, "sleep 120");
    const logDir = join(agentDir.path, "bg-tasks");
    expect(existsSync(join(logDir, `${job.id}.json`))).toBe(true);
    backdate(job.logPath, 4 * DAY_MS);
    backdate(join(logDir, `${job.id}.json`), 4 * DAY_MS);

    vi.resetModules();
    const second = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    await second.emit({ type: "session_start", reason: "reload" });

    try {
      const wait = await second.callTool("bg_wait", { timeout: 1 });
      expect(wait.details.running, "the runtime that takes over a session takes over its commands too").toContain(job.id);
      expect(existsSync(job.logPath), "and does not delete the log of a command that is still writing").toBe(true);

      const stop = await second.callTool("bg_stop", { task_id: job.id, reason: "test cleanup" });
      expect(text(stop)).toContain(`Task ${job.id} stopped`);
      await waitFor(() => !isAlive(job.pid), "the adopted command to exit");
    } finally {
      stopHard(job.pid);
      await second.emit({ type: "session_shutdown", reason: "quit" });
      second.dispose();
      first.dispose();
      agentDir.dispose();
    }
  });

  it("re-adopts a live command when the retained-count sweep runs past it", async () => {
    // The same loss through the other retention rule: the command's files fall outside the newest 100
    // logs, even though everything about the command is still running.
    const agentDir = makeTempDir("pi-ext-agent-");
    vi.resetModules();
    const first = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    const job = await startBackground(first, "sleep 120");
    const logDir = join(agentDir.path, "bg-tasks");
    backdate(job.logPath, 10 * 60 * 1000);
    backdate(join(logDir, `${job.id}.json`), 10 * 60 * 1000);
    for (let i = 0; i < 105; i++) writeFileSync(join(logDir, `bg-newer${String(i).padStart(3, "0")}.log`), "newer\n");

    vi.resetModules();
    const second = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    await second.emit({ type: "session_start", reason: "reload" });

    try {
      const wait = await second.callTool("bg_wait", { timeout: 1 });
      expect(wait.details.running).toContain(job.id);

      const stop = await second.callTool("bg_stop", { task_id: job.id, reason: "test cleanup" });
      expect(text(stop)).toContain(`Task ${job.id} stopped`);
      await waitFor(() => !isAlive(job.pid), "the adopted command to exit");
    } finally {
      stopHard(job.pid);
      await second.emit({ type: "session_shutdown", reason: "quit" });
      second.dispose();
      first.dispose();
      agentDir.dispose();
    }
  });

  it("holds the log dir inside the retained count during a session, not only at its start", async () => {
    // Every truncated command leaves a full log behind, and a long-running interactive session never
    // reloads: retention that only runs at session_start never runs at all.
    const agentDir = makeTempDir("pi-ext-agent-");
    vi.resetModules();
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    for (let i = 0; i < 105; i++) await ext.callTool("bash", { command: "seq 1 3000" });

    expect(logNames(agentDir.path).length, "the README promises the newest 100 logs are kept").toBeLessThanOrEqual(100);

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
    agentDir.dispose();
  });
});
