/**
 * What MEMORY.md does to the system prompt, driven through the event Pi fires before a run.
 *
 * The extension owns one prompt section, so these tests assert the shape of that section: the note
 * first, then one `<memory path="…">` block per file, in discovery order. The note's wording comes
 * from the extension itself rather than being copied here, so rewording it is an edit to the
 * extension, not a test failure; what is pinned down is where the note sits relative to the tags.
 *
 * MEMORY.md is a startup input: each session reads it once, on its first run, and keeps that
 * rendering for as long as that session lasts. `run()` gives each call its own session unless a test
 * passes one, which is how the difference between the same session and a new one gets exercised.
 *
 * Assertions are scoped to paths inside each test's own sandbox: the extension searches the whole
 * ancestor chain up to the filesystem root, so a MEMORY.md belonging to the machine running the
 * tests must not make these fail.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";
import { MEMORY_NOTE, SECTION_NAME } from "../src/index.ts";

interface ContextFile {
  path: string;
  content: string;
}

/**
 * The prompt options a `before_agent_start` handler is given. Pi normalizes them, so `sections` is
 * always there in a real run; leaving it off in a test is how the extension's tolerance for a
 * hand-built event gets exercised.
 */
interface PromptOptions {
  cwd: string;
  contextFiles: ContextFile[];
  sections?: Record<string, string>;
}

/** What one run left behind in the prompt options, split into the two places an extension can write. */
interface PromptState {
  files: ContextFile[];
  sections: Record<string, string>;
  sessionId: string;
}

let cwd: TempDir;
let agentDir: TempDir;
let ext: LoadedExtension;
let sessions = 0;

beforeEach(async () => {
  cwd = makeTempDir("pi-memory-cwd-");
  agentDir = makeTempDir("pi-memory-agent-");
  ext = await loadExtension({ packageDir: packageDir("pi-memory"), cwd: cwd.path, agentDir: agentDir.path });
  sessions = 0;
});

afterEach(() => {
  ext?.dispose();
  cwd?.dispose();
  agentDir?.dispose();
});

/**
 * Run one turn and return the prompt options as the extension left them. `session` is what makes
 * this run part of an existing session; omit it for a session nobody has run yet.
 */
async function run(startingFiles: ContextFile[] = [], runCwd: string = cwd.path, session?: string): Promise<PromptState> {
  const id = session ?? `session-${++sessions}`;
  const event = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hello",
    systemPrompt: "",
    systemPromptOptions: { cwd: runCwd, contextFiles: startingFiles.map((file) => ({ ...file })), sections: {} },
  };
  await ext.emit(event, ext.makeContext({ cwd: runCwd, sessionId: id, sessionFile: join(agentDir.path, "sessions", `${id}.jsonl`) }));
  return {
    files: event.systemPromptOptions.contextFiles as ContextFile[],
    sections: event.systemPromptOptions.sections as Record<string, string>,
    sessionId: id,
  };
}

/** Begin a session boundary for `session`, the way Pi's `/reload`, `/new`, or `/resume` would. */
async function sessionStart(session: string, reason = "reload"): Promise<void> {
  await ext.emit({ type: "session_start", reason }, sessionContext(session));
}

/** The context one run of `session` gets; the same file path means the same session. */
function sessionContext(session: string) {
  return ext.makeContext({ cwd: cwd.path, sessionId: session, sessionFile: join(agentDir.path, "sessions", `${session}.jsonl`) });
}

/** The memory section for one run, or undefined when the run left no memory in the prompt. */
async function section(startingFiles: ContextFile[] = [], runCwd: string = cwd.path, session?: string): Promise<string | undefined> {
  const state = await run(startingFiles, runCwd, session);
  return state.sections[SECTION_NAME];
}

/** The memory section for one run, failing the test when the run injected nothing. */
async function sectionOf(startingFiles: ContextFile[] = [], runCwd: string = cwd.path, session?: string): Promise<string> {
  const text = await section(startingFiles, runCwd, session);
  if (text === undefined) throw new Error(`the run injected no <${SECTION_NAME}> section`);
  return text;
}

/** The `<memory path="…">` blocks in the section, in order, as `<path, block>` pairs. */
function blocks(text: string): Array<{ path: string; body: string }> {
  const found = [...text.matchAll(/<memory path="([^"]*)">\n([\s\S]*?)\n<\/memory>/g)];
  return found.map((match) => ({ path: match[1] as string, body: match[2] as string }));
}

/** Text belonging to the sandbox: the memory blocks whose paths live under one of `roots`. */
function scoped(text: string, roots: string[]): Array<{ path: string; body: string }> {
  return blocks(text).filter((block) => roots.some((root) => block.path === root || block.path.startsWith(`${root}/`)));
}

