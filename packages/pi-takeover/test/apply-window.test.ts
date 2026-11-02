/**
 * The window in which a handoff is neither queued nor applied.
 *
 * `applyTakeover()` takes the handoff out of the queue before it asks the user to confirm the replacement,
 * and Pi's confirmation is a promise with no timeout and no signal: in the interactive mode it is a modal
 * the user answers, but in rpc mode it is an `extension_ui_request` the client is expected to answer, and an
 * unattended driver never does. Between the claim and the answer, `pending.json` does not exist and nothing
 * else holds the prompt — so a session that dies, is quit, or has its queue taken by another session during
 * that window loses the handoff entirely, while the README promises "a prompt is never lost just because a
 * session ended" and the extension says "the handoff is still queued".
 *
 * The same window swallows a human's `/takeover <prompt>`: while a replacement is in flight the command
 * queues the prompt, finds `applying` already set, and returns without saying anything. The entry it left
 * belongs to the session that is being replaced, so nothing will ever apply it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";
const OWNER = join("/tmp", "owner.jsonl");
const ELSEWHERE = join("/tmp", "elsewhere.jsonl");

let agentDir: TempDir;
let ext: LoadedExtension;

async function load(env?: Record<string, string>): Promise<void> {
  vi.resetModules();
  ext?.dispose();
  ext = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: agentDir.path, env });
}

beforeEach(async () => {
  agentDir = makeTempDir("takeover-window-");
});

afterEach(() => {
  ext?.dispose();
  agentDir?.dispose();
});

function stateDir(): string {
  return join(agentDir.path, "takeover");
}

/**
 * Whatever the extension does with a handoff, its prompt has to be findable in the state folder until it is
 * actually handed to a session: `pending.json`, or a `discarded-*.md` copy, or a backup of its own.
 */
function promptOnDisk(prompt: string): boolean {
  try {
    return readdirSync(stateDir()).some((name) => readFileSync(join(stateDir(), name), "utf8").includes(prompt));
  } catch {
    return false;
  }
}

/** A command context whose `ui.confirm` is answered by the test, whenever the test likes. */
function dialogContext(file: string, answer: () => Promise<boolean>) {
  return {
    sessionFile: file,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {}, confirm: answer },
    newSession: async () => ({ cancelled: false }),
  };
}

describe("a handoff that is waiting to be confirmed", () => {
  beforeEach(async () => {
    await load({ PI_TAKEOVER_CONFIRM: "1" });
  });

  it("keeps the prompt on disk while the user is being asked", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    let answer: (approved: boolean) => void = () => {};
    const dialog = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const applying = ext.runCommand(
      "takeover-apply",
      "",
      dialogContext(OWNER, () => dialog),
    );
    await new Promise((settled) => setTimeout(settled, 30));

    // The dialog is open. Nothing has been replaced, nothing is queued: the handoff exists only in a
    // closure, and an rpc driver that never answers the dialog never lets it come back.
    expect(promptOnDisk(HANDOFF), "a handoff waiting on its confirmation is on disk nowhere").toBe(true);

    answer(false);
    await applying;
  });

  it("does not lose the prompt when the queue moves while the user is being asked", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    let answer: (approved: boolean) => void = () => {};
    const dialog = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const applying = ext.runCommand(
      "takeover-apply",
      "",
      dialogContext(OWNER, () => dialog),
    );
    await new Promise((settled) => setTimeout(settled, 30));

    // Another session sharing this agent dir takes the only slot in the queue.
    await ext.callTool("takeover", { prompt: "Someone else's turn." }, { context: { sessionFile: ELSEWHERE } });

    answer(false);
    await applying;

    // `putHandoffBack` stands aside when the file holds a different id, which is right — but then the
    // handoff this session had is gone from the queue, from the closure, and from the state folder, and the
    // session has just been told it is still queued.
    expect(promptOnDisk(HANDOFF), "the declined handoff left no trace anywhere").toBe(true);
  });
});

describe("a takeover asked for while another is in flight", () => {
  beforeEach(async () => {
    await load();
  });

  it("says so instead of leaving a handoff nobody will apply", async () => {
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    // A replacement that has not finished: its `newSession()` is still open, so `applying` is set.
    let finish: () => void = () => {};
    const inFlight = new Promise<{ cancelled: boolean }>((resolve) => {
      finish = () => resolve({ cancelled: false });
    });
    const first = ext.runCommand("takeover-apply", "", {
      ...dialogContext(OWNER, async () => true),
      newSession: () => inFlight,
    });
    await new Promise((settled) => setTimeout(settled, 30));

    const notices: string[] = [];
    await ext.runCommand("takeover", "My turn now.", {
      sessionFile: OWNER,
      mode: "tui",
      hasUI: true,
      ui: { notify: (message: string) => void notices.push(message), confirm: async () => true },
    });

    // The human typed a takeover and nothing happened: no replacement, no word back, and a queue entry
    // addressed to a session that the in-flight replacement is about to tear down.
    expect(notices.join(" "), "a takeover that cannot run is not mentioned to the user").toMatch(/takeover/i);

    finish();
    await first;
  });
});
