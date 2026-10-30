/**
 * pi-memory — MEMORY.md in the system prompt, kept up to date by the assistant.
 *
 * Pi injects the project's `AGENTS.md` (or `CLAUDE.md`) into the `<project_context>` section of the
 * system prompt, and that file belongs to the user: it is where they write the spec for a
 * repository. This extension adds a second file with the same discovery rules and the opposite
 * ownership: `MEMORY.md` is the assistant's, so what a session learns can be written down where
 * later sessions will read it without rewriting the user's spec.
 *
 * What happens per session (`before_agent_start`, the event Pi fires before every run):
 *   - the first run of a session reads the memory files and remembers the result; every later run in
 *     that session reuses it. Like Pi's own context files, MEMORY.md is a startup input: an edit
 *     made while the session is running — by whoever the file's owner is — does not move the prompt,
 *     and so cannot arrive as a system-prompt delta or show up retroactively in the transcript;
 *   - `session_start` forgets what was remembered. That event opens every session boundary: a new
 *     session, a resumed one, a fork, and `/reload`. Each reads MEMORY.md again on its first run, the
 *     way Pi re-reads its own context files, while a session that keeps running does not;
 *   - the discovery order is Pi's for `AGENTS.md`: `<agent-dir>/MEMORY.md` first (global scope), then
 *     `MEMORY.md` in the cwd's ancestors from the outermost in, ending with the cwd's own file, so
 *     the closest file is closest to the end of the section;
 *   - the files go into `systemPromptOptions.sections["assistant_memory"]`, which Pi renders as its
 *     own prompt section holding one `<memory path="…">` block per file — deliberately not
 *     `contextFiles`, because those render as `<project_instructions>` and would put the assistant's
 *     notes in the same kind of tag as the user's `AGENTS.md`;
 *   - the section opens with a short model-facing note, outside the tags, the way Pi opens
 *     `<project_context>` with its own lead-in line. It owns the genre of the file: the assistant's
 *     spec of the system, not a log of the sessions that worked on it;
 *   - change nothing when there is no such file, when it is empty, or when it cannot be read.
 *
 * A section whose text never changes is what the transcript needs: Pi diffs prompt sections against
 * the system message it is replaying and only patches what differs, so a stable section is written
 * once and left alone. Re-reading and re-rendering MEMORY.md on each run would make every run look
 * like a prompt change (invalidating the upstream prompt cache each time it does) and would insert
 * an edit into the transcript after the messages it describes.
 *
 * Configuration, read when the extension module loads, so changes need a restart rather than
 * `/reload`:
 *   PI_MEMORY_FILENAME   the file name to look for (default `MEMORY.md`)
 *   PI_MEMORY_MAX_BYTES  most bytes injected per file (default 16384)
 *   PI_MEMORY_DEBUG=1    write lines to stderr about what was injected and when
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_FILENAME = "MEMORY.md";
/** Roughly 4k tokens. A memory file is meant to hold notes, not the repository. */
const DEFAULT_MAX_BYTES = 16 * 1024;

const FILENAME = configuredFilename();
const MAX_BYTES = configuredMaxBytes();
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.PI_MEMORY_DEBUG ?? "");

/**
 * How many sessions' memory to remember. Each entry is one session's rendered section, so the cap
 * costs little; eviction only protects a long-lived process that keeps swapping sessions.
 */
const SNAPSHOT_LIMIT = 16;

function configuredFilename(): string {
  const value = (process.env.PI_MEMORY_FILENAME ?? "").trim();
  if (!value) return DEFAULT_FILENAME;
  // A search name is a single directory entry, the same kind of thing Pi looks for when it searches
  // for AGENTS.md. A path would silently match nothing, so keep the default and say so.
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    process.stderr.write(`pi-memory: ignoring PI_MEMORY_FILENAME "${value}", which is not a file name; using "${DEFAULT_FILENAME}".\n`);
    return DEFAULT_FILENAME;
  }
  return value;
}

function configuredMaxBytes(): number {
  const raw = (process.env.PI_MEMORY_MAX_BYTES ?? "").trim();
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(`pi-memory: ignoring PI_MEMORY_MAX_BYTES "${raw}", which is not a positive byte count.\n`);
    return DEFAULT_MAX_BYTES;
  }
  return parsed;
}

