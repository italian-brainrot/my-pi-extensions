/**
 * A scripted model for tests: no network, no reasoning, no waiting.
 *
 * Load it with `-e` next to the extension under test and select `fake/fake`. Every model call picks
 * the first rule of PI_FAKE_RULES whose condition matches the transcript it was shown, so behaviour
 * depends on what the session contains rather than on a counter this file cannot trust: Pi builds a
 * fresh extension instance for every session, and a takeover starts a session.
 *
 * Each call appends what the model was shown to PI_FAKE_LOG, which is how a test sees the context of
 * a session it did not start.
 *
 *   PI_FAKE_RULES='[{"when":{"lastUserIncludes":"REVIEW:"},"respond":{"text":"lgtm"}},
 *                   {"respond":{"toolCall":{"name":"takeover","arguments":{"prompt":"REVIEW: …"}}}}]'
 */

import { appendFileSync } from "node:fs";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface FakeTurn {
  text?: string;
  toolCall?: { name: string; arguments?: Record<string, string | number | boolean> };
}

interface FakeRule {
  when?: {
    /** A string in the text of the latest user message. */
    lastUserIncludes?: string;
    /** A string anywhere in the transcript. */
    transcriptIncludes?: string;
    /** A tool the transcript already called. */
    usedTool?: string;
    /** How many user messages the transcript holds. */
    userMessages?: number;
  };
  respond: FakeTurn;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block.text ?? ""))
    .join("\n");
}

function allText(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      const content = (message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return textOf(message);

      return content
        .map((block: any) => {
          if (block?.type === "text") return String(block.text ?? "");
          if (block?.type === "toolCall") return `${String(block.name ?? "")}(${JSON.stringify(block.arguments ?? {})})`;
          if (block?.type === "toolResult") return textOf(block);
          return "";
        })
        .join("\n");
    })
    .join("\n");
}

export default function (pi: ExtensionAPI): void {
  const rules: FakeRule[] = JSON.parse(process.env.PI_FAKE_RULES ?? "[]");
  const logFile = process.env.PI_FAKE_LOG;
  let call = 0;

  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:9/",
    apiKey: "fake-key",
    api: "fake",
    models: [
      {
        id: "fake",
        name: "Fake scripted model",
        api: "fake",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 1024,
      },
    ],

    streamSimple: (model: Model<any>, context: TranscriptContext, _options?: SimpleStreamOptions) => {
      const messages = Array.isArray(context.messages) ? context.messages : [];
      const users = messages.filter((message: any) => message?.role === "user");
      const lastUser = users.length > 0 ? textOf(users[users.length - 1]) : "";
      const whole = allText(messages);

      if (logFile) {
        appendFileSync(
          logFile,
          `${JSON.stringify({
            call,
            cwd: process.cwd(),
            userCount: users.length,
            lastUser,
            systemTakeoverSection: messages.filter((m: any) => m?.role === "system").map((m: any) => m?.sections?.takeover ?? null),
          })}\n`,
        );
      }

      const rule = rules.find((candidate) => {
        const when = candidate.when;
        if (!when) return true;
        if (when.lastUserIncludes !== undefined && !lastUser.includes(when.lastUserIncludes)) return false;
        if (when.transcriptIncludes !== undefined && !whole.includes(when.transcriptIncludes)) return false;
        if (when.usedTool !== undefined && !whole.includes(`${when.usedTool}(`)) return false;
        if (when.userMessages !== undefined && users.length !== when.userMessages) return false;
        return true;
      })?.respond ?? { text: "no more scripted turns" };

      const stream = createAssistantMessageEventStream();
      const content: AssistantMessage["content"] = [];
      if (rule.text) content.push({ type: "text", text: rule.text });
      if (rule.toolCall) {
        content.push({
          type: "toolCall",
          id: `fake-call-${call}`,
          name: rule.toolCall.name,
          arguments: rule.toolCall.arguments ?? {},
        });
      }

      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: rule.toolCall ? "toolUse" : "stop",
        timestamp: Date.now(),
      };

      stream.push({ type: "start", partial: message });

      let index = 0;
      for (const block of content) {
        if (block.type === "text") {
          stream.push({ type: "text_start", contentIndex: index, partial: message });
          stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
          stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
        } else if (block.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
        }
        index += 1;
      }

      stream.push({ type: "done", reason: rule.toolCall ? "toolUse" : "stop", message });
      stream.end(message);
      call += 1;

      return stream;
    },
  });
}
