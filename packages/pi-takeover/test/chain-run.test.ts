/**
 * What a chain is.
 *
 * The cap exists to stop an unattended implement/review loop pinging forever, so the thing that matters
 * is what counts as one chain. Right now `chain.json` is a counter in the agent dir that nothing ever
 * starts over: the only resets are an interactive message and a user-invoked `/takeover <prompt>`. A run
 * driven over rpc — which is what `test/session.test.ts` and every scripted/headless driver does — never
 * produces either, so a chain left behind by one process is the chain the next one continues, and a loop
 * that spent its cap yesterday is refused before its first handoff today.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";
const MAX = 3;

let agentDir: TempDir;
let ext: LoadedExtension | undefined;

beforeEach(async () => {
  vi.resetModules();
  agentDir = makeTempDir("takeover-chain-");
  ext = await loadExtension({
    packageDir: packageDir("pi-takeover"),
    agentDir: agentDir.path,
    env: { PI_TAKEOVER_MAX_CHAIN: String(MAX) },
  });
});

afterEach(() => {
  ext?.dispose();
  agentDir.dispose();
});

function chainPath(): string {
  return join(agentDir.path, "takeover", "chain.json");
}

function seedChain(chain: { id: string; count: number }): void {
  mkdirSync(join(agentDir.path, "takeover"), { recursive: true });
  writeFileSync(chainPath(), JSON.stringify({ ...chain, updatedAt: new Date().toISOString() }));
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("\n");
}

/** A session whose own branch carries a takeover entry, i.e. one that arrived by handoff. */
function takeoverSession(position: number, chainId: string, file = "/tmp/incoming.jsonl") {
  return ext!.makeContext({
    sessionFile: file,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => "incoming",
      getBranch: () => [
        {
          type: "custom",
          id: "e1",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "takeover",
          data: { handoffId: "h", chainId, position, maxChain: MAX, prompt: HANDOFF },
        },
      ],
    },
  });
}

describe("a chain and the run it belongs to", () => {
  it("starts a fresh chain for a session that did not arrive by takeover", async () => {
    // What an earlier process left in the agent dir: the same chain id, the cap already used up.
    seedChain({ id: "an-earlier-run", count: MAX });

    const fresh = ext!.makeContext({ sessionFile: join("/tmp", "fresh.jsonl") });
    await ext!.emit({ type: "session_start", reason: "startup" }, fresh);

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: join("/tmp", "fresh.jsonl") } });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(`takeover 1/${MAX}`);
  });

  it("starts a fresh chain for a session the user made with /new", async () => {
    seedChain({ id: "an-earlier-run", count: MAX });

    const fresh = ext!.makeContext({ sessionFile: join("/tmp", "fresh.jsonl") });
    await ext!.emit({ type: "session_start", reason: "new" }, fresh);

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: join("/tmp", "fresh.jsonl") } });

    expect(result.isError).toBeFalsy();
  });

  it("continues the chain of a session that arrived by takeover", async () => {
    // The other half of the rule: the handoff that made this session already moved the counter, and this
    // session must carry on from there rather than starting over at 1.
    seedChain({ id: "chain-1", count: 2 });

    await ext!.emit({ type: "session_start", reason: "new" }, takeoverSession(2, "chain-1"));

    const result = await ext!.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: "/tmp/incoming.jsonl" } });
    expect(text(result)).toContain(`takeover 3/${MAX}`);
    expect(readFileSync(chainPath(), "utf8")).toContain("chain-1");
  });
});
