/**
 * Configuration. Every setting is read when the extension module loads, so each case needs its own
 * module instance: `vi.resetModules()` before loading, otherwise the previous load's environment is
 * still baked into the extension's constants.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

interface ContextFile {
  path: string;
  content: string;
}

let cwd: TempDir;
let ext: LoadedExtension | undefined;
let stderr: string[] = [];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = makeTempDir("pi-memory-cwd-");
  stderr = [];
  writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  ext?.dispose();
  ext = undefined;
  cwd?.dispose();
});

/** Load the extension with `env` in place, run one turn, and report what it injected in the sandbox. */
async function loadWith(env: Record<string, string | undefined>): Promise<ContextFile[]> {
  ext?.dispose();
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-memory"), cwd: cwd.path, env });

  const event = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hello",
    systemPrompt: "",
    systemPromptOptions: { cwd: cwd.path, contextFiles: [] as ContextFile[] },
  };
  await ext.emit(event, ext.makeContext());

  return (event.systemPromptOptions.contextFiles as ContextFile[]).filter((file) => file.path.startsWith(`${cwd.path}/`));
}

/** Assert exactly one file was injected inside the sandbox, and return it. */
function one(files: ContextFile[]): ContextFile {
  expect(files).toHaveLength(1);
  return files[0] as ContextFile;
}

function write(name: string, text: string): string {
  const path = join(cwd.path, name);
  writeFileSync(path, text);
  return path;
}

describe("pi-memory configuration", () => {
  it("looks for MEMORY.md when nothing is configured", async () => {
    write("MEMORY.md", "- default name\n");

    expect(await loadWith({})).toEqual([expect.objectContaining({ path: join(cwd.path, "MEMORY.md") })]);
  });

  it("uses PI_MEMORY_FILENAME as the file to look for", async () => {
    write("NOTES.md", "- configured name\n");
    write("MEMORY.md", "- ignored\n");

    const files = await loadWith({ PI_MEMORY_FILENAME: "NOTES.md" });

    expect(files.map((file) => file.path)).toEqual([join(cwd.path, "NOTES.md")]);
    expect(files[0]?.content).toContain("- configured name");
    expect(files[0]?.content).not.toContain("- ignored");
  });

  it("keeps the default name and says so when PI_MEMORY_FILENAME is not a file name", async () => {
    write("MEMORY.md", "- default name\n");

    const files = await loadWith({ PI_MEMORY_FILENAME: "docs/MEMORY.md" });

    expect(files.map((file) => file.path)).toEqual([join(cwd.path, "MEMORY.md")]);
    expect(stderr.join("")).toContain('pi-memory: ignoring PI_MEMORY_FILENAME "docs/MEMORY.md"');
  });

  it("truncates a memory file to PI_MEMORY_MAX_BYTES on a line boundary and says that it did", async () => {
    const body = `${"- keep this line\n".repeat(10)}- this line is past the limit\n`;
    write("MEMORY.md", body);
    const memory = one(await loadWith({ PI_MEMORY_MAX_BYTES: "60" }));

    const marker = /truncated this file at (\d+) of (\d+) bytes; raise the limit with PI_MEMORY_MAX_BYTES/.exec(memory.content);

    expect(memory.content.startsWith("Note from the pi-memory extension")).toBe(true);
    expect(memory.content).toContain("- keep this line");
    expect(memory.content).not.toContain("past the limit");
    expect(marker, memory.content).not.toBeNull();
    const [, shownBytes, totalBytes] = marker!;
    expect(Number(totalBytes)).toBe(Buffer.byteLength(body.trim()));
    expect(Number(shownBytes)).toBeGreaterThan(0);
    expect(Number(shownBytes)).toBeLessThanOrEqual(60);
    // Cutting to a line boundary, and never mid-codepoint.
    expect(memory.content.slice(memory.content.indexOf("- keep"), memory.content.indexOf("\n\n[…"))).toMatch(/(- keep this line\n?){3}$/);
    expect(memory.content).not.toContain("\uFFFD");
  });

  it("does not truncate a file that already fits under the limit", async () => {
    write("MEMORY.md", "- small\n");

    const memory = one(await loadWith({ PI_MEMORY_MAX_BYTES: "60" }));

    expect(memory.content).not.toContain("truncated");
  });

  it("keeps the default limit and says so when PI_MEMORY_MAX_BYTES is not a byte count", async () => {
    write("MEMORY.md", "- a line of some length\n".repeat(40));

    const memory = one(await loadWith({ PI_MEMORY_MAX_BYTES: "lots" }));

    expect(memory.content).not.toContain("truncated");
    expect(stderr.join("")).toContain('pi-memory: ignoring PI_MEMORY_MAX_BYTES "lots"');
  });

  it("stays silent unless PI_MEMORY_DEBUG is set", async () => {
    write("MEMORY.md", "- quiet\n");

    await loadWith({});
    const quiet = [...stderr];

    stderr = [];
    await loadWith({ PI_MEMORY_DEBUG: "1" });

    expect(quiet).toEqual([]);
    expect(stderr.join("")).toContain(`injected ${join(cwd.path, "MEMORY.md")}`);
    expect(stderr.join("")).toContain("1 MEMORY.md added");
  });

  it("logs when nothing was injected", async () => {
    await loadWith({ PI_MEMORY_DEBUG: "1" });

    expect(stderr.join("")).toContain(`no MEMORY.md in scope for ${cwd.path}`);
  });
});
