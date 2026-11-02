/**
 * The windows around a handoff: the one where it is neither queued nor applied, and the one where a
 * replacement is already under way.
 *
 * `applyTakeover()` used to take the handoff out of the queue before it asked the user to confirm the
 * replacement, and Pi's confirmation is a promise with no timeout and no signal: in the interactive mode it
 * is a modal the user answers, but in rpc mode it is an `extension_ui_request` the client is expected to
 * answer, and an unattended driver never does. Between the claim and the answer, `pending.json` did not
 * exist and nothing else held the prompt — so a session that died, was quit, or had its queue taken by
 * another session during that window lost the handoff entirely, while the README promised "a prompt is
 * never lost just because a session ended" and the extension said "the handoff is still queued". The tests
 * below hold the window open and ask what is on disk in it.
 *
 * The same window swallows a human's `/takeover <prompt>`: while a replacement is in flight the command
 * queued the prompt, found `applying` already set, and returned without saying anything. The entry it left
 * belonged to the session that was being replaced, so nothing would ever apply it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  it("does not replace the session with a handoff the user cancelled while being asked about", async () => {
    // Asking before claiming is what makes a question answerable at all — and it means the queue can move
    // while the question is open. A `/takeover-cancel` (or any session's `takeover`) in that window has to
    // be the last word, not the dialog that was already on screen.
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    let answer: (approved: boolean) => void = () => {};
    const dialog = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    let replacements = 0;
    const applying = ext.runCommand("takeover-apply", "", {
      ...dialogContext(OWNER, () => dialog),
      newSession: async () => {
        replacements += 1;
        return { cancelled: false };
      },
    });
    await new Promise((settled) => setTimeout(settled, 30));

    await ext.runCommand("takeover-cancel", "", { sessionFile: OWNER, mode: "tui", hasUI: true, ui: { notify: () => {} } });

    // The answer arrives after the cancel. Approving it must not resurrect a handoff that is gone.
    answer(true);
    await applying;

    expect(replacements, "a cancelled handoff was applied because the dialog said yes").toBe(0);
    expect(promptOnDisk(HANDOFF), "the cancelled prompt is not in the state folder").toBe(true);
  });

  it("asks a bounded question, so a session is not parked on an unanswered dialog", async () => {
    // Pi's rpc `confirm` is an `extension_ui_request` that resolves only when a client answers it, and the
    // drivers this extension is used with never do. Only something the extension passes can end the wait:
    // Pi resolves a dialog to its default on a timeout or an abort. Without one, a takeover in an
    // unattended run neither happens nor leaves anything behind — the loop is simply stuck.
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    let releaseDialog: (approved: boolean) => void = () => {};
    const asked: Array<{ signal?: AbortSignal; timeout?: number }> = [];
    const applying = ext.runCommand("takeover-apply", "", {
      ...dialogContext(OWNER, () => new Promise<boolean>(() => {})),
      ui: {
        notify: () => {},
        confirm: (_title: string, _message: string, options: { signal?: AbortSignal; timeout?: number }) => {
          asked.push(options);
          // The dialog answers to its signal and to nothing else, which is what the assertions below are
          // really about: the shutdown after this has to be enough to release the apply.
          options.signal?.addEventListener("abort", () => releaseDialog(false));
          return new Promise<boolean>((resolve) => {
            releaseDialog = resolve;
          });
        },
      },
    });
    await new Promise((settled) => setTimeout(settled, 30));

    expect(asked, "the confirmation was asked without anything that can end it").toHaveLength(1);
    expect(asked[0]!.signal, "the confirmation has no signal, so nothing can dismiss it").toBeInstanceOf(AbortSignal);
    expect(asked[0]!.timeout, "the confirmation has no timeout, so an unanswered dialog never ends").toBeGreaterThan(0);

    // The session goes away while the question is open. Nothing answers a dialog for a dead session, so
    // the extension has to.
    await ext.emit({ type: "session_shutdown", reason: "quit" }, ext.makeContext({ sessionFile: OWNER }));

    const outcome = await Promise.race([applying.then(() => "released"), new Promise((hung) => setTimeout(() => hung("hung"), 1000))]);
    expect(outcome, "the apply is still waiting on a dialog nobody will answer").toBe("released");
    expect(promptOnDisk(HANDOFF), "the session ended with a handoff that is nowhere on disk").toBe(true);
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

  it("leaves no queue entry behind for the session that is being replaced", async () => {
    // The other half of the same mistake: a prompt queued during a replacement is keyed to a session that
    // is on its way out, so no settle will ever apply it. It waits out the hour-long expiry, and the
    // notice about it goes to a session that has moved on.
    await ext.callTool("takeover", { prompt: HANDOFF }, { context: { sessionFile: OWNER } });

    let finish: () => void = () => {};
    const inFlight = new Promise<{ cancelled: boolean }>((resolve) => {
      finish = () => resolve({ cancelled: false });
    });
    const first = ext.runCommand("takeover-apply", "", {
      ...dialogContext(OWNER, async () => true),
      newSession: () => inFlight,
    });
    await new Promise((settled) => setTimeout(settled, 30));

    await ext.runCommand("takeover", "My turn now.", {
      sessionFile: OWNER,
      mode: "tui",
      hasUI: true,
      ui: { notify: () => {}, confirm: async () => true },
    });

    const queued = existsSync(join(stateDir(), "pending.json"));
    expect(queued, "a refused takeover still parked a handoff in the queue").toBe(false);

    finish();
    await first;
  });
});
