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
 * A chain is one run. The counter sits in the agent dir and outlives the process that wrote it, so a
 * session that did not arrive by takeover starts a new one; otherwise the cap would be a count of every
 * takeover this agent dir has ever seen, and a loop that spent its cap yesterday would be refused before
 * its first handoff today. The chain is what the incoming agent is told about, so it can wind down.
 *
 * The queue is the file. `pending.json` is read on every question about the queue and never copied into
 * memory, because it is on disk precisely so that a `/reload` — which replaces this module and its
 * state — keeps the handoff. A handler that consulted memory instead would find nothing in a reloaded
 * session, which is how the guard rails come undone: the queue would still be there for the settle, so
 * the session gets replaced under a user who has just typed something.
 *
 * A handoff belongs to the session that queued it. Everything that changes the queue is handed the
 * handoff it changes, and a handoff addressed to another session — or to another pi sharing this agent
 * dir — is left exactly where it is: this session may report that a queue exists, but it cannot apply,
 * cancel, or destroy what is in it.
 *
 * What the incoming session knows. Each takeover writes a custom entry into the new session — visible
 * in the transcript, invisible to the model — and the section this extension adds to that session's
 * system prompt is rendered from it, so lineage survives a reload and a resume. It says that the session
 * arrived through a takeover, where the chain stands (its position, and the cap, when there is one), and
 * names the previous session's file. The chain line is there because the cap is the loop's brake, and an
 * agent in an unattended loop that only meets it by being refused cannot wind the loop down.
 *
 * The model survives as well, and only because it is carried. A replacement is Pi's `/new`, which
 * resolves the model from settings, so a model the outgoing agent had switched to — session-scoped, the
 * way Pi keeps it — would be gone in the next session. The outgoing one records its selection in the
 * lineage entry; the incoming one applies it to itself at `session_start`, since `setModel` acts on the
 * session whose `pi` it is called on and the outgoing session's handle is dead by then.
 *
 * Configuration, read when the module loads, so a change needs a restart rather than `/reload`:
 *   PI_TAKEOVER_MAX_CHAIN  takeovers per chain before refusing more (default 12, 0 for unlimited)
 *   PI_TAKEOVER_CONFIRM=1  ask the user before applying a queued handoff
 *   PI_TAKEOVER_NAME=0     do not name the incoming session after its handoff prompt
 *   PI_TAKEOVER_DEBUG=1    write what happened to stderr
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Dropped prompts are kept for a human to read, but only the most recent ones. */
const MAX_DISCARDED_PROMPTS = 20;

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

/** A model selection, in the form a session entry can hold and a later session can look up again. */
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

