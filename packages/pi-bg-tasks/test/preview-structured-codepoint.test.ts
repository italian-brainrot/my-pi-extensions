/**
 * The other two edges where a byte window cuts a character.
 *
 * `preview-codepoint.test.ts` covers the model-facing preview: a last-4 KB window that starts on a
 * continuation byte used to begin with U+FFFD. `decodeByteWindow` now trims a straddling sequence at either
 * end, and two more reads go through the same window code:
 *
 *   - `readStructuredOutput` cuts `structuredContent.output` at 1 MiB *from the start*, so the half character
 *     is at the end — not model-facing, but a codemode caller gets the same broken string, and trimming it is
 *     the same three lines of thinking as the start of a tail window.
 *   - `backgroundResult` labels the preview with a byte count. It counts the window taken from the file, which
 *     is what "last 4.0KB of 7.8KB" claims, not the length of the decoded text (which is shorter whenever the
 *     window had to trim, and longer whenever the log holds bytes that are not valid UTF-8 at all).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

/** `x`, then 700000 two-byte characters: 1400001 bytes, so the 1 MiB cut lands on a lead byte. */
const HUGE = `printf 'x'; printf '\\303\\251%.0s' {1..700000}`;
/** The tester's split-tail payload, plus a sleep so the command is still running when it is previewed. */
const MARKER = "223";
const TAIL = `printf 'x'; printf '\\303\\251%.0s' {1..4000}; printf 'M'; sleep ${MARKER}`;

let ext: LoadedExtension | undefined;
let agentDir: ReturnType<typeof makeTempDir>;

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
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

describe("a byte window that ends in the middle of a character", () => {
  it("cuts structuredContent.output at a character boundary, not only at a byte", async () => {
    const result = await ext!.callTool("bash", { command: HUGE, timeout: 30 });

    expect(result.structuredContent.truncated, "the log is over the 1 MiB cap").toBe(true);
    const output: string = result.structuredContent.output;
    expect(output, "the cut never leaves a replacement character").not.toContain("\uFFFD");
    // 1 MiB minus the lead byte whose continuation byte fell outside the window: exactly one character is
    // dropped, so a future change that decodes the raw window again shows up here.
    expect(Buffer.byteLength(output), "the window is one character short of 1 MiB").toBe(1024 * 1024 - 1);
    expect(output.endsWith("é"), "and it ends on a whole character").toBe(true);
  });

  it("labels the preview with the window taken from the file", async () => {
    const result = await ext!.callTool("bash", { command: TAIL, timeout: 1 });
    const label = text(result)
      .split("\n")
      .find((line) => line.startsWith("Preview"));

    // 8002 bytes of payload; the window is 4096 of them. The numbers are the window and the file, and neither
    // is the length of the text that ends up on screen.
    expect(label, `the preview line: ${text(result).slice(0, 200)}`).toBe("Preview (last 4.0KB of 7.8KB):");
  });
});
