/**
 * The bash tool has three environment preconditions — a working directory that exists, a configured shell
 * that can be run, a log directory that can be written — and each of them answers as a tool *result*, never
 * as a thrown errno (F6, F11, F19). A fourth way the same call can fail is still unhandled: `spawn` itself
 * throwing synchronously.
 *
 * `child_process.spawn` throws rather than emitting `error` when the failure is detected before the fork.
 * Two are reachable from a command:
 *
 *   - `E2BIG` — one argument longer than the kernel's per-argument limit (`MAX_ARG_STRLEN`, 131072 bytes on
 *     Linux). The command is handed to the shell as a single `-c` argument, so a command over that size
 *     cannot be started at all. Measured here: 131071 bytes spawns, 131072 throws.
 *   - `ERR_INVALID_ARG_VALUE` — Node rejects an argument containing a NUL byte before it reaches libuv.
 *
 * Both escape `spawnJob`'s catch (which unlinks the log and rethrows) and end the tool call as a rejected
 * promise: `Error: spawn E2BIG`, `The argument 'args[1]' must be a string without null bytes`. That names no
 * setting, no directory and no limit, and it bypasses everything the rest of the spawn path does — no job, no
 * sidecar, no `proc.on("error")` note in the log, no `structuredContent`. Pi's own tool throws for the same
 * two inputs, so this is not a divergence; it is the one remaining case where this extension answers with an
 * errno where it has decided everywhere else that it answers with a sentence.
 *
 * What must not regress: the failure leaves nothing in the log dir (the log opened before the spawn is
 * unlinked), and the blocking mutex survives a call that threw.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

/** Comfortably past the 131072-byte per-argument limit, with a shape a model really writes: a long heredoc. */
function oversizedCommand(): string {
  return `cat <<'EOF'\n${"x".repeat(200_000)}\nEOF`;
}

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

/** Call the tool and say plainly what happened, so a rejection shows up as a failure rather than a stack. */
async function attempt(params: Record<string, unknown>): Promise<{ result?: any; rejection?: unknown }> {
  try {
    return { result: await ext!.callTool("bash", params) };
  } catch (rejection) {
    return { rejection };
  }
}

beforeEach(() => {
  agentDir = makeTempDir("pi-ext-agent-");
  vi.resetModules();
});

afterEach(async () => {
  // A load whose shutdown was never emitted keeps its temporary working directory behind.
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
});

async function start(): Promise<void> {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await ext.emit({ type: "session_start", reason: "startup" });
}

function logDirFiles(): string[] {
  try {
    return readdirSync(join(agentDir.path, "bg-tasks"));
  } catch {
    return [];
  }
}

describe("a command that cannot be handed to a shell at all", () => {
  it("answers as a result naming the limit, not as a rejected spawn error", async () => {
    await start();
    const { result, rejection } = await attempt({ command: oversizedCommand(), timeout: 5 });

    if (rejection !== undefined) {
      expect.fail(`the tool call rejected instead of answering: ${String(rejection)}`);
    }
    expect(result!.isError, `a command that never started is an error: ${text(result)}`).toBe(true);
    expect(result!.structuredContent?.exit_code, "nothing ran, so there is no exit code to report").toBeUndefined();
    // The actionable half: what is too long, and for what. "spawn E2BIG" names neither.
    expect(text(result!), `the answer has to say why: ${text(result)}`).toMatch(/too long/i);
  });

  it("answers the same way for a background start", async () => {
    // `timeout: 0` is the path with less time to notice, and the one where a failure is easiest to report as
    // a success.
    await start();
    const { result, rejection } = await attempt({ command: oversizedCommand(), timeout: 0 });

    if (rejection !== undefined) {
      expect.fail(`the tool call rejected instead of answering: ${String(rejection)}`);
    }
    expect(result!.isError, `the command did not start: ${text(result)}`).toBe(true);
    expect(text(result!), "and it is not presented as a running task").not.toMatch(/running in background/i);
  });

  it("takes a NUL byte in the command as a result too", async () => {
    // Node refuses the argument before libuv sees it, which throws from the same line for the same reason as
    // the oversized one. A model copying text out of a binary can produce this.
    await start();
    const { result, rejection } = await attempt({ command: "echo a\u0000b", timeout: 5 });

    if (rejection !== undefined) {
      expect.fail(`the tool call rejected instead of answering: ${String(rejection)}`);
    }
    expect(result!.isError, `the answer: ${text(result)}`).toBe(true);
  });

  it("leaves nothing in the log dir behind", async () => {
    // Already true, and worth pinning across whatever fix lands: the log is opened before the spawn, so a
    // spawn that throws has to take the empty file with it.
    await start();
    await attempt({ command: oversizedCommand(), timeout: 5 });
    await attempt({ command: oversizedCommand(), timeout: 0 });

    expect(logDirFiles(), "no log, no sidecar, no temp").toEqual([]);
  });

  it("does not cost the blocking mutex the call that threw", async () => {
    // The rejection has to release the lock, or every later default (blocking) command of the session waits
    // on a chain that never settles.
    await start();
    await attempt({ command: oversizedCommand(), timeout: 5 });

    const after = await ext!.callTool("bash", { command: "echo AFTER-AN-IMPOSSIBLE-COMMAND" });
    expect(text(after)).toContain("AFTER-AN-IMPOSSIBLE-COMMAND");
  });
});
