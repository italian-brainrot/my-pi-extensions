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
});
