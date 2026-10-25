/**
 * What MEMORY.md does to the system prompt, driven through the event Pi fires before a run.
 *
 * Assertions are scoped to paths inside each test's own sandbox: the extension searches the whole
 * ancestor chain up to the filesystem root, so a MEMORY.md belonging to the machine running the
 * tests must not make these fail.
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

interface ContextFile {
  path: string;
  content: string;
}

let cwd: TempDir;
let agentDir: TempDir;
let ext: LoadedExtension;

beforeEach(async () => {
  cwd = makeTempDir("pi-memory-cwd-");
  agentDir = makeTempDir("pi-memory-agent-");
  ext = await loadExtension({ packageDir: packageDir("pi-memory"), cwd: cwd.path, agentDir: agentDir.path });
});

afterEach(() => {
  ext?.dispose();
  cwd?.dispose();
  agentDir?.dispose();
});

/** Run one turn and return the context files Pi would render for it, in prompt order. */
async function run(startingFiles: ContextFile[] = [], runCwd: string = cwd.path): Promise<ContextFile[]> {
  const event = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hello",
    systemPrompt: "",
    systemPromptOptions: { cwd: runCwd, contextFiles: startingFiles.map((file) => ({ ...file })) },
  };
  await ext.emit(event, ext.makeContext({ cwd: runCwd }));

  const files = event.systemPromptOptions.contextFiles as ContextFile[];
  // Memory is appended after whatever Pi already loaded, never in place of it.
  for (let i = 0; i < startingFiles.length; i++) {
    expect(files[i], "files another source loaded must survive").toEqual(startingFiles[i]);
  }
  return files;
}

/** The injected files that live inside the given sandbox directories, in prompt order. */
function scoped(files: ContextFile[], roots: string[]): ContextFile[] {
  return files.filter((file) => roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)));
}

function paths(files: ContextFile[], roots: string[]): string[] {
  return scoped(files, roots).map((file) => file.path);
}

/** Assert the sandbox contributed exactly one injected file, and return it. */
function only(files: ContextFile[], roots: string[]): ContextFile {
  const inScope = scoped(files, roots);
  expect(inScope).toHaveLength(1);
  return inScope[0] as ContextFile;
}

