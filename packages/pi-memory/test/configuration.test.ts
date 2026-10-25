/**
 * Configuration. Every setting is read when the extension module loads, so each case needs its own
 * module instance: `vi.resetModules()` before loading, otherwise the previous load's environment is
 * still baked into the extension's constants.
 *
 * Only the section name is imported from the extension; the model-facing note is not asserted here,
 * and nothing in this file repeats it, so rewording it cannot break these tests.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";
import { SECTION_NAME } from "../src/index.ts";

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

/** Load the extension with `env` in place, run one turn, and report its section of the prompt. */
async function loadWith(env: Record<string, string | undefined>): Promise<string | undefined> {
  ext?.dispose();
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-memory"), cwd: cwd.path, env });

  const event = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hello",
    systemPrompt: "",
    systemPromptOptions: { cwd: cwd.path, contextFiles: [] as ContextFile[], sections: {} as Record<string, string> },
  };
  await ext.emit(event, ext.makeContext());

  const sections = event.systemPromptOptions.sections as Record<string, string>;
  const text = sections[SECTION_NAME];
  if (text === undefined) return undefined;

  // Only the sandbox's own blocks: the extension also searches the machine-wide ancestor chain.
  const inSandbox = [...text.matchAll(/<memory path="([^"]*)">\n([\s\S]*?)\n<\/memory>/g)].filter((match) =>
    match[1]?.startsWith(`${cwd.path}/`),
  );
  if (inSandbox.length !== 1) throw new Error(`expected one memory block for ${cwd.path}, got ${inSandbox.length}`);
  return inSandbox[0]?.[0];
}

/** The one block the sandbox contributed, or a failure explaining what the run produced. */
function one(block: string | undefined): string {
  if (block === undefined) throw new Error("the run injected no memory section");
  return block;
}

function write(name: string, text: string): string {
  const path = join(cwd.path, name);
  writeFileSync(path, text);
  return path;
}

describe("pi-memory configuration", () => {
  it("looks for MEMORY.md when nothing is configured", async () => {
    write("MEMORY.md", "- default name\n");

    expect(await loadWith({})).toBe(`<memory path="${join(cwd.path, "MEMORY.md")}">\n- default name\n</memory>`);
  });

  it("uses PI_MEMORY_FILENAME as the file to look for", async () => {
    write("NOTES.md", "- configured name\n");
    write("MEMORY.md", "- ignored\n");

    const block = one(await loadWith({ PI_MEMORY_FILENAME: "NOTES.md" }));

    expect(block).toContain(`path="${join(cwd.path, "NOTES.md")}"`);
    expect(block).toContain("- configured name");
    expect(block).not.toContain("- ignored");
  });

  it("keeps the default name and says so when PI_MEMORY_FILENAME is not a file name", async () => {
    write("MEMORY.md", "- default name\n");

    const block = one(await loadWith({ PI_MEMORY_FILENAME: "docs/MEMORY.md" }));

    expect(block).toContain(`path="${join(cwd.path, "MEMORY.md")}"`);
    expect(stderr.join("")).toContain('pi-memory: ignoring PI_MEMORY_FILENAME "docs/MEMORY.md"');
  });

  it("truncates a memory file to PI_MEMORY_MAX_BYTES on a line boundary and says that it did", async () => {
    const body = `${"- keep this line\n".repeat(10)}- this line is past the limit\n`;
    write("MEMORY.md", body);
    const block = one(await loadWith({ PI_MEMORY_MAX_BYTES: "60" }));

    const marker = /truncated this file at (\d+) of (\d+) bytes; raise the limit with PI_MEMORY_MAX_BYTES/.exec(block);

    expect(block).toContain("- keep this line");
    expect(block).not.toContain("past the limit");
    expect(marker, block).not.toBeNull();
    const [, shownBytes, totalBytes] = marker!;
    expect(Number(totalBytes)).toBe(Buffer.byteLength(body.trim()));
    expect(Number(shownBytes)).toBeGreaterThan(0);
    expect(Number(shownBytes)).toBeLessThanOrEqual(60);
    // Cutting to a line boundary, and never mid-codepoint.
    expect(block.slice(block.indexOf("- keep"), block.indexOf("\n\n[…"))).toMatch(/(- keep this line\n?){3}$/);
    expect(block).not.toContain("\uFFFD");
    // The marker belongs to the block, inside its tags, not to the section around them.
    expect(block.trimEnd().endsWith("</memory>")).toBe(true);
  });

  it("does not truncate a file that already fits under the limit", async () => {
    write("MEMORY.md", "- small\n");

    expect(one(await loadWith({ PI_MEMORY_MAX_BYTES: "60" }))).not.toContain("truncated");
  });

  it("keeps the default limit and says so when PI_MEMORY_MAX_BYTES is not a byte count", async () => {
    write("MEMORY.md", "- a line of some length\n".repeat(40));

    expect(one(await loadWith({ PI_MEMORY_MAX_BYTES: "lots" }))).not.toContain("truncated");
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
    expect(stderr.join("")).toContain(`1 MEMORY.md added to <${SECTION_NAME}>`);
  });

  it("logs when nothing was injected", async () => {
    await loadWith({ PI_MEMORY_DEBUG: "1" });

    expect(stderr.join("")).toContain(`no MEMORY.md in scope for ${cwd.path}`);
  });
});
