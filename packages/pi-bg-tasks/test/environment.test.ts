import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterAll(() => {
  ext?.dispose();
});

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

async function envFor(context: Record<string, unknown>, command = "env"): Promise<Record<string, string>> {
  const result = await ext.callTool("bash", { command }, { context });
  const parsed: Record<string, string> = {};
  for (const line of text(result).split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) parsed[line.slice(0, split)] = line.slice(split + 1);
  }
  return parsed;
}

describe("the environment handed to commands", () => {
  it("describes the current session and model", async () => {
    const env = await envFor({
      sessionId: "sess-42",
      sessionFile: join(ext.agentDir, "sessions", "sess-42.jsonl"),
      model: { id: "model-x", provider: "prov-y" },
      thinkingLevel: "high",
    });

    expect(env.PI_SESSION_ID).toBe("sess-42");
    expect(env.PI_SESSION_FILE).toBe(join(ext.agentDir, "sessions", "sess-42.jsonl"));
    expect(env.PI_MODEL).toBe("model-x");
    expect(env.PI_PROVIDER).toBe("prov-y");
    expect(env.PI_REASONING_LEVEL).toBe("high");
  });

  it("puts pi's own bin dir on PATH", async () => {
    const env = await envFor({});
    expect((env.PATH ?? "").split(":")).toContain(join(ext.agentDir, "bin"));
  });

  it("adds the bin dir once, even when PATH already contains it", async () => {
    const env = await envFor({});
    expect((env.PATH ?? "").split(":").filter((entry) => entry === join(ext.agentDir, "bin")).length).toBe(1);
  });

  it("clears PI_* variables inherited from a parent pi process", async () => {
    ext.dispose();
    vi.resetModules();
    ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), env: { PI_MODEL: "stale-model", PI_SESSION_ID: "stale-session" } });

    const env = await envFor({});
    expect(env.PI_MODEL).toBeUndefined();
    expect(env.PI_SESSION_ID).toBe("test-session");
  });
});

describe("shell selection", () => {
  async function shellProbe(load: () => Promise<LoadedExtension>): Promise<string> {
    const loaded = await load();
    const result = await loaded.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}" });
    loaded.dispose();
    return text(result);
  }

  it("uses bash by default", async () => {
    vi.resetModules();
    expect(await shellProbe(() => loadExtension({ packageDir: packageDir("pi-bg-tasks") }))).not.toContain("BASH=none");
  });

  it("honours shellPath from the agent settings", async () => {
    vi.resetModules();
    const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    writeFileSync(join(loaded.agentDir, "settings.json"), JSON.stringify({ shellPath: "sh" }));
    const result = await loaded.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}" });
    expect(text(result)).toContain("BASH=none");
    loaded.dispose();
  });

  it("selects the shell once per runtime, so later settings changes do not affect it", async () => {
    vi.resetModules();
    const loaded = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
    const first = await loaded.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}" });
    writeFileSync(join(loaded.agentDir, "settings.json"), JSON.stringify({ shellPath: "sh" }));
    const second = await loaded.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}" });

    expect(text(first)).not.toContain("BASH=none");
    expect(text(second)).not.toContain("BASH=none");
    loaded.dispose();
  });
});