function write(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe("pi-memory", () => {
  it("registers a before_agent_start handler and nothing else", () => {
    expect([...ext.tools.keys()]).toEqual([]);
    expect([...ext.handlers.keys()]).toEqual(["before_agent_start"]);
    expect(ext.calls.map((call) => call.prop)).toEqual(["on"]);
  });

  it("does nothing when no MEMORY.md exists", async () => {
    write(cwd.path, "AGENTS.md", "# spec\n");

    const files = await run([{ path: join(cwd.path, "AGENTS.md"), content: "# spec" }]);

    expect(files).toEqual([{ path: join(cwd.path, "AGENTS.md"), content: "# spec" }]);
  });

  it("injects the cwd's MEMORY.md with the maintenance note ahead of its contents", async () => {
    write(cwd.path, "MEMORY.md", "# Notes\n\n- releases are cut from main\n");

    const memory = only(await run(), [cwd.path]);

    expect(memory.path).toBe(join(cwd.path, "MEMORY.md"));
    expect(memory.content).toContain("- releases are cut from main");

    const noteAt = memory.content.indexOf("Note from the pi-memory extension");
    const bodyAt = memory.content.indexOf("# Notes");
    expect(bodyAt, "the file's own text must be injected").toBeGreaterThan(-1);
    expect(noteAt, "the ownership note must come before the notes themselves").toBeLessThan(bodyAt);
  });

  it("tells the assistant that keeping the file current is its job", async () => {
    write(cwd.path, "MEMORY.md", "- a note\n");

    const memory = only(await run(), [cwd.path]);
    const parts = memory.content.split("\n\n");

    expect(parts[0]).toBe(
      "Note from the pi-memory extension: this file is the assistant's own memory, injected from this " +
        "path at the start of every run, and this note is not part of the file. Keep it up to date as you " +
        "work: record what future sessions need (decisions, constraints, gotchas, commands, invariants), " +
        "delete what is stale or wrong, and keep it short, because it is loaded into every later session. " +
        "Use the normal file tools on this path to change it.",
    );
    expect(parts[1]).toBe("- a note");
  });

  it("injects the global memory first and the cwd's last", async () => {
    const root = makeTempDir("pi-memory-tree-");
    try {
      const outer = join(root.path, "outer");
      const inner = join(outer, "project");
      write(agentDir.path, "MEMORY.md", "- global memory\n");
      write(outer, "MEMORY.md", "- repo memory\n");
      write(inner, "MEMORY.md", "- checkout memory\n");

      const files = await run([], inner);

      expect(paths(files, [agentDir.path, outer, inner])).toEqual([
        join(agentDir.path, "MEMORY.md"),
        join(outer, "MEMORY.md"),
        join(inner, "MEMORY.md"),
      ]);
      expect(scoped(files, [outer])[0]?.content).toContain("- repo memory");
    } finally {
      root.dispose();
    }
  });

  it("injects an ancestor's MEMORY.md when the cwd has none", async () => {
    const root = makeTempDir("pi-memory-tree-");
    try {
      const inner = join(root.path, "packages", "one");
      write(root.path, "MEMORY.md", "- one note for the whole tree\n");

      const files = await run([], inner);

      expect(paths(files, [root.path])).toEqual([join(root.path, "MEMORY.md")]);
    } finally {
      root.dispose();
    }
  });

  it("injects a memory file in the agent directory when a session runs there", async () => {
    write(agentDir.path, "MEMORY.md", "- same place\n");

    const files = await run([], agentDir.path);

    expect(paths(files, [agentDir.path])).toEqual([join(agentDir.path, "MEMORY.md")]);
  });

  it("injects one entry when the agent directory is an ancestor of the cwd", async () => {
    write(agentDir.path, "MEMORY.md", "- one file, two scopes\n");

    const files = await run([], join(agentDir.path, "nested", "checkout"));

    expect(paths(files, [agentDir.path])).toEqual([join(agentDir.path, "MEMORY.md")]);
    expect(only(files, [agentDir.path]).content).toContain("- one file, two scopes");
  });

  it("injects a symlinked MEMORY.md once, as the file it points at", async () => {
    const globalMemory = write(agentDir.path, "MEMORY.md", "- shared file\n");
    symlinkSync(globalMemory, join(cwd.path, "MEMORY.md"));

    const files = await run();

    expect(paths(files, [agentDir.path, cwd.path])).toEqual([globalMemory]);
  });

  it("skips a MEMORY.md that is empty and one that is not a file", async () => {
    write(cwd.path, "MEMORY.md", "   \n\n\t\n");
    // A directory named MEMORY.md is not a memory file; Pi leaves it alone for the same reason.
    mkdirSync(join(cwd.path, "nested", "MEMORY.md"), { recursive: true });

    const files = await run([], join(cwd.path, "nested"));

    expect(scoped(files, [agentDir.path, cwd.path])).toEqual([]);
  });

  it("re-reads the file for every run, so an edit reaches the next prompt", async () => {
    const path = write(cwd.path, "MEMORY.md", "- first version\n");

    const before = only(await run(), [cwd.path]);
    writeFileSync(path, "- second version\n");
    const after = only(await run(), [cwd.path]);

    expect(before.content).toContain("- first version");
    expect(after.content).toContain("- second version");
    expect(after.content).not.toContain("- first version");
  });

  it("picks up a MEMORY.md created during the session", async () => {
    expect(scoped(await run(), [cwd.path])).toEqual([]);

    write(cwd.path, "MEMORY.md", "- written mid-session\n");

    expect(only(await run(), [cwd.path]).content).toContain("- written mid-session");
  });

  it("does not inject a MEMORY.md another extension already loaded", async () => {
    write(cwd.path, "MEMORY.md", "- mine\n");

    const files = await run([{ path: join(cwd.path, "MEMORY.md"), content: "- loaded by someone else" }]);

    expect(files).toEqual([{ path: join(cwd.path, "MEMORY.md"), content: "- loaded by someone else" }]);
  });

  it("appends what Pi appends for AGENTS.md, and Pi still does not read MEMORY.md", async () => {
    // The whole feature rests on `contextFiles` being the list Pi renders as <project_instructions>
    // blocks, and on MEMORY.md not being in it already. If Pi starts loading MEMORY.md itself, this
    // fails on purpose: the extension would need to become a rewrite of that section, not an append.
    const agentsPath = write(cwd.path, "AGENTS.md", "# spec\n");
    const memoryPath = write(cwd.path, "MEMORY.md", "- note\n");

    const fromPi = loadProjectContextFiles({ cwd: cwd.path, agentDir: agentDir.path });
    const files = await run(fromPi);
    const memory = files.find((file) => file.path === memoryPath);

    expect(fromPi.map((file) => file.path)).toContain(agentsPath);
    expect(fromPi.map((file) => file.path)).not.toContain(memoryPath);
    expect(memory, `MEMORY.md was not appended after Pi's own files: ${files.map((file) => file.path).join(", ")}`).toBeDefined();
    expect(Object.keys(memory!).sort()).toEqual(["content", "path"]);
    expect(memory!.content).toContain("- note");
    // Last, so the assistant reads its own notes after the user's spec.
    expect(files.at(-1)?.path).toBe(memoryPath);
  });
});
