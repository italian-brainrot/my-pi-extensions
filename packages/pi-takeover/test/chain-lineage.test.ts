/**
 * Two rules the queue and the chain need to hold when more than one session shares an agent dir, plus the
 * one the chain reset in `chain-run.test.ts` makes necessary.
 *
 * `chain.json` and `pending.json` are per agent dir, and Pi gives an extension no way to know how many
 * sessions are pointed at one dir. So both are addressed rather than grabbed: a handoff is applied by the
 * session that queued it, and a session that arrived by takeover counts from where its own transcript
 * says it stands, because another session can reset the file under it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";
const OWNER = join("/tmp", "owner.jsonl");
const INCOMING = join("/tmp", "incoming.jsonl");
const ELSEWHERE = join("/tmp", "elsewhere.jsonl");

let agentDir: TempDir;
let ext: LoadedExtension;

beforeEach(async () => {
  // Every load here reads configuration (the cap) and derives the state dir at module load.
  vi.resetModules();
  agentDir = makeTempDir("takeover-lineage-");
  ext = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: agentDir.path });
});

afterEach(() => {
  ext?.dispose();
  agentDir?.dispose();
});

function state(name: string): string {
  return join(agentDir.path, "takeover", name);
}

function pending(): any {
  return JSON.parse(readFileSync(state("pending.json"), "utf8"));
}

function chain(): any {
  return JSON.parse(readFileSync(state("chain.json"), "utf8"));
}

function seedChain(chain: { id: string; count: number }): void {
  mkdirSync(join(agentDir.path, "takeover"), { recursive: true });
  writeFileSync(state("chain.json"), JSON.stringify({ ...chain, updatedAt: new Date().toISOString() }));
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("\n");
}

/** Overrides for a session whose branch says it is the fifth handoff of `chain-1`. */
function lineageContext(file = INCOMING, position = 5, chainId = "chain-1"): Record<string, unknown> {
  return {
    sessionFile: file,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {}, confirm: async () => true },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => "incoming",
      getSessionName: () => undefined,
      appendCustomEntry: () => {},
      appendSessionInfo: () => {},
      getBranch: () => [
        {
          type: "custom",
          id: "e1",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "takeover",
          data: { handoffId: "h", chainId, position, maxChain: 12, prompt: HANDOFF },
        },
      ],
    },
    newSession: async () => ({ cancelled: false }),
  };
}

describe("the chain a session counts from", () => {
  it("counts the next handoff from where the session stands when the file was reset under it", async () => {
    // Another session sharing this agent dir typed a message, which reset the counter. This session
    // arrived at #5, and the handoff it queues is still the sixth of its chain — otherwise the cap could
    // be walked straight through by whoever last touched the file.
    seedChain({ id: "a-foreign-run", count: 0 });

    const result = await ext.callTool("takeover", { prompt: HANDOFF }, { context: lineageContext() });

    expect(text(result)).toContain("takeover 6/12");
  });

  it("keeps counting in the chain the session arrived in", async () => {
    seedChain({ id: "a-foreign-run", count: 5 });

    await ext.callTool("takeover", { prompt: HANDOFF }, { context: lineageContext() });
    await ext.runCommand("takeover-apply", "", lineageContext());

    // The id of the chain comes from the session's lineage, not from whoever last wrote the file.
    expect(chain().id).toBe("chain-1");
    expect(chain().count).toBe(6);
  });

  it("starts a new chain when the user invokes the takeover themselves", async () => {
    // The human took the wheel, so the count starts over — whatever the session's own lineage says.
    seedChain({ id: "chain-1", count: 5 });

    await ext.runCommand("takeover", "Fresh instructions.", lineageContext());

    expect(chain().id).not.toBe("chain-1");
    expect(chain().count).toBe(1);
  });
});

describe("the queue with two sessions in one agent dir", () => {
  it("keeps the prompt of a handoff another session queued over", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    // A different session queues its own: the queue holds one handoff, and the one being pushed out
    // belongs to a session that was never asked about it.
    await ext.callTool("takeover", { prompt: "Someone else's turn." }, { context: { sessionFile: ELSEWHERE } });

    expect(pending().prompt).toBe("Someone else's turn.");

    const kept = readdirSync(join(agentDir.path, "takeover")).filter((name) => name.startsWith("discarded-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(agentDir.path, "takeover", kept[0]!), "utf8")).toContain(HANDOFF);
    expect(existsSync(state("pending.json"))).toBe(true);
  });
});
