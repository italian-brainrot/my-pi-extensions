/**
 * The `shellPath` check answers for the environment and the working directory of the *command*. Pass 3 made
 * the PATH part of that true by having one function build the PATH both the check and the child use — but
 * that function rebuilds the PATH instead of handing on the one Pi hands on, and a PATH entry only means
 * something relative to the directory the command runs in, which is `ctx.cwd`, not the runtime's.
 *
 * Pi's `getShellEnv` (utils/shell.js) keeps the configured PATH **verbatim**: it filters into
 * `pathEntries` only to decide whether the bin dir is already there, and then uses `currentPath` itself —
 * `[binDir, currentPath].join(delimiter)` otherwise. So an empty entry, which both bash and libuv read as
 * the command's working directory, survives into the child with the built-in tool. This extension splits,
 * filters out the empties and rejoins, so the same session with the same settings loses a whole PATH entry.
 *
 * The other half is what a value is resolved *against*. The extension spawns with `cwd: ctx.cwd` (Pi's own
 * tool: `ctx?.cwd || cwd`), and Pi can run a session whose cwd is not the process's — `SessionManager.open`
 * takes the cwd from the session header. A relative `shellPath`, or a bare name with a relative or empty
 * PATH entry, therefore has two different answers depending on which directory asks.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const originalCwd = process.cwd();

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;
/** The working directory of the *runtime* — what the extension sees as `process.cwd()`. */
let runtimeDir: ReturnType<typeof makeTempDir>;
/** The working directory of the *commands* — what the extension sees as `ctx.cwd`. */
let sessionDir: ReturnType<typeof makeTempDir>;
let extraBin: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function settings(dir: string, values: Record<string, unknown>): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(values));
}

/** A program that announces which file ran, and echoes the command it was handed. */
function writeProgram(dir: string, name: string, marker: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ${marker} "$*"\n`);
  chmodSync(path, mode);
  return path;
}

async function startRuntime(pathValue: string): Promise<void> {
  vi.resetModules();
  ext = await loadExtension({
    packageDir: packageDir("pi-bg-tasks"),
    agentDir: agentDir.path,
    cwd: sessionDir.path,
    env: { PATH: pathValue },
  });
  await ext.emit({ type: "session_start", reason: "startup" });
}

beforeEach(() => {
  agentDir = makeTempDir("pi-ext-agent-");
  runtimeDir = makeTempDir("pi-ext-cwd-");
  sessionDir = makeTempDir("pi-ext-cwd-");
  extraBin = makeTempDir("pi-ext-bin-");
  // The runtime and the commands run in different directories, which is what a resumed session does:
  // `SessionManager.open` takes the cwd from the session header, not from the process.
  process.chdir(runtimeDir.path);
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  process.chdir(originalCwd);
  extraBin?.dispose();
  sessionDir?.dispose();
  runtimeDir?.dispose();
  agentDir?.dispose();
});

describe("the PATH commands are handed", () => {
  it("keeps the PATH it was given entry for entry, so an empty entry still means the command's directory", async () => {
    // bash and sh treat an empty PATH entry as the current directory, and libuv resolves a bare program
    // name against the child's cwd the same way. `PATH=$SOMETHING:$PATH` with an unset variable is the
    // ordinary way one of these entries appears, and Pi passes it on untouched.
    writeProgram(sessionDir.path, "from-the-session-dir", "FROM-SESSION-DIR");
    const configured = [extraBin.path, "", "/usr/bin", "/bin"].join(delimiter);

    await startRuntime(configured);
    const result = await ext!.callTool("bash", { command: "from-the-session-dir the-command" });

    expect(result.structuredContent?.exit_code, `the command is on PATH exactly as it is for Pi:\n${text(result)}`).toBe(0);
    expect(text(result)).toContain("FROM-SESSION-DIR");
  });

  it("leaves PATH alone apart from the prepended bin dir, when the bin dir is already on it", async () => {
    // Pi's rule has a second half: when the bin dir is already an entry, `getShellEnv` returns `currentPath`
    // itself, character for character. Splitting and filtering and rejoining is not a no-op — it drops the
    // empty entries — and before pass 3 this extension only rewrote PATH in the other branch, so this case
    // behaved exactly like the built-in tool and now does not.
    const binDir = join(agentDir.path, "bin");
    const configured = [binDir, "", extraBin.path, "/usr/bin", "/bin"].join(delimiter);

    await startRuntime(configured);
    const result = await ext!.callTool("bash", { command: 'echo "PATH=[$PATH]"' });

    const given = /PATH=\[(.*)\]/.exec(text(result))?.[1];
    expect(given, `no PATH reached the command:\n${text(result)}`).toBeDefined();
    expect(given!.split(delimiter), "the configured entries, in order, empties included").toEqual(configured.split(delimiter));
  });

  it("prepends pi's bin dir without rebuilding the rest of PATH", async () => {
    const configured = [extraBin.path, "", "/usr/bin", "/bin"].join(delimiter);

    await startRuntime(configured);
    const result = await ext!.callTool("bash", { command: 'echo "PATH=[$PATH]"' });

    const given = /PATH=\[(.*)\]/.exec(text(result))?.[1];
    expect(given, `no PATH reached the command:\n${text(result)}`).toBeDefined();
    expect(given!.split(delimiter)[0]).toBe(join(agentDir.path, "bin"));
    // Pi's rule, spelled out: `[binDir, currentPath].join(delimiter)` — the configured string, verbatim.
    expect(given!.split(delimiter), "every configured entry survives, including the empty one").toEqual([
      join(agentDir.path, "bin"),
      ...configured.split(delimiter),
    ]);
  });
});

describe("where a configured shellPath is resolved", () => {
  it("runs a relative shellPath from the directory the commands run in", async () => {
    // The value is handed to `spawn` with `cwd: ctx.cwd`, so libuv resolves it against the session
    // directory. A check that resolves it against the runtime's directory answers about a different file.
    writeProgram(sessionDir.path, "session-dir-sh", "SESSION-DIR-SHELL");
    settings(agentDir.path, { shellPath: "./session-dir-sh" });

    await startRuntime(join("/usr/bin", delimiter, "/bin"));
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError, `the shell is where the commands run:\n${text(result)}`).toBeFalsy();
    expect(text(result)).toContain("SESSION-DIR-SHELL");
    expect(text(result)).toContain("the-command");
  });

  it("refuses a relative shellPath that is only reachable from the runtime's own directory", async () => {
    // The other side of the same disagreement, and the worse one: the check passes, the child cannot
    // start, and a broken setting arrives as a command that exited 127 — the failure mode the check
    // exists to prevent.
    writeProgram(runtimeDir.path, "runtime-dir-sh", "RUNTIME-DIR-SHELL");
    settings(agentDir.path, { shellPath: "./runtime-dir-sh" });

    await startRuntime(join("/usr/bin", delimiter, "/bin"));
    const result = await ext!.callTool("bash", { command: "echo the-command" });

    expect(result.isError).toBe(true);
    expect(text(result), "the setting is what is broken, not the command").toMatch(/runtime-dir-sh/);
    expect(text(result)).not.toMatch(/exited with code/);
    expect(result.structuredContent?.exit_code, "no command ever ran, so there is no exit code").toBeUndefined();
  });
});
