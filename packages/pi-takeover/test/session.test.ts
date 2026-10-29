/**
 * A takeover in a real Pi process, with a scripted model instead of a real one.
 *
 * This is the test that proves the route from a tool call to a session replacement actually works: the
 * queue, the settle boundary, the internal apply command, `newSession()`, the handoff prompt arriving
 * as the incoming session's first message, and the lineage section in that session's system prompt.
 * Nothing here touches the network, the user's agent dir, or a real model.
 *
 * The scripted model's rules are matched against the transcript it is shown, so they hold for a session
 * the test never started. Two takeovers run in a row, which is the shape of the implement/review loop
 * this extension exists for.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, repoRoot, type TempDir } from "../../../test/helpers/extension.ts";
import { waitFor } from "../../../test/helpers/wait.ts";

const REVIEW = "REVIEW: check the change and report what is still blocking.";
const MERGE = "MERGE: nothing is blocking, merge it and report the merge commit.";

const RULES = [
  // A session that has already handed off ends its turn.
  { when: { usedTool: "takeover" }, respond: { text: "My part is done." } },
  // The last session has nothing to hand on.
  { when: { lastUserIncludes: "MERGE:" }, respond: { text: "Merged." } },
  // The reviewer passes it back to an implementer.
  { when: { lastUserIncludes: "REVIEW:" }, respond: { toolCall: { name: "takeover", arguments: { prompt: MERGE } } } },
  // The implementer starts the chain.
  { respond: { toolCall: { name: "takeover", arguments: { prompt: REVIEW } } } },
];

/** Pi's own binary, pinned by the root devDependencies, so the test runs the version it types against. */
function piBinary(): string {
  const bundled = resolve(repoRoot, "node_modules", ".bin", "pi");
  return existsSync(bundled) ? bundled : (process.env.PI_BIN ?? "pi");
}

interface ModelCall {
  call: number;
  lastUser: string;
  systemTakeoverSection: Array<string | null>;
}

let agentDir: TempDir;
let cwd: TempDir;
let child: ChildProcessWithoutNullStreams;
let stderr: string;

beforeAll(async () => {
  agentDir = makeTempDir("takeover-agent-");
  cwd = makeTempDir("takeover-cwd-");
  stderr = "";

  child = spawn(
    piBinary(),
    [
      "--mode",
      "rpc",
      "--model",
      "fake/fake",
      "-ne",
      "-e",
      join(repoRoot, "packages/pi-takeover/src/index.ts"),
      "-e",
      join(repoRoot, "packages/pi-takeover/test/fixtures/fake-model.ts"),
    ],
    {
      cwd: cwd.path,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir.path,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_FAKE_RULES: JSON.stringify(RULES),
        PI_FAKE_LOG: join(agentDir.path, "model-calls.jsonl"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  // Wait for the runtime to be up before sending anything: the first command is what proves it.
  const started = await new Promise<void>((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error(`pi did not start; stderr:\n${stderr}`)), 30_000);
    const write = () => {
      clearTimeout(timer);
      resolveStart();
    };
    child.stdout.once("data", write);
    child.once("error", rejectStart);
    child.once("close", () => {
      clearTimeout(timer);
      rejectStart(new Error(`pi exited before it started; stderr:\n${stderr}`));
    });
    child.stdin.write(`${JSON.stringify({ id: "wake", type: "get_state" })}\n`);
  });

  await started;
  child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "Implement the change, then hand it to a reviewer." })}\n`);
});

afterAll(async () => {
  if (child && !child.killed) {
    child.stdin.end();
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
  agentDir?.dispose();
  cwd?.dispose();
});

function modelCalls(): ModelCall[] {
  const path = join(agentDir.path, "model-calls.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ModelCall);
}

function sessionFiles(): string[] {
  const sessions = join(agentDir.path, "sessions");
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions)
    .flatMap((dir) => readdirSync(join(sessions, dir)).map((file) => join(sessions, dir, file)))
    .sort();
}

describe("a takeover in a running pi", () => {
  it("ends one session and starts the next with the handoff prompt", async () => {
    // Two takeovers, and one closing answer each: session A calls the tool, B calls it again, C stops.
    await waitFor(() => modelCalls().length >= 5, "five model calls across three sessions", 30_000);

    const calls = modelCalls();
    const [opening] = calls;

    // The chain: implementer, reviewer, merge. Each session's first message is the previous agent's
    // handoff prompt, and only the sessions that arrived that way carry the lineage section.
    expect(opening!.lastUser).toContain("Implement the change");
    expect(opening!.systemTakeoverSection).toEqual([null]);

    const reviewer = calls.find((entry) => entry.lastUser === REVIEW);
    const merger = calls.find((entry) => entry.lastUser === MERGE);
    expect(reviewer?.systemTakeoverSection[0]).toContain("takeover #1 of 12");
    expect(merger?.systemTakeoverSection[0]).toContain("takeover #2 of 12");
    expect(reviewer?.systemTakeoverSection[0]).toContain("previous session file is");

    const sessions = sessionFiles();
    expect(sessions).toHaveLength(3);

    const [first = [], second = [], third = []] = sessions.map((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any),
    );

    // The outgoing transcript is complete: the handoff's tool call and its result are both there.
    const firstText = JSON.stringify(first);
    expect(firstText).toContain('"toolCall"');
    expect(firstText).toContain("Takeover queued");
    expect(first.at(-1)?.type).toBe("message");

    // Each takeover links back to the session it replaced and records its lineage in the new one.
    expect(second[0]?.parentSession).toBeTruthy();
    expect(third[0]?.parentSession).toBeTruthy();
    const lineageOf = (entries: any[]) => entries.filter((entry) => entry.type === "custom" && entry.customType === "takeover");
    expect(lineageOf(second)).toHaveLength(1);
    expect(lineageOf(second)[0].data).toMatchObject({ position: 1, prompt: REVIEW });
    expect(lineageOf(third)[0].data).toMatchObject({ position: 2, prompt: MERGE });

    const chain = JSON.parse(readFileSync(join(agentDir.path, "takeover", "chain.json"), "utf8"));
    expect(chain.count).toBe(2);
    expect(existsSync(join(agentDir.path, "takeover", "pending.json"))).toBe(false);
  }, 60_000);
});
