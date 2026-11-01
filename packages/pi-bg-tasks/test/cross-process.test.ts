/**
 * Sessions share `<agent-dir>/bg-tasks`, so they must not reach into each other's commands.
 *
 * A real second runtime (test/fixtures/foreign-runtime.mjs) loads the extension against the same
 * agent dir, adopts what it finds at `session_start`, and stops everything it knows about at
 * shutdown — which is exactly what a nested `pi -p`, an RPC session, or a `subagent` call does
 * while another session has commands running. Regression guard for the bug where that killed the
 * parent session's commands.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";
import { isAlive, waitFor } from "../../../test/helpers/wait.ts";

const foreignRuntime = new URL("./fixtures/foreign-runtime.mjs", import.meta.url).pathname;
const extensionEntry = join(packageDir("pi-bg-tasks"), "src", "index.ts");
const DAY_MS = 24 * 60 * 60 * 1000;
/** A duration no other test in this suite uses, so a scan can single this worker out. */
const VANISHED_MARKER = "177";

let ext: LoadedExtension;

/** Live processes whose whole command line is `sleep <seconds>`; a finished task has no pid to keep. */
function pidsNamedFor(seconds: string): number[] {
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

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

async function startBackground(command: string) {
  const result = await ext.callTool("bash", { command, timeout: 0 });
  return { id: result.details.id as string, pid: result.details.pid as number, logPath: result.details.logPath as string };
}

function sidecarPath(id: string): string {
  return join(ext.agentDir, "bg-tasks", `${id}.json`);
}

/**
 * Run a second runtime against the same agent dir and report the sidecars it saw.
 *
 * Async on purpose: the owning runtime keeps its event loop turning while the other runtime runs,
 * so it reaps its own children the way a real pi session does. A synchronous spawn would block the
 * loop and leave a zombie that looks like a live process to every liveness check in the test.
 */
async function runForeignRuntime(spawnCommand?: string): Promise<{
  sidecarsBefore: string[];
  sidecarsAfter: string[];
  spawned?: { id: string; pid: number };
  stderr: string;
}> {
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const argv = [foreignRuntime, extensionEntry];
    if (spawnCommand !== undefined) argv.push("--spawn", spawnCommand);
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, PI_CODING_AGENT_DIR: ext.agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    timer.unref?.();
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

  if (result.status !== 0) {
    throw new Error(`foreign runtime exited ${result.status}: ${result.stderr}`);
  }

  const lastLine = result.stdout.trim().split("\n").pop() ?? "{}";
  return { ...JSON.parse(lastLine), stderr: result.stderr };
}

async function stopQuietly(id: string): Promise<void> {
  try {
    await ext.callTool("bg_stop", { task_id: id, reason: "test cleanup" });
  } catch {
    // Already finished.
  }
}

function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buffered = "";
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        stream.pause();
        resolve(buffered.slice(0, newline));
      }
    });
  });
}

