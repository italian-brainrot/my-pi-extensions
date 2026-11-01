/**
 * A task log is command output the model was not shown in full, and a sidecar carries the whole
 * command line: `curl -H "Authorization: Bearer …"` and `ps aux` both end up in there. Pi writes the
 * same class of data (a truncated tool's full output) with mode 0600 and says why — "Output can carry
 * private data, so only the user may read them". `<agent-dir>/bg-tasks` and the files inside it must
 * not be readable or writable by anyone else: on a shared machine, group-writable logs mean another
 * user can append text that this session then reads back as its own command output.
 */

import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

let agentDir: ReturnType<typeof makeTempDir>;
let ext: LoadedExtension;

/** Group and other permission bits, which must all be empty. */
function sharedBits(path: string): number {
  return statSync(path).mode & 0o077;
}

function logDir(): string {
  return join(agentDir.path, "bg-tasks");
}

beforeAll(async () => {
  agentDir = makeTempDir("pi-ext-agent-");
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  agentDir?.dispose();
});

describe("who can read a task's files", () => {
  it("keeps the log directory, the log, the sidecar and a kept foreground log private", async () => {
    const background = await ext.callTool("bash", { command: "echo background-output; sleep 30", timeout: 0 });
    const truncated = await ext.callTool("bash", { command: "seq 1 3000" });

    const sidecar = join(logDir(), `${background.details.id}.json`);
    const paths = [logDir(), background.details.logPath, sidecar, truncated.details.fullOutputPath];

    for (const path of paths) {
      expect(sharedBits(path), `${path} is reachable by group or other`).toBe(0);
    }

    await ext.callTool("bg_stop", { task_id: background.details.id, reason: "test cleanup" });
  });

  it("makes an already world-readable log directory private, so an upgraded install stops leaking", async () => {
    // An install from before the fix has a group-writable directory full of group-writable logs; the
    // directory is what gates everything inside it, so it has to be tightened even when it exists.
    mkdirSync(logDir(), { recursive: true });
    chmodSync(logDir(), 0o775);
    writeFileSync(join(logDir(), "bg-legacy1.log"), "output from before the fix\n");

    vi.resetModules();
    const second = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
    await second.emit({ type: "session_start", reason: "reload" });
    await second.callTool("bash", { command: "echo x", timeout: 0 });

    expect(sharedBits(logDir()), "the directory, which is what gates everything inside it").toBe(0);
    for (const name of readdirSync(logDir()).filter((entry) => !entry.startsWith("bg-legacy"))) {
      expect(sharedBits(join(logDir(), name)), name).toBe(0);
    }

    await second.emit({ type: "session_shutdown", reason: "quit" });
    second.dispose();
  });
});