interface ModelSelection {
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;
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
  /** The model the session it replaced was running on. */
  model?: ModelSelection;
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * The handoff awaiting its turn lives only in PENDING_FILE, never copied into memory.
 *
 * Lineage is not kept here either: it is read from the session's own entries, so it survives everything
 * — a reload, a session replacement, and a resume in a later process.
 */
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

/**
 * Where the next takeover from this session would land in the chain.
 *
 * The file is the chain this agent dir is on. A session that arrived by takeover also knows where it
 * stands, and along one lineage neither the count nor the identity goes backwards: another session
 * sharing the agent dir can reset the file or start a chain of its own, and the next handoff from here is
 * still the next one in the chain this session's own transcript says it is part of.
 */
function nextChainPosition(ctx: ExtensionContext): { position: number; used: number; chainId: string } {
  const chain = readChain();
  const lineage = lineageOf(ctx);

  const used = Math.max(chain?.count ?? 0, lineage?.position ?? 0);
  return { used, position: used + 1, chainId: lineage?.chainId || chain?.id || randomUUID() };
}

// ── The handoff queue ────────────────────────────────────────────────────────

function queueHandoff(prompt: string, ctx: ExtensionContext): PendingHandoff {
  const handoff: PendingHandoff = {
    id: randomUUID(),
    prompt,
    queuedAt: new Date().toISOString(),
    sessionKey: sessionKey(ctx),
  };

  // The queue holds one handoff, so this pushes out whatever is in the file. A handoff this session
  // queued earlier in the same turn is replaced without a word, which is what the tool says it does; one
  // belonging to another session is kept where a human can find it, because it is being destroyed by
  // something that never had the right to.
  const previous = readHandoff();
  if (previous && previous.sessionKey !== handoff.sessionKey) {
    discardHandoff(previous, "another session queued a handoff over it");
  }

  writeJsonFile(PENDING_FILE, handoff);
  debugLog(`queued handoff ${handoff.id} for ${handoff.sessionKey}`);
  return handoff;
}

/** The handoff in the queue, malformed ones rejected. Does not ask who it belongs to. */
function readHandoff(): PendingHandoff | undefined {
  const stored = readJsonFile<PendingHandoff>(PENDING_FILE);
  if (!stored) return undefined;
  if (typeof stored.id !== "string" || !stored.id) return undefined;
  if (typeof stored.prompt !== "string") return undefined;
  if (typeof stored.sessionKey !== "string" || !stored.sessionKey) return undefined;
  if (typeof stored.queuedAt !== "string") return undefined;
  return stored;
}

/**
 * The queued handoff this session owns, restoring it from disk after a `/reload`.
 *
 * A handoff addressed to another session is returned as nothing at all, and untouched: it is that other
 * session's to apply, cancel, or destroy, and this one may be a different pi process altogether.
 *
 * One that has outlived its own session is retired here, out loud. An agent was told the handoff applies
 * at the end of its turn; silence when it does not is the agent believing the loop is still running. The
 * caller that gets `undefined` back has therefore either nothing queued or nothing it may act on, which
 * is every decision these handlers make.
 */
function ownedHandoff(ctx: ExtensionContext): PendingHandoff | undefined {
  const handoff = readHandoff();
  if (!handoff || handoff.sessionKey !== sessionKey(ctx)) return undefined;

  const age = Date.now() - Date.parse(handoff.queuedAt);
  if (!Number.isFinite(age) || age <= PENDING_MAX_AGE_MS) return handoff;

  discardHandoff(handoff, `it was queued ${Math.round(age / 60_000)} minutes ago`);
  notify(
    ctx,
    `Queued takeover expired instead of running: it had waited ${Math.round(age / 60_000)} minutes. The prompt is kept in the takeover state folder.`,
    "warning",
  );
  return undefined;
}

/**
 * Take a handoff out of the queue.
 *
 * It is handed the handoff rather than reaching for whatever happens to be queued: the file can hold a
 * newer one from this session or another, and that one is not this call's to remove.
 */
function claimHandoff(handoff: PendingHandoff): boolean {
  const current = readHandoff();
  if (current && current.id !== handoff.id) return false;
  removeFile(PENDING_FILE);
  return true;
}

function putHandoffBack(handoff: PendingHandoff): void {
  const current = readHandoff();
  if (current && current.id !== handoff.id) {
    debugLog(`handoff ${handoff.id} not put back; the queue holds ${current.id}`);
    return;
  }
  writeJsonFile(PENDING_FILE, handoff);
  debugLog(`handoff ${handoff.id} is queued again`);
}

/** Drop a handoff that will not be applied, keeping its prompt where a human can find it. */
function discardHandoff(handoff: PendingHandoff, reason: string): void {
  if (!claimHandoff(handoff)) {
    debugLog(`handoff ${handoff.id} was already gone; nothing to drop`);
    return;
  }

  // Out of the session, not out of the world: the prompt goes to a file the user can find, since the
  // transcript that queued it is one the user would have to go looking for.
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, `discarded-${handoff.id}.md`), `${handoff.prompt}\n`, "utf8");
  } catch {
    // A copy for looking at later is a courtesy, not a requirement.
  }
  pruneDiscardedPrompts();

  debugLog(`dropped handoff ${handoff.id}: ${reason}; kept a copy in ${STATE_DIR}`);
}

/**
 * Keep the newest dropped prompts and forget the older ones.
 *
 * An unattended loop drops handoffs — at the cap, on an interrupted run, on a quit — and the folder that
 * holds them is in the agent dir, where it would otherwise only ever grow.
 */
