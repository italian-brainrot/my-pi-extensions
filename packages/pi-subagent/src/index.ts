/**
 * Simple Subagent Tool
 *
 * Delegates a prompt to a subagent running the same model in an isolated process.
 * The prompt is piped to the nested `pi` on stdin, and the nested run reports no
 * `subagent` tool of its own, so delegation does not cascade.
 *
 * The subagent's token use and cost are returned as the tool result's `usage`, so
 * session totals and the cost breakdown include what the subagent spent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const COLLAPSED_ITEM_COUNT = 10;

/**
 * Nesting guard. A subagent runs a nested pi, which loads this extension again,
 * so the child is not handed the `subagent` tool back. Set PI_SUBAGENT_MAX_DEPTH
 * to allow deeper delegation.
 */
const CURRENT_DEPTH = readNonNegativeInt(process.env.PI_SUBAGENT_DEPTH, 0);
const MAX_DEPTH = readNonNegativeInt(process.env.PI_SUBAGENT_MAX_DEPTH, 1);

/** Subagent stderr is a diagnostic, so keep only its tail. */
const MAX_STDERR_CHARS = 64_000;

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
  /** Per-component costs, needed to report usage the way pi records it. */
  costParts: { input: number; output: number; cacheRead: number; cacheWrite: number };
  totalTokens: number;
  reasoning?: number;
  cacheWrite1h?: number;
}

interface SubagentDetails {
  prompt: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface RunResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function addTokens(current: number, value: unknown): number {
  return current + toFiniteNumber(value, 0);
}

function extractCost(value: unknown): number {
  if (typeof value === "number") {
    return toFiniteNumber(value, 0);
  }

  if (value && typeof value === "object") {
    return toFiniteNumber((value as Record<string, unknown>).total, 0);
  }

  return 0;
}

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    totalTokens: 0,
  };
}

function accumulateUsage(target: UsageStats, source: Record<string, any> | undefined): void {
  if (!source) return;

  target.input = addTokens(target.input, source.input);
  target.output = addTokens(target.output, source.output);
  target.cacheRead = addTokens(target.cacheRead, source.cacheRead);
  target.cacheWrite = addTokens(target.cacheWrite, source.cacheWrite);

  if (Number.isFinite(source.cacheWrite1h)) {
    target.cacheWrite1h = toFiniteNumber(target.cacheWrite1h, 0) + source.cacheWrite1h;
  }
  if (Number.isFinite(source.reasoning)) {
    target.reasoning = toFiniteNumber(target.reasoning, 0) + source.reasoning;
  }

  const totalTokens = toFiniteNumber(source.totalTokens, 0);
  if (totalTokens > 0) {
    // `totalTokens` is the context size of one response: the largest is the
    // live context, the sum is the usage total.
    target.totalTokens += totalTokens;
    target.contextTokens = Math.max(target.contextTokens, totalTokens);
  }

  const cost = source.cost;
  if (typeof cost === "number") {
    target.cost += toFiniteNumber(cost, 0);
  } else if (cost && typeof cost === "object") {
    target.cost += extractCost(cost);
    target.costParts.input += toFiniteNumber(cost.input, 0);
    target.costParts.output += toFiniteNumber(cost.output, 0);
    target.costParts.cacheRead += toFiniteNumber(cost.cacheRead, 0);
    target.costParts.cacheWrite += toFiniteNumber(cost.cacheWrite, 0);
  }
}

/**
 * The subagent's model calls happen in another process, so pi cannot see them.
 * Reporting them as the tool result's `usage` is what keeps the session cost
 * total and the per-model cost breakdown accurate.
 */
function toProviderUsage(usage: UsageStats): Usage {
  const providerUsage: Usage = {
    input: toFiniteNumber(usage.input, 0),
    output: toFiniteNumber(usage.output, 0),
    cacheRead: toFiniteNumber(usage.cacheRead, 0),
    cacheWrite: toFiniteNumber(usage.cacheWrite, 0),
    totalTokens: toFiniteNumber(usage.totalTokens, 0),
    cost: {
      input: toFiniteNumber(usage.costParts.input, 0),
      output: toFiniteNumber(usage.costParts.output, 0),
      cacheRead: toFiniteNumber(usage.costParts.cacheRead, 0),
      cacheWrite: toFiniteNumber(usage.costParts.cacheWrite, 0),
      total: toFiniteNumber(usage.cost, 0),
    },
  };

  if (usage.cacheWrite1h !== undefined) providerUsage.cacheWrite1h = toFiniteNumber(usage.cacheWrite1h, 0);
  if (usage.reasoning !== undefined) providerUsage.reasoning = toFiniteNumber(usage.reasoning, 0);

  return providerUsage;
}

