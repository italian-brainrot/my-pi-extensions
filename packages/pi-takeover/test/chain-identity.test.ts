/**
 * Which conversation a chain belongs to.
 *
 * `chain.json` is one counter for the whole agent dir, and pass 2 gave it a rule for starting over: at
 * `session_start` with reason `startup` or `new`, when the incoming session has no takeover lineage. The
 * reason is the problem, not the lineage. A session that arrives by `resume` — `/resume` in the terminal,
 * `switch_session` over rpc, which is how this extension is driven unattended — never starts a fresh chain,
 * whatever it is. For the session the chain belongs to that is right: resuming it must not hand the loop a
 * clean cap. For a *different* conversation it is wrong in the same way F4 was: the tool refuses it for
 * takeovers it never made, and the README says "a session that did not arrive by takeover starts a new one".
 *
 * The first two tests below are a pair, and a fix has to keep both. The first is the over-refusal. The second is
 * the reason the second half of the rule cannot just be "reset whenever there is no lineage": a session can
 * lose its takeover entry — a branch trimmed by `/tree` or a fork — and then its own chain is exactly what
 * must survive, or the cap can be walked through by trimming the branch and coming back.
 *
 * What answers both: `chain.json` names the conversation it belongs to. That field is written at every apply
 * and re-written by the session a handoff landed in (a takeover's own replacement reaches `session_start`
 * already holding the entry, before its file could be named as the owner), and a session that is not the one
 * named starts a chain of its own whatever event brought it. The tests after the pair pin that rule from the
 * inside: the field itself, the hop that hands the chain over, and each reason a session can arrive for.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";
const CAP = 1;

const OUTGOING = join("/tmp", "outgoing.jsonl");
/** The session the first takeover created: the chain is standing in this one. */
const INCOMING = join("/tmp", "incoming.jsonl");
/** A session with its own transcript, unrelated to the chain above. */
const UNRELATED = join("/tmp", "unrelated.jsonl");

let agentDir: TempDir;
let ext: LoadedExtension;

beforeEach(async () => {
  vi.resetModules();
  agentDir = makeTempDir("takeover-identity-");
  ext = await loadExtension({
    packageDir: packageDir("pi-takeover"),
    agentDir: agentDir.path,
    env: { PI_TAKEOVER_MAX_CHAIN: String(CAP) },
  });
});

afterEach(() => {
  ext?.dispose();
  agentDir?.dispose();
});

function state(name: string): string {
  return join(agentDir.path, "takeover", name);
}

function chain(): any {
  return JSON.parse(readFileSync(state("chain.json"), "utf8"));
}

/** Overrides for a context over `file`, with `branch` as its transcript. */
function context(file: string, branch: unknown[] = []): Record<string, unknown> {
  const sessionManager = {
    getSessionFile: () => file,
    getSessionId: () => file,
    getSessionName: () => undefined,
    appendCustomEntry: () => {},
    appendSessionInfo: () => {},
    getBranch: () => branch,
  };

  return {
    sessionFile: file,
    sessionManager,
    newSession: async () => ({ cancelled: false }),
  };
}

/**
 * Walk the chain to its cap: `OUTGOING` hands off, which writes the counter and creates `INCOMING`. One
 * takeover is the whole cap here, so the chain is spent the moment it has run.
 */
async function walkTheChain(): Promise<void> {
  await ext!.callTool("takeover", { prompt: HANDOFF }, { context: context(OUTGOING) });
  await ext!.runCommand("takeover-apply", "", {
    ...context(OUTGOING),
    newSession: async (options: any) => {
      const manager = {
        getSessionFile: () => INCOMING,
        getSessionId: () => "incoming",
        getSessionName: () => undefined,
        appendCustomEntry: () => {},
        appendSessionInfo: () => {},
      };
      await options.setup?.(manager);
      await options.withSession?.({
        mode: "tui",
        hasUI: true,
        ui: { notify: () => {} },
        sessionManager: manager,
        sendUserMessage: () => {},
      });
      return { cancelled: false };
    },
  });
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("\n");
}

