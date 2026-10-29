/**
 * The apply step: a queued handoff replacing one session with another.
 *
 * Pi's `newSession()` is faked here — the point is what pi-takeover asks Pi to do and what it writes
 * while asking. `session.test.ts` runs the same flow against a real Pi process.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";
const OUTGOING = join("/tmp", "outgoing.jsonl");
const INCOMING = join("/tmp", "incoming.jsonl");

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-takeover") });
});

afterEach(async () => {
  await ext.runCommand("takeover-cancel");
  const { rmSync } = await import("node:fs");
  rmSync(join(ext.agentDir, "takeover"), { recursive: true, force: true });
  ext.sent.length = 0;
});

/** What a faked `newSession()` recorded. */
interface Replacement {
  parentSession?: string;
  entries: Array<{ type: string; data: any }>;
  name?: string;
  sent: string[];
  calls: number;
}

function fakedNewSession(replacement: Replacement, options: { file?: string; throws?: Error; throwsInside?: Error } = {}) {
  return async (newSessionOptions: any): Promise<{ cancelled: boolean }> => {
    replacement.calls += 1;
    replacement.parentSession = newSessionOptions.parentSession;

    const sessionManager = {
      getSessionFile: () => {
        // The apply step reads the incoming session first, so throwing here breaks it after it has
        // taken hold of the replacement context and before it has sent anything.
        if (options.throwsInside) throw options.throwsInside;
        return options.file ?? INCOMING;
      },
      getSessionId: () => "incoming",
      getSessionName: () => replacement.name,
      appendCustomEntry: (type: string, data: unknown) => {
        replacement.entries.push({ type, data });
      },
      appendSessionInfo: (name: string) => {
        replacement.name = name;
      },
    };

    if (options.throws) throw options.throws;

    await newSessionOptions.setup?.(sessionManager);
    await newSessionOptions.withSession?.({
      mode: "tui",
      hasUI: true,
      ui: { notify: () => {} },
      sessionManager,
      sendUserMessage: async (content: string) => {
        replacement.sent.push(String(content));
      },
    });

    return { cancelled: false };
  };
}

/**
 * Context overrides for the session being taken over, as `runCommand` builds them. `ctxSent` is how a
 * test sees the message the extension sends back into the session it is standing in.
 */
function outgoingContext(replacement: Replacement, options: { throws?: Error; throwsInside?: Error; cancelled?: boolean } = {}) {
  const ctxSent: string[] = [];
  const overrides: Record<string, unknown> = {
    sessionFile: OUTGOING,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {}, confirm: async () => true },
    sendUserMessage: async (content: string) => {
      ctxSent.push(String(content));
    },
    newSession: options.cancelled
      ? async () => ({ cancelled: true })
      : fakedNewSession(replacement, { throws: options.throws, throwsInside: options.throwsInside }),
  };

  return { overrides, ctxSent };
}

/** Queue a handoff from the session the apply command will be run in. */
async function queue(prompt: string = HANDOFF): Promise<void> {
  await ext.callTool("takeover", { prompt }, { context: { sessionFile: OUTGOING } });
}

function chain(): any {
  return JSON.parse(readFileSync(join(ext.agentDir, "takeover", "chain.json"), "utf8"));
}