function paths(text: string, roots: string[]): string[] {
  return scoped(text, roots).map((block) => block.path);
}

/** Assert the sandbox contributed exactly one memory block, and return it. */
function only(text: string, roots: string[]): { path: string; body: string } {
  const inScope = scoped(text, roots);
  expect(inScope).toHaveLength(1);
  return inScope[0] as { path: string; body: string };
}

function write(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe("pi-memory", () => {
  it("registers a before_agent_start and a session_start handler, and nothing else", () => {
    expect([...ext.tools.keys()]).toEqual([]);
    expect([...ext.handlers.keys()]).toEqual(["session_start", "before_agent_start"]);
    expect(ext.calls.map((call) => call.prop)).toEqual(["on", "on"]);
  });

  it("does nothing when no MEMORY.md exists", async () => {
    write(cwd.path, "AGENTS.md", "# spec\n");

    const state = await run([{ path: join(cwd.path, "AGENTS.md"), content: "# spec" }]);

    expect(state.files).toEqual([{ path: join(cwd.path, "AGENTS.md"), content: "# spec" }]);
    expect(state.sections[SECTION_NAME]).toBeUndefined();
  });

  it("leaves the prompt options untouched when there is nothing to inject", async () => {
    // A no-memory run must not look like it changed the prompt, even in the shape of the options: Pi
    // diffs sections against the transcript, so an empty section here would be a prompt delta.
    const agentsPath = write(cwd.path, "AGENTS.md", "# spec\n");
    const options: PromptOptions = { cwd: cwd.path, contextFiles: [{ path: agentsPath, content: "# spec" }] };

    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: "hello", systemPrompt: "", systemPromptOptions: options },
      ext.makeContext({ sessionId: "quiet-session", sessionFile: join(agentDir.path, "sessions", "quiet-session.jsonl") }),
    );

    expect(options).toEqual({ cwd: cwd.path, contextFiles: [{ path: agentsPath, content: "# spec" }] });
  });

  it("injects the cwd's MEMORY.md as a <memory> block with the note ahead of it", async () => {
    const path = write(cwd.path, "MEMORY.md", "# Notes\n\n- releases are cut from main\n");

    const text = await sectionOf();

    expect(text).toBe(`${MEMORY_NOTE}\n\n<memory path="${path}">\n# Notes\n\n- releases are cut from main\n</memory>`);
    expect(scoped(text, [agentDir.path, cwd.path])).toHaveLength(1);
  });

  it("keeps the note outside the <memory> tags, ahead of them", async () => {
    write(cwd.path, "MEMORY.md", "- a note\n");

    const text = await sectionOf();

    // The note is the section's lead-in line, as Pi's "Project-specific instructions and
    // guidelines:" is the lead-in for <project_context>; it is not part of any memory block.
    expect(text.slice(0, text.indexOf("<memory")).trim()).toBe(MEMORY_NOTE);
    expect(blocks(text)[0]?.body).toBe("- a note");
    // The assertion above only means something if the note itself cannot be confused with a tag.
    expect(MEMORY_NOTE).not.toContain("<memory");
    expect(MEMORY_NOTE.trim().split("\n\n")).toHaveLength(1);
    // It is also a cost paid by every session that has a memory file, so it stays about this long;
    // its wording is free to change, its size is not.
    expect(Buffer.byteLength(MEMORY_NOTE, "utf8")).toBeLessThan(1200);
  });

  it("keeps memory out of project context, so it is not in the AGENTS.md tag", async () => {
    const agentsPath = write(cwd.path, "AGENTS.md", "# spec\n");
    write(cwd.path, "MEMORY.md", "- note\n");

    const state = await run([{ path: agentsPath, content: "# spec" }]);

    expect(state.files).toEqual([{ path: agentsPath, content: "# spec" }]);
    expect(state.files.some((file) => file.content.includes("- note"))).toBe(false);
    expect(state.sections[SECTION_NAME]).not.toContain("<project_instructions");
  });

  it("injects the global memory first and the cwd's last", async () => {
    const root = makeTempDir("pi-memory-tree-");
    try {
      const outer = join(root.path, "outer");
      const inner = join(outer, "project");
      write(agentDir.path, "MEMORY.md", "- global memory\n");
      write(outer, "MEMORY.md", "- repo memory\n");
      write(inner, "MEMORY.md", "- checkout memory\n");

      const text = await sectionOf([], inner);

      expect(paths(text, [agentDir.path, outer, inner])).toEqual([
        join(agentDir.path, "MEMORY.md"),
        join(outer, "MEMORY.md"),
        join(inner, "MEMORY.md"),
      ]);
      expect(scoped(text, [outer])[0]?.body).toBe("- repo memory");
      // One lead-in note for the whole section, however many files it holds.
      expect(text.split(MEMORY_NOTE).length).toBe(2);
    } finally {
      root.dispose();
    }
  });

  it("injects an ancestor's MEMORY.md when the cwd has none", async () => {
    const root = makeTempDir("pi-memory-tree-");
    try {
      const inner = join(root.path, "packages", "one");
      write(root.path, "MEMORY.md", "- one note for the whole tree\n");

      const text = await sectionOf([], inner);

      expect(paths(text, [root.path])).toEqual([join(root.path, "MEMORY.md")]);
    } finally {
      root.dispose();
    }
  });

  it("injects a memory file in the agent directory when a session runs there", async () => {
    write(agentDir.path, "MEMORY.md", "- same place\n");

    const text = await sectionOf([], agentDir.path);

    expect(paths(text, [agentDir.path])).toEqual([join(agentDir.path, "MEMORY.md")]);
  });

  it("injects one block when the agent directory is an ancestor of the cwd", async () => {
    write(agentDir.path, "MEMORY.md", "- one file, two scopes\n");

    const text = await sectionOf([], join(agentDir.path, "nested", "checkout"));

    expect(paths(text, [agentDir.path])).toEqual([join(agentDir.path, "MEMORY.md")]);
    expect(only(text, [agentDir.path]).body).toBe("- one file, two scopes");
  });

  it("injects a symlinked MEMORY.md once, as the file it points at", async () => {
    const globalMemory = write(agentDir.path, "MEMORY.md", "- shared file\n");
    symlinkSync(globalMemory, join(cwd.path, "MEMORY.md"));

    const text = await sectionOf();

    expect(paths(text, [agentDir.path, cwd.path])).toEqual([globalMemory]);
  });

  it("skips a MEMORY.md that is empty and one that is not a file", async () => {
    write(cwd.path, "MEMORY.md", "   \n\n\t\n");
    // A directory named MEMORY.md is not a memory file; Pi leaves it alone for the same reason.
    mkdirSync(join(cwd.path, "nested", "MEMORY.md"), { recursive: true });

    const state = await run([], join(cwd.path, "nested"));

    expect(state.sections[SECTION_NAME]).toBeUndefined();
    expect(blocks(state.sections[SECTION_NAME] ?? "")).toEqual([]);
  });

  it("does not inject a MEMORY.md another extension already loaded", async () => {
    write(cwd.path, "MEMORY.md", "- mine\n");

    const state = await run([{ path: join(cwd.path, "MEMORY.md"), content: "- loaded by someone else" }]);

    expect(state.files).toEqual([{ path: join(cwd.path, "MEMORY.md"), content: "- loaded by someone else" }]);
    expect(state.sections[SECTION_NAME]).toBeUndefined();
  });

  it("creates the section when the run was given no sections to work with", async () => {
    // Pi normalizes `sections` into the options, but an extension should not depend on that.
    write(cwd.path, "MEMORY.md", "- note\n");
    const options: PromptOptions = { cwd: cwd.path, contextFiles: [] };

    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: "hello", systemPrompt: "", systemPromptOptions: options },
      ext.makeContext({ sessionId: "no-sections", sessionFile: join(agentDir.path, "sessions", "no-sections.jsonl") }),
    );

    expect(options.sections?.[SECTION_NAME]).toContain("<memory path=");
  });

  it("leaves another section alone and appends memory after AGENTS.md", async () => {
    // Pi rebuilds the prompt options for every run, so the extension only ever writes its own
    // section; a section another extension contributed is passed through untouched.
    const agentsPath = write(cwd.path, "AGENTS.md", "# spec\n");
    write(cwd.path, "MEMORY.md", "- note\n");
    const options: PromptOptions = {
      cwd: cwd.path,
      contextFiles: [{ path: agentsPath, content: "# spec" }],
      sections: { other_extension: "someone else's section" },
    };

    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: "hello", systemPrompt: "", systemPromptOptions: options },
      ext.makeContext({ sessionId: "another-section", sessionFile: join(agentDir.path, "sessions", "another-section.jsonl") }),
    );

    expect(options.sections?.other_extension).toBe("someone else's section");
    expect(options.sections?.[SECTION_NAME]).toContain("<memory path=");
  });

  it("adds a section that Pi does not produce, and Pi still does not read MEMORY.md", async () => {
    // The whole feature rests on Pi leaving MEMORY.md out of the project-context files it loads. If
    // Pi starts loading MEMORY.md itself, this fails on purpose: the extension would need to become a
    // rewrite of that part of Pi, not a section of its own.
    const agentsPath = write(cwd.path, "AGENTS.md", "# spec\n");
    const memoryPath = write(cwd.path, "MEMORY.md", "- note\n");

    const fromPi = loadProjectContextFiles({ cwd: cwd.path, agentDir: agentDir.path });
    const state = await run(fromPi);

    expect(fromPi.map((file) => file.path)).toContain(agentsPath);
    expect(fromPi.map((file) => file.path)).not.toContain(memoryPath);
    expect(state.files.map((file) => file.path)).toEqual(fromPi.map((file) => file.path));
    expect(only(state.sections[SECTION_NAME]!, [cwd.path]).body).toBe("- note");
  });
});