function pruneDiscardedPrompts(): void {
  try {
    const kept = readdirSync(STATE_DIR)
      .filter((name) => name.startsWith("discarded-") && name.endsWith(".md"))
      .map((name) => ({ name, mtime: statSync(join(STATE_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const entry of kept.slice(MAX_DISCARDED_PROMPTS)) {
      unlinkSync(join(STATE_DIR, entry.name));
    }
  } catch {
    // The folder being unreadable, or a file vanishing mid-sweep, is not a reason to lose the newest copy.
  }
}

// ── Model-facing text ────────────────────────────────────────────────────────

/**
 * The prompt section this extension owns, which Pi renders as `<takeover>…</takeover>`. It is derived
 * from the session's own lineage entry, so it is the same text on every run of that session, which is
 * what keeps it out of the transcript diff and out of the provider cache's way.
 */
function renderSection(info: TakeoverEntry): string {
  const lines = [`You are spawned by an earlier agent via a takeover.`];

  // The cap is the loop's brake. An agent that only meets it by being refused cannot wind the loop down,
  // so the section says where the chain stands, in the same numbers the transcript marker shows.
  if (info.maxChain > 0) {
    const left = info.maxChain - info.position;
    lines.push(
      left > 0
        ? `This session is takeover #${info.position} of ${info.maxChain} allowed in this chain; ${left} more will start, then the tool refuses.`
        : `This session is takeover #${info.position}, and the chain has reached its cap of ${info.maxChain}: no further takeover will start, so finish the work here and report to the user.`,
    );
  } else {
    lines.push(`This session is takeover #${info.position} in a chain with no cap.`);
  }

  if (info.fromSession) {
    lines.push(`The previous session file is ${info.fromSession} — read it if the handoff left something out.`);
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

/** The model a session is running on, as a lineage entry records it. */
function selectionOf(ctx: ExtensionContext): ModelSelection | undefined {
  const model = ctx.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return undefined;

  const thinkingLevel = ctx.thinkingLevel;
  return { provider: model.provider, id: model.id, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function parseSelection(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== "object") return undefined;

  const { provider, id, thinkingLevel } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;

  return {
    provider,
    id,
    ...(typeof thinkingLevel === "string" ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
  };
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

    const model = parseSelection(data.model);

    return {
      handoffId: typeof data.handoffId === "string" ? data.handoffId : "",
      chainId: typeof data.chainId === "string" ? data.chainId : "",
      position: data.position,
      maxChain: typeof data.maxChain === "number" ? data.maxChain : MAX_CHAIN,
      fromSession: typeof data.fromSession === "string" ? data.fromSession : undefined,
      prompt: typeof data.prompt === "string" ? data.prompt : "",
      ...(model ? { model } : {}),
    };
  }

  return undefined;
}

/**
 * Run the incoming session on the model the session it replaced was on.
 *
 * Only the incoming session can do this, and only before its first message: `setModel` acts on the
 * session whose `pi` it is called on, and the outgoing session's `pi` was invalidated when that session
 * was torn down. So the handoff carries the selection, and this runs at the `session_start` of the
 * session holding the lineage entry — the new one, whose module instance has a `pi` of its own.
 */
async function carryModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const selection = lineageOf(ctx)?.model;
  if (!selection) return undefined;

  const current = ctx.model;
  if (!current || current.provider !== selection.provider || current.id !== selection.id) {
    const target = ctx.modelRegistry?.find?.(selection.provider, selection.id);
    if (!target) {
      notify(ctx, `Takeover cannot keep ${selection.provider}/${selection.id}: that model is not available here.`, "warning");
      return undefined;
    }

    let applied = false;
    try {
      applied = await pi.setModel(target);
    } catch (error) {
      debugLog(`setting ${selection.provider}/${selection.id} failed: ${errorMessage(error)}`);
    }

    if (!applied) {
      // Usually no credentials for that provider. The session still runs, on whatever it picked itself.
      notify(ctx, `Takeover cannot keep ${selection.provider}/${selection.id}: no credentials for it here.`, "warning");
      return undefined;
    }

    debugLog(`the takeover session runs on ${selection.provider}/${selection.id}`);
  } else {
    debugLog(`the takeover session was already on ${selection.provider}/${selection.id}`);
  }

  // A model switch picks a thinking level for the new model; the outgoing session's own level wins.
  // `setThinkingLevel` clamps to what this model can do, as it does for any other level change.
  if (selection.thinkingLevel && selection.thinkingLevel !== ctx.thinkingLevel) {
    pi.setThinkingLevel(selection.thinkingLevel);
    debugLog(`the takeover session thinks at ${selection.thinkingLevel}`);
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

  const handoff = ownedHandoff(ctx);
  if (!handoff) return;
  if (!claimHandoff(handoff)) return;

  // A user-invoked takeover is the human taking the wheel, so it heads a new chain whatever the file or
  // this session's lineage says; an agent-invoked one continues the chain it came from.
  if (options.freshChain) resetChain("a takeover was invoked by the user");
  const { position, chainId } = options.freshChain ? { position: 1, chainId: randomUUID() } : nextChainPosition(ctx);

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

  const selection = selectionOf(ctx);

  const info: TakeoverEntry = {
    handoffId: handoff.id,
    chainId,
    position,
    maxChain: MAX_CHAIN,
    fromSession: ctx.sessionManager.getSessionFile(),
    prompt: handoff.prompt,
    ...(selection ? { model: selection } : {}),
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

    // The agent is about to see its own handoff prompt arrive as a user message, and unless it is told
    // otherwise it will read it as one from the user. Nothing was replaced in this branch, so the
    // outgoing context is still good — Pi invalidates it only when that session is torn down.
    notify(replacement ?? ctx, message, "error");

    // Pi hands `sendUserMessage` to the API and to a replacement context, never to a command context.
    const sender: Addressable | undefined = replacement ?? api;
    try {
      void Promise.resolve(sender?.sendUserMessage(handoff.prompt)).catch((sendError: unknown) => {
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
  discardHandoff(handoff, `the chain cap of ${MAX_CHAIN} was reached at position ${position}`);
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
    description: "Prompt to send to the next agent.",
    minLength: 1,
  }),
});

const takeoverTool: ToolDefinition<typeof TakeoverParams, TakeoverToolDetails> = {
  name: "takeover",
  label: "Takeover",
  description:
    "End this session and hand the work to a fresh agent that starts with only your prompt. " +
    "If running takeover loop, instruct it to also use takeover.",
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

    const replaced = ownedHandoff(ctx);
    const { used, position } = nextChainPosition(ctx);

    if (MAX_CHAIN > 0 && position > MAX_CHAIN) {
      return {
        content: [
          {
            type: "text",
            text:
              `Takeover refused: this chain already used ${used} takeovers and the cap is ${MAX_CHAIN}. ` +
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
    const handoff = ownedHandoff(ctx);
    if (!handoff) return undefined;

    if (event.aborted) {
      discardHandoff(handoff, "the run was interrupted");
      notify(ctx, "Queued takeover dropped: the run was interrupted. The prompt is kept in the takeover state folder.", "warning");
      return undefined;
    }

    pi.sendUserMessage(`/${APPLY_COMMAND}`, { expandPromptTemplates: true });
    return undefined;
  });

  pi.on("input", (event, ctx) => {
    // Anything the user types ends the chain and its queued handoff: from here a human is driving, and
    // a session replaced under them a moment later is a surprise, not autonomy. This has to ask the file
    // and not a memory of it — after a `/reload` the queue is on disk and this module has never seen it,
    // and skipping the question is exactly how a session gets replaced under a user who has just spoken.
    // (A slash command never reaches here at all: Pi dispatches extension commands, and intercepts its
    // own built-ins, before the input handlers. `/new` is caught by the chain reset in `session_start`.)
    if (event.source !== "interactive") return undefined;

    resetChain("the user sent a message");
    capAnnounced.delete(sessionKey(ctx));

    const handoff = ownedHandoff(ctx);
    if (handoff) {
      discardHandoff(handoff, "the user sent a message");
      notify(ctx, "Queued takeover cancelled: you sent a message. The prompt is kept in the takeover state folder.", "info");
    }
    return undefined;
  });

  pi.on("session_start", (event, ctx) => {
    // A session boundary is where lineage is read again: a new session, a resumed one, and `/reload`
    // all look at their own entries on the next run.
    sectionBySession.delete(sessionKey(ctx));

    // A chain belongs to one run. The counter is in the agent dir and outlives the process that wrote
    // it, so a session that did not arrive by takeover starts one — without this, the cap counts every
    // takeover this agent dir has seen since a human last typed something, and the next unattended run
    // is refused before its first handoff. Lineage-aware, because a takeover's own replacement lands
    // here too: the entry the outgoing session wrote in `newSession({ setup })` is already on this
    // session's branch by the time this event fires.
    if ((event.reason === "startup" || event.reason === "new") && !lineageOf(ctx)) {
      resetChain(`a session started (${event.reason}) with no takeover lineage`);
    }

    // A replacement starts on the configured default model, so the incoming session has to be put back
    // on the one the outgoing agent chose. This is the only place that can: the outgoing session's `pi`
    // is dead, and this one's first message is sent once `session_start` handlers have finished.
    if (event.reason === "new") return carryModel(pi, ctx);
    return undefined;
  });

  pi.on("session_shutdown", (event, ctx) => {
    const key = sessionKey(ctx);
    sectionBySession.delete(key);
    capAnnounced.delete(key);

    // A handoff queued in a session that is going away for good must not surface in an unrelated one
    // later. `/reload` and this extension's own replacement ("new") keep it. Asked of the file, not of
    // memory: a session that outlived a `/reload` has a queue this module instance never queued.
    if (event.reason === "quit" || event.reason === "resume" || event.reason === "fork") {
      const handoff = ownedHandoff(ctx);
      if (handoff) discardHandoff(handoff, `the session ${event.reason === "quit" ? "quit" : `was ${event.reason}`}`);
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
    if (expanded && data?.model) {
      const level = data.model.thinkingLevel ? ` at ${data.model.thinkingLevel}` : "";
      text += `\n${theme.fg("dim", `model ${data.model.provider}/${data.model.id}${level}`)}`;
    }
    if (expanded && data?.prompt) text += `\n${theme.fg("muted", data.prompt)}`;

    return new Text(text, 0, 0);
  });

  pi.registerCommand("takeover", {
    description: "Start a fresh session with this prompt now: /takeover [prompt]",
    handler: async (args, ctx) => {
      const prompt = args.trim();

      if (!prompt) {
        const chain = readChain();
        const queued = ownedHandoff(ctx);
        const lineage = lineageOf(ctx);

        const lines = [
          lineage
            ? `This session is takeover #${lineage.position}${lineage.maxChain > 0 ? ` of ${lineage.maxChain}` : ""}.`
            : "This session did not arrive by takeover.",
          chain
            ? `Chain ${chain.id.slice(0, 8)} has used ${chain.count} takeover${chain.count === 1 ? "" : "s"}${MAX_CHAIN > 0 ? ` of ${MAX_CHAIN} allowed` : " (no cap)"}.`
            : "No takeover chain in progress.",
          queued ? "A handoff is queued and will apply when this turn ends." : "No handoff is queued for this session.",
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
      const handoff = ownedHandoff(ctx);
      if (!handoff) {
        notify(ctx, "No handoff is queued for this session.", "info");
        return;
      }
      discardHandoff(handoff, "the user cancelled it");
      notify(ctx, "Queued takeover cancelled; the prompt is kept in the takeover state folder.", "info");
    },
  });

  pi.registerCommand(APPLY_COMMAND, {
    description: "pi-takeover internal: apply the handoff the takeover tool queued",
    handler: async (_args, ctx) => {
      if (!ownedHandoff(ctx)) {
        notify(ctx, "No handoff is queued for this session.", "info");
        return;
      }
      await applyTakeover(ctx, { freshChain: false });
    },
  });
}
