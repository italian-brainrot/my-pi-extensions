/**
 * The queue: what the `takeover` tool accepts, what it writes, and when it hands the session to the
 * apply step. The session replacement itself is in handoff.test.ts, and a real pair of sessions is in
 * session.test.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-takeover") });
});

// The load made an agent dir and a working dir; nothing else removes them.
afterAll(() => ext?.dispose());

afterEach(async () => {
  // Every test starts clean: the extension's own cancel clears what it holds in memory as well as on
  // disk, and then the state folder goes.
  await ext.runCommand("takeover-cancel");
  rmSync(join(ext.agentDir, "takeover"), { recursive: true, force: true });
  ext.sent.length = 0;
});

function state(name: string): string {
  return join(ext.agentDir, "takeover", name);
}

function writeState(name: string, value: unknown): void {
  mkdirSync(join(ext.agentDir, "takeover"), { recursive: true });
  writeFileSync(state(name), JSON.stringify(value));
}

function pending(): any {
  return JSON.parse(readFileSync(state("pending.json"), "utf8"));
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("\n");
}

function chainUsed(count: number): void {
  writeState("chain.json", { id: "chain-1", count, updatedAt: new Date().toISOString() });
}

describe("the takeover tool", () => {
  it("queues a handoff instead of replacing the session", async () => {
    const result = await ext.callTool("takeover", { prompt: HANDOFF });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Takeover queued");
    expect(text(result)).toContain("when this turn ends");

    const queued = pending();
    expect(queued.prompt).toBe(HANDOFF);
    expect(queued.sessionKey).toBe(`file:${ext.makeContext().sessionManager.getSessionFile()}`);
  });

  it("refuses a prompt the next agent cannot act on", async () => {
    const result = await ext.callTool("takeover", { prompt: "   " });

    expect(result.isError).toBe(true);
    expect(existsSync(state("pending.json"))).toBe(false);
  });

  it("keeps only the last handoff queued in a turn", async () => {
    await ext.callTool("takeover", { prompt: "first handoff" });
    const second = await ext.callTool("takeover", { prompt: "second handoff" });

    expect(text(second)).toContain("replaces the handoff");
    expect(pending().prompt).toBe("second handoff");
  });

  it("counts takeovers against the chain", async () => {
    chainUsed(2);
    const result = await ext.callTool("takeover", { prompt: HANDOFF });

    expect(text(result)).toContain("takeover 3/12");
  });

  it("refuses to continue a chain that reached its cap", async () => {
    chainUsed(12);
    const result = await ext.callTool("takeover", { prompt: HANDOFF });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("cap is 12");
    expect(text(result)).toContain("tell the user");
    expect(existsSync(state("pending.json"))).toBe(false);
  });
});

describe("the settle boundary", () => {
  it("sends the handoff to the apply command once the run settles", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF });
    await ext.emit({ type: "agent_settled", aborted: false });

    expect(ext.sent).toHaveLength(1);
    expect(ext.sent[0]!.content).toBe("/takeover-apply");
    expect(ext.sent[0]!.options).toEqual({ expandPromptTemplates: true });
  });

  it("does nothing when no handoff is queued", async () => {
    await ext.emit({ type: "agent_settled", aborted: false });
    expect(ext.sent).toEqual([]);
  });

  it("leaves another session's handoff alone", async () => {
    const elsewhere = ext.makeContext({ sessionFile: join(ext.agentDir, "sessions", "elsewhere.jsonl") });
    await ext.callTool("takeover", { prompt: HANDOFF });

    await ext.emit({ type: "agent_settled", aborted: false }, elsewhere);
    expect(ext.sent).toEqual([]);
  });

  it("drops a handoff when the run was interrupted, and keeps the prompt", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF });
    await ext.emit({ type: "agent_settled", aborted: true });

    expect(ext.sent).toEqual([]);
    expect(existsSync(state("pending.json"))).toBe(false);

    const discarded = readdirSync(join(ext.agentDir, "takeover")).filter((name) => name.startsWith("discarded-"));
    expect(discarded).toHaveLength(1);
    expect(readFileSync(join(ext.agentDir, "takeover", discarded[0]!), "utf8")).toContain(HANDOFF);
  });

  it("finds the queued handoff again after a reload replaces the module", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF });

    // Same agent dir, new module instance: the queue has to come off disk. The `resetModules` is what
    // makes that true — without it Vitest hands back the module the first load already has, and the
    // test only proves that an in-memory variable survived.
    vi.resetModules();
    const reloaded = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: ext.agentDir });
    await reloaded.emit({ type: "agent_settled", aborted: false });

    expect(reloaded.sent.map((message) => message.content)).toEqual(["/takeover-apply"]);
    reloaded.dispose();
  });

  it("forgets a handoff that is no longer on disk", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF });
    rmSync(state("pending.json"));

    vi.resetModules();
    const reloaded = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: ext.agentDir });
    await reloaded.emit({ type: "agent_settled", aborted: false });

    expect(reloaded.sent).toEqual([]);
    reloaded.dispose();
  });

  it("says so when a queued handoff expired instead of being applied", async () => {
    // `peekHandoff` drops a handoff older than an hour. The agent was told the takeover would happen at
    // the end of its turn, so the drop has to be said out loud rather than only to the debug log.
    const sessionKey = `file:${ext.makeContext().sessionManager.getSessionFile()}`;
    writeState("pending.json", {
      id: "h-expired",
      prompt: HANDOFF,
      queuedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      sessionKey,
    });

    const notices: string[] = [];
    const ctx = ext.makeContext({ hasUI: true, ui: { notify: (message: string) => void notices.push(message) } });
    await ext.emit({ type: "agent_settled", aborted: false }, ctx);

    expect(ext.sent).toEqual([]);
    expect(notices.join(" ")).toMatch(/takeover/i);
  });
});

describe("the state folder", () => {
  it("does not let dropped prompts fill the agent dir", async () => {
    // Every dropped handoff writes `discarded-<id>.md` and nothing ever removes one, so an unattended
    // loop grows the folder without limit. Old copies are the ones to lose.
    mkdirSync(join(ext.agentDir, "takeover"), { recursive: true });
    const old = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 40; i++) {
      const path = join(ext.agentDir, "takeover", `discarded-old-${i}.md`);
      writeFileSync(path, "an older prompt\n", "utf8");
      utimesSync(path, old / 1000, old / 1000);
    }

    await ext.callTool("takeover", { prompt: HANDOFF });
    await ext.emit({ type: "session_shutdown", reason: "quit" });

    const kept = readdirSync(join(ext.agentDir, "takeover")).filter((name) => name.startsWith("discarded-"));
    expect(kept.length).toBeLessThanOrEqual(30);
    expect(kept.some((name) => readFileSync(join(ext.agentDir, "takeover", name), "utf8").includes(HANDOFF))).toBe(true);
  });
});

describe("the user", () => {
  it("cancels a queued handoff by sending a message", async () => {
    chainUsed(3);
    await ext.callTool("takeover", { prompt: HANDOFF });

    await ext.emit({ type: "input", text: "wait, do this instead", source: "interactive" });

    expect(existsSync(state("pending.json"))).toBe(false);
    expect(existsSync(state("chain.json"))).toBe(false);
  });

  it("does not cancel its own messages", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF });
    await ext.emit({ type: "input", text: HANDOFF, source: "extension" });

    expect(pending().prompt).toBe(HANDOFF);
  });

  it("drops a handoff when the session quits, but keeps it across a reload", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF });
    await ext.emit({ type: "session_shutdown", reason: "reload" });
    expect(existsSync(state("pending.json"))).toBe(true);

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    expect(existsSync(state("pending.json"))).toBe(false);
  });
});

describe("what the incoming session is told", () => {
  const lineage = {
    handoffId: "h-1",
    chainId: "chain-1",
    position: 3,
    maxChain: 12,
    fromSession: "/tmp/previous.jsonl",
    prompt: HANDOFF,
  };

  // One session file per lineage, and one counter to mint them. `sectionBySession` is keyed by session and
  // this file loads the extension once, so every lineage built over the same session file after the first is
  // never rendered: the cache answers with the first test's section and the assertions below end up about
  // text this test did not cause. (Pass 3 found the no-cap test passing that way.)
  let lineageSessions = 0;

  function sessionWithLineage(data: unknown = lineage) {
    const file = `/tmp/incoming-${++lineageSessions}.jsonl`;
    return ext.makeContext({
      sessionFile: file,
      sessionManager: {
        getSessionFile: () => file,
        getSessionId: () => file,
        getBranch: () => [{ type: "custom", id: "e1", parentId: null, timestamp: new Date().toISOString(), customType: "takeover", data }],
      },
    });
  }

  it("adds a takeover section to a session that arrived by handoff", async () => {
    const options = { sections: {} as Record<string, string> };
    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: HANDOFF, systemPrompt: "", systemPromptOptions: options },
      sessionWithLineage(),
    );

    const section = options.sections.takeover;
    expect(section).toContain("/tmp/previous.jsonl");
  });

  it("renders the same section on every run of that session", async () => {
    const ctx = sessionWithLineage();
    const first = { sections: {} as Record<string, string> };
    const second = { sections: {} as Record<string, string> };

    await ext.emit({ type: "before_agent_start", messageType: "user", prompt: HANDOFF, systemPrompt: "", systemPromptOptions: first }, ctx);
    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: "next run", systemPrompt: "", systemPromptOptions: second },
      ctx,
    );

    expect(second.sections.takeover).toBe(first.sections.takeover);
  });

  it("tells the incoming session where the chain stands", async () => {
    // The README promises the section says "its position in the chain, how many takeovers are left
    // before the cap". This is the only place an agent in an unattended loop can learn it is near the
    // cap before it calls the tool and is refused.
    const options = { sections: {} as Record<string, string> };
    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: HANDOFF, systemPrompt: "", systemPromptOptions: options },
      sessionWithLineage({ ...lineage, position: 3, maxChain: 12 }),
    );

    const section = options.sections.takeover;
    expect(section).toMatch(/\b3\b/);
    expect(section).toMatch(/\b12\b/);
  });

  it("does not mention a cap there when the chain has none", async () => {
    const options = { sections: {} as Record<string, string> };
    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: HANDOFF, systemPrompt: "", systemPromptOptions: options },
      sessionWithLineage({ ...lineage, position: 3, maxChain: 0 }),
    );

    const section = options.sections.takeover!;
    expect(section).toMatch(/\b3\b/);
    // The wording, not just the absence of a digit: "0 more will start" satisfies the line above and is the
    // thing this setting is meant to avoid.
    expect(section.toLowerCase()).toContain("no cap");
  });

  it("says at the cap that no further takeover will start", async () => {
    // Added in pass 3: the section is how an agent in an unattended loop learns the brake is down. The
    // last session of a chain is the one that has to be told to wind down rather than hand off.
    const options = { sections: {} as Record<string, string> };
    await ext.emit(
      { type: "before_agent_start", messageType: "user", prompt: HANDOFF, systemPrompt: "", systemPromptOptions: options },
      sessionWithLineage({ ...lineage, position: 12, maxChain: 12 }),
    );

    const section = options.sections.takeover!;
    expect(section).toMatch(/\b12\b/);
    expect(section.toLowerCase()).toMatch(/no further|no more|reached|finish/);
    // "0 more will start" would be the other way to say it, and is not what this branch does.
    expect(section).not.toMatch(/0 more/);
  });

  it("adds nothing to a session that did not arrive by handoff", async () => {
    const options = { sections: { other: "kept" } as Record<string, string> };
    await ext.emit({ type: "before_agent_start", messageType: "user", prompt: "hello", systemPrompt: "", systemPromptOptions: options });

    expect(options.sections).toEqual({ other: "kept" });
  });
});