describe("applying a handoff", () => {
  it("starts a new session whose first message is the handoff", async () => {
    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    await queue();

    const { overrides } = outgoingContext(replacement);
    await ext.runCommand("takeover-apply", "", overrides);

    expect(replacement.calls).toBe(1);
    expect(replacement.sent).toEqual([HANDOFF]);
  });

  it("links the new session to the one it replaced and records the handoff in it", async () => {
    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    await queue();

    const { overrides } = outgoingContext(replacement);
    await ext.runCommand("takeover-apply", "", overrides);

    expect(replacement.parentSession).toBe(OUTGOING);
    expect(replacement.entries).toHaveLength(1);
    expect(replacement.entries[0]!.type).toBe("takeover");
    expect(replacement.entries[0]!.data).toMatchObject({
      position: 1,
      maxChain: 12,
      fromSession: OUTGOING,
      prompt: HANDOFF,
    });
    expect(replacement.name).toContain("takeover #1");
  });

  it("advances the chain and clears the queue", async () => {
    await queue();
    const first: Replacement = { entries: [], sent: [], calls: 0 };
    await ext.runCommand("takeover-apply", "", outgoingContext(first).overrides);

    expect(chain().count).toBe(1);
    expect(existsSync(join(ext.agentDir, "takeover", "pending.json"))).toBe(false);

    await queue("Second handoff");
    const second: Replacement = { entries: [], sent: [], calls: 0 };
    await ext.runCommand("takeover-apply", "", outgoingContext(second).overrides);

    expect(chain().count).toBe(2);
    expect(chain().id).toBe(chain().id);
    expect(second.entries[0]!.data.position).toBe(2);
  });

  it("stops at a cap reached after the handoff was queued, and tells the agent once", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(ext.agentDir, "takeover"), { recursive: true });

    // The last handoff the cap allows, queued while there is room; the chain moves under it before the
    // turn ends, which is why the cap is checked again at apply time.
    writeFileSync(
      join(ext.agentDir, "takeover", "chain.json"),
      JSON.stringify({ id: "chain-1", count: 11, updatedAt: new Date().toISOString() }),
    );
    await queue();
    writeFileSync(
      join(ext.agentDir, "takeover", "chain.json"),
      JSON.stringify({ id: "chain-1", count: 12, updatedAt: new Date().toISOString() }),
    );

    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    const first = outgoingContext(replacement);
    await ext.runCommand("takeover-apply", "", first.overrides);

    expect(replacement.calls).toBe(0);
    expect(replacement.sent).toEqual([]);
    expect(existsSync(join(ext.agentDir, "takeover", "pending.json"))).toBe(false);
    expect(readdirSync(join(ext.agentDir, "takeover")).some((name) => name.startsWith("discarded-"))).toBe(true);

    const announced = ext.sent.filter((message) => String(message.content).includes("cap of 12"));
    expect(announced).toHaveLength(1);

    // Asking again must not produce a second round of the same instruction.
    await queue();
    await ext.runCommand("takeover-apply", "", outgoingContext(replacement).overrides);
    expect(ext.sent.filter((message) => String(message.content).includes("cap of 12"))).toHaveLength(1);
  });

  it("leaves the queue alone when another extension cancels the switch", async () => {
    await queue();
    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    const { overrides } = outgoingContext(replacement, { cancelled: true });

    await ext.runCommand("takeover-apply", "", overrides);

    expect(JSON.parse(readFileSync(join(ext.agentDir, "takeover", "pending.json"), "utf8")).prompt).toBe(HANDOFF);
    expect(chain().count).toBe(1);
  });

  it("runs the handoff in place when the replacement fails", async () => {
    await queue();
    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    const { overrides, ctxSent } = outgoingContext(replacement, { throws: new Error("disk on fire") });

    await ext.runCommand("takeover-apply", "", overrides);

    // No session was replaced, so the prompt goes to this one through the extension's own API.
    expect(ctxSent).toEqual([]);
    expect(ext.sent.map((message) => message.content)).toEqual([HANDOFF]);
  });

  it("uses the new session when the replacement itself breaks partway", async () => {
    await queue();
    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    const { overrides } = outgoingContext(replacement, { throwsInside: new Error("the first message failed") });

    await ext.runCommand("takeover-apply", "", overrides);

    // The old session is gone by then: only the replacement can be spoken to.
    expect(ext.sent).toEqual([]);
    expect(replacement.sent).toEqual([HANDOFF]);
  });

  it("a takeover asked for by the user starts a new chain and runs immediately", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(ext.agentDir, "takeover"), { recursive: true });
    writeFileSync(
      join(ext.agentDir, "takeover", "chain.json"),
      JSON.stringify({ id: "old-chain", count: 5, updatedAt: new Date().toISOString() }),
    );

    const replacement: Replacement = { entries: [], sent: [], calls: 0 };
    const { overrides } = outgoingContext(replacement);
    await ext.runCommand("takeover", HANDOFF, overrides);

    expect(replacement.calls).toBe(1);
    expect(replacement.sent).toEqual([HANDOFF]);
    expect(chain().count).toBe(1);
    expect(chain().id).not.toBe("old-chain");
  });

  it("says what is queued when asked, and queues nothing", async () => {
    const notices: string[] = [];
    const { overrides } = outgoingContext({ entries: [], sent: [], calls: 0 });
    overrides.ui = { notify: (message: string) => notices.push(message) };

    await ext.runCommand("takeover", "", overrides);

    expect(notices.join(" ")).toContain("No handoff is queued");
    expect(notices.join(" ")).toContain("No takeover chain in progress");
    expect(existsSync(join(ext.agentDir, "takeover", "pending.json"))).toBe(false);
  });
});