describe("other pi sessions sharing the agent dir", () => {
  it("records which process owns a job", async () => {
    const job = await startBackground("sleep 120");
    const meta = JSON.parse(readFileSync(sidecarPath(job.id), "utf8"));

    expect(meta.ownerPid).toBe(process.pid);
    expect(meta.pid).toBe(job.pid);

    await stopQuietly(job.id);
  });

  it("leaves this session's running job alone: not adopted, not stopped, not deleted", async () => {
    const job = await startBackground("sleep 120");

    const seen = await runForeignRuntime();
    const sidecar = `${job.id}.json`;
    expect(seen.sidecarsBefore, `the foreign runtime should have seen the sidecar; stderr: ${seen.stderr}`).toContain(sidecar);
    expect(seen.sidecarsAfter, `the foreign runtime must not delete a sidecar it does not own; stderr: ${seen.stderr}`).toContain(sidecar);

    expect(isAlive(job.pid), "the nested runtime must not stop a command it does not own").toBe(true);
    expect(existsSync(sidecarPath(job.id))).toBe(true);
    expect(existsSync(job.logPath)).toBe(true);

    // This session still tracks it as running, which is what bg_wait and bg_stop report on.
    const wait = await ext.callTool("bg_wait", { timeout: 1 });
    expect(wait.details.running, "the owning session must still consider the job running").toContain(job.id);

    await stopQuietly(job.id);
    await waitFor(() => !isAlive(job.pid), "the job to stop after we stopped it ourselves");
  });

  it("takes over a command whose owning process is gone, and can stop it", async () => {
    const logDir = join(ext.agentDir, "bg-tasks");
    mkdirSync(logDir, { recursive: true });

    // Stand in for a dev server orphaned by a crash. The shell that starts it exits at once, so the
    // process is reparented to init and reaped when it dies; spawning it as a direct child of this
    // test process would leave a zombie that reads as live. Its stdio is redirected, otherwise it
    // holds the shell's stdout pipe open and execFileSync waits for the whole 120 seconds.
    const printed = execFileSync("sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
    const orphanPid = Number(printed.trim());
    if (!Number.isFinite(orphanPid) || orphanPid <= 0) throw new Error(`could not start the fake orphan: ${printed}`);
    const id = "bg-orphan1";

    try {
      writeFileSync(
        join(logDir, `${id}.json`),
        JSON.stringify({
          id,
          pid: orphanPid,
          cwd: ext.cwd,
          command: "sleep 120",
          logPath: join(logDir, `${id}.log`),
          startedAt: Date.now(),
        }),
      );

      const seen = await runForeignRuntime();
      expect(seen.sidecarsBefore, `the orphan sidecar should have been visible; stderr: ${seen.stderr}`).toContain(`${id}.json`);

      await waitFor(() => !isAlive(orphanPid), "the adopting runtime to stop the orphaned command");
      await waitFor(() => !existsSync(join(logDir, `${id}.json`)), "the sidecar to be removed once the job is finished");
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("leaves an unmarked command alone when its parent process is still alive", async () => {
    // A sidecar written before ownerPid existed carries no marker. The process table still says who
    // owns it: a command whose parent process is alive belongs to that runtime, so a foreign runtime
    // must not take it. The reparented case (parent is init) is covered by the orphan test above,
    // which writes the same unmarked shape.
    const logDir = join(ext.agentDir, "bg-tasks");
    mkdirSync(logDir, { recursive: true });

    const parentShell = spawn("sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let childPid = Number.NaN;
    try {
      childPid = Number(await readFirstLine(parentShell.stdout));
      if (!Number.isFinite(childPid) || childPid <= 0) {
        throw new Error(`could not start the fake owner's command: ${childPid}`);
      }

      const id = "bg-unowned1";
      writeFileSync(
        join(logDir, `${id}.json`),
        JSON.stringify({
          id,
          pid: childPid,
          cwd: ext.cwd,
          command: "sleep 120",
          logPath: join(logDir, `${id}.log`),
          startedAt: Date.now(),
        }),
      );

      const seen = await runForeignRuntime();
      expect(seen.sidecarsBefore, `the unmarked sidecar should have been visible; stderr: ${seen.stderr}`).toContain(`${id}.json`);

      expect(isAlive(childPid), "an unmarked command with a live parent process is not ours to stop").toBe(true);
      expect(existsSync(join(logDir, `${id}.json`)), "and its sidecar stays for the runtime that owns it").toBe(true);
    } finally {
      try {
        if (Number.isFinite(childPid)) process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
      parentShell.kill("SIGKILL");
    }
  });

  it("does not kill the very command that started it", async () => {
    // The case that made this bug look random: any bash command that itself launches a pi (a nested
    // `pi -p`, a script that runs pi, the subagent tool) registers a sidecar for its own wrapper.
    // The nested runtime used to adopt that sidecar and, at shutdown, SIGTERM the command running
    // it — the tool result came back as "Command terminated by signal SIGTERM" with no timeout
    // anywhere near its limit. The fixture stands in for the nested pi; it is started by this
    // session's own bash tool, so this session is its parent exactly as in the real failure.
    const result = await ext.callTool("bash", {
      command: `node ${JSON.stringify(foreignRuntime)} ${JSON.stringify(extensionEntry)}`,
      timeout: 60,
    });

    expect(result.details.status, `the nested runtime killed its own parent: ${text(result)}`).toBe("completed");
    const seen = JSON.parse(text(result).trim().split("\n").pop() ?? "{}");
    expect(seen.sidecarsBefore.length, "the wrapper's sidecar should have been visible to the nested runtime").toBeGreaterThan(0);
  });

  it("does not prune another session's files, even past the retention age", async () => {
    const job = await startBackground("sleep 120");
    const when = new Date(Date.now() - 4 * DAY_MS);
    utimesSync(job.logPath, when, when);
    utimesSync(sidecarPath(job.id), when, when);

    await runForeignRuntime();

    expect(existsSync(job.logPath), "a foreign runtime must not prune a live session's log").toBe(true);
    expect(existsSync(sidecarPath(job.id))).toBe(true);

    await stopQuietly(job.id);
  });

  it("does not delete a sidecar it cannot parse, which is another session's record of a live command", async () => {
    // A sidecar is rewritten in place — `open(path, "w")` truncates it, then the bytes arrive — so a
    // runtime that lists the log dir at that moment sees a partial file. A runtime killed during the
    // write leaves the same thing behind. The reader cannot tell whose the record was, and today it
    // simply removes it: the live command of another session is left with no record at all, which is the
    // F3/F9 hole (not adoptable, not protected from retention, not stoppable by the next runtime).
    const job = await startBackground("sleep 120");
    const contents = readFileSync(sidecarPath(job.id), "utf8");
    writeFileSync(sidecarPath(job.id), contents.slice(0, Math.floor(contents.length / 2)));

    const seen = await runForeignRuntime();

    expect(seen.sidecarsBefore, `the truncated record should have been visible; stderr: ${seen.stderr}`).toContain(`${job.id}.json`);
    expect(seen.sidecarsAfter, "a runtime that cannot parse a record must leave it where it is").toContain(`${job.id}.json`);
    expect(existsSync(job.logPath), "and it must not take the log of a live command with it").toBe(true);
    expect(isAlive(job.pid), "the command it stands for is still running, and still the owner's").toBe(true);

    await stopQuietly(job.id);
    await waitFor(() => !isAlive(job.pid), "the owning session to stop its own command");
  });

  it("takes over the process group a runtime that went away left behind", async () => {
    // A runtime that disappears without a shutdown — a crash, a kill, a nested pi that exits nonzero —
    // stops nothing and claims nothing. What it leaves is a task that finished while its process group
    // kept running, and the record of that group is the only handle on it. This session re-reads the
    // sidecars at its own session_start, and from then on the orphan is its responsibility: listed as
    // the finished task it was, and stopped by its shutdown.
    const foreign = await runForeignRuntime(`sleep ${VANISHED_MARKER} & echo started`);
    const spawned = foreign.spawned;
    if (!spawned) throw new Error(`the fixture did not report a task; stderr: ${foreign.stderr}`);
    expect(foreign.sidecarsAfter, "the record outlives the runtime that wrote it").toContain(`${spawned.id}.json`);

    // The other runtime is gone (its exit has been awaited, so its pid is reaped), its own leader is
    // gone with it, and the worker it left behind is nobody's until someone takes the record over.
    await waitFor(() => pidsNamedFor(VANISHED_MARKER).length > 0, "the worker the vanished runtime left behind");

    await ext.emit({ type: "session_start", reason: "reload" });

    const wait = await ext.callTool("bg_wait", { timeout: 1 });
    const inherited = (wait.structuredContent.tasks as any[]).find((task) => task.id === spawned.id);
    expect(inherited, "the next session adopts the record, not a running task").toBeTruthy();
    expect(inherited.status).not.toBe("running");
    expect(inherited.adopted).toBe(true);

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => pidsNamedFor(VANISHED_MARKER).length === 0, "this session's shutdown to stop the inherited group", 12_000);
    expect(existsSync(sidecarPath(spawned.id)), "and the record goes with the group").toBe(false);
  });
});
