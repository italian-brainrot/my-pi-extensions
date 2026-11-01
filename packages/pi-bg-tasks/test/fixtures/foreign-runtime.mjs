#!/usr/bin/env node
/**
 * A *second* pi runtime loading the extension against the same agent directory.
 *
 * It fires the two events that used to reach across sessions: `session_start` (which re-adopts the
 * sidecars it finds in `<agent-dir>/bg-tasks`) and `session_shutdown` with reason `quit` (which
 * stops everything that runtime knows about). This is what a nested `pi -p`, an RPC session, or a
 * `subagent` call does while another session has commands running.
 *
 * Usage: node foreign-runtime.mjs <path-to-extension-entry> [--spawn <command>]
 * The agent dir comes from PI_CODING_AGENT_DIR. Prints which sidecars it saw before and after.
 *
 * Most tests spawn it from the test process. The last one spawns it through the extension's own bash
 * tool, which reproduces the circular failure: the nested runtime used to adopt the sidecar of the
 * command running it and kill that command at shutdown.
 *
 * With --spawn, this runtime starts the command as a background task of its own, waits for it to
 * finish, and then exits *without* running the shutdown handlers. That is a runtime going away without
 * stopping what it started — a crash, or a kill — leaving its sidecars behind for whoever comes next.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const args = process.argv.slice(2);
const entry = args[0];
if (!entry) {
  console.error("usage: node foreign-runtime.mjs <extension-entry> [--spawn <command>]");
  process.exit(2);
}
const spawnIndex = args.indexOf("--spawn");
const spawnCommand = spawnIndex === -1 ? undefined : args[spawnIndex + 1];

function sidecars() {
  try {
    return readdirSync(join(process.env.PI_CODING_AGENT_DIR, "bg-tasks"))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

const handlers = new Map();
const tools = new Map();
const api = {
  registerTool: (tool) => {
    tools.set(tool.name, tool);
  },
  registerCommand: () => {},
  on: (event, handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {};
  },
};

const before = sidecars();

const jiti = createJiti(import.meta.url, { moduleCache: false });
const module = await jiti.import(entry);
await module.default(api);

const ctx = {
  cwd: process.cwd(),
  mode: "print",
  hasUI: false,
  ui: undefined,
  sessionManager: { getSessionId: () => "foreign-session", getSessionFile: () => undefined },
  modelRegistry: {},
  model: undefined,
  thinkingLevel: undefined,
  tools: [],
  executeTool: async () => {
    throw new Error("unused in this fixture");
  },
};

for (const handler of handlers.get("session_start") ?? []) {
  await handler({ type: "session_start", reason: "startup" }, ctx);
}

let spawned;
if (spawnCommand) {
  const started = await tools.get("bash").execute("spawn", { command: spawnCommand, timeout: 0 }, undefined, undefined, ctx);
  spawned = { id: started.details.id, pid: started.details.pid };
  // Let the task end here, so its sidecar is written the way a finished task writes it.
  await tools.get("bg_wait").execute("wait", { timeout: 15 }, undefined, undefined, ctx);
  process.stdout.write(`${JSON.stringify({ sidecarsBefore: before, sidecarsAfter: sidecars(), spawned })}\n`);
  // And go away without a shutdown: no stop, no claim, nothing that would drop the record.
  process.exit(0);
}

for (const handler of handlers.get("session_shutdown") ?? []) {
  await handler({ type: "session_shutdown", reason: "quit" }, ctx);
}

process.stdout.write(`${JSON.stringify({ sidecarsBefore: before, sidecarsAfter: sidecars() })}\n`);