describe("MEMORY.md within one session", () => {
  it("gives every run of a session the same section, so Pi patches nothing after the first", async () => {
    write(cwd.path, "MEMORY.md", "- first version\n");
    const session = "one-session";

    const first = await sectionOf([], cwd.path, session);
    writeFileSync(join(cwd.path, "MEMORY.md"), "- rewritten mid-session\n");
    const second = await sectionOf([], cwd.path, session);

    // Pi only patches the sections that differ, so identical text means no new system message and no
    // upstream prompt-cache break.
    expect(second).toBe(first);
    expect(only(second, [cwd.path]).body).toBe("- first version");
  });

  it("reads MEMORY.md once per session, so an edit mid-session reaches the model later", async () => {
    const path = write(cwd.path, "MEMORY.md", "- first version\n");

    // The same session, two runs.
    expect(only(await sectionOf([], cwd.path, "same"), [cwd.path]).body).toBe("- first version");
    writeFileSync(path, "- second version\n");
    expect(only(await sectionOf([], cwd.path, "same"), [cwd.path]).body).toBe("- first version");

    // A new session reads it again, and reads what the file holds now.
    expect(only(await sectionOf([], cwd.path, "next"), [cwd.path]).body).toBe("- second version");
  });

  it("ignores a MEMORY.md that appears during the session, and one that disappears", async () => {
    expect(await section([], cwd.path, "empty-to-full")).toBeUndefined();
    const path = write(cwd.path, "MEMORY.md", "- written mid-session\n");
    expect(await section([], cwd.path, "empty-to-full")).toBeUndefined();

    expect(only(await sectionOf([], cwd.path, "full-to-empty"), [cwd.path]).body).toBe("- written mid-session");
    writeFileSync(path, "");
    expect(only(await sectionOf([], cwd.path, "full-to-empty"), [cwd.path]).body).toBe("- written mid-session");
    rmSync(path);
    expect(only(await sectionOf([], cwd.path, "full-to-empty"), [cwd.path]).body).toBe("- written mid-session");
  });

  it("keeps each session's own rendering when sessions are swapped", async () => {
    const path = write(cwd.path, "MEMORY.md", "- old session\n");

    const oldSection = await sectionOf([], cwd.path, "old");
    writeFileSync(path, "- new session\n");

    // A session Pi starts for you — /new, /resume, /fork — is a different session, so it reads the
    // file as it stands then. The session already running keeps what it started with.
    expect(only(await sectionOf([], cwd.path, "new"), [cwd.path]).body).toBe("- new session");
    expect(only(await sectionOf([], cwd.path, "old"), [cwd.path]).body).toBe("- old session");
    expect(only(oldSection, [cwd.path]).body).toBe("- old session");
  });

  it("reads MEMORY.md again when a session boundary reopens it, as /reload does", async () => {
    const path = write(cwd.path, "MEMORY.md", "- first version\n");
    const reopened = "reopened";
    const running = "still-running";

    expect(only(await sectionOf([], cwd.path, reopened), [cwd.path]).body).toBe("- first version");
    expect(only(await sectionOf([], cwd.path, running), [cwd.path]).body).toBe("- first version");

    writeFileSync(path, "- second version\n");
    await sessionStart(reopened);

    // Pi re-reads AGENTS.md on /reload, and MEMORY.md behaves the same way: the session that starts
    // now reads the files again, and the one already running keeps what it started with.
    expect(only(await sectionOf([], cwd.path, reopened), [cwd.path]).body).toBe("- second version");
    expect(only(await sectionOf([], cwd.path, running), [cwd.path]).body).toBe("- first version");
  });

  it("replaces a session's memory when the sessions it remembers run out", async () => {
    const path = write(cwd.path, "MEMORY.md", "- old\n");

    const remembered = await sectionOf([], cwd.path, "remembered");
    // Enough unrelated sessions to push the first one out of the snapshots it is kept in.
    for (let i = 0; i < 32; i++) await section([], cwd.path, `filler-${i}`);

    writeFileSync(path, "- new\n");

    expect(only(remembered, [cwd.path]).body).toBe("- old");
    expect(only(await sectionOf([], cwd.path, "remembered"), [cwd.path]).body).toBe("- new");
  });
});