function debugLog(message: string): void {
  if (DEBUG) process.stderr.write(`pi-memory: ${message}\n`);
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** Identity, for deduplicating a file reached through a symlink or through both roots. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The memory file in `dir`, or undefined when it is missing or is not a regular file. */
function memoryFileIn(dir: string): string | undefined {
  const path = join(dir, FILENAME);
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    // Missing, unreadable directory, or a permission error on the way up: nothing to inject.
    return undefined;
  }
}

/**
 * Every memory file in scope, in injection order: the agent directory's (global, the same scope as a
 * global AGENTS.md), then ancestors from the outermost in, ending with the cwd's own. Duplicates —
 * symlinks, or an agent directory inside the walked tree — are dropped.
 */
function findMemoryFiles(cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (path: string | undefined): void => {
    if (!path) return;
    const key = canonical(path);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(path);
  };

  add(memoryFileIn(getAgentDir()));

  const ancestors: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const file = memoryFileIn(dir);
    if (file) ancestors.unshift(file);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const file of ancestors) add(file);

  return found;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The prompt section this extension owns. Pi wraps its content in `<assistant_memory>…
 * </assistant_memory>`, and the memory files inside it get their own `<memory path="…">` tags — the
 * same two-level shape Pi uses for `<project_context>` and `<project_instructions>`.
 */
export const SECTION_NAME = "assistant_memory";

/**
 * Model-facing text that opens the section, outside the `<memory>` tags, the way Pi's lead-in line
 * opens `<project_context>`. Part of the extension's interface; tests assert where it goes, not what
 * it says, so rewording it is a deliberate edit and not a test failure.
 *
 * It says what the file is *for*, because that is the part a model gets wrong on its own: an
 * assistant left with a scratch file keeps a diary of its sessions — dated entries, what it did, how
 * it debugged — which is history the transcript already has and no description of the system. The
 * note asks for the other thing: the specification of how things work now, for everything the user's
 * `AGENTS.md` does not settle. Keep it one paragraph (a blank line would read as a block boundary in
 * the section) and keep it roughly this size; it is in every session's prompt.
 */
export const MEMORY_NOTE =
  "Assistant-maintained notes, owned by you, injected at the start of every session; edit these files with the normal file tools, and changes reach later sessions, not this one. " +
  "Write the specification of the system as it stands now — what it is, how it works, what to run — covering what AGENTS.md and the code leave unsettled: invariants, constraints, interfaces, gotchas, and decisions with the reason behind them. " +
  "This is not a diary: no dates, no log of what a session did, no retelling of how a problem was tracked down. " +
  "Omit anything the next session can read off the code, the tests, or AGENTS.md, and rewrite or delete an entry when it stops being true instead of appending a correction; the file is only worth its prompt space while it is accurate and short.";

function readMemory(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Cut `text` to `maxBytes` of UTF-8 on a codepoint and line boundary, reporting whether it was cut. */
function limitToBytes(text: string, maxBytes: number): { text: string; truncated: boolean; shownBytes: number } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, truncated: false, shownBytes: total };

  let shown = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  // A slice can end half way through a codepoint, which decodes as a replacement character.
  if (shown.endsWith("\uFFFD")) shown = shown.slice(0, -1);
  const lastNewline = shown.lastIndexOf("\n");
  if (lastNewline > 0) shown = shown.slice(0, lastNewline);

  return { text: shown, truncated: true, shownBytes: Buffer.byteLength(shown, "utf8") };
}

/**
 * The `<memory path="…">` block for one memory file, or undefined when there is nothing worth
 * injecting. The path is an attribute so the model can see which file a block came from and edit it.
 */
function renderMemory(path: string, raw: string): string | undefined {
  const body = raw.replace(/^\uFEFF/, "").trim();
  if (!body) return undefined;

  const { text, truncated, shownBytes } = limitToBytes(body, MAX_BYTES);
  const marker = truncated
    ? `\n\n[… pi-memory truncated this file at ${shownBytes} of ${Buffer.byteLength(body, "utf8")} bytes; raise the limit with PI_MEMORY_MAX_BYTES …]`
    : "";

  return `<memory path="${path}">\n${text}${marker}\n</memory>`;
}

/**
 * Render one session's whole section, or undefined when it has no memory in it. A file Pi already
 * loaded as project context is left out, so the same file is never in the prompt twice.
 */
