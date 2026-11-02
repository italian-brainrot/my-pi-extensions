/**
 * The fourth environment precondition, and the limit behind it.
 *
 * `spawn` *throws* — it does not emit `error` — for a failure it notices before the fork, so a command the
 * kernel or Node refuses to hand to a shell never reaches the `error` handling, the registry, or a sidecar. Two
 * reachable inputs do that, and both are answered with a sentence, because what a thrown tool error becomes in
 * the model's context is the errno alone:
 *
 *   - `E2BIG` — the command is one `-c` argument, and one argument holds at most `MAX_ARG_STRLEN - 1` bytes:
 *     32 pages, 131071 bytes on a 4 KiB-page kernel (measured: 131071 spawn, 131072 throw).
 *   - a NUL byte — Node refuses the argument before libuv sees it.
 *
 * These tests hold the boundary and the wording. The boundary matters most: the limit belongs to the kernel and
 * its page size, so the extension catches the errno instead of checking a guessed size — a command one byte
 * under the limit still runs, which is what rules out a precondition that bites early. `shellCommandPrefix`
 * joins the same argument, and the refusal says the size of the whole argument, not of the command alone.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

/** Linux's `MAX_ARG_STRLEN` is 32 pages; the NUL terminator is one of those bytes. */
const ARG_LIMIT = 131_071;

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

beforeEach(() => {
  agentDir = makeTempDir("pi-ext-agent-");
  vi.resetModules();
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
});

async function start(): Promise<void> {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await ext.emit({ type: "session_start", reason: "startup" });
}

/** A command whose whole `-c` argument is `bytes` long and whose output is one line. */
function commandOfLength(bytes: number, marker: string): string {
  const head = `echo ${marker} #`;
  return `${head}${"#".repeat(bytes - head.length)}`;
}

describe("the per-argument limit on a command", () => {
  it("runs a command that is exactly one argument's worth of bytes", async () => {
    await start();
    const command = commandOfLength(ARG_LIMIT, "AT-THE-ARGUMENT-LIMIT");
    expect(Buffer.byteLength(command), "the argument is exactly at the limit").toBe(ARG_LIMIT);

    const result = await ext!.callTool("bash", { command, timeout: 10 });

    expect(result.isError, `a command that fits runs: ${text(result).slice(0, 200)}`).toBeUndefined();
    expect(text(result)).toContain("AT-THE-ARGUMENT-LIMIT");
  });

  it("refuses one byte more, naming the size and the limit", async () => {
    await start();
    const command = commandOfLength(ARG_LIMIT + 1, "PAST-THE-ARGUMENT-LIMIT");

    const result = await ext!.callTool("bash", { command, timeout: 10 });

    const body = text(result);
    expect(result.isError).toBe(true);
    expect(body, "the answer has to say what is too long").toMatch(/too long/i);
    // Both numbers, so the model can see it is over by one byte and not by a thousand.
    expect(body, `the answer quotes the size: ${body}`).toContain(String(ARG_LIMIT + 1));
    expect(body, `and the limit it broke: ${body}`).toContain(String(ARG_LIMIT));
    expect(result.structuredContent, "nothing ran, so there is no result to report").toBeUndefined();
  });

  it("counts the shell command prefix in the same argument", async () => {
    // What gets refused is the argument, and the prefix is part of it: a short command under a long prefix is
    // too long, and the number in the answer is the whole argument's size.
    const command = "echo PREFIX-MAKES-IT-TOO-LONG";
    const prefix = "y".repeat(ARG_LIMIT - command.length);
    writeFileSync(join(agentDir.path, "settings.json"), JSON.stringify({ shellCommandPrefix: prefix }));
    await start();

    const result = await ext!.callTool("bash", { command, timeout: 10 });

    expect(Buffer.byteLength(`${prefix}\n${command}`), "the argument is one byte over").toBe(ARG_LIMIT + 1);
    expect(result.isError, `the command alone is far under the limit: ${text(result)}`).toBe(true);
    expect(text(result)).toMatch(/too long/i);
    expect(text(result)).toContain(String(ARG_LIMIT + 1));
  });

  it("names the null byte for a command that holds one", async () => {
    await start();
    const result = await ext!.callTool("bash", { command: "echo a\u0000b", timeout: 5 });

    expect(result.isError).toBe(true);
    expect(text(result), "the sentence has to say what is wrong with the command").toMatch(/null byte/i);
  });
});
