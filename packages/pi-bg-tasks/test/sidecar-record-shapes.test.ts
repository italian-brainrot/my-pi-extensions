/**
 * F16's rule is "a record that cannot be parsed is left where it is". The reader cannot ask the ownership
 * question without a parsed record, and the file may be another live session's only record of a command it
 * is waiting on. `adoptJobs` implements that with `if (!meta) continue`.
 *
 * `readMeta` returns whatever `JSON.parse` answers, and the guard only stops the falsy ones. A sidecar that
 * parses to something that is not an object — `[]`, `42`, `"x"` — gets a second chance at the ownership
 * question, answers it as "nobody's" (no `ownerPid`, no numeric `pid`), and is unlinked by the same loop
 * that was told not to remove what it cannot read. The value being a *record* is what the rule protects, not
 * whether it happened to be falsy.
 *
 * The consequence is the small one F16 was about: a record belonging to a command some other runtime is
 * still running is removed by a reader that could not make sense of it — here because the record is not in
 * the shape this reader expects, which is exactly what a reader older or newer than the writer meets.
 */

import { existsSync, utimesSync, writeFileSync } from "node:fs";
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

describe("a record that parses but is not a record", () => {
  it.each([
    ["an array", "[]"],
    ["a number", "42"],
    ["a string", '"bg-nobody"'],
  ] as const)("leaves %s where it is, like a record that does not parse at all", async (_label, contents) => {
    await leavesTheReaderAlone(contents);
  });
});

describe("a record whose fields are not the types this reader expects", () => {
  // The same question one level in. `pid` is what answers "is this command over, and did it leave a group
  // behind", and a record that cannot answer it is not evidence that nothing has to be stopped: deleting it
  // is the same guess, made by a reader that met a writer it did not recognise.
  it.each([
    ["a string pid", '{"pid":"123456"}'],
    ["a null pid", '{"pid":null}'],
    ["no pid at all", '{"command":"sleep"}'],
  ] as const)("leaves %s where it is and adopts nothing", async (_label, contents) => {
    await leavesTheReaderAlone(contents);
  });
});

/**
 * Replace a live task's sidecar with `contents`, let a second runtime read the directory, and hold the line:
 * it is not deleted, it is not adopted, and the age rule is what eventually collects it.
 */
async function leavesTheReaderAlone(contents: string): Promise<void> {
  const job = (await ext!.callTool("bash", { command: "sleep 197", timeout: 0 })).details as { id: string; pid: number };
  const sidecar = sidecarOf(job.id);

  writeFileSync(sidecar, contents);

  const second = await startRuntime();
  try {
    expect(existsSync(sidecar), `a reader that cannot read a record does not remove it (${contents})`).toBe(true);

    const wait = await second.callTool("bg_wait", { timeout: 1 });
    const ids = ((wait.structuredContent.tasks as any[]) ?? []).map((task) => task.id);
    expect(ids, "and it does not adopt what it cannot read").not.toContain(job.id);

    expect(isAlive(job.pid), "the command it stood for stays its owner's to stop").toBe(true);

    backdate(sidecar, 4 * DAY_MS);
    await second.emit({ type: "session_start", reason: "reload" });
    expect(existsSync(sidecar), "retention's age rule is what collects it").toBe(false);
  } finally {
    await stopQuietly(ext!, job.id);
    await waitFor(() => !isAlive(job.pid), "the owning runtime to stop its own command");
    await second.emit({ type: "session_shutdown", reason: "quit" });
    second.dispose();
  }
}
