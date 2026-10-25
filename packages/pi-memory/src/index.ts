/**
 * pi-memory — MEMORY.md in the system prompt, kept up to date by the assistant.
 *
 * Pi injects the project's `AGENTS.md` (or `CLAUDE.md`) into the `<project_context>` section of
 * the system prompt, and that file belongs to the user: it is where they write the spec for a
 * repository. This extension adds a second file with the same discovery rules and the opposite
 * ownership: `MEMORY.md` is the assistant's, so what a session learns can be written down where
 * later sessions will read it without rewriting the user's spec.
 *
 * What happens on each run (`before_agent_start`):
 *   - look for `<agent-dir>/MEMORY.md`, then for `MEMORY.md` in the cwd and every ancestor up to
 *     the filesystem root, in the order Pi uses for `AGENTS.md`: global first, outermost ancestor
 *     next, the cwd's own file last and therefore closest to the end of the prompt;
 *   - append each one found to `systemPromptOptions.contextFiles`, which is what Pi renders as
 *     `<project_instructions path="…">` blocks inside `<project_context>`;
 *   - prepend a short model-facing note saying that the file is the assistant's to maintain;
 *   - change nothing when there is no such file, when it is empty, or when it cannot be read.
 *
 * Files are re-read for every run rather than cached at startup, so an edit made during a session
 * reaches the model on its next prompt as a system-prompt section delta instead of a full prompt
 * replacement, and a file created mid-session is picked up by the run that follows.
 *
 * Configuration, read at startup, so changes need a restart rather than `/reload`:
 *   PI_MEMORY_FILENAME   the file name to look for (default `MEMORY.md`)
 *   PI_MEMORY_MAX_BYTES  most bytes injected per file (default 16384)
 *   PI_MEMORY_DEBUG=1    write one line per run to stderr about what was injected
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_FILENAME = "MEMORY.md";
/** Roughly 4k tokens. A memory file is meant to hold notes, not the repository. */
const DEFAULT_MAX_BYTES = 16 * 1024;

const FILENAME = configuredFilename();
const MAX_BYTES = configuredMaxBytes();
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.PI_MEMORY_DEBUG ?? "");

/** Model-facing text that opens every injected file. Part of the extension's interface. */
const MEMORY_NOTE =
  "Assistant-maintained memory. This file is owned by you (the assistant) and is automatically injected into system message. " +
  "Keep it up to date, and keep it short, because it is loaded into every later session. Use the normal file tools on this path to change it.";

function configuredFilename(): string {
  const value = (process.env.PI_MEMORY_FILENAME ?? "").trim();
  if (!value) return DEFAULT_FILENAME;
  // A search name is a single directory entry, the same kind of thing Pi looks for when it
  // searches for AGENTS.md. A path would silently match nothing, so keep the default and say so.
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
 * Every memory file in scope, in injection order: the agent directory's (global, the same scope
 * as a global AGENTS.md), then ancestors from the outermost in, ending with the cwd's own.
 * Duplicates — symlinks, or an agent directory inside the walked tree — are dropped.
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

// ── Injection ────────────────────────────────────────────────────────────────

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
 * The text to inject for one memory file, or undefined when there is nothing worth injecting.
 * The note comes first so the model reads the ownership rules before the notes themselves.
 */
function renderMemory(raw: string): string | undefined {
  const body = raw.replace(/^\uFEFF/, "").trim();
  if (!body) return undefined;

  const { text, truncated, shownBytes } = limitToBytes(body, MAX_BYTES);
  const marker = truncated
    ? `\n\n[… pi-memory truncated this file at ${shownBytes} of ${Buffer.byteLength(body, "utf8")} bytes; raise the limit with PI_MEMORY_MAX_BYTES …]`
    : "";

  return `${MEMORY_NOTE}\n\n${text}${marker}`;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const options = event.systemPromptOptions;
    if (!options) return undefined;
    if (!Array.isArray(options.contextFiles)) options.contextFiles = [];

    // Pi does not load MEMORY.md itself, but another extension might; never inject a file twice.
    const alreadyInjected = new Set(options.contextFiles.map((file: { path: string }) => canonical(file.path)));

    let added = 0;
    for (const path of findMemoryFiles(ctx.cwd)) {
      if (alreadyInjected.has(canonical(path))) continue;

      const raw = readMemory(path);
      if (raw === undefined) {
        debugLog(`skipping ${path}: could not be read`);
        continue;
      }

      const content = renderMemory(raw);
      if (content === undefined) {
        debugLog(`skipping ${path}: empty`);
        continue;
      }

      options.contextFiles.push({ path, content });
      alreadyInjected.add(canonical(path));
      added++;
      debugLog(`injected ${path} (${Buffer.byteLength(content, "utf8")} bytes)`);
    }

    if (DEBUG) debugLog(added === 0 ? `no ${FILENAME} in scope for ${ctx.cwd}` : `${added} ${FILENAME} added for ${ctx.cwd}`);

    return undefined;
  });
}
