/**
 * pi-takeover — hand the session to a fresh agent.
 *
 * Only one conversation fits in the KV cache at a time, so autonomy here cannot come from running
 * agents side by side. It comes from replacing them: `takeover` ends this agent and starts another one
 * whose entire context is the prompt the first one wrote. Implementer, then reviewer, then implementer,
 * until nothing is blocking — one live session the whole way.
 *
 * A takeover is what `/new` does, initiated by the agent instead of the user: Pi tears the current
 * session down (its run is aborted and disposed) and creates a new session file, linked to the old one
 * as its parent, then sends the handoff prompt as that session's first message. The process, the
 * terminal, and the model selection stay; the conversation does not. The outgoing transcript stays on
 * disk, resumable with `/resume`, and its path is given to the incoming agent.
 *
 * Timing. The tool never cuts across a turn: it queues the handoff, and the replacement runs when the
 * run settles (Pi's `agent_settled`, the point where Pi has decided it will not continue on its own).
 * The outgoing session therefore ends with a complete transcript — the tool call, its result, and
 * whatever the agent still wanted to say — and nothing lands between a tool call and its result.
 *
 * Route. Pi gives `newSession()` to user-initiated command handlers only, never to tool execution, so
 * the apply step is an extension command: at settle the extension sends `/takeover-apply` as a user
 * message with `expandPromptTemplates`, which Pi executes as a command and, at that boundary, defers
 * until the settle has finished. That is the only way from a tool call to a session replacement, which
 * is why the tool says the handoff is queued rather than immediate.
 *
 * Loop safety. Takeovers are counted per chain (`<agent-dir>/takeover/chain.json`) and capped by
 * PI_TAKEOVER_MAX_CHAIN, because an implementer/reviewer pair can otherwise ping-pong unattended. At
 * the cap the tool refuses the call; a handoff that reaches the cap already queued is dropped with one
 * message into the current session telling the agent to report to the user instead of continuing. A
 * message typed by the user cancels a queued handoff and resets the chain: a human took the wheel.
 *
 * What the incoming session knows. Each takeover writes a custom entry into the new session — visible
 * in the transcript, invisible to the model — and the section this extension adds to that session's
 * system prompt is rendered from it, so lineage survives a reload and a resume. It states the position
 * in the chain, the remaining budget, and the path of the previous session file.
 *
 * Configuration, read when the module loads, so a change needs a restart rather than `/reload`:
 *   PI_TAKEOVER_MAX_CHAIN  takeovers per chain before refusing more (default 12, 0 for unlimited)
 *   PI_TAKEOVER_CONFIRM=1  ask the user before applying a queued handoff
 *   PI_TAKEOVER_NAME=0     do not name the incoming session after its handoff prompt
 *   PI_TAKEOVER_DEBUG=1    write what happened to stderr
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CustomEntry, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHAIN = 12;

const MAX_CHAIN = configuredCount(process.env.PI_TAKEOVER_MAX_CHAIN, DEFAULT_MAX_CHAIN);
const CONFIRM = isTruthy(process.env.PI_TAKEOVER_CONFIRM);
const NAME_SESSION = !isFalsy(process.env.PI_TAKEOVER_NAME);
const DEBUG = isTruthy(process.env.PI_TAKEOVER_DEBUG);

/** Handoff state lives beside the other extensions' state, because it has to outlive a `/reload`. */
const STATE_DIR = join(getAgentDir(), "takeover");
const PENDING_FILE = join(STATE_DIR, "pending.json");
const CHAIN_FILE = join(STATE_DIR, "chain.json");

/** The internal command that carries a tool call to `newSession()`. */
const APPLY_COMMAND = "takeover-apply";

/** Custom-entry type holding a session's takeover lineage. */
const ENTRY_TYPE = "takeover";

/** A handoff left over from a session that is already gone is dropped past this age. */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function isFalsy(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value ?? "");
}

