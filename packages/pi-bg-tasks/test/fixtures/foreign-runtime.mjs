#!/usr/bin/env node
/**
 * A *second* pi runtime loading the extension against the same agent directory.
 *
 * It fires the two events that used to reach across sessions: `session_start` (which re-adopts the
 * sidecars it finds in `<agent-dir>/bg-tasks`) and `session_shutdown` with reason `quit` (which
 * stops everything that runtime knows about). This is what a nested `pi -p`, an RPC session, or a
 * `subagent` call does while another session has commands running.
 *
 * Usage: node foreign-runtime.mjs <path-to-extension-entry>
 * The agent dir comes from PI_CODING_AGENT_DIR. Prints which sidecars it saw before and after.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node foreign-runtime.mjs <extension-entry>");
  process.exit(2);
}

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
const api = {
  registerTool: () => {},
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
for (const handler of handlers.get("session_shutdown") ?? []) {
  await handler({ type: "session_shutdown", reason: "quit" }, ctx);
}

process.stdout.write(`${JSON.stringify({ sidecarsBefore: before, sidecarsAfter: sidecars() })}\n`);
