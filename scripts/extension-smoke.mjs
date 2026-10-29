#!/usr/bin/env node
/**
 * Drive a real pi against an extension in this repo and print what happened:
 *
 *   npm run smoke                 # pi-takeover, the only scenario with a script here so far
 *   npm run smoke -- pi-takeover
 *   PI_TAKEOVER_DEBUG=1 npm run smoke -- pi-takeover
 *
 * The model is `test/fixtures/fake-model.ts` in the package under test: a provider registered by an
 * extension, answering from rules matched against the transcript it is shown. No network, no API key,
 * and no dependency on what model you normally use. Everything — agent dir, working dir, sessions —
 * goes into a temporary folder that is removed on the way out.
 *
 * Useful for seeing a flow that unit tests can only describe: which session replaced which, what the
 * incoming agent was actually shown, and what landed in the transcript.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const packageArg = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "pi-takeover";

/** Per-package scenario: what to send, how the scripted model should answer, what to print at the end. */
const SCENARIOS = {
  "pi-takeover": {
    prompt: "Implement the change, then hand it to a reviewer.",
    // Rules are matched in order against the transcript the model call is shown.
    rules: [
      { when: { usedTool: "takeover" }, respond: { text: "My part is done." } },
      { when: { lastUserIncludes: "MERGE:" }, respond: { text: "Merged." } },
      {
        when: { lastUserIncludes: "REVIEW:" },
        respond: { toolCall: { name: "takeover", arguments: { prompt: "MERGE: nothing is blocking, merge it." } } },
      },
      { respond: { toolCall: { name: "takeover", arguments: { prompt: "REVIEW: check the change and report blockers." } } } },
    ],
    env: { PI_TAKEOVER_DEBUG: process.env.PI_TAKEOVER_DEBUG ?? "1" },
    // A model switch first: it belongs to the session that made it, so a takeover has to carry it over.
    setup: [
      { id: "model", type: "set_model", provider: "fake", modelId: "other" },
      { id: "thinking", type: "set_thinking_level", level: "medium" },
    ],
    sessions: true,
  },
};

const scenario = SCENARIOS[packageArg];
if (!scenario) {
  console.error(`No smoke scenario for ${packageArg}. Known: ${Object.keys(SCENARIOS).join(", ")}.`);
  process.exit(1);
}

const packageDir = join(repoRoot, "packages", packageArg);
const extension = join(packageDir, "src", "index.ts");
const fakeModel = join(packageDir, "test", "fixtures", "fake-model.ts");
for (const path of [extension, fakeModel]) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}.`);
    process.exit(1);
  }
}

const agentDir = mkdtempSync(join(tmpdir(), `${packageArg}-smoke-agent-`));
const cwd = mkdtempSync(join(tmpdir(), `${packageArg}-smoke-cwd-`));
const logPath = join(agentDir, "model-calls.jsonl");

const bundledPi = join(repoRoot, "node_modules", ".bin", "pi");
const pi = process.env.PI_BIN ?? (existsSync(bundledPi) ? bundledPi : "pi");

const child = spawn(pi, ["--mode", "rpc", "--model", "fake/fake", "-ne", "-e", extension, "-e", fakeModel], {
  cwd,
  env: {
    ...process.env,
    ...scenario.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_FAKE_RULES: JSON.stringify(scenario.rules),
    PI_FAKE_LOG: logPath,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
/** Ids of the rpc commands this script has seen the answer to, so the next one can wait for its turn. */
const answered = new Set();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      console.log(`[unparsed] ${line.slice(0, 200)}`);
      continue;
    }

    if (record.type === "message_update") continue;
    if (record.type === "response" && record.id) answered.add(String(record.id));

    const detail =
      record.type === "message_end"
        ? ` role=${record.message?.role} stop=${record.message?.stopReason} text=${JSON.stringify(
            (Array.isArray(record.message?.content) ? record.message.content : [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(" ")
              .slice(0, 90),
          )}`
        : record.type === "response"
          ? ` command=${record.command} success=${record.success} data=${JSON.stringify(record.data ?? null).slice(0, 120)}`
          : "";
    console.log(`[${record.type ?? "?"}]${detail}`);
  }
});

function dump(label, path) {
  if (!existsSync(path)) {
    console.log(`\n--- ${label}: none at ${path}`);
    return;
  }
  console.log(`\n--- ${label} ---\n${readFileSync(path, "utf8").trim()}`);
}

function describeSessions() {
  const sessions = join(agentDir, "sessions");
  if (!existsSync(sessions)) return;

  for (const dir of readdirSync(sessions)) {
    for (const file of readdirSync(join(sessions, dir))) {
      const entries = readFileSync(join(sessions, dir, file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      console.log(`\nsession ${file}`);
      console.log(`  parent: ${entries[0]?.parentSession ?? "none"}`);
      console.log(`  entries: ${entries.map((entry) => (entry.type === "message" ? entry.message?.role : entry.type)).join(", ")}`);
      console.log(`  name: ${entries.find((entry) => entry.type === "session_info")?.name ?? "none"}`);
      const selection = entries
        .filter((entry) => entry.type === "model_change" || entry.type === "thinking_level_change")
        .map((entry) => (entry.type === "model_change" ? `${entry.provider}/${entry.modelId}` : `thinking:${entry.thinkingLevel}`));
      console.log(`  selection: ${selection.join(" -> ")}`);
      for (const entry of entries) {
        if (entry.type === "custom") console.log(`  ${entry.customType}: ${JSON.stringify(entry.data).slice(0, 220)}`);
      }
    }
  }
}

setTimeout(async () => {
  // RPC answers commands as they arrive rather than one after another, so each one is waited for:
  // `set_model` picks a thinking level of its own, and it must not land after a level set here.
  for (const command of scenario.setup ?? []) {
    child.stdin.write(`${JSON.stringify(command)}\n`);
    const deadline = Date.now() + 8000;
    while (!answered.has(String(command.id)) && Date.now() < deadline) {
      await new Promise((resolveStep) => setTimeout(resolveStep, 50));
    }
  }
  child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: scenario.prompt })}\n`);
}, 1200);

setTimeout(
  async () => {
    dump("what each model call was shown", logPath);
    dump("takeover chain", join(agentDir, "takeover", "chain.json"));
    dump("queued handoff", join(agentDir, "takeover", "pending.json"));
    if (scenario.sessions) describeSessions();

    child.stdin.end();
    await new Promise((resolveExit) => child.once("close", resolveExit));

    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  },
  Number(process.env.SMOKE_MS ?? 12_000),
);
