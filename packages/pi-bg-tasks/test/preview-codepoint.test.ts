/**
 * A model-facing preview must not break a character in half.
 *
 * `readTail(path, 4096)` reads the last 4096 *bytes* of a log and decodes them, and the offset it starts at is
 * whatever the file size happens to make it. A log whose tail window starts on a continuation byte therefore
 * begins with `U+FFFD`, and that character goes straight into the tool result:
 *
 *   Preview (last 4.0KB of 7.8KB):
 *   �ééééééééééé…
 *
 * The same hazard is already handled one function over: `readLogWindow`, which windows a log over 8 MB, drops
 * a leading `U+FFFD` before showing anything (`replace(/^\uFFFD+/, "")`, with a comment about split
 * codepoints). `readTail` — used for the preview of a command that moved to the background, for the partial
 * output streamed while a command runs, and for `bg_wait`'s preview line — has no such step, and neither does
 * trimming the preview change what was read.
 *
 * The counts next to it are wrong by the same accident: `backgroundResult` labels the preview "last
 * `Buffer.byteLength(read)`", which counts the three bytes the replacement character took for the one byte
 * that was actually read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

/**
 * `x`, then 4000 two-byte characters, then `M`: 8002 bytes, so the last-4096 window starts on the second byte
 * of a character. Verified against `tail -c 4096`, which starts `a9 c3 a9 …`.
 */
const MARKER = "217";
const PAYLOAD = `printf 'x'; printf '\\303\\251%.0s' {1..4000}; printf 'M'`;
const COMMAND = `${PAYLOAD}; sleep ${MARKER}`;

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function rows(result: any): string[] {
  return text(result).split("\n");
}

beforeEach(async () => {
  if (ext) {
    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  }
  agentDir?.dispose();
  agentDir = makeTempDir("pi-ext-agent-");
  vi.resetModules();
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks"), agentDir: agentDir.path });
  await ext.emit({ type: "session_start", reason: "startup" });
});

afterEach(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
  ext = undefined;
  agentDir?.dispose();
});

describe("the preview of a log that does not end on a character boundary", () => {
  it("does not put a replacement character in front of the model when a command moves to the background", async () => {
    const result = await ext!.callTool("bash", { command: COMMAND, timeout: 1 });
    const body = text(result);

    const preview = rows(result).find((line) => line.startsWith("Preview"));
    expect(preview, `the result should have a preview: ${body.slice(0, 200)}`).toBeDefined();
    expect(body, "the payload arrived intact: it ends with the marker").toContain("M");
    expect(body, "and no character of it was replaced").not.toContain("\uFFFD");
  });

  it("does not put one in the output streamed while a command runs", async () => {
    const partials: string[] = [];
    const result = await ext!.callTool("bash", { command: COMMAND, timeout: 2 }, { onUpdate: (p: any) => partials.push(text(p)) });

    const withOutput = partials.filter((part) => part.includes("é"));
    expect(withOutput.length, `the preview arrived: ${partials.length} partials, ${text(result).slice(0, 120)}`).toBeGreaterThan(0);
    for (const part of withOutput) expect(part, "a streamed preview never splits a character").not.toContain("\uFFFD");
  });
});
