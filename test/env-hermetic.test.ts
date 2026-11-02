/**
 * The suite has to mean the same thing in every shell.
 *
 * Every extension in this repo reads its configuration from the environment at module load — pi-takeover
 * `PI_TAKEOVER_MAX_CHAIN`/`_CONFIRM`/`_NAME`/`_DEBUG`, pi-bg-tasks `PI_BG_TASKS_KEEP_RUNNING` (at call
 * time), pi-subagent `PI_SUBAGENT_MAX_DEPTH`/`_DEPTH`, pi-memory `PI_MEMORY_FILENAME`/`_MAX_BYTES`/`_DEBUG`.
 * `loadExtension` sets `PI_CODING_AGENT_DIR` and whatever a test asks for, and passes everything else
 * through — so a developer or an unattended agent whose own shell configures these extensions runs a suite
 * that is red for reasons unrelated to the change. `PI_TAKEOVER_MAX_CHAIN=100` in a `.bashrc` is enough:
 * four pi-takeover tests fail on the cap, and `PI_MEMORY_FILENAME` takes out most of pi-memory.
 *
 * This is the same mistake pi-bg-tasks guards against for the commands it spawns — "no PI_* leftovers from
 * a parent pi process" — pointed at the test process instead. A load is a fresh runtime: the harness owns
 * its environment, and an ambient value must be asked for by name (`env: { … }`) to reach it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadExtension, packageDir } from "./helpers/extension.ts";
import { isAlive, waitFor } from "./helpers/wait.ts";

/** Every extension-owned variable in the repo, set to something that changes behaviour. */
const HOST_CONFIGURATION: Record<string, string> = {
  PI_TAKEOVER_MAX_CHAIN: "100",
  PI_TAKEOVER_CONFIRM: "1",
  PI_TAKEOVER_NAME: "0",
  PI_TAKEOVER_DEBUG: "1",
  PI_BG_TASKS_KEEP_RUNNING: "0",
  PI_SUBAGENT_MAX_DEPTH: "0",
  PI_SUBAGENT_DEPTH: "0",
  PI_MEMORY_FILENAME: "HOST-NOTES.md",
  PI_MEMORY_MAX_BYTES: "1",
  PI_MEMORY_DEBUG: "1",
};

const saved: Record<string, string | undefined> = {};

function configureHost(): void {
  for (const [key, value] of Object.entries(HOST_CONFIGURATION)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

function restoreHost(): void {
  for (const key of Object.keys(HOST_CONFIGURATION)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function text(result: any): string {
  return result.content.map((part: any) => part?.text ?? "").join("\n");
}

afterEach(() => {
  restoreHost();
  for (const key of Object.keys(saved)) delete saved[key];
});

describe("a load in a shell that configures the extensions", () => {
  it("uses pi-takeover's documented cap, not the shell's", async () => {
    configureHost();
    const ext = await loadExtension({ packageDir: packageDir("pi-takeover") });
    try {
      const result = await ext.callTool("takeover", { prompt: "Report what is still blocking." });

      expect(text(result), "the queued handoff came from a fresh runtime").toContain("Takeover queued");
      expect(text(result), `the ambient cap leaked into the extension:\n${text(result)}`).not.toContain("/100");
      expect(text(result)).toMatch(/takeover 1\/\d+/);
    } finally {
      ext.dispose();
    }
  });

  it("keeps pi-bg-tasks' documented shutdown rule, not the shell's", async () => {
    configureHost();
    const ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    try {
      const started = await ext.callTool("bash", { command: "sleep 199", timeout: 0 });
      const pid = started.details.pid as number;

      // The default is "keep running"; `PI_BG_TASKS_KEEP_RUNNING=0` in the caller's shell is not the
      // test's, and the extension reads it at call time, so a load-time snapshot is not enough.
      await ext.emit({ type: "session_shutdown", reason: "reload" });
      expect(isAlive(pid), "a session replacement leaves the task alone unless the test asked otherwise").toBe(true);

      await ext.emit({ type: "session_shutdown", reason: "quit" });
      await waitFor(() => !isAlive(pid), "the quit shutdown to stop the task");
    } finally {
      ext.dispose();
    }
  });
});