function configuredCount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    process.stderr.write(`pi-takeover: ignoring PI_TAKEOVER_MAX_CHAIN "${value}", which is not a non-negative integer.\n`);
    return fallback;
  }
  return parsed;
}

function debugLog(message: string): void {
  if (DEBUG) process.stderr.write(`pi-takeover: ${message}\n`);
}

/** Something with a notification channel, which every context has except in a mode without a UI. */
interface Notifiable {
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
}

/**
 * A session something can still be said into. `pi` reaches the session the extension instance was
 * built for; the context a replacement handed back reaches the new one. A command context reaches
 * neither: Pi gives `sendUserMessage` to the API and to a replacement context, not to commands.
 */
interface Addressable extends Notifiable {
  sendUserMessage(content: string): void | Promise<void>;
}

function notify(target: Notifiable, message: string, level: "info" | "warning" | "error" = "info"): void {
  debugLog(`notify(${level}): ${message}`);
  try {
    target.ui?.notify?.(message, level);
  } catch {
    // A UI that refuses a notification is not a reason to stop the takeover.
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

/** A handoff waiting for its session's run to settle. */
interface PendingHandoff {
  id: string;
  prompt: string;
  /** When it was queued, to recognise a leftover from a session that is gone. */
  queuedAt: string;
  /** The session that queued it; a handoff is only ever applied to that session. */
  sessionKey: string;
}

/** How many takeovers the current chain has used. */
interface ChainState {
  id: string;
  count: number;
  updatedAt: string;
}

/** The lineage written into the incoming session, and read back out of it. */
interface TakeoverEntry {
  handoffId: string;
  chainId: string;
  /** This session's 1-based position in the chain. */
  position: number;
  maxChain: number;
  fromSession?: string;
  prompt: string;
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * The handoff awaiting its turn, plus small caches.
 *
 * `pending` mirrors PENDING_FILE, so a `/reload`, which replaces this module's state, still finds the
 * queued handoff. Lineage is deliberately not kept here: it is read from the session's own entries, so
 * it survives everything — a reload, a session replacement, and a resume in a later process.
 */
let pending: PendingHandoff | undefined;
let applying = false;
let api: ExtensionAPI | undefined;

/** Rendered prompt sections by session, and the sessions already told they hit the chain cap. */
const sectionBySession = new Map<string, string>();
const capAnnounced = new Set<string>();

function sessionKey(ctx: ExtensionContext): string {
  const file = ctx.sessionManager?.getSessionFile?.();
  if (typeof file === "string" && file) return `file:${file}`;
  const id = ctx.sessionManager?.getSessionId?.();
  return typeof id === "string" && id ? `id:${id}` : "session:unknown";
}

// ── Files ────────────────────────────────────────────────────────────────────

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Write, then replace, so a reader never sees half a record. */
function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, path);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, which is the usual case.
  }
}

// ── The chain ────────────────────────────────────────────────────────────────

function readChain(): ChainState | undefined {
  const chain = readJsonFile<ChainState>(CHAIN_FILE);
  if (!chain || typeof chain.id !== "string" || typeof chain.count !== "number") return undefined;
  return chain;
}

function resetChain(reason: string): void {
  if (!existsSync(CHAIN_FILE)) return;
  removeFile(CHAIN_FILE);
  debugLog(`chain reset: ${reason}`);
}

/** The position the next takeover would take, and whether the cap has already been reached. */
function nextChainPosition(): { position: number; chain: ChainState | undefined } {
  const chain = readChain();
  return { position: (chain?.count ?? 0) + 1, chain };
}

// ── The handoff queue ────────────────────────────────────────────────────────

function queueHandoff(prompt: string, ctx: ExtensionContext): PendingHandoff {
  const handoff: PendingHandoff = {
    id: randomUUID(),
    prompt,
    queuedAt: new Date().toISOString(),
    sessionKey: sessionKey(ctx),
  };

  pending = handoff;
  writeJsonFile(PENDING_FILE, handoff);
  debugLog(`queued handoff ${handoff.id} for ${handoff.sessionKey}`);
  return handoff;
}

