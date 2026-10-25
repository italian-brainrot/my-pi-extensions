/**
 * bg-tasks — simple background bash tasks for pi.
 *
 * Adds a `timeout` argument to the bash tool (default 60s). After timeout,
 * the command is moved to the background with a unique ID and its output is
 * saved to a log file inside the pi temp folder. Set `timeout: 0` to start a
 * command in the background immediately.
 *
 * Two extra tools:
 *   - bg_wait — wait for ANY running background task to finish (default 1 hour)
 *   - bg_stop — stop a background task by ID (SIGTERM, then SIGKILL)
 *
 * Behaviour worth knowing:
 *   - Background jobs are process-scoped, not session-scoped. Their pid and log
 *     path are recorded next to the log, so a reloaded session re-adopts jobs
 *     that are still alive and bg_stop / bg_wait keep working.
 *   - Jobs are killed on real shutdown (reason "quit"). Set
 *     PI_BG_TASKS_KEEP_RUNNING=0 to also kill them on /new, /resume, /fork and
 *     /reload (the previous behaviour).
 *   - Logs live in `<agentDir>/bg-tasks` and are pruned by age and count.
 *   - Finished commands return `structuredContent` (as the built-in bash tool
 *     does) for programmatic callers such as codemode scripts; a command that was
 *     moved to the background returns only its task text, since it has no result.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionToolContext,
  formatSize,
  getAgentDir,
  type TruncationResult,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Constants ────────────────────────────────────────────────────────────────

const LOG_DIR = join(getAgentDir(), "bg-tasks");
const META_SUFFIX = ".json";

const DEFAULT_TIMEOUT_SEC = 60;
/** Same upper bound the built-in bash tool uses (max setTimeout delay). */
const MAX_TIMEOUT_SEC = Math.floor(2_147_483_647 / 1000);
const DEFAULT_BG_WAIT_TIMEOUT_SEC = 3600;
const SIGTERM_GRACE_MS = 5000;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MAX_REGISTRY_SIZE = 200;

/** Logs and their metadata are removed after this age. */
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** Newest logs kept regardless of age (metadata sidecars go with them). */
const MAX_RETAINED_LOGS = 100;

/** Model-facing limits come from pi's own truncation helpers. */
const PARTIAL_PREVIEW_BYTES = 4096;
/** Read the whole log below this size so truncation counts are exact. */
const WHOLE_FILE_READ_CAP = 8 * 1024 * 1024;
/** Cap for `structuredContent.output`, matching the built-in bash tool. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
/** Above this size a running job's log gets flagged in tool results. */
const LARGE_LOG_WARN_BYTES = 50 * 1024 * 1024;

/** How often output is streamed to the UI, and how often adopted jobs are checked. */
const OUTPUT_POLL_MS = 300;
const ADOPTED_POLL_MS = 1000;

/** PI_* variables the built-in tool owns; they must never leak from a parent session. */
const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

// ── Types ────────────────────────────────────────────────────────────────────

type BgStatus = "running" | "completed" | "failed" | "killed" | "exited";

interface BgJob {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  logPath: string;
  metaPath: string;
  startedAt: number;
  status: BgStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Present for jobs this process did not spawn (restored after reload). */
  adopted: boolean;
  /** Set once a kill was requested, so an adopted job reports "killed". */
  killRequested?: boolean;
  proc?: ChildProcess;
  donePromise?: Promise<void>;
  resolveDone?: () => void;
}

/** Shared result shape so every tool branch stays type-checked. */
interface BgToolDetails {
  id?: string;
  status?: BgStatus;
  exitCode?: number | null;
  pid?: number;
  /** Log path, only while the file still exists. */
  logPath?: string;
  /** Same as `logPath`; set when model-facing output was truncated. */
  fullOutputPath?: string;
  truncation?: TruncationResult;
  running?: string[];
  timeout?: number;
}

interface BashParams {
  command: string;
  timeout?: number;
  blocking?: boolean;
}

