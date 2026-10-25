import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../../../test/helpers/env.ts";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, withPiArgv } from "../../../test/helpers/extension.ts";

const fakePi = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-subagent") });
});

afterAll(() => {
  ext?.dispose();
});

interface StubRun {
  result: any;
  invocation: { argv: string[]; depth: string | null; cwd: string; prompt: string } | null;
  signal: { signal: string } | null;
}

/** Run the subagent tool against the fake `pi`, returning the tool result plus what the child recorded. */
async function runStub(
  prompt: string,
  stubEnv: Record<string, string | undefined>,
  options: { signal?: AbortSignal; context?: Record<string, unknown> } = {},
): Promise<StubRun> {
  const records = makeTempDir("fake-pi-records-");
  try {
    const result = await withEnv({ FAKE_PI_DIR: records.path, ...stubEnv }, () =>
      withPiArgv(fakePi, () => ext.callTool("subagent", { prompt }, options)),
    );

    const read = (name: string) => {
      const path = join(records.path, name);
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as any) : null;
    };
    return { result, invocation: read("invocation.json"), signal: read("signal.json") };
  } finally {
    records.dispose();
  }
}

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

describe("running a subagent", () => {
  it("returns the subagent's final answer", async () => {
    const { result } = await runStub("Summarise this repo", { FAKE_PI_ANSWER: "It is a monorepo." });

    expect(text(result)).toBe("It is a monorepo.");
    expect(result.isError).toBeUndefined();
    expect(result.details.stopReason).toBe("stop");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.model).toBe("fake/model");
  });

  it("hands the prompt to the nested pi with the session's model and thinking level", async () => {
    const { invocation } = await runStub(
      "  do the thing \n",
      {},
      {
        context: { model: { provider: "prov", id: "model-x" }, thinkingLevel: "high", cwd: ext.cwd },
      },
    );

    expect(invocation?.argv).toEqual(["--mode", "json", "-p", "--no-session", "--model", "prov/model-x", "--thinking", "high"]);
    expect(invocation?.prompt).toBe("  do the thing \n");
    expect(invocation?.cwd).toBe(ext.cwd);
    // The child is told it is one level deeper, which is what stops nested delegation.
    expect(invocation?.depth).toBe("1");
  });

  it("reports the subagent's tokens and cost as the tool result usage", async () => {
    const turns = JSON.stringify([
      {
        text: "looking into it",
        toolCall: "bash",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 10,
          totalTokens: 180,
          cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0.0001, total: 0.0036 },
        },
      },
      {
        text: "done",
        usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 210, cost: 0.01, reasoning: 7, cacheWrite1h: 4 },
      },
    ]);

    const { result } = await runStub("work", { FAKE_PI_TURNS: turns });

    expect(result.usage).toMatchObject({ input: 130, output: 25, cacheRead: 50, cacheWrite: 10, totalTokens: 390 });
    expect(result.usage.cost.total).toBeCloseTo(0.0136, 10);
    expect(result.usage.cost.input).toBeCloseTo(0.001, 10);
    expect(result.usage.reasoning).toBe(7);
    expect(result.usage.cacheWrite1h).toBe(4);

    expect(result.details.usage.turns).toBe(2);
    // Context size is the largest single response, not the sum of all of them.
    expect(result.details.usage.contextTokens).toBe(210);
  });

  it("picks the last assistant message that has text", async () => {
    const turns = JSON.stringify([
      { text: "first draft", toolCall: "read" },
      { text: "   ", stopReason: "stop" },
    ]);

    const { result } = await runStub("work", { FAKE_PI_TURNS: turns });
    expect(text(result)).toBe("first draft");
    expect(result.details.messages.length).toBe(4);
  });

  it("warns when the subagent stopped at its length limit", async () => {
    const turns = JSON.stringify([{ text: "a long answer", stopReason: "length" }]);
    const { result } = await runStub("work", { FAKE_PI_TURNS: turns });

    expect(text(result)).toContain("a long answer");
    expect(text(result)).toContain("stopped at its output length limit");
    expect(result.isError).toBeUndefined();
  });

  it("ignores non-JSON and unrelated lines on stdout", async () => {
    const { result } = await runStub("work", { FAKE_PI_JUNK: "1", FAKE_PI_ANSWER: "still parsed" });

    expect(text(result)).toBe("still parsed");
    expect(result.isError).toBeUndefined();
  });

  it("reassembles events that arrive in pieces", async () => {
    const { result } = await runStub("work", { FAKE_PI_SPLIT: "1", FAKE_PI_ANSWER: "reassembled" });

    expect(text(result)).toBe("reassembled");
  });

  it("marks a non-zero exit as an error and keeps the details", async () => {
    const { result } = await runStub("work", { FAKE_PI_EXIT: "2", FAKE_PI_ANSWER: "partial work" });

    expect(result.isError).toBe(true);
    expect(result.details.exitCode).toBe(2);
    expect(text(result)).toContain("Subagent failed (exit code 2)");
    expect(text(result)).toContain("partial work");
    expect(result.details.prompt).toBe("work");
  });

  it("surfaces the subagent's own error message", async () => {
    const turns = JSON.stringify([{ text: "", stopReason: "error", errorMessage: "upstream model exploded" }]);
    const { result } = await runStub("work", { FAKE_PI_TURNS: turns });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("upstream model exploded");
    expect(result.details.stopReason).toBe("error");
  });

  it("keeps only the tail of a flood of stderr", async () => {
    const noise = `${"x".repeat(20_000)}TAILMARKER`;
    const { result } = await runStub("work", { FAKE_PI_EXIT: "1", FAKE_PI_STDERR: noise });

    expect(result.details.stderr.length).toBeLessThanOrEqual(64_000);
    expect(result.details.stderr.endsWith("TAILMARKER")).toBe(true);
    expect(text(result)).toContain("TAILMARKER");
  });

  it("kills the nested pi when the tool call is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const { result, signal } = await runStub("work", { FAKE_PI_SLEEP_MS: "8000" }, { signal: controller.signal });

    expect(result.isError).toBe(true);
    expect(result.details.stopReason).toBe("aborted");
    expect(signal?.signal).toBe("SIGTERM");
  });

  it("reports a nested pi that cannot be started", async () => {
    const missing = await withEnv({ PATH: "/nonexistent-pi-path" }, () =>
      withPiArgv("/nonexistent/pi-entry", () => ext.callTool("subagent", { prompt: "work" })),
    );

    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("Failed to start subagent");
    expect(missing.details.usage.input).toBe(0);
  });

  it("refuses an empty prompt without spawning a process", async () => {
    for (const prompt of ["", "   ", "\n\n"]) {
      const { result, invocation } = await runStub(prompt, {});
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("needs a non-empty prompt");
      expect(invocation).toBeNull();
    }
  });
});