/** The handoff queued for this session, restoring it from disk after a reload. */
function peekHandoff(ctx: ExtensionContext): PendingHandoff | undefined {
  if (!pending) {
    const stored = readJsonFile<PendingHandoff>(PENDING_FILE);
    if (stored && typeof stored.prompt === "string" && typeof stored.sessionKey === "string") {
      pending = stored;
    }
  }

  if (!pending) return undefined;
  if (pending.sessionKey !== sessionKey(ctx)) return undefined;

  const age = Date.now() - Date.parse(pending.queuedAt);
  if (Number.isFinite(age) && age > PENDING_MAX_AGE_MS) {
    debugLog(`handoff ${pending.id} is ${Math.round(age / 1000)}s old; dropping it`);
    discardHandoff("it was queued too long ago");
    return undefined;
  }

  return pending;
}

/** Claim the handoff for application. One caller can win: this is a single thread. */
function claimHandoff(ctx: ExtensionContext): PendingHandoff | undefined {
  const handoff = peekHandoff(ctx);
  if (!handoff) return undefined;

  pending = undefined;
  removeFile(PENDING_FILE);
  return handoff;
}

function putHandoffBack(handoff: PendingHandoff): void {
  pending = handoff;
  writeJsonFile(PENDING_FILE, handoff);
}

function discardHandoff(reason: string): void {
  const handoff = pending;
  pending = undefined;
  removeFile(PENDING_FILE);
  if (!handoff) return;

  // Out of the session, not out of the world: the prompt goes to a file the user can find, since the
  // transcript that queued it is one the user would have to go looking for.
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, `discarded-${handoff.id}.md`), `${handoff.prompt}\n`, "utf8");
  } catch {
    // A copy for looking at later is a courtesy, not a requirement.
  }

  debugLog(`dropped handoff ${handoff.id}: ${reason}; kept a copy in ${STATE_DIR}`);
}

// ── Model-facing text ────────────────────────────────────────────────────────

/**
 * The prompt section this extension owns, which Pi renders as `<takeover>…</takeover>`. It is derived
 * from the session's own lineage entry, so it is the same text on every run of that session, which is
 * what keeps it out of the transcript diff and out of the provider cache's way.
 */
function renderSection(info: TakeoverEntry): string {
  const limit = info.maxChain > 0 ? ` of ${info.maxChain}` : "";
  const lines = [
    `This session is takeover #${info.position}${limit} in a handoff chain: an earlier agent ended its ` +
      "session, and the first prompt you were given is the only thing that carried over. Nothing else from " +
      "that conversation is in your context.",
  ];

  if (info.fromSession) {
    lines.push(`The previous session file is ${info.fromSession} — read it if the handoff left something out.`);
  }

  lines.push(
    "When your part of the work is done, call the takeover tool with a prompt the next agent can act on " +
      "by itself; it ends this session and starts that agent in your place.",
  );

  if (info.maxChain > 0) {
    const remaining = Math.max(info.maxChain - info.position, 0);
    lines.push(`${remaining} takeover${remaining === 1 ? "" : "s"} left in this chain before the cap.`);
  }

  return lines.join("\n\n");
}

/** The name given to an incoming session, so the session picker says what it is for. */
function sessionNameFor(info: TakeoverEntry): string {
  const firstLine =
    info.prompt
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return short ? `takeover #${info.position}: ${short}` : `takeover #${info.position}`;
}

