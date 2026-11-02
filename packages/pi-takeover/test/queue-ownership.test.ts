/**
 * The queue is on disk so that a `/reload` keeps it, but a handoff belongs to the session that queued
 * it. Both halves of that have to hold at once, and they are easiest to break from opposite sides:
 *
 * - the module-level cache is empty in a fresh module, so a handler that looks at the cache instead of
 *   the file does nothing in a session that survived a reload — while `agent_settled`, which does read
 *   the file, keeps working;
 * - the cache is not tagged with the session it came from, so a handler that acts on it can act on a
 *   handoff the session it is standing in does not own.
 *
 * Every test here reloads for real: `vi.resetModules()` before the second load, otherwise Vitest hands
 * back the same module instance and the reload being modelled never happens.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";

/** The session that queued the handoff, and a different one. */
const OWNER = join("/tmp", "owner.jsonl");
const ELSEWHERE = join("/tmp", "elsewhere.jsonl");

let agentDir: TempDir;
let loads: LoadedExtension[] = [];

beforeEach(() => {
  // A reload is a new module over the same state folder; without this the second load shares the first
  // one's `pending`, and every test below models a reload that never happened.
  vi.resetModules();
  agentDir = makeTempDir("takeover-ownership-");
  loads = [];
});

afterEach(() => {
  for (const load of loads) load.dispose();
  loads = [];
  agentDir.dispose();
});

/** Load the extension against the same agent dir, which is what `/reload` gives it. */
async function load(): Promise<LoadedExtension> {
  const ext = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: agentDir.path });
  loads.push(ext);
  return ext;
}

function state(name: string): string {
  return join(agentDir.path, "takeover", name);
}

function pendingExists(): boolean {
  return existsSync(state("pending.json"));
}

function pending(): any {
  return JSON.parse(readFileSync(state("pending.json"), "utf8"));
}

function droppedPrompts(): string[] {
  if (!existsSync(join(agentDir.path, "takeover"))) return [];
  return readdirSync(join(agentDir.path, "takeover")).filter((name) => name.startsWith("discarded-"));
}

/** A load, a handoff queued in `OWNER`, and the shutdown a `/reload` emits first. */
async function queuedThenReloaded(): Promise<LoadedExtension> {
  const before = await load();
  await before.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });
  await before.emit({ type: "session_shutdown", reason: "reload" }, before.makeContext({ sessionFile: OWNER }));
  expect(pendingExists()).toBe(true);

  vi.resetModules();
  return load();
}

describe("a queue that outlives its module", () => {
  it("lets a reloaded session apply the handoff it queued before the reload", async () => {
    // The behaviour the disk queue exists for; everything below is the same session, one reload later.
    const after = await queuedThenReloaded();
    await after.emit({ type: "agent_settled", aborted: false }, after.makeContext({ sessionFile: OWNER }));

    expect(after.sent.map((message) => message.content)).toEqual(["/takeover-apply"]);
  });

  it("cancels the queued handoff when the user types a message into the reloaded session", async () => {
    const after = await queuedThenReloaded();
    const notices: string[] = [];
    const ctx = after.makeContext({ sessionFile: OWNER, hasUI: true, ui: { notify: (message: string) => void notices.push(message) } });

    await after.emit({ type: "input", text: "wait, do this instead", source: "interactive" }, ctx);

    expect(pendingExists()).toBe(false);

    // The point of cancelling: the session must not be replaced underneath the user who just spoke.
    await after.emit({ type: "agent_settled", aborted: false }, ctx);
    expect(after.sent).toEqual([]);
  });

  for (const reason of ["quit", "resume", "fork"] as const) {
    it(`drops the queued handoff when the reloaded session ends for good (${reason})`, async () => {
      const after = await queuedThenReloaded();

      await after.emit({ type: "session_shutdown", reason }, after.makeContext({ sessionFile: OWNER }));

      expect(pendingExists()).toBe(false);
      // Dropped, not lost: the prompt keeps its copy in the state folder.
      expect(droppedPrompts()).toHaveLength(1);
    });
  }
});

describe("a queue that belongs to someone else", () => {
  it("leaves a handoff this session did not queue alone when the user types a message", async () => {
    const ext = await load();
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    // Another session is live now. Nothing it does may consume or destroy the queued handoff, and it is
    // not this session's to cancel.
    await ext.emit({ type: "input", text: "something else entirely", source: "interactive" }, ext.makeContext({ sessionFile: ELSEWHERE }));

    expect(pending()).toMatchObject({ prompt: HANDOFF });
  });

  it("leaves a handoff this session did not queue alone when a settle runs in it", async () => {
    const ext = await load();
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    // Peeking another session's handoff is allowed — it is how it is found again after a reload — but it
    // must not become this session's to apply.
    await ext.emit({ type: "agent_settled", aborted: false }, ext.makeContext({ sessionFile: ELSEWHERE }));
    expect(ext.sent).toEqual([]);

    await ext.emit(
      { type: "input", text: "a message in the wrong session", source: "interactive" },
      ext.makeContext({ sessionFile: ELSEWHERE }),
    );
    expect(pending()).toMatchObject({ prompt: HANDOFF });
  });
});