describe("the conversation a chain belongs to", () => {
  it("starts a fresh chain for a conversation that arrives by resume", async () => {
    await walkTheChain();
    expect(chain().count).toBe(CAP);

    // The driver moves to a different session — its own transcript, no takeover entry anywhere in it.
    await ext!.emit({ type: "session_start", reason: "resume", previousSessionFile: OUTGOING }, ext!.makeContext(context(UNRELATED)));

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: context(UNRELATED) });

    expect(text(result), "a session that did not arrive by takeover is refused for another chain").not.toContain("refused");
    expect(text(result)).toContain(`takeover 1/${CAP}`);
  });

  it("keeps the chain of the session it is standing in when that session's branch lost the entry", async () => {
    await walkTheChain();
    expect(chain().count).toBe(CAP);

    // The session the chain is standing in, come back to by resume, with a branch trimmed to before the
    // takeover entry (`/tree` navigation, or a fork taken at an earlier point). It no longer looks like part
    // of any chain, and that is exactly when the counter must not be zeroed: otherwise trimming the branch
    // and returning buys a fresh cap, as many times as you like.
    const trimmed = [
      { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [] } },
    ];
    await ext!.emit(
      { type: "session_start", reason: "resume", previousSessionFile: OUTGOING },
      ext!.makeContext(context(INCOMING, trimmed)),
    );

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: context(INCOMING, trimmed) });

    expect(result.isError, "a trimmed branch reset the chain this session is standing in").toBe(true);
    expect(text(result)).toContain(`cap is ${CAP}`);
  });

  it.each(["resume", "reload", "fork"] as const)("keeps the chain across a %s of the session the chain is standing in", async (reason) => {
    // The rule cannot care which event brought a session back, only whether it is the one the chain is
    // standing in — otherwise every reason that is not `startup` or `new` is a hole a spent chain falls
    // through, and every reason that is one is a way to zero someone else's count.
    await walkTheChain();
    expect(chain().count).toBe(CAP);

    await ext!.emit({ type: "session_start", reason }, ext!.makeContext(context(INCOMING)));

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: context(INCOMING) });
    expect(result.isError, `a ${reason} of the owning session started a fresh chain`).toBe(true);
    expect(text(result)).toContain(`cap is ${CAP}`);
  });

  it("names the conversation the chain belongs to", async () => {
    // What makes the two rules above answerable at all: the counter has to say who it is standing in. A
    // test that cannot see that field cannot tell "the count survived" from "the count was reset and this
    // session's own lineage happened to cover for it".
    await walkTheChain();

    expect(chain().owner).toBe(`file:${INCOMING}`);
    expect(chain().count).toBe(CAP);
  });

  it("hands the chain to the session a takeover created, before that session ever asks", async () => {
    // A real hop, not a walk: the replacement reaches `session_start` with the entry the outgoing session
    // wrote, and the file still names the outgoing session as its owner. If that is read as "someone
    // else's chain", every hop of a chain starts a fresh cap and the brake is gone.
    await walkTheChain();
    const handed = chain();
    expect(handed.owner).toBe(`file:${INCOMING}`);

    const arrived = ext!.makeContext(context(INCOMING, [takeoverEntry(handed)]));
    await ext!.emit({ type: "session_start", reason: "new", previousSessionFile: OUTGOING }, arrived);

    expect(chain().owner, "the incoming session was treated as a stranger to its own chain").toBe(`file:${INCOMING}`);
    expect(chain().count, "the incoming session's chain was reset under it").toBe(CAP);

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: context(INCOMING, [takeoverEntry(handed)]) });
    expect(result.isError, "a session that arrived at the cap was handed a fresh chain").toBe(true);
    expect(text(result)).toContain(`cap is ${CAP}`);
  });
});

/** The lineage entry a takeover writes into the session it creates. */
function takeoverEntry(chain: { id: string; count: number }): Record<string, unknown> {
  return {
    type: "custom",
    id: "t1",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "takeover",
    data: { handoffId: "h", chainId: chain.id, position: chain.count, maxChain: CAP, prompt: HANDOFF },
  };
}