function formatTokens(count: number): string {
  const n = toFiniteNumber(count, 0);

  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];

  const turns = toFiniteNumber(usage.turns, 0);
  const input = toFiniteNumber(usage.input, 0);
  const output = toFiniteNumber(usage.output, 0);
  const cacheRead = toFiniteNumber(usage.cacheRead, 0);
  const cacheWrite = toFiniteNumber(usage.cacheWrite, 0);
  const cost = toFiniteNumber(usage.cost, 0);
  const contextTokens = toFiniteNumber(usage.contextTokens, 0);

  if (turns > 0) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
  if (input > 0) parts.push(`↑${formatTokens(input)}`);
  if (output > 0) parts.push(`↓${formatTokens(output)}`);
  if (cacheRead > 0) parts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite > 0) parts.push(`W${formatTokens(cacheWrite)}`);
  if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
  if (contextTokens > 0) parts.push(`ctx:${formatTokens(contextTokens)}`);
  if (model) parts.push(model);

  return parts.join(" ");
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = asString(args.command, "...");
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }

    case "read": {
      const rawPath = asString(args.file_path ?? args.path, "...");
      const filePath = shortenPath(rawPath);

      const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : undefined;
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined;

      let text = themeFg("accent", filePath);

      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;

        if (limit !== undefined && limit > 0) {
          const endLine = startLine + limit - 1;
          text += themeFg("warning", `:${startLine}-${endLine}`);
        } else {
          text += themeFg("warning", `:${startLine}`);
        }
      }

      return themeFg("muted", "read ") + text;
    }

    case "write": {
      const rawPath = asString(args.file_path ?? args.path, "...");
      const filePath = shortenPath(rawPath);
      const content = asString(args.content, "");
      const lines = content.split("\n").length;

      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);

      return text;
    }

    case "edit": {
      const rawPath = asString(args.file_path ?? args.path, "...");
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }

    case "ls": {
      const rawPath = asString(args.path ?? ".", ".");
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }

    case "find": {
      const pattern = asString(args.pattern, "*");
      const rawPath = asString(args.path ?? ".", ".");
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }

    case "grep": {
      const pattern = asString(args.pattern, "");
      const rawPath = asString(args.path ?? ".", ".");
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }

    default: {
      let argsStr: string;
      try {
        argsStr = JSON.stringify(args) ?? "{}";
      } catch {
        argsStr = "[unserializable args]";
      }

      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", asString(toolName, "tool")) + themeFg("dim", ` ${preview}`);
    }
  }
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    const texts: string[] = [];

    for (const part of msg.content) {
      const p = part as any;

      if (p?.type === "text") {
        const text = asString(p.text).trim();
        if (text) texts.push(text);
      }
    }

    if (texts.length > 0) {
      return texts.join("\n\n");
    }
  }

  return "";
}