function renderSection(cwd: string, contextFiles: ReadonlyArray<{ path: string }>): string | undefined {
  const alreadyInPrompt = new Set(contextFiles.map((file) => canonical(file.path)));
  const blocks: string[] = [];

  for (const path of findMemoryFiles(cwd)) {
    if (alreadyInPrompt.has(canonical(path))) {
      debugLog(`skipping ${path}: already in the prompt as project context`);
      continue;
    }

    const raw = readMemory(path);
    if (raw === undefined) {
      debugLog(`skipping ${path}: could not be read`);
      continue;
    }

    const block = renderMemory(path, raw);
    if (block === undefined) {
      debugLog(`skipping ${path}: empty`);
      continue;
    }

    blocks.push(block);
    alreadyInPrompt.add(canonical(path));
    debugLog(`injected ${path} (${Buffer.byteLength(block, "utf8")} bytes)`);
  }

  if (blocks.length === 0) {
    debugLog(`no ${FILENAME} in scope for ${cwd}`);
    return undefined;
  }
  debugLog(`${blocks.length} ${FILENAME} added to <${SECTION_NAME}> for ${cwd}`);

  return [MEMORY_NOTE, ...blocks].join("\n\n");
}

// ── Per-session snapshots ────────────────────────────────────────────────────

/**
 * What each session's first run rendered, keyed by the session file that identifies it. Values are
 * the section text, or undefined when that session's scope had no memory at all, which is a key
 * worth keeping: it says the search already happened, and that this session will stay quiet about
 * memory no matter what the file now holds.
 *
 * A key is dropped by `session_start`, which is how `/reload` of the same session, and `/new`,
 * `/resume`, and `/fork` of a different one, all read the files again.
 */
const bySession = new Map<string, string | undefined>();

/** What identifies a session for snapshot purposes, or undefined when the context has no session. */
function sessionKey(ctx: ExtensionContext): string | undefined {
  const file = ctx.sessionManager?.getSessionFile?.();
  if (typeof file === "string" && file) return `file:${file}`;
  const id = ctx.sessionManager?.getSessionId?.();
  return typeof id === "string" && id ? `id:${id}` : undefined;
}

/** The session's section, rendering it on the first run of that session and keeping it afterward. */
function sectionForSession(ctx: ExtensionContext, cwd: string, contextFiles: ReadonlyArray<{ path: string }>): string | undefined {
  const key = sessionKey(ctx);
  if (key === undefined) {
    // Nothing to key a session by: render, but do not remember it, which is the pre-session state of
    // a hand-built context rather than a real run.
    debugLog("no session file or id in the context; rendering memory without caching it");
    return renderSection(cwd, contextFiles);
  }

  if (!bySession.has(key)) {
    bySession.set(key, renderSection(cwd, contextFiles));
    if (bySession.size > SNAPSHOT_LIMIT) {
      for (const oldest of bySession.keys()) {
        bySession.delete(oldest);
        break;
      }
    }
  }

  return bySession.get(key);
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    // A session boundary is where MEMORY.md is read again, and this event opens all of them: startup,
    // `/new`, `/resume`, `/fork`, and `/reload`. Forgetting what this session had means its next run
    // renders from what the files hold now, which is where Pi re-reads its own context files.
    const key = sessionKey(ctx);
    if (key === undefined) return undefined;
    bySession.delete(key);
    debugLog(`${event.reason}: forgot the memory of ${key}`);
    return undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const options = event.systemPromptOptions;
    if (!options) return undefined;

    // Pi rebuilds the prompt options for every run and diffs the sections that come out of them
    // against the transcript, so the same text every run is what leaves the prompt, and the model's
    // cache, alone. Read only: a session with no memory in scope must not touch anything.
    const contextFiles = Array.isArray(options.contextFiles) ? options.contextFiles : [];
    const section = sectionForSession(ctx, ctx.cwd, contextFiles);

    if (section === undefined) {
      // A run that remembers no memory must not look like it changed the prompt: an empty section
      // here would be a prompt delta.
      if (options.sections) delete options.sections[SECTION_NAME];
    } else {
      if (!options.sections || typeof options.sections !== "object") options.sections = {};
      options.sections[SECTION_NAME] = section;
    }

    return undefined;
  });
}