type BgResult = AgentToolResult<BgToolDetails>;
type AnyToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

// ── Registry ─────────────────────────────────────────────────────────────────

const jobs = new Map<string, BgJob>();

function newId(): string {
  let id: string;
  do {
    let suffix = "";
    for (let i = 0; i < 8; i++) {
      suffix += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)];
    }
    id = `bg-${suffix}`;
  } while (jobs.has(id));
  return id;
}

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never created.
  }
}

function logPathFor(id: string): string {
  return join(LOG_DIR, `${id}.log`);
}

function metaPathFor(id: string): string {
  return join(LOG_DIR, `${id}${META_SUFFIX}`);
}

function getDone(job: BgJob): Promise<void> {
  if (!job.donePromise) {
    if (job.status !== "running") return Promise.resolve();
    let settle: () => void = () => {};
    job.donePromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    job.resolveDone = settle;
  }
  return job.donePromise;
}

function markDone(job: BgJob, exitCode: number | null, signal: NodeJS.Signals | null): void {
  if (job.status !== "running") return;
  job.exitCode = exitCode;
  job.signal = signal;
  // An adopted job has no exit handle, so a kill we requested shows up as
  // "exited" unless the kill request itself is what ended it.
  if (signal || job.killRequested) job.status = "killed";
  else if (exitCode === null) job.status = "exited";
  else job.status = exitCode === 0 ? "completed" : "failed";
  unlinkQuietly(job.metaPath);
  job.resolveDone?.();
  enforceRegistryCap();
}

function enforceRegistryCap(): void {
  if (jobs.size <= MAX_REGISTRY_SIZE) return;
  // Insertion order: drop the oldest finished job. Running jobs are never evicted
  // silently, because that would strand a live process with no way to stop it.
  for (const [id, job] of jobs) {
    if (job.status !== "running") {
      jobs.delete(id);
      if (jobs.size <= MAX_REGISTRY_SIZE) return;
    }
  }
}

function describeJob(job: BgJob, includeId = true): string {
  const label = includeId ? `${job.id}: ` : "";
  if (job.status === "running") return `${label}running (pid ${job.pid})`;
  const code = job.exitCode !== null ? `exit ${job.exitCode}` : job.signal ? `signal ${job.signal}` : "code unknown";
  return `${label}${job.status} (${code})`;
}

function logSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ── Environment and shell resolution ─────────────────────────────────────────

let cachedShell: string | undefined;

function readConfiguredShell(): string | undefined {
  for (const file of [join(process.cwd(), CONFIG_DIR_NAME, "settings.json"), join(getAgentDir(), "settings.json")]) {
    try {
      const settings = JSON.parse(readFileSync(file, "utf8")) as { shellPath?: unknown };
      const configured = typeof settings.shellPath === "string" ? settings.shellPath.trim() : "";
      if (configured) {
        return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
      }
    } catch {
      // Missing or unreadable settings are fine; fall through to the default.
    }
  }
  return undefined;
}

function resolveShell(): string {
  cachedShell ??= readConfiguredShell() ?? "bash";
  return cachedShell;
}

/**
 * Match what the built-in bash tool hands to the shell: pi's own bin dir on
 * PATH, PI_* variables describing the current session, and no PI_* leftovers
 * from a parent pi process.
 */
function buildEnv(ctx: ExtensionToolContext | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const binDir = join(getAgentDir(), "bin");
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (!entries.includes(binDir)) {
    env[pathKey] = [binDir, ...entries].join(delimiter);
  }

  for (const key of SESSION_ENV_KEYS) delete env[key];
  if (ctx) {
    env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) env.PI_SESSION_FILE = sessionFile;
    if (ctx.model) {
      env.PI_PROVIDER = ctx.model.provider;
      env.PI_MODEL = ctx.model.id;
    }
    if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  }

  return env;
}

// ── Spawning ─────────────────────────────────────────────────────────────────