function isFailedResult(exitCode: number, stopReason?: string): boolean {
  return exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    for (const part of msg.content) {
      const p = part as any;

      if (p?.type === "text") {
        const text = asString(p.text);
        if (text) items.push({ type: "text", text });
      } else if (p?.type === "toolCall") {
        items.push({
          type: "toolCall",
          name: asString(p.name, "tool"),
          args: (p.arguments ?? {}) as Record<string, any>,
        });
      }
    }
  }

  return items;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript) {
    try {
      if (fs.statSync(currentScript).isFile()) {
        return { command: process.execPath, args: [currentScript, ...args] };
      }
    } catch {
      // Fall through.
    }
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function runSubagent(
  cwd: string,
  model: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);

  const currentResult: RunResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model,
  };

  if (signal?.aborted) {
    currentResult.exitCode = 1;
    currentResult.stopReason = "aborted";
    currentResult.errorMessage = "Subagent was aborted before it started";
    return currentResult;
  }

  let wasAborted = false;
  let stdinError: Error | undefined;

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);

    // The prompt travels on stdin, which is how pi reads piped input. That keeps a
    // long prompt out of the argument list, keeps a prompt starting with "-" or "@"
    // out of the CLI parser, and stops the prompt reaching the model twice.
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT_DEPTH: String(CURRENT_DEPTH + 1) },
    });

    proc.stdin?.on("error", (err) => {
      stdinError = err instanceof Error ? err : new Error(String(err));
    });
    proc.stdin?.end(prompt);

    let buffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    let abortListener: (() => void) | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = () => {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }

      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      // `message_end` is the authoritative record for every role: the starting user
      // message, assistant responses, and tool results. JSON mode has no
      // `tool_result_end` event, so that name would silently match nothing.
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);

        if (msg.role === "assistant") {
          currentResult.usage.turns++;
          accumulateUsage(currentResult.usage, (msg as any).usage);

          if (!currentResult.model && (msg as any).model) {
            currentResult.model = asString((msg as any).model);
          }

          if ((msg as any).stopReason) {
            currentResult.stopReason = asString((msg as any).stopReason);
          }

          if ((msg as any).errorMessage) {
            currentResult.errorMessage = asString((msg as any).errorMessage);
          }
        }
      }
    };

    const finish = (code: number) => {
      if (settled) return;

      settled = true;

      buffer += stdoutDecoder.end();
      currentResult.stderr += stderrDecoder.end();

      if (buffer.trim()) {
        processLine(buffer);
      }

      cleanup();
      resolve(code);
    };

    proc.stdout?.on("data", (data: Buffer) => {
      buffer += stdoutDecoder.write(data);

      const messageLines = buffer.split("\n");
      buffer = messageLines.pop() || "";

      for (const line of messageLines) {
        processLine(line);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      currentResult.stderr += stderrDecoder.write(data);
      if (currentResult.stderr.length > MAX_STDERR_CHARS) {
        currentResult.stderr = currentResult.stderr.slice(-MAX_STDERR_CHARS);
      }
    });

    proc.on("close", (code) => {
      finish(code ?? 0);
    });

    proc.on("error", (err) => {
      if (!currentResult.errorMessage) {
        currentResult.errorMessage = `Failed to start subagent: ${err.message}`;
      }

      finish(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;

        try {
          proc.kill("SIGTERM");
        } catch {
          // Ignore.
        }

        killTimer = setTimeout(() => {
          if (!proc.killed) {
            try {
              proc.kill("SIGKILL");
            } catch {
              // Ignore.
            }
          }
        }, 5000);

        if (typeof (killTimer as any).unref === "function") {
          (killTimer as any).unref();
        }
      };

      abortListener = killProc;

      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }
  });

  currentResult.exitCode = exitCode;

  if (wasAborted) {
    currentResult.stopReason = "aborted";

    if (!currentResult.errorMessage) {
      currentResult.errorMessage = "Subagent was aborted";
    }

    if (currentResult.exitCode === 0) {
      currentResult.exitCode = 1;
    }
  }

  if (stdinError && !currentResult.errorMessage) {
    currentResult.errorMessage = `Failed to send the prompt to the subagent: ${stdinError.message}`;
  }

  return currentResult;
}

const SubagentParams = Type.Object({
  prompt: Type.String({
    description: "The prompt to send to the subagent",
    minLength: 1,
  }),
});

