/**
 * `shellCommandPrefix` is joined to the command with a newline, which is what the built-in tool does, and
 * the whole reason output is attached by file descriptor instead of by a shell wrapper is that the
 * command string must reach `bash -c` unchanged. Both halves of that are worth pinning while the join is
 * new: the prefix must not perturb the command forms a wrapper used to break, and the prefix must stay
 * out of what the extension itself records and lists — a sidecar and a task listing that carried the
 * prefix would show a command the user never ran, and a reload would adopt that as the command.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const PREFIX_LINE = "prefix-ran";

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

beforeEach(async () => {
  agentDir = makeTempDir("pi-ext-agent-");
  // The shell settings are resolved once per runtime, so they have to be on disk before the load.
  writeFileSync(join(agentDir.path, "settings.json"), JSON.stringify({ shellCommandPrefix: `echo ${PREFIX_LINE}` }));

  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
});

describe("a prefix joined onto a command", () => {
  it.each([
    ["a heredoc", "cat <<'MARK'\nheredoc-body\nMARK", "heredoc-body"],
    ["a command ending in a comment", "echo hi # trailing comment", "hi"],
    ["a command ending in a backslash", "echo tail\\", "tail\\"],
    ["a command starting with a paren", "(echo subshell-out)", "subshell-out"],
  ])("leaves %s intact and runs the prefix first", async (_label, command, expected) => {
    const result = await ext!.callTool("bash", { command });

    expect(text(result)).toContain(PREFIX_LINE);
    expect(text(result)).toContain(expected);
  });

  it("keeps the prefix out of the sidecar and the task listing", async () => {
    const command = "echo the-command # raw";
    const started = await ext!.callTool("bash", { command, timeout: 0 });

    const meta = JSON.parse(readFileSync(join(agentDir.path, "bg-tasks", `${started.details.id}.json`), "utf8"));
    expect(meta.command, "a reload adopts the command the user wrote, not the prefix-joined one").toBe(command);

    const wait = await ext!.callTool("bg_wait", { timeout: 10 });
    expect(text(wait)).toContain(`$ ${command}`);
    expect(text(wait), "the listing is of the task, not of the shell's argument vector").not.toContain(PREFIX_LINE);
    expect(wait.structuredContent.tasks.find((entry: any) => entry.id === started.details.id).command).toBe(command);
  });
});