function writeMeta(job: BgJob): void {
  try {
    writeFileSync(
      job.metaPath,
      JSON.stringify({ id: job.id, pid: job.pid, cwd: job.cwd, command: job.command, logPath: job.logPath, startedAt: job.startedAt }),
      "utf8",
    );
  } catch {
    // Metadata is only needed to re-adopt after a reload; losing it is not fatal.
  }
}

/**
 * Start a command with stdout and stderr attached to a log file.
 *
 * The descriptors are handed to the child directly instead of wrapping the
 * command in a shell redirection: a wrapper such as `(cmd) > log 2>&1` breaks
 * heredocs, trailing line continuations, commands that end in a comment, and
 * commands that start with `(`.
 */
function spawnJob(command: string, cwd: string, ctx: ExtensionToolContext | undefined, ref: boolean): BgJob {
  ensureLogDir();
  const id = newId();
  const logPath = logPathFor(id);
  const metaPath = metaPathFor(id);

  const fd = openSync(logPath, "w");
  let proc: ChildProcess;
  try {
    proc = spawn(resolveShell(), ["-c", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", fd, fd],
      env: buildEnv(ctx),
    });
  } finally {
    // The child duplicated the descriptors at spawn; the parent copy is not needed.
    closeSync(fd);
  }

  const job: BgJob = {
    id,
    command,
    cwd,
    pid: proc.pid ?? -1,
    logPath,
    metaPath,
    startedAt: Date.now(),
    status: "running",
    exitCode: null,
    signal: null,
    adopted: false,
    proc,
  };
  getDone(job);
  jobs.set(id, job);
  writeMeta(job);
  enforceRegistryCap();

  proc.on("exit", (code, signal) => markDone(job, code, signal));
  proc.on("error", (err) => {
    const note = `failed to start command with ${resolveShell()}: ${err instanceof Error ? err.message : String(err)}`;
    appendToLog(job.logPath, `\n[bg-tasks] ${note}`);
    markDone(job, 127, null);
  });

  // A background job must never keep the agent process alive, so its handle is
  // unref'd right away. A foreground job stays ref'd: that is what keeps the
  // event loop alive while the command is being awaited. It is unref'd when the
  // command is moved to the background.
  if (!ref) proc.unref();

  return job;
}

function releaseToBackground(job: BgJob): void {
  job.proc?.unref();
}

function appendToLog(path: string, text: string): void {
  try {
    const fd = openSync(path, "a");
    try {
      writeFileSync(fd, text, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    // Losing the note is not worth failing the tool call.
  }
}

function killJob(job: BgJob): void {
  const { pid } = job;
  job.killRequested = true;
  if (pid <= 0) return;

  const signal = (sig: NodeJS.Signals): void => {
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore a missing taskkill.
      }
      return;
    }
    // The child is a process group leader, so signal the whole tree first.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, sig);
        return;
      } catch {
        // Group may be gone while the leader lives on, or vice versa.
      }
    }
  };

  signal("SIGTERM");

  // Deliberately not unref'd and never cleared: a kill in flight is awaited by a tool call or by
  // shutdown, and the grace window must not be cut short by the event loop exiting.
  setTimeout(() => {
    if (job.status === "running") signal("SIGKILL");
  }, SIGTERM_GRACE_MS);
}

// ── Re-adopting jobs after reload or session replacement ─────────────────────

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pruneRetention(): void {
  ensureLogDir();
  let names: string[];
  try {
    names = readdirSync(LOG_DIR);
  } catch {
    return;
  }

  const now = Date.now();
  const logs: { name: string; id: string; mtimeMs: number }[] = [];

  for (const name of names) {
    const path = join(LOG_DIR, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }

    const id = name.endsWith(".log") ? name.slice(0, -4) : name.endsWith(META_SUFFIX) ? name.slice(0, -META_SUFFIX.length) : undefined;
    if (!id?.startsWith("bg-")) continue;

    // Never touch files that belong to a job this runtime is still tracking.
    const tracked = jobs.get(id);
    if (tracked?.status === "running") continue;

    if (now - mtimeMs > RETENTION_MS) {
      unlinkQuietly(path);
      continue;
    }
    if (name.endsWith(".log")) logs.push({ name, id, mtimeMs });
  }

  for (const entry of logs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(MAX_RETAINED_LOGS)) {
    unlinkQuietly(join(LOG_DIR, entry.name));
    unlinkQuietly(metaPathFor(entry.id));
  }
}