export default function (pi: ExtensionAPI) {
  if (CURRENT_DEPTH >= MAX_DEPTH) {
    // Running inside a subagent: nested delegation is off by default, so the tool
    // is not offered again and a subagent cannot spawn its own subagents.
    return;
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run a subagent with the same model and tools as the current session. " +
      "Returns the subagent's response. " +
      "Useful for isolated reasoning tasks without consuming the main context.",

    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const prompt = asString(params.prompt);
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const cwd = ctx.cwd || process.cwd();

      if (!prompt.trim()) {
        return {
          content: [{ type: "text", text: "Subagent needs a non-empty prompt." }],
          details: undefined,
          isError: true,
        };
      }

      let result: RunResult;

      try {
        result = await runSubagent(cwd, model, ctx.thinkingLevel, prompt, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        return {
          content: [
            {
              type: "text",
              text: `Subagent failed: ${message}`,
            },
          ],
          details: {
            prompt,
            exitCode: 1,
            messages: [],
            stderr: message,
            usage: emptyUsage(),
            model,
            stopReason: "error",
            errorMessage: message,
          } as SubagentDetails,
          usage: toProviderUsage(emptyUsage()),
          isError: true,
        };
      }

      const isError = isFailedResult(result.exitCode, result.stopReason);
      const finalOutput = getFinalOutput(result.messages);

      // A clean stop reason with a non-zero exit code is still a failure, and saying so
      // keeps the message from reading like "Subagent stop: ...".
      const failureLabel = result.stopReason && result.stopReason !== "stop" ? result.stopReason : `failed (exit code ${result.exitCode})`;

      const details: SubagentDetails = {
        prompt,
        exitCode: result.exitCode,
        messages: result.messages,
        stderr: result.stderr,
        usage: result.usage,
        model: result.model,
        stopReason: result.stopReason,
        errorMessage: result.errorMessage,
      };

      if (isError) {
        const errorText = result.errorMessage || result.stderr.trim() || finalOutput || "(no output)";

        return {
          content: [
            {
              type: "text",
              text: `Subagent ${failureLabel}: ${errorText}`,
            },
          ],
          details,
          usage: toProviderUsage(result.usage),
          isError: true,
        };
      }

      const lengthHint =
        result.stopReason === "length" ? "\n\n[subagent stopped at its output length limit; the answer may be cut off]" : "";

      return {
        content: [
          {
            type: "text",
            text: `${finalOutput || "(no output)"}${lengthHint}`,
          },
        ],
        details,
        usage: toProviderUsage(result.usage),
      };
    },

    renderCall(args, theme, _context) {
      const prompt = asString(args?.prompt);
      const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt || "(empty prompt)";

      const text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", preview);

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;

      if (!details) {
        const first = result.content?.[0];
        const text = first?.type === "text" ? first.text : "(no output)";
        return new Text(text, 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      const exitCode = toFiniteNumber(details.exitCode, 0);
      const isError = isFailedResult(exitCode, details.stopReason);
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

      const messages = Array.isArray(details.messages) ? details.messages : [];
      const displayItems = getDisplayItems(messages);
      const finalOutput = getFinalOutput(messages);

      const usage = details.usage ?? emptyUsage();
      const usageStr = formatUsageStats(usage, details.model);

      const promptText = asString(details.prompt);
      const errorText = isError ? details.errorMessage || (details.stderr ?? "").trim() : "";

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;

        let text = "";

        if (skipped > 0) {
          text += theme.fg("muted", `... ${skipped} earlier items\n`);
        }

        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");

            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }

        return text.trimEnd();
      };

      if (expanded) {
        const container = new Container();

        let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
        if (isError && details.stopReason) {
          header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
        }

        container.addChild(new Text(header, 0, 0));

        if (errorText) {
          container.addChild(new Text(theme.fg("error", `Error: ${errorText}`), 0, 0));
        }

        container.addChild(new Spacer(1));

        container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", promptText || "(empty prompt)"), 0, 0));

        container.addChild(new Spacer(1));

        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

        if (displayItems.length === 0) {
          if (finalOutput.trim()) {
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          } else {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          }
        } else {
          for (const item of displayItems) {
            if (item.type === "toolCall") {
              container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
            } else if (item.text.trim()) {
              container.addChild(new Markdown(item.text.trim(), 0, 0, mdTheme));
            }
          }
        }

        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }

        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;

      if (isError && details.stopReason) {
        text += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
      }

      if (errorText) {
        text += `\n${theme.fg("error", `Error: ${errorText}`)}`;
      } else if (displayItems.length === 0) {
        text += `\n${theme.fg("muted", finalOutput.trim() || "(no output)")}`;
      } else {
        text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;

        if (displayItems.length > COLLAPSED_ITEM_COUNT) {
          text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
      }

      if (usageStr) {
        text += `\n${theme.fg("dim", usageStr)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
