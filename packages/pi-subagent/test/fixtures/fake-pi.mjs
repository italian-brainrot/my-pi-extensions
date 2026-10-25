#!/usr/bin/env node
/**
 * Stand-in for the `pi` CLI that `pi-subagent` spawns.
 *
 * It speaks the same slice of `pi --mode json` output the extension consumes
 * (`message_end` events with a `message`) and records how it was invoked, so tests
 * can assert the flags, the prompt on stdin, and the nesting environment without
 * spending tokens or needing network access.
 *
 * Controlled entirely through FAKE_PI_* environment variables.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_PI_DIR || "";
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS ?? 0);

function record(name, payload) {
  if (!dir) return;
  try {
    writeFileSync(join(dir, name), JSON.stringify(payload));
  } catch {
    // The test is the only consumer; a failed write shows up as a missing file.
  }
}

process.on("SIGTERM", () => {
  record("signal.json", { signal: "SIGTERM" });
  process.exit(143);
});

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  record("invocation.json", {
    argv: process.argv.slice(2),
    depth: process.env.PI_SUBAGENT_DEPTH ?? null,
    cwd: process.cwd(),
    prompt,
  });

  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  const emit = (message) => {
    const line = JSON.stringify({ type: "message_end", message });
    if (process.env.FAKE_PI_SPLIT === "1") {
      // Half a line, then the rest: the extension must reassemble the stream.
      const half = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, half));
      return new Promise((resolve) =>
        setTimeout(() => {
          process.stdout.write(`${line.slice(half)}\n`);
          resolve();
        }, 40),
      );
    }
    process.stdout.write(`${line}\n`);
    return Promise.resolve();
  };

  if (process.env.FAKE_PI_JUNK === "1") {
    process.stdout.write("this line is not json\n");
    process.stdout.write(`${JSON.stringify({ type: "message_end" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "other_event", message: { role: "assistant", content: [] } })}\n`);
  }

  await emit({ role: "user", content: [{ type: "text", text: prompt }] });

  const turns = process.env.FAKE_PI_TURNS ? JSON.parse(process.env.FAKE_PI_TURNS) : [{ text: process.env.FAKE_PI_ANSWER ?? "The answer." }];

  for (const turn of turns) {
    const content = [{ type: "text", text: turn.text }];
    if (turn.toolCall) {
      content.push({ type: "toolCall", id: `call-${turn.toolCall}`, name: turn.toolCall, arguments: { note: "from the subagent" } });
    }
    await emit({
      role: "assistant",
      model: turn.model ?? "fake/model",
      stopReason: turn.stopReason ?? "stop",
      ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      content,
    });
    if (turn.toolCall) {
      await emit({ role: "toolResult", toolCallId: `call-${turn.toolCall}`, content: [{ type: "text", text: "tool output" }] });
    }
  }

  if (process.env.FAKE_PI_STDERR) {
    process.stderr.write(process.env.FAKE_PI_STDERR);
  }

  process.exit(Number(process.env.FAKE_PI_EXIT ?? 0));
});
