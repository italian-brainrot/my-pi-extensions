/**
 * The queue: what the `takeover` tool accepts, what it writes, and when it hands the session to the
 * apply step. The session replacement itself is in handoff.test.ts, and a real pair of sessions is in
 * session.test.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-takeover") });
});

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

    // Same agent dir, new module instance: the queue has to come off disk.
    const reloaded = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: ext.agentDir });
    await reloaded.emit({ type: "agent_settled", aborted: false });

    expect(reloaded.sent.map((message) => message.content)).toEqual(["/takeover-apply"]);
    reloaded.dispose();
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

  function sessionWithLineage(data: unknown = lineage) {
    return ext.makeContext({
      sessionFile: "/tmp/incoming.jsonl",
      sessionManager: {
        getSessionFile: () => "/tmp/incoming.jsonl",
        getSessionId: () => "incoming",
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
    expect(section).toContain("takeover #3 of 12");
    expect(section).toContain("/tmp/previous.jsonl");
    expect(section).toContain("9 takeovers left");
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

  it("adds nothing to a session that did not arrive by handoff", async () => {
    const options = { sections: { other: "kept" } as Record<string, string> };
    await ext.emit({ type: "before_agent_start", messageType: "user", prompt: "hello", systemPrompt: "", systemPromptOptions: options });

    expect(options.sections).toEqual({ other: "kept" });
  });
});
