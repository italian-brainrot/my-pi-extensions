/**
 * What the queue file is allowed to name.
 *
 * `pending.json` is on disk so that another load — or another pi sharing the agent dir, which the README
 * says shares this folder — can write it, and the pass-2 design invites exactly that: every question about
 * the queue is a read of that file. So its contents are input, not the extension's own output. One of its
 * fields, `id`, is used to name a file: a dropped handoff is written to `discarded-<id>.md` inside the state
 * folder and pruned with the rest of them — so an `id` that is a path writes wherever the thing that wrote
 * the file can write, and a `queuedAt` that is not a date turns into an age of `NaN` in a message to the
 * session. The shape has to be checked where it is read.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir, type TempDir } from "../../../test/helpers/extension.ts";

const HANDOFF = "Review the diff and report what is still blocking.";

let agentDir: TempDir;
let ext: LoadedExtension;

beforeEach(async () => {
  vi.resetModules();
  agentDir = makeTempDir("takeover-names-");
  ext = await loadExtension({ packageDir: packageDir("pi-takeover"), agentDir: agentDir.path });
});

afterEach(() => {
  ext?.dispose();
  agentDir?.dispose();
});

function stateDir(): string {
  return join(agentDir.path, "takeover");
}

/**
 * A handoff written by something other than this extension: the shape `readHandoff()` used to accept, owned
 * by this session, and an `id` that is a path rather than a name.
 */
function seedHandoffWrittenBySomeoneElse(id: string): void {
  mkdirSync(stateDir(), { recursive: true });
  const sessionKey = `file:${ext.makeContext().sessionManager.getSessionFile()}`;
  writeFileSync(join(stateDir(), "pending.json"), JSON.stringify({ id, prompt: HANDOFF, queuedAt: new Date().toISOString(), sessionKey }));
}

describe("the name of a dropped prompt", () => {
  it("keeps the discarded copy inside the state folder whatever the queue file calls the handoff", async () => {
    // `discarded-${handoff.id}.md` is built with join(), which resolves ".." like any other segment, so this
    // id writes wherever the user running pi can write. The prompt then is not in the folder the README and
    // the extension's own notification both point at, and `pruneDiscardedPrompts` never sees it.
    const id = "../../../../pi-takeover-escape";
    seedHandoffWrittenBySomeoneElse(id);

    const escaped = resolve(stateDir(), `discarded-${id}.md`);
    expect(escaped.startsWith(stateDir()), "the fixture: this id is meant to get out of the state folder").toBe(false);

    try {
      // Any of the ways a handoff is dropped builds the same file name.
      await ext.runCommand("takeover-cancel");

      expect(existsSync(escaped), `dropping a handoff wrote outside the state folder: ${escaped}`).toBe(false);
    } finally {
      try {
        unlinkSync(escaped);
      } catch {
        // Not written, which is what the assertion wants.
      }
    }
  });

  it("never files a dropped prompt outside the state folder, whatever the queue file calls it", async () => {
    // The same field reaching the same write by a different door: whatever gets as far as writing the copy
    // stays inside the folder that the notifications and the pruning both look at.
    seedHandoffWrittenBySomeoneElse("a-legal-id");
    await ext.runCommand("takeover-cancel");

    const kept = readdirSync(stateDir()).filter((name) => name.startsWith("discarded-"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^discarded-[A-Za-z0-9._-]+\.md$/);
  });
});

describe("the date a queue file carries", () => {
  it.each(["yesterday", "not-a-date", ""])("leaves a handoff whose queuedAt is %j alone", async (queuedAt) => {
    // `queuedAt` is what the age check is computed from, and an unparseable one used to take the
    // not-a-number branch: the handoff was dropped as expired and the session was told it had waited
    // "NaN minutes". A field that is not a date is not a handoff, so nothing about it is applied, dropped,
    // or announced — and it is not acted on silently either, it stays where it is for a human to look at.
    mkdirSync(stateDir(), { recursive: true });
    const sessionKey = `file:${ext.makeContext().sessionManager.getSessionFile()}`;
    writeFileSync(join(stateDir(), "pending.json"), JSON.stringify({ id: "h-odd-date", prompt: HANDOFF, queuedAt, sessionKey }));

    const notices: string[] = [];
    const ctx = ext.makeContext({ hasUI: true, ui: { notify: (message: string) => void notices.push(message) } });
    await ext.emit({ type: "agent_settled", aborted: false }, ctx);

    expect(ext.sent, "a handoff with an unreadable date was applied").toEqual([]);
    expect(readFileSync(join(stateDir(), "pending.json"), "utf8")).toContain(HANDOFF);
    expect(notices.join(" ")).not.toMatch(/NaN/);
    expect(
      readdirSync(stateDir()).some((name) => name.startsWith("discarded-")),
      "the unreadable handoff was dropped",
    ).toBe(false);
  });
});