let adoptedTimer: NodeJS.Timeout | undefined;

/** Adopted jobs have no child handle, so their end is detected by polling. */
function startAdoptedPoller(): void {
  if (adoptedTimer) return;

  adoptedTimer = setInterval(() => {
    let anyAdopted = false;
    for (const job of jobs.values()) {
      if (!job.adopted || job.status !== "running") continue;
      if (isAlive(job.pid)) {
        anyAdopted = true;
        continue;
      }
      markDone(job, null, null);
    }
    if (!anyAdopted) {
      clearInterval(adoptedTimer);
      adoptedTimer = undefined;
    }
  }, ADOPTED_POLL_MS);
  adoptedTimer.unref?.();
}

function adoptJobs(): void {
  pruneRetention();

  let names: string[];
  try {
    names = readdirSync(LOG_DIR);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.endsWith(META_SUFFIX)) continue;
    const id = name.slice(0, -META_SUFFIX.length);
    if (!id.startsWith("bg-") || jobs.has(id)) continue;

    const metaPath = join(LOG_DIR, name);
    let meta: { pid?: unknown; command?: unknown; cwd?: unknown; startedAt?: unknown; logPath?: unknown };
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
    } catch {
      unlinkQuietly(metaPath);
      continue;
    }

    const pid = typeof meta.pid === "number" ? meta.pid : Number.NaN;
    if (!Number.isFinite(pid) || !isAlive(pid)) {
      unlinkQuietly(metaPath);
      continue;
    }

    const job: BgJob = {
      id,
      command: typeof meta.command === "string" ? meta.command : "(command unknown)",
      cwd: typeof meta.cwd === "string" ? meta.cwd : process.cwd(),
      pid,
      logPath: typeof meta.logPath === "string" ? meta.logPath : logPathFor(id),
      metaPath,
      startedAt: typeof meta.startedAt === "number" ? meta.startedAt : Date.now(),
      status: "running",
      exitCode: null,
      signal: null,
      adopted: true,
    };
    jobs.set(id, job);
    getDone(job);
  }

  enforceRegistryCap();
  if ([...jobs.values()].some((job) => job.adopted && job.status === "running")) startAdoptedPoller();
}

// ── Reading output ───────────────────────────────────────────────────────────

function readTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(path, "r");
    try {
      // Re-check the size: the file may have grown between stat and read.
      const currentSize = statSync(path).size;
      const pos = Math.max(0, currentSize - bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, pos);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

interface LogWindow {
  content: string;
  size: number;
  /** True when only the tail of a large log could be read. */
  windowed: boolean;
}

function readLogWindow(path: string): LogWindow {
  try {
    const size = statSync(path).size;
    if (size === 0) return { content: "", size: 0, windowed: false };
    if (size <= WHOLE_FILE_READ_CAP) {
      return { content: readFileSync(path, "utf8"), size, windowed: false };
    }

    const buffer = Buffer.alloc(WHOLE_FILE_READ_CAP);
    const fd = openSync(path, "r");
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      // Drop the partial first line and any split-codepoint replacement char.
      const content = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .replace(/^[^\n]*\n/, "")
        .replace(/^\uFFFD+/, "");
      return { content, size, windowed: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { content: "", size: 0, windowed: false };
  }
}

function lastLineBytes(content: string): number {
  const end = content.endsWith("\n") ? content.length - 1 : content.length;
  const start = content.lastIndexOf("\n", Math.max(0, end - 1)) + 1;
  return Buffer.byteLength(content.slice(start, end), "utf8");
}

/** Model-facing rendering of a finished job's log, with pi's own limits. */
function formatLog(job: BgJob): { text: string; truncation?: TruncationResult; fullOutputPath?: string } {
  const { content, size, windowed } = readLogWindow(job.logPath);
  if (!content.trim()) return { text: "" };

  const truncation = truncateTail(content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

  if (windowed) {
    return {
      text: `${truncation.content}\n\n[Showing the last ${formatSize(truncation.outputBytes)} of ${formatSize(size)} of output. Full output: ${job.logPath}]`,
      fullOutputPath: job.logPath,
    };
  }

  if (!truncation.truncated) return { text: truncation.content };

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  let note: string;
  if (truncation.lastLinePartial) {
    note = `Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes(content))}). Full output: ${job.logPath}`;
  } else if (truncation.truncatedBy === "lines") {
    note = `Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${job.logPath}`;
  } else {
    note = `Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${job.logPath}`;
  }

  return {
    text: `${truncation.content}\n\n[${note}]`,
    truncation,
    fullOutputPath: job.logPath,
  };
}

function readStructuredOutput(path: string): { content: string; truncated: boolean } {
  try {
    const size = statSync(path).size;
    if (size <= STRUCTURED_OUTPUT_MAX_BYTES) return { content: readFileSync(path, "utf8"), truncated: false };

    // Same as the built-in tool: the script-facing output starts at the beginning.
    const buffer = Buffer.alloc(STRUCTURED_OUTPUT_MAX_BYTES);
    const fd = openSync(path, "r");
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      return { content: buffer.subarray(0, bytesRead).toString("utf8"), truncated: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { content: "", truncated: false };
  }
}

/** Exit code to report, turning signal terminations into 128 + signal number. */
function exitCodeOf(job: BgJob): number {
  if (job.exitCode !== null) return job.exitCode;
  if (job.signal) return 128 + (osConstants.signals[job.signal as keyof typeof osConstants.signals] ?? 0);
  return 1;
}

function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

function wallSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 100) / 10;
}

function oversizedNote(job: BgJob): string {
  const size = logSize(job.logPath);
  return size > LARGE_LOG_WARN_BYTES
    ? `\nWarning: ${job.logPath} is already ${formatSize(size)}. Consider limiting the command's output.`
    : "";
}

// ── Foreground execution with auto-backgrounding ─────────────────────────────

function startOutputPolling(job: BgJob, onUpdate: AgentToolUpdateCallback<BgToolDetails> | undefined): () => void {
  if (!onUpdate) return () => {};

  let lastText = "";
  const timer = setInterval(() => {
    if (job.status !== "running") return;
    const text = readTail(job.logPath, PARTIAL_PREVIEW_BYTES);
    if (text === lastText) return;
    lastText = text;
    onUpdate({ content: [{ type: "text", text }], details: { id: job.id, status: "running", logPath: job.logPath } });
  }, OUTPUT_POLL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}

function backgroundResult(job: BgJob, reason: string | undefined): BgResult {
  const preview = readTail(job.logPath, PARTIAL_PREVIEW_BYTES);
  return {
    content: [
      {
        type: "text",
        text: [
          reason
            ? `Command ${reason} with ID: ${job.id} (pid ${job.pid}).`
            : `Command running in background with ID: ${job.id} (pid ${job.pid}).`,
          `Output is being written to: ${job.logPath}`,
          ...(preview ? ["", "Preview:", preview] : []),
          "",
          "Read the log file to inspect output, bg_wait to wait for it to finish, bg_stop to kill it.",
          oversizedNote(job),
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      } as TextContent,
    ],
    details: { id: job.id, status: job.status, pid: job.pid, logPath: job.logPath },
  };
}

function finishedResult(job: BgJob, aborted: boolean): BgResult {
  const exitCode = exitCodeOf(job);
  const { text, truncation, fullOutputPath } = formatLog(job);

  let statusText = text;
  const failure = aborted
    ? "Command aborted"
    : job.status === "killed"
      ? `Command terminated by signal ${job.signal}`
      : exitCode !== 0
        ? `Command exited with code ${exitCode}`
        : undefined;
  if (failure) statusText = appendStatus(statusText, failure);
  if (!statusText) statusText = "(no output)";

  // Match the built-in tool: the temp log is kept only when output was truncated.
  const kept = Boolean(fullOutputPath);
  if (!kept) {
    unlinkQuietly(job.logPath);
    unlinkQuietly(job.metaPath);
  }

  const full = kept ? readStructuredOutput(job.logPath) : { content: text, truncated: false };

  return {
    content: [{ type: "text", text: statusText } as TextContent],
    details: {
      id: job.id,
      status: job.status,
      exitCode,
      ...(kept ? { logPath: job.logPath, fullOutputPath } : {}),
      ...(truncation ? { truncation } : {}),
    },
    structuredContent: {
      output: full.content,
      truncated: full.truncated,
      ...(full.truncated && fullOutputPath ? { full_output_path: fullOutputPath } : {}),
      exit_code: exitCode,
      wall_time_seconds: wallSeconds(job.startedAt),
    },
    ...(failure ? { isError: true } : {}),
  };
}

async function runWithTimeout(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BgToolDetails> | undefined,
  ctx: ExtensionToolContext | undefined,
): Promise<BgResult> {
  const job = spawnJob(command, cwd, ctx, true);
  const stopPolling = startOutputPolling(job, onUpdate);

  if (signal) {
    if (signal.aborted) killJob(job);
    else signal.addEventListener("abort", () => killJob(job), { once: true });
  }

  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, Math.max(0, timeoutSec) * 1000);
    timer.unref?.();
  });
  const abortPromise = new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

  try {
    await Promise.race([getDone(job), timeoutPromise, abortPromise]);

    // An abort starts a kill; give the grace window room to land before deciding.
    if (job.status === "running" && !timedOut) {
      await Promise.race([getDone(job), delay(SIGTERM_GRACE_MS + 1000)]);
    }

    if (job.status === "running") {
      releaseToBackground(job);
      const reason = signal?.aborted
        ? "did not stop after an abort and is still running"
        : `timed out after ${timeoutSec}s and moved to background`;
      return backgroundResult(job, reason);
    }

    return finishedResult(job, signal?.aborted === true);
  } finally {
    stopPolling();
  }
}

/**
 * Bounded wait helper. Its timer is ref'd on purpose: a tool call that is being
 * awaited must keep the event loop alive, otherwise a print/run-mode process can
 * exit while the tool is still waiting.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── Background spawn ─────────────────────────────────────────────────────────

function spawnBackground(command: string, cwd: string, ctx: ExtensionToolContext | undefined): BgResult {
  const job = spawnJob(command, cwd, ctx, false);
  return backgroundResult(job, undefined);
}

// ── Bash tool override ───────────────────────────────────────────────────────

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds before auto-backgrounding (default: ${DEFAULT_TIMEOUT_SEC}). Set to 0 to run in background immediately.`,
    }),
  ),
  blocking: Type.Optional(
    Type.Boolean({
      description:
        "If true (default), the command executes synchronously, one at a time, waiting for any previous blocking command to finish. If false, the command is spawned immediately and may run concurrently with other commands.",
    }),
  ),
});

function resolveTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_TIMEOUT_SEC;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_SEC) {
    throw new Error(`Invalid timeout: use a finite number of seconds between 0 and ${MAX_TIMEOUT_SEC}`);
  }
  return timeout;
}

const BASH_PROMPT_GUIDELINES = [
  "Use timeout: 0 when a command is expected to run for a long time (dev servers, watchers, long builds).",
  "After starting a background command, do NOT wait on it — continue with other work.",
  "Read a task's output with the Read tool on the log file path returned in the result.",
  "Stop a task with bg_stop; wait for any task to finish with bg_wait.",
  "You can inspect PI_* environment variables for current model and session details.",
];

function registerBashOverride(pi: ExtensionAPI): void {
  const original = createBashToolDefinition(process.cwd());

  const execute = async (
    _toolCallId: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BgToolDetails> | undefined,
    ctx: ExtensionToolContext,
  ): Promise<BgResult> => {
    const { command, timeout, blocking } = params;
    const cwd = ctx.cwd || process.cwd();

    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("Command is empty.");
    }

    const resolvedTimeout = resolveTimeout(timeout);

    const run = async (): Promise<BgResult> => {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Command not started: the tool call was aborted." }],
          details: { status: "killed" },
          isError: true,
        };
      }
      if (resolvedTimeout === 0) return spawnBackground(command, cwd, ctx);
      return runWithTimeout(command, cwd, resolvedTimeout, signal, onUpdate, ctx);
    };

    // blocking is the default: commands that share mutable state run one at a time.
    return blocking === false ? run() : withBlockingLock(run);
  };

  const definition = {
    ...original,
    name: "bash",
    label: original.label ?? "bash",
    description:
      `Execute a bash command. Returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. ` +
      `After ${DEFAULT_TIMEOUT_SEC} seconds the command is moved to the background with a unique ID and output is saved to a log file.`,
    promptSnippet: original.promptSnippet ?? "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: BASH_PROMPT_GUIDELINES,
    parameters: bashSchema,
    execute,
  } as unknown as AnyToolDefinition;

  pi.registerTool(definition);
}

// ── bg_stop tool ─────────────────────────────────────────────────────────────

function registerBgStop(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bg_stop",
    label: "Background Task Stop",
    description:
      "Stop a running background task: SIGTERM, then SIGKILL after a 5s grace window if it refuses to exit. Returns the final status.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID (from bash timeout or background spawn)" }),
      reason: Type.Optional(Type.String({ description: "Why the task is being stopped" })),
    }),

    async execute(_toolCallId, params): Promise<BgResult> {
      const { task_id: taskId, reason } = params as { task_id: string; reason?: string };
      const job = jobs.get(taskId);
      if (!job) {
        throw new Error(
          `Unknown task: ${taskId}. The ID comes from the bash result details, and tasks older than the retention window are no longer tracked.`,
        );
      }

      if (job.status !== "running") {
        // A finished command's log is deleted unless its output was truncated, so only
        // point at the file when it is still there.
        const logExists = existsSync(job.logPath);
        return {
          content: [
            {
              type: "text",
              text:
                `Task ${job.id} is already ${describeJob(job, false)}.${reason ? ` Stop reason: ${reason}` : ""}` +
                (logExists ? `\nLog: ${job.logPath}` : ""),
            },
          ],
          details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: logExists ? job.logPath : undefined },
        };
      }

      killJob(job);
      await Promise.race([getDone(job), delay(SIGTERM_GRACE_MS + 1000)]);

      return {
        content: [
          {
            type: "text",
            text: `Task ${job.id} ${job.status === "running" ? "is still shutting down" : `stopped (${job.status})`}.\nLog: ${job.logPath}`,
          },
        ],
        details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath },
      };
    },
  });
}

// ── bg_wait tool ─────────────────────────────────────────────────────────────

type WaitOutcome = { kind: "job" } | { kind: "timeout" } | { kind: "aborted" };

function registerBgWait(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bg_wait",
    label: "Background Task Wait",
    description:
      "Wait for ANY currently running background command to finish (similar to bash `wait -n`). Returns as soon as at least one task finishes. Has a timeout (default 1 hour).",
    parameters: Type.Object({
      timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default: ${DEFAULT_BG_WAIT_TIMEOUT_SEC})` })),
    }),

    async execute(_toolCallId, params, signal): Promise<BgResult> {
      const { timeout } = params as { timeout?: number };
      const timeoutSec = timeout === undefined ? DEFAULT_BG_WAIT_TIMEOUT_SEC : resolveTimeout(timeout);

      const runningJobs = [...jobs.values()].filter((job) => job.status === "running");
      if (runningJobs.length === 0) {
        return { content: [{ type: "text", text: "No background tasks are running." }], details: { running: [] } };
      }

      const jobOutcomes: Promise<WaitOutcome>[] = runningJobs.map(async (job) => {
        await getDone(job);
        return { kind: "job" } as const;
      });

      const timeoutOutcome: Promise<WaitOutcome> = delay(timeoutSec * 1000).then(() => ({ kind: "timeout" }) as const);
      const abortOutcome: Promise<WaitOutcome> = new Promise((resolve) => {
        if (!signal) return;
        if (signal.aborted) resolve({ kind: "aborted" });
        else signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
      });

      const outcome = await Promise.race([...jobOutcomes, timeoutOutcome, abortOutcome]);

      if (outcome.kind === "timeout") {
        return {
          content: [
            {
              type: "text",
              text: `Timeout reached (${timeoutSec} sec). No tasks finished yet. Still running: ${runningJobs.map((job) => job.id).join(", ")}.`,
            },
          ],
          details: { timeout: timeoutSec, running: runningJobs.map((job) => job.id) },
        };
      }

      if (outcome.kind === "aborted") {
        // Background jobs keep running; only the wait was cancelled.
        return {
          content: [
            {
              type: "text",
              text: `Wait aborted. Tasks are still running: ${runningJobs.map((job) => job.id).join(", ")}.`,
            },
          ],
          details: { running: runningJobs.map((job) => job.id) },
          isError: true,
        };
      }

      const finished = runningJobs.filter((job) => job.status !== "running");
      const stillRunning = runningJobs.filter((job) => job.status === "running");

      return {
        content: [
          {
            type: "text",
            text: [
              `${finished.length} task(s) finished:`,
              ...finished.map((job) => describeJob(job)),
              ...(stillRunning.length > 0 ? ["", "Still running:", ...stillRunning.map((job) => describeJob(job))] : []),
            ].join("\n"),
          },
        ],
        details: { running: stillRunning.map((job) => job.id) },
      };
    },
  });
}

// ── Blocking mutex ───────────────────────────────────────────────────────────

let blockingLock: Promise<void> = Promise.resolve();

function withBlockingLock<T>(run: () => Promise<T>): Promise<T> {
  const next = blockingLock.then(run);
  // Advance the chain even when this call rejects, so later calls are never stuck.
  blockingLock = next.then(
    () => {},
    () => {},
  );
  return next;
}

// ── Session lifecycle ────────────────────────────────────────────────────────

function killAllJobs(): Promise<void> {
  const running = [...jobs.values()].filter((job) => job.status === "running");
  if (running.length === 0) return Promise.resolve();
  for (const job of running) killJob(job);
  return Promise.race([Promise.all(running.map(getDone)), delay(SIGTERM_GRACE_MS + 1000)]).then(() => undefined);
}

function keepOnSessionReplacement(): boolean {
  return process.env.PI_BG_TASKS_KEEP_RUNNING !== "0";
}

function registerLifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    // A reload or session replacement drops module state; re-adopt live jobs so
    // bg_stop and bg_wait can still reach them.
    adoptJobs();
  });

  pi.on("session_shutdown", async (event) => {
    const killing = event.reason === "quit" || !keepOnSessionReplacement();
    if (killing) await killAllJobs();
    if (adoptedTimer) {
      clearInterval(adoptedTimer);
      adoptedTimer = undefined;
    }
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  registerBashOverride(pi);
  registerBgStop(pi);
  registerBgWait(pi);
  registerLifecycle(pi);
}