/** This session's lineage: the last takeover entry on the current branch, if it has one. */
function lineageOf(ctx: ExtensionContext): TakeoverEntry | undefined {
  const entries = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(entries)) return undefined;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
    if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;

    const data = entry.data as Partial<TakeoverEntry> | undefined;
    if (!data || typeof data.position !== "number") continue;

    return {
      handoffId: typeof data.handoffId === "string" ? data.handoffId : "",
      chainId: typeof data.chainId === "string" ? data.chainId : "",
      position: data.position,
      maxChain: typeof data.maxChain === "number" ? data.maxChain : MAX_CHAIN,
      fromSession: typeof data.fromSession === "string" ? data.fromSession : undefined,
      prompt: typeof data.prompt === "string" ? data.prompt : "",
    };
  }

  return undefined;
}

// ── Applying a handoff ───────────────────────────────────────────────────────

/**
 * Replace this session with a fresh one that starts with the handoff prompt.
 *
 * `freshChain` puts a user-invoked takeover at the head of a new chain; an agent-invoked one continues
 * the chain it came from.
 */
async function applyTakeover(ctx: ExtensionCommandContext, options: { freshChain: boolean }): Promise<void> {
  if (applying) {
    debugLog("a takeover is already being applied; leaving the handoff queued");
    return;
  }

  const handoff = claimHandoff(ctx);
  if (!handoff) return;

  if (options.freshChain) resetChain("a takeover was invoked by the user");

  const { position, chain } = nextChainPosition();
  const chainId = chain?.id ?? randomUUID();

  if (MAX_CHAIN > 0 && position > MAX_CHAIN) {
    refuseAtCap(ctx, handoff, position);
    return;
  }

  if (CONFIRM && ctx.hasUI) {
    const preview = handoff.prompt.length > 300 ? `${handoff.prompt.slice(0, 300)}…` : handoff.prompt;
    const approved = await ctx.ui.confirm(
      "Take over this session?",
      `${preview}\n\nThe current conversation ends, and this prompt starts a new session.`,
    );
    if (!approved) {
      putHandoffBack(handoff);
      notify(ctx, "Takeover cancelled; the handoff is still queued.", "info");
      debugLog(`handoff ${handoff.id} was not confirmed`);
      return;
    }
  }

  const info: TakeoverEntry = {
    handoffId: handoff.id,
    chainId,
    position,
    maxChain: MAX_CHAIN,
    fromSession: ctx.sessionManager.getSessionFile(),
    prompt: handoff.prompt,
  };

  // Counted before the replacement, not after it: a takeover that fails halfway still has to move the
  // chain, or a broken apply would loop until the cap instead of stopping at it.
  writeJsonFile(CHAIN_FILE, { id: chainId, count: position, updatedAt: new Date().toISOString() } satisfies ChainState);

  applying = true;

  // `ctx` belongs to the session being replaced, and Pi marks it stale the moment that session is torn
  // down. Everything read from it is read here, and the replacement's own context is kept for the
  // error path, which may run after the replacement exists even though the call threw.
  const outgoing = ctx.mode;
  let replacement: Addressable | undefined;

  try {
    const result = await ctx.newSession({
      ...(info.fromSession ? { parentSession: info.fromSession } : {}),
      setup: async (sessionManager) => {
        // A custom entry: visible in the transcript, invisible to the model. Inside the new session it
        // is the only trace of a handoff whose tool call stayed in the previous session.
        sessionManager.appendCustomEntry(ENTRY_TYPE, info);
        if (NAME_SESSION && !sessionManager.getSessionName()) {
          sessionManager.appendSessionInfo(sessionNameFor(info));
        }
      },
      withSession: async (next) => {
        replacement = next;
        sectionBySession.delete(sessionKey(next));
        notify(next, `Takeover #${info.position}: fresh session, started from the handoff prompt.`, "info");

        // A one-shot process would exit with the incoming run still going, so there the handoff is
        // awaited. In the interactive and rpc modes the incoming run is the point of the takeover, and
        // waiting for it here would hold the outgoing session's settle boundary open for its length.
        const started = next.sendUserMessage(handoff.prompt);
        if (next.mode === "tui" || next.mode === "rpc") {
          void started.catch((error: unknown) => notify(next, `Takeover prompt failed: ${errorMessage(error)}`, "error"));
        } else {
          await started;
        }
      },
    });

    if (result.cancelled) {
      putHandoffBack(handoff);
      notify(ctx, "Takeover cancelled before the session was replaced.", "info");
      debugLog(`handoff ${handoff.id} was cancelled by a session_before_switch handler`);
      return;
    }

    debugLog(`took over in ${outgoing}: ${info.fromSession ?? "in-memory session"} (chain ${chainId.slice(0, 8)} #${position})`);
  } catch (error) {
    // Losing the replacement must not lose the work: run the handoff wherever a session is still alive.
    // A throw before the replacement leaves this extension's own `pi`; one after it can only be
    // answered by the context the replacement handed back, because the old session is gone by then.
    const message = `Takeover failed (${errorMessage(error)}); running the prompt in the current session instead.`;
    debugLog(message);

    const target: Addressable | undefined = replacement ?? api;
    notify(target ?? { ui: undefined }, message, "error");

    try {
      void Promise.resolve(target?.sendUserMessage(handoff.prompt)).catch((sendError: unknown) => {
        debugLog(`the fallback prompt failed too: ${errorMessage(sendError)}`);
      });
    } catch (fallbackError) {
      debugLog(`no session was reachable for the fallback prompt: ${errorMessage(fallbackError)}`);
    }
  } finally {
    applying = false;
  }
}

