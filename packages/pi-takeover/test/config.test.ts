/**
 * The configuration variables, each of which is read once when the module loads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";
const OUTGOING = join("/tmp", "outgoing.jsonl");

let ext: LoadedExtension | undefined;

beforeEach(() => {
  // A fresh module per test: these settings are read when the module is evaluated.
  vi.resetModules();
});

afterEach(async () => {
  if (ext) {
    await ext.runCommand("takeover-cancel");
    ext.dispose();
    ext = undefined;
  }
});

function statePath(agentDir: string, name: string): string {
  return join(agentDir, "takeover", name);
}

function seedChain(ext: LoadedExtension, count: number): void {
  mkdirSync(join(ext.agentDir, "takeover"), { recursive: true });
  writeFileSync(statePath(ext.agentDir, "chain.json"), JSON.stringify({ id: "chain-1", count, updatedAt: new Date().toISOString() }));
}

function replacementRecord(options: { confirm?: boolean } = {}) {
  const record = {
    entries: [] as Array<{ type: string; data: any }>,
    sent: [] as string[],
    name: undefined as string | undefined,
    calls: 0,
  };

  const overrides = {
    sessionFile: OUTGOING,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {}, confirm: async () => options.confirm ?? true },
    newSession: async (newSessionOptions: any) => {
      record.calls += 1;
      const sessionManager = {
        getSessionFile: () => join("/tmp", "incoming.jsonl"),
        getSessionId: () => "incoming",
        getSessionName: () => record.name,
        appendCustomEntry: (type: string, data: unknown) => record.entries.push({ type, data }),
        appendSessionInfo: (name: string) => {
          record.name = name;
        },
      };
      await newSessionOptions.setup?.(sessionManager);
      await newSessionOptions.withSession?.({
        mode: "tui",
        hasUI: true,
        ui: { notify: () => {} },
        sessionManager,
        sendUserMessage: async (content: string) => {
          record.sent.push(String(content));
        },
      });
      return { cancelled: false };
    },
  };

  return { record, overrides };
}

describe("PI_TAKEOVER_CONFIRM", () => {
  it("asks before replacing the session, and keeps the handoff when the answer is no", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover"), env: { PI_TAKEOVER_CONFIRM: "1" } });
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });

    const declined = replacementRecord({ confirm: false });
    await ext.runCommand("takeover-apply", "", declined.overrides);

    expect(declined.record.calls).toBe(0);
    expect(JSON.parse(readFileSync(statePath(ext.agentDir, "pending.json"), "utf8")).prompt).toBe(HANDOFF);

    const accepted = replacementRecord({ confirm: true });
    await ext.runCommand("takeover-apply", "", accepted.overrides);

    expect(accepted.record.calls).toBe(1);
    expect(accepted.record.sent).toEqual([HANDOFF]);
  });

  it("does not ask when the setting is off", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover") });
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });

    let asked = false;
    const { record, overrides } = replacementRecord();
    (overrides.ui as any).confirm = async () => {
      asked = true;
      return false;
    };

    await ext.runCommand("takeover-apply", "", overrides);

    expect(asked).toBe(false);
    expect(record.calls).toBe(1);
  });
});

describe("PI_TAKEOVER_MAX_CHAIN", () => {
  it("refuses past a cap of its own making", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover"), env: { PI_TAKEOVER_MAX_CHAIN: "2" } });
    seedChain(ext, 2);

    const result = await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cap is 2");
  });

  it("counts forever when the cap is zero", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover"), env: { PI_TAKEOVER_MAX_CHAIN: "0" } });
    seedChain(ext, 99);

    const result = await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });

    expect(result.isError).toBeFalsy();
    expect(existsSync(statePath(ext.agentDir, "pending.json"))).toBe(true);
  });

  it("falls back to the default when the value is nonsense", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover"), env: { PI_TAKEOVER_MAX_CHAIN: "plenty" } });
    seedChain(ext, 12);

    const result = await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });
    expect(result.isError).toBe(true);
  });
});

describe("PI_TAKEOVER_NAME", () => {
  it("names the incoming session after its handoff", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover") });
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });

    const named = replacementRecord();
    await ext.runCommand("takeover-apply", "", named.overrides);

    expect(named.record.name).toBe("takeover #1: Review the diff and report what is still blocking.");
  });

  it("leaves the name alone when switched off", async () => {
    ext = await loadExtension({ packageDir: packageDir("pi-takeover"), env: { PI_TAKEOVER_NAME: "0" } });
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OUTGOING } });

    const nameless = replacementRecord();
    await ext.runCommand("takeover-apply", "", nameless.overrides);

    expect(nameless.record.name).toBeUndefined();
    expect(nameless.record.calls).toBe(1);
  });
});
