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

  it("drops the oldest finished rows and says that it did", async () => {
    // What the cap is actually for. Fifteen running tasks and more finished ones than fit: the running ones
    // all keep their rows, and what goes are the oldest finished ones, which is the only thing the sentence
    // under the table may then claim.
    const finished: string[] = [];
    for (let i = 0; i < 34; i++) {
      finished.push((await ext!.callTool("bash", { command: "true", timeout: 0, blocking: false })).details.id);
    }
    for (const id of finished) await ext!.callTool("bg_stop", { task_id: id });
    const running: string[] = [];
    for (let i = 0; i < 15; i++) {
      running.push((await ext!.callTool("bash", { command: `sleep ${MARKER}`, timeout: 0, blocking: false })).details.id);
    }

    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    const body = text(report);

    expect(report.structuredContent.tasks.length).toBe(49);
    for (const id of running) expect(body, `a running task always has a row: ${summary(report)}`).toContain(id);

    const keptFinished = finished.filter((id) => body.includes(id));
    expect(keptFinished.length, `the finished rows are capped: ${summary(report)}`).toBe(30);
    expect(keptFinished, "and they are the newest ones").toEqual(finished.slice(-30));

    expect(body).toMatch(/\(4 older finished tasks not listed; their logs are in /);
    expect(body, "nothing was dropped that was running").not.toMatch(/running tasks? not listed/);
  });

  it("bounds the running rows too, and names them as running when it drops one", async () => {
    // Running tasks are not capped by the finished cap, but the model-facing table is still bounded. The
    // sentence under it has to say which kind went missing — the old one could only say "finished".
    const RUNNING = 104;
    const running: string[] = [];
    for (let i = 0; i < RUNNING; i++) {
      running.push((await ext!.callTool("bash", { command: "sleep 205", timeout: 0, blocking: false })).details.id);
    }

    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    const body = text(report);

    expect(report.structuredContent.tasks.length).toBe(RUNNING);
    expect(body, `the heading counts them all: ${summary(report)}`).toContain(`(${RUNNING} tracked, ${RUNNING} running)`);
    expect(running.filter((id) => body.includes(id)).length, `the table stays bounded: ${summary(report)}`).toBe(100);
    expect(body).toMatch(/\(4 running tasks not listed; their logs are in /);
    expect(body).not.toMatch(/finished tasks not listed/);
  });

  it("drops the oldest running rows when it has to drop any", async () => {
    // The cap on running rows is a decision, but it should be the same decision the finished rows make: the
    // rows kept are the newest. As written, `runningInfos.slice(0, LISTING_MAX_RUNNING_TASKS)` keeps the 100
    // tasks that started *first*, so the four the model started last — the ones it just asked for, and the
    // ones whose status it has no other way to ask about — are the invisible ones, under a sentence that does
    // not say which four they are. Either the newest running tasks keep their rows, or the README and the
    // sentence under the table have to say that the oldest do.
    const RUNNING = 104;
    const running: string[] = [];
    for (let i = 0; i < RUNNING; i++) {
      running.push(
        (await ext!.callTool("bash", { command: `sleep 213 # listing-marker-213-${i}`, timeout: 0, blocking: false })).details.id,
      );
    }

    const report = await ext!.callTool("bg_wait", { timeout: 0 });
    const body = text(report);

    expect(report.structuredContent.tasks.length).toBe(RUNNING);
    const kept = running.filter((id) => body.includes(id));
    expect(kept.length, `the table stays bounded: ${summary(report)}`).toBe(100);
    expect(kept, "the newest running tasks are the ones with rows").toEqual(running.slice(-100));
  });

  it("keeps the newest running rows and prints them in the order they started", async () => {
    // Which 100 of 104 running tasks get a row, and in what order they are printed, is one decision: the newest
    // 100, oldest first, the same way the finished rows are capped and printed. So the tasks without a row are
    // always the oldest of their kind, and the sentence under the table says how many of each kind went.
    const RUNNING = 104;
    const running: string[] = [];
    for (let i = 0; i < RUNNING; i++) {
      running.push(
        (await ext!.callTool("bash", { command: `sleep 221 # listing-marker-221-${i}`, timeout: 0, blocking: false })).details.id,
      );
    }

    const report = await ext!.callTool("bg_wait", { timeout: 0 });

    // A row line starts with the ID; the line under it is the command.
    const printed = text(report)
      .split("\n")
      .filter((line) => line.startsWith("bg-"))
      .map((line) => line.slice(0, 11));

    expect(printed.length, `the table stays bounded: ${summary(report)}`).toBe(100);
    expect(printed, "the four oldest running tasks are the ones with no row, oldest first").toEqual(running.slice(4));
    expect(text(report)).toMatch(/\(4 running tasks not listed; their logs are in /);
  });
});