/**
 * The cap ends an unattended loop. The user sees it in the UI; the agent hears it once per session, so
 * the message telling it to stop cannot start a loop of its own.
 */
function refuseAtCap(ctx: ExtensionCommandContext, handoff: PendingHandoff, position: number): void {
  putHandoffBack(handoff);
  discardHandoff(`the chain cap of ${MAX_CHAIN} was reached at position ${position}`);
  notify(ctx, `Takeover refused: this chain reached ${MAX_CHAIN} takeovers (PI_TAKEOVER_MAX_CHAIN).`, "error");

  const key = sessionKey(ctx);
  if (capAnnounced.has(key)) return;
  capAnnounced.add(key);

  api?.sendUserMessage(
    `The takeover chain reached its cap of ${MAX_CHAIN}, so no further takeovers will start. ` +
      "Do not call takeover again. Finish what you can here, then report the state of the work, what is " +
      "left, and what is blocking it.",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Tool ─────────────────────────────────────────────────────────────────────

interface TakeoverToolDetails {
  status: "queued" | "rejected";
  handoffId?: string;
  prompt: string;
  position?: number;
  maxChain: number;
  replaced?: string;
}

const TakeoverParams = Type.Object({
  prompt: Type.String({
    description: "Everything the next agent needs: what to do, what is done, what is blocking. It sees none of this conversation.",
    minLength: 1,
  }),
});

const takeoverTool: ToolDefinition<typeof TakeoverParams, TakeoverToolDetails> = {
  name: "takeover",
  label: "Takeover",
  description:
    "End this session and hand the work to a fresh agent that starts with only your prompt. " +
    "Call it once, as the last thing in a turn: the handoff is applied when the turn ends, not while it runs. " +
    "It returns nothing about the next agent — that agent is a different session.",
  parameters: TakeoverParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const prompt = typeof params?.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt) {
      return {
        content: [{ type: "text", text: "takeover needs a prompt the next agent can act on." }],
        details: { status: "rejected", prompt: "", maxChain: MAX_CHAIN } satisfies TakeoverToolDetails,
        isError: true,
      };
    }

    const replaced = peekHandoff(ctx);
    const { position, chain } = nextChainPosition();

    if (MAX_CHAIN > 0 && position > MAX_CHAIN) {
      return {
        content: [
          {
            type: "text",
            text:
              `Takeover refused: this chain already used ${chain?.count ?? 0} takeovers and the cap is ${MAX_CHAIN}. ` +
              "No new session will start. Finish what you can here, then tell the user the state of the work, " +
              "what is left, and what is blocking it.",
          },
        ],
        details: { status: "rejected", prompt, position, maxChain: MAX_CHAIN } satisfies TakeoverToolDetails,
        isError: true,
      };
    }

    const handoff = queueHandoff(prompt, ctx);
    const limit = MAX_CHAIN > 0 ? ` (takeover ${position}/${MAX_CHAIN} of this chain)` : "";

    return {
      content: [
        {
          type: "text",
          text:
            `Takeover queued${limit}. It applies when this turn ends: the next agent starts with your prompt and nothing else. ` +
            `${replaced ? "It replaces the handoff you queued earlier in this turn. " : ""}` +
            "Do not start new work — say anything you still need to say, then end the turn.",
        },
      ],
      details: {
        status: "queued",
        handoffId: handoff.id,
        prompt,
        position,
        maxChain: MAX_CHAIN,
        replaced: replaced?.id,
      } satisfies TakeoverToolDetails,
    };
  },

  renderCall(args, theme) {
    const prompt = args.prompt ?? "";
    const firstLine =
      prompt
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim() ?? "";
    const preview = firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine || "(empty)";
    return new Text(`${theme.fg("toolTitle", theme.bold("takeover "))}${theme.fg("dim", preview)}`, 0, 0);
  },

  renderResult(result, { expanded }, theme) {
    const details = result.details as TakeoverToolDetails | undefined;
    if (!details) {
      const first = result.content?.[0];
      return new Text(first?.type === "text" ? first.text : "(no result)", 0, 0);
    }

    const mark = details.status === "queued" ? theme.fg("success", "✓ queued") : theme.fg("error", "✗ refused");
    const chain = details.maxChain > 0 && details.position ? ` chain ${details.position}/${details.maxChain}` : "";
    const promptLines = details.prompt.split("\n");
    const body = expanded ? details.prompt : promptLines.slice(0, 3).join("\n");

    let text = `${theme.fg("toolTitle", theme.bold("takeover"))} ${mark}${theme.fg("dim", chain)}`;
    text += `\n${theme.fg("muted", body || "(empty prompt)")}`;
    if (!expanded && promptLines.length > 3) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

    return new Text(text, 0, 0);
  },
};

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // The newest instance owns the route back into the current session. Handlers are per instance, but
  // these module-level helpers are not, and a message has to reach the session that is live now.
  api = pi;

  pi.registerTool(takeoverTool);

  pi.on("agent_settled", (event, ctx) => {
    // The one moment a session can be replaced without cutting across a turn: Pi has decided it will
    // not continue on its own, and it defers a message sent here until the boundary has closed, which
    // is what makes dispatching the apply command from here safe.
    const handoff = peekHandoff(ctx);
    if (!handoff) return undefined;

    if (event.aborted) {
      discardHandoff("the run was interrupted");
      notify(ctx, "Queued takeover dropped: the run was interrupted. The prompt is kept in the takeover state folder.", "warning");
      return undefined;
    }

    pi.sendUserMessage(`/${APPLY_COMMAND}`, { expandPromptTemplates: true });
    return undefined;
  });

  pi.on("input", (event, ctx) => {
    // Anything the user types ends the chain and its queued handoff: from here a human is driving, and
    // a session replaced under them a moment later is a surprise, not autonomy.
    if (event.source !== "interactive") return undefined;

    resetChain("the user sent a message");
    capAnnounced.delete(sessionKey(ctx));
    if (pending) {
      discardHandoff("the user sent a message");
      notify(ctx, "Queued takeover cancelled: you sent a message. The prompt is kept in the takeover state folder.", "info");
    }
    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    // A session boundary is where lineage is read again: a new session, a resumed one, and `/reload`
    // all look at their own entries on the next run.
    sectionBySession.delete(sessionKey(ctx));
  });

  pi.on("session_shutdown", (event, ctx) => {
    const key = sessionKey(ctx);
    sectionBySession.delete(key);
    capAnnounced.delete(key);

    // A handoff queued in a session that is going away for good must not surface in an unrelated one
    // later. `/reload` and this extension's own replacement ("new") keep it.
    if (event.reason === "quit" || event.reason === "resume" || event.reason === "fork") {
      if (pending) discardHandoff(`the session ${event.reason === "quit" ? "quit" : `was ${event.reason}`}`);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const options = event.systemPromptOptions;
    if (!options) return undefined;

    const key = sessionKey(ctx);
    let section = sectionBySession.get(key);

    if (section === undefined) {
      const lineage = lineageOf(ctx);
      if (lineage) {
        section = renderSection(lineage);
        sectionBySession.set(key, section);
      }
    }

    if (section === undefined) {
      // A session that did not arrive by takeover must not look like it changed the prompt.
      if (options.sections) delete options.sections[ENTRY_TYPE];
      return undefined;
    }

    if (!options.sections || typeof options.sections !== "object") options.sections = {};
    options.sections[ENTRY_TYPE] = section;
    return undefined;
  });

  pi.registerEntryRenderer<TakeoverEntry>(ENTRY_TYPE, (entry: CustomEntry<TakeoverEntry>, { expanded }, theme) => {
    const data = entry.data;
    const limit = data && data.maxChain > 0 ? ` of ${data.maxChain}` : "";
    const from = data?.fromSession ? basename(String(data.fromSession)).replace(/\.jsonl$/, "") : "a previous session";

    let text = `${theme.fg("accent", `↳ takeover #${data?.position ?? "?"}${limit}`)} ${theme.fg("dim", `from ${from}`)}`;
    if (expanded && data?.prompt) text += `\n${theme.fg("muted", data.prompt)}`;

    return new Text(text, 0, 0);
  });

  pi.registerCommand("takeover", {
    description: "Start a fresh session with this prompt now: /takeover [prompt]",
    handler: async (args, ctx) => {
      const prompt = args.trim();

      if (!prompt) {
        const chain = readChain();
        const queued = peekHandoff(ctx);
        const lineage = lineageOf(ctx);

        const lines = [
          lineage
            ? `This session is takeover #${lineage.position}${lineage.maxChain > 0 ? ` of ${lineage.maxChain}` : ""}.`
            : "This session did not arrive by takeover.",
          chain
            ? `Chain ${chain.id.slice(0, 8)} has used ${chain.count} takeover${chain.count === 1 ? "" : "s"}${MAX_CHAIN > 0 ? ` of ${MAX_CHAIN} allowed` : " (no cap)"}.`
            : "No takeover chain in progress.",
          queued ? "A handoff is queued and will apply when this turn ends." : "No handoff is queued.",
        ];
        notify(ctx, lines.join(" "), "info");
        return;
      }

      queueHandoff(prompt, ctx);
      await applyTakeover(ctx, { freshChain: true });
    },
  });

  pi.registerCommand("takeover-cancel", {
    description: "Discard the handoff the takeover tool queued",
    handler: async (_args, ctx) => {
      if (!peekHandoff(ctx)) {
        notify(ctx, "No handoff is queued for this session.", "info");
        return;
      }
      discardHandoff("the user cancelled it");
      notify(ctx, "Queued takeover cancelled; the prompt is kept in the takeover state folder.", "info");
    },
  });

  pi.registerCommand(APPLY_COMMAND, {
    description: "pi-takeover internal: apply the handoff the takeover tool queued",
    handler: async (_args, ctx) => {
      if (!peekHandoff(ctx)) {
        notify(ctx, "No handoff is queued for this session.", "info");
        return;
      }
      await applyTakeover(ctx, { freshChain: false });
    },
  });
}
