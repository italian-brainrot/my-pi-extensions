/**
 * The listing cap and the note under it have to agree about what was left out.
 *
 * `taskSection` prints `LISTING_MAX_TASKS` (30) rows and, when there are more tasks, closes with
 * "(N older finished tasks not listed; their logs are in …)". The code comment next to it says
 * "Running tasks sort first, so anything dropped here is an old finished one" — true only while there are
 * fewer running tasks than the cap. A session with more than 30 background tasks running — a fan-out
 * `make -j40`, a watcher per package, a loop of `timeout: 0` commands — drops running tasks and tells the
 * model they are finished ones. The README makes the same promise more strongly: "The listing shows the 30
 * newest tasks (running ones are always included)".
 *
 * The cap on *rows* is reasonable; the promise and the note are what these tests hold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

/** More running tasks than `LISTING_MAX_TASKS`. */
const TASKS = 34;
const MARKER = "191";

let ext: LoadedExtension | undefined;

async function stopRuntime(): Promise<void> {
  if (!ext) return;
  await ext.emit({ type: "session_shutdown", reason: "quit" });
  ext.dispose();
  ext = undefined;
}

beforeEach(async () => {
  await stopRuntime();
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterEach(stopRuntime);

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

/** The part of a table worth quoting in a failure: the heading and the sentence under it. */
function summary(report: any): string {
  const lines = text(report).split("\n");
  const heading = lines.findIndex((line) => line.startsWith("Background tasks in this session"));
  return [lines[0], ...(heading >= 0 ? [lines[heading]] : []), lines[lines.length - 1]].join(" | ");
}

describe("a task listing with more running tasks than the cap", () => {
  it("lists every running task, as the README says it does", async () => {
    const ids: string[] = [];
    for (let i = 0; i < TASKS; i++) {
      const started = await ext!.callTool("bash", { command: `sleep ${MARKER}`, timeout: 0, blocking: false });
      ids.push(started.details.id);
    }
    expect(ids.length).toBe(TASKS);

    // `timeout: 0` waits for nothing: the answer is the table.
    const report = await ext!.callTool("bg_wait", { timeout: 0 });

    const listed = ids.filter((id) => text(report).includes(id));
    expect(listed.length, `every running task has a row; the table: ${summary(report)}`).toBe(TASKS);
    expect(report.structuredContent.tasks.length).toBe(TASKS);
    expect(report.structuredContent.running.length).toBe(TASKS);

    // Nothing was finished, so nothing may be described as a finished omission.
    expect(text(report), `the sentence under the table: ${summary(report)}`).not.toMatch(/older finished tasks not listed/);
  });

  it("counts the omission correctly when running and finished tasks together pass the cap", async () => {
    const running: string[] = [];
    for (let i = 0; i < TASKS; i++) {
      running.push((await ext!.callTool("bash", { command: `sleep ${MARKER}`, timeout: 0, blocking: false })).details.id);
    }
    // Finished background tasks: they keep their logs, and they are what the note is supposed to be about.
    const finished: string[] = [];
    for (let i = 0; i < 4; i++) {
      finished.push((await ext!.callTool("bash", { command: "true", timeout: 0, blocking: false })).details.id);
    }
    for (const id of finished) await ext!.callTool("bg_stop", { task_id: id });

    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    const shown = running.filter((id) => text(report).includes(id)).length;

    expect(report.structuredContent.tasks.length).toBe(TASKS + 4);
    expect(shown, `running tasks still have rows next to finished ones; the table: ${summary(report)}`).toBe(TASKS);

    // And the sentence under the table may only account for finished tasks. It is matched loosely on
    // purpose: if the wording changes, this stops saying something false rather than failing.
    const note = /\((\d+) older finished tasks not listed/.exec(text(report));
    if (note) expect(Number(note[1]), `only ${4} tasks are finished`).toBeLessThanOrEqual(4);
  });
});
