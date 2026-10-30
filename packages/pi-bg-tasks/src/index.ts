/**
 * bg-tasks — simple background bash tasks for pi.
 *
 * Adds a `timeout` argument to the bash tool (default 60s). After timeout,
 * the command is moved to the background with a unique ID and its output is
 * saved to a log file inside the pi temp folder. Set `timeout: 0` to start a
 * command in the background immediately.
 *
 * Two extra tools:
 *   - bg_wait — wait for ANY running background task to finish (default 1 hour), then list every
 *     background task of this session: status, run time, output size, exit code, and log path
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
 *   - Results carry `structuredContent` (as the built-in bash tool does) for programmatic callers
 *     such as codemode scripts: a finished command reports its output, a command moved to the
 *     background only its task text, and bg_wait every background task of the session.
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
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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

/**
 * Limits for counting a job's output. A whole-file scan is capped so a runaway log cannot stall a
 * tool call; past the cap the byte count stays exact and lines/chars are reported as lower bounds.
 */
const COUNT_CHUNK_BYTES = 1024 * 1024;
const COUNT_SCAN_CAP_BYTES = 16 * 1024 * 1024;
/** Commands are shown on one line in the task listing. */
const LISTING_COMMAND_CHARS = 100;
/** Cap on the model-facing listing; `details.tasks` still carries all of them. */
const LISTING_MAX_TASKS = 30;

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
  /** Set when the job stopped running, so run time stops growing. */
  finishedAt?: number;
  /** Present for jobs this process did not spawn (restored after reload). */
  adopted: boolean;
  /**
   * True once the job is a *background task*: spawned with `timeout: 0`, released to the background
   * at the timeout, or adopted from another runtime. Foreground commands that finished inside their
   * timeout are tracked (so they can still be killed) but are not listed or waited on as background
   * tasks, and their logs are already gone.
   */
  backgrounded: boolean;
  /** Set once a kill was requested, so an adopted job reports "killed". */
  killRequested?: boolean;
  proc?: ChildProcess;
  donePromise?: Promise<void>;
  resolveDone?: () => void;
  /** Cached output counts, valid while the log's size and mtime are unchanged. */
  counts?: { size: number; mtimeMs: number; value: OutputCounts };
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
  finished?: string[];
  timeout?: number;
  /** Per-task information, as reported by bg_wait. */
  tasks?: TaskInfo[];
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
  job.finishedAt = Date.now();
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
      JSON.stringify({
        id: job.id,
        pid: job.pid,
        cwd: job.cwd,
        command: job.command,
        logPath: job.logPath,
        startedAt: job.startedAt,
        // Who wrote this. The agent dir is shared by every pi process, and a job belongs to the
        // session that started it: see isOwnedByAnotherSession().
        ownerPid: process.pid,
        backgrounded: job.backgrounded,
      }),
      "utf8",
    );
  } catch {
    // Metadata is only needed to re-adopt after a reload; losing it is not fatal.
  }
}

/** What a sidecar records about a job, as written by writeMeta() and read back by adoptJobs(). */
interface JobMeta {
  id?: unknown;
  pid?: unknown;
  command?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  logPath?: unknown;
  ownerPid?: unknown;
  backgrounded?: unknown;
}

/** Parse a sidecar; undefined when it cannot be read or is not valid JSON. */
function readMeta(metaPath: string): JobMeta | undefined {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as JobMeta;
  } catch {
    return undefined;
  }
}

/**
 * True when a sidecar's command belongs to another live runtime, and is therefore not ours to
 * adopt, stop, or prune.
 *
 * Every pi process shares `<agent-dir>/bg-tasks`: an interactive session, a nested `pi -p` (print
 * or RPC mode, including the one the subagent tool spawns), and any other pi started against the
 * same agent directory all load this extension, and each keeps its own job registry. A nested pi
 * used to adopt whatever sidecars it found and kill them on shutdown, taking out commands another
 * session was still waiting on.
 *
 * `ownerPid` names the owning runtime and is rewritten whenever a runtime adopts a job, so
 * ownership survives a reload and stays correct after a takeover. Two cases have no usable marker:
 * a pid recycled by an unrelated live process, and a sidecar written before `ownerPid` existed.
 * Both are answered from the process table — a command whose parent process is still alive belongs
 * to that runtime, one reparented to init lost its owner, and one whose parent is this process is
 * ours to pick up after a reload. Where the process table cannot be read, an unmarked job is left
 * alone rather than guessed at.
 */
function isOwnedByAnotherSession(meta: JobMeta | undefined): boolean {
  const ownerPid = typeof meta?.ownerPid === "number" ? meta.ownerPid : undefined;
  if (ownerPid !== undefined) return isManagedByOtherProcess(ownerPid);

  const info = procStateAndParent(typeof meta?.pid === "number" ? meta.pid : -1);
  if (info === "absent") return false;
  if (info === undefined || !Number.isFinite(info.ppid)) return true;
  if (info.ppid <= 1) return false;
  return isManagedByOtherProcess(info.ppid);
}

function isManagedByOtherProcess(pid: number): boolean {
  return pid !== process.pid && isAlive(pid);
}

/** Listeners told about every job that becomes a background task, so a wait can pick it up. */
const backgroundListeners = new Set<(job: BgJob) => void>();

/**
 * Start a command with stdout and stderr attached to a log file.
 *
 * The descriptors are handed to the child directly instead of wrapping the
 * command in a shell redirection: a wrapper such as `(cmd) > log 2>&1` breaks
 * heredocs, trailing line continuations, commands that end in a comment, and
 * commands that start with `(`.
 *
 * A background job must never keep the agent process alive, so its handle is unref'd when it is
 * spawned as a background task. A foreground job stays ref'd: that is what keeps the event loop
 * alive while the command is being awaited. It is unref'd when the command is moved to the
 * background.
 */
function spawnJob(command: string, cwd: string, ctx: ExtensionToolContext | undefined, backgrounded: boolean): BgJob {
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
  } catch (error) {
    // Nothing can read an empty log left behind by a command that never started.
    unlinkQuietly(logPath);
    throw error;
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
    backgrounded,
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

  if (backgrounded) {
    proc.unref();
    announceBackground(job);
  }

  return job;
}

/**
 * A foreground job that ran out of its timeout becomes a background task: its output stays in the
 * log, its handle stops holding the event loop, and its sidecar now says what the job really is, so
 * a reload re-adopts it. The caller's abort listener is removed by the caller that owned it: an
 * abort later in the same run must not kill a task that was deliberately left running.
 */
function releaseToBackground(job: BgJob): void {
  job.backgrounded = true;
  job.proc?.unref();
  writeMeta(job);
  announceBackground(job);
}

function announceBackground(job: BgJob): void {
  for (const listener of backgroundListeners) listener(job);
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

  // Unref'd on purpose: whoever asked for this kill awaits it with a timer of their own that holds
  // the event loop, so the escalation must not be the last thing keeping the process alive.
  setTimeout(() => {
    if (job.status === "running") signal("SIGKILL");
  }, SIGTERM_GRACE_MS).unref?.();
}

// ── Re-adopting jobs after reload or session replacement ─────────────────────

/**
 * The process-table fields that matter, read from `/proc/<pid>/stat`. The format is
 * "pid (comm) state ppid …", and comm can contain spaces and parentheses, so the interesting
 * fields start after the last closing paren.
 *
 * Three outcomes, and the difference matters: the process exists and is readable, it is gone
 * ("absent"), or the question cannot be answered (not Linux, or a process we cannot read).
 */
function procStateAndParent(pid: number): { state: string; ppid: number } | "absent" | undefined {
  if (pid <= 0) return "absent";
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    return { state: fields[0] ?? "", ppid: Number.isFinite(ppid) ? ppid : Number.NaN };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : undefined;
  }
}

/**
 * A process signalled but not yet reaped is a zombie: it still answers signal 0, but its command is
 * over. Counting it as running pins an adopted job to "running" forever, and hid the cross-session
 * kill from the first version of the regression test.
 */
function isZombie(pid: number): boolean {
  const info = procStateAndParent(pid);
  return typeof info === "object" && info.state === "Z";
}

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return !isZombie(pid);
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

  // Jobs another live pi session owns are off-limits to us, however old their files look.
  const foreignIds = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(META_SUFFIX)) continue;
    const id = name.slice(0, -META_SUFFIX.length);
    if (id.startsWith("bg-") && isOwnedByAnotherSession(readMeta(join(LOG_DIR, name)))) {
      foreignIds.add(id);
    }
  }

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

    // Never touch files that belong to a job this runtime is still tracking, or to one another
    // session is still running.
    const tracked = jobs.get(id);
    if (tracked?.status === "running" || foreignIds.has(id)) continue;

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
    const meta = readMeta(metaPath);
    if (!meta) {
      unlinkQuietly(metaPath);
      continue;
    }

    // Another live pi process owns this command and will report and stop it itself. Adopting it
    // here would mean this session's shutdown kills a command a different session is waiting on —
    // which is exactly what a nested pi (print mode, RPC mode, or the subagent tool) used to do to
    // its parent. Ownership comes from ownerPid, or, for a sidecar written before that field
    // existed, from the process table. A command whose owner has died is fair game: taking it over
    // is how a dev server left behind by a crashed session can still be stopped.
    if (isOwnedByAnotherSession(meta)) continue;

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
      // Nothing is awaiting an adopted job, so by definition it is a background task.
      backgrounded: true,
    };
    jobs.set(id, job);
    getDone(job);
    // Claim the sidecar, so a later reload of this process finds the job again.
    writeMeta(job);
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

function wallSeconds(job: BgJob): number {
  const end = job.finishedAt ?? Date.now();
  return Math.round((end - job.startedAt) / 100) / 10;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

function oversizedNote(job: BgJob): string {
  const size = logSize(job.logPath);
  return size > LARGE_LOG_WARN_BYTES
    ? `\nWarning: ${job.logPath} is already ${formatSize(size)}. Consider limiting the command's output.`
    : "";
}

// ── Counting and listing background tasks ─────────────────────────────────────

interface OutputCounts {
  bytes: number;
  chars: number;
  lines: number;
  /** True when the scan stopped at the cap, so chars and lines are lower bounds. */
  partial: boolean;
}

/**
 * Count a log in bounded chunks: the file may be megabytes long and is still being written while the
 * task runs. Newlines are counted on the raw bytes, which is exact for UTF-8 (0x0A never appears
 * inside a multi-byte sequence); characters are counted on the decoded text, so a split codepoint at
 * a chunk boundary is not miscounted.
 */
function scanOutputCounts(path: string, size: number): OutputCounts {
  if (size === 0) return { bytes: 0, chars: 0, lines: 0, partial: false };

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let scanned = 0;
    let lines = 0;
    let chars = 0;
    let endsWithNewline = false;

    while (scanned < size && scanned < COUNT_SCAN_CAP_BYTES) {
      const want = Math.min(buffer.length, size - scanned, COUNT_SCAN_CAP_BYTES - scanned);
      const bytesRead = readSync(fd, buffer, 0, want, scanned);
      if (bytesRead === 0) break;
      chars += decoder.write(buffer.subarray(0, bytesRead)).length;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0x0a) lines++;
      }
      endsWithNewline = buffer[bytesRead - 1] === 0x0a;
      scanned += bytesRead;
    }
    chars += decoder.end().length;
    // Pi counts a final line that has no trailing newline; a capped scan counts its last fragment too.
    if (!endsWithNewline) lines++;

    return { bytes: size, chars, lines, partial: scanned < size };
  } catch {
    return { bytes: size, chars: 0, lines: 0, partial: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Counts of a job's log, re-scanned only when the file changed. */
function outputCounts(job: BgJob): OutputCounts {
  let stat: Stats;
  try {
    stat = statSync(job.logPath);
  } catch {
    return { bytes: 0, chars: 0, lines: 0, partial: false };
  }

  const cached = job.counts;
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;

  const value = scanOutputCounts(job.logPath, stat.size);
  job.counts = { size: stat.size, mtimeMs: stat.mtimeMs, value };
  return value;
}

/** One background task, as bg_wait reports it. */
interface TaskInfo {
  id: string;
  status: BgStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number;
  command: string;
  runtimeSeconds: number;
  logPath: string;
  logExists: boolean;
  bytes: number;
  chars: number;
  lines: number;
  countsPartial: boolean;
  adopted: boolean;
}

function taskInfo(job: BgJob): TaskInfo {
  const counts = outputCounts(job);
  return {
    id: job.id,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
    pid: job.pid,
    command: job.command,
    runtimeSeconds: wallSeconds(job),
    logPath: job.logPath,
    logExists: existsSync(job.logPath),
    bytes: counts.bytes,
    chars: counts.chars,
    lines: counts.lines,
    countsPartial: counts.partial,
    adopted: job.adopted,
  };
}

/** Every background task this runtime knows about for the session, running ones first. */
function backgroundTasks(): TaskInfo[] {
  return [...jobs.values()]
    .filter((job) => job.backgrounded)
    .sort((a, b) => {
      const aRunning = a.status === "running";
      const bRunning = b.status === "running";
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      return a.startedAt - b.startedAt;
    })
    .map(taskInfo);
}

function statusColumn(info: TaskInfo): string {
  if (info.status === "running") return `running (pid ${info.pid}${info.adopted ? ", adopted" : ""})`;
  const code = info.exitCode !== null ? `exit ${info.exitCode}` : info.signal ? `signal ${info.signal}` : "code unknown";
  return `${info.status} (${code})`;
}

function truncateOneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** One pair of lines per task: the facts, then the command that produced them. */
function taskListing(infos: TaskInfo[]): string[] {
  const rows = infos.map((info) => {
    const bound = info.countsPartial ? ">=" : "";
    return {
      command: truncateOneLine(info.command, LISTING_COMMAND_CHARS),
      cells: [
        info.id,
        statusColumn(info),
        formatDuration(info.runtimeSeconds),
        `${bound}${info.lines} lines`,
        `${bound}${info.chars} chars`,
        info.logExists ? info.logPath : `(no log: ${info.logPath})`,
      ],
    };
  });

  // Pad every column except the last, where the path reads better unbroken.
  const widths = rows[0]!.cells.map((_, column) => Math.max(...rows.map((row) => row.cells[column]!.length)));
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      row.cells
        .map((cell, column) => (column < row.cells.length - 1 ? cell.padEnd(widths[column]!) : cell))
        .join("  ")
        .trimEnd(),
    );
    if (row.command) lines.push(`  $ ${row.command}`);
  }
  return lines;
}

/** The section bg_wait appends to whatever it was waiting for. */
function taskSection(infos: TaskInfo[]): string[] {
  if (infos.length === 0) return [];

  const running = infos.filter((info) => info.status === "running").length;
  const shown = infos.slice(0, LISTING_MAX_TASKS);
  const omitted = infos.length - shown.length;

  return [
    "",
    `Background tasks in this session (${infos.length} tracked, ${running} running):`,
    "",
    ...taskListing(shown),
    // Running tasks sort first, so anything dropped here is an old finished one.
    ...(omitted > 0 ? ["", `(${omitted} older finished tasks not listed; their logs are in ${LOG_DIR})`] : []),
  ];
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

/**
 * The result for a command that is still running and is now a background task. Whatever the command
 * printed so far is already in the log; say what is not there rather than leaving the model to guess.
 */
function backgroundResult(job: BgJob, reason: string | undefined): BgResult {
  // The preview is trimmed for display, but whether it was cut is judged on what was read, not on
  // what is shown.
  const read = readTail(job.logPath, PARTIAL_PREVIEW_BYTES);
  const readBytes = Buffer.byteLength(read, "utf8");
  const preview = read.trimEnd();
  const size = logSize(job.logPath);
  const previewLabel = size > readBytes ? `Preview (last ${formatSize(readBytes)} of ${formatSize(size)}):` : "Preview:";

  return {
    content: [
      {
        type: "text",
        text: [
          reason
            ? `Command ${reason} with ID: ${job.id} (pid ${job.pid}).`
            : `Command running in background with ID: ${job.id} (pid ${job.pid}).`,
          `Output is being written to: ${job.logPath}`,
          "",
          ...(preview ? [previewLabel, preview] : ["(no output yet)"]),
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
      wall_time_seconds: wallSeconds(job),
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
  const job = spawnJob(command, cwd, ctx, false);
  const stopPolling = startOutputPolling(job, onUpdate);

  // Pi gives one signal to every tool call in a run, so every listener installed here is removed
  // again in the finally: a command that was deliberately released to the background must survive an
  // abort that arrives later in the same run, and long runs must not pile listeners onto one signal.
  const stopKillOnAbort = onAbort(signal, () => killJob(job));
  const timer = sleep(Math.max(0, timeoutSec) * 1000);
  const aborting = abortWatch(signal);

  try {
    const settled = await Promise.race([
      getDone(job).then(() => "done" as const),
      timer.promise.then(() => "timeout" as const),
      aborting.promise,
    ]);

    // An abort starts a kill; give the grace window room to land before deciding.
    if (job.status === "running" && settled !== "timeout") {
      const grace = sleep(SIGTERM_GRACE_MS + 1000);
      await Promise.race([getDone(job), grace.promise]);
      grace.cancel();
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
    timer.cancel();
    aborting.off();
    stopKillOnAbort();
  }
}

/**
 * Bounded wait helper. Its timer is ref'd on purpose: a tool call that is being awaited must keep
 * the event loop alive, otherwise a print/run-mode process can exit while the tool is still waiting.
 * A caller that stops waiting early has to `cancel()`, or a finished tool call keeps holding the
 * process open for the rest of its timeout.
 */
interface Sleeper {
  promise: Promise<void>;
  cancel(): void;
}

function sleep(ms: number): Sleeper {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Attach an abort handler and return its remover.
 *
 * Handlers that are never removed are both a leak and a correctness hazard here: the signal belongs
 * to the whole run, so an abort handler left behind by a call that backgrounded its command would
 * kill that command when the user aborts something else later in the same run.
 */
function onAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    handler();
    return () => {};
  }
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

/** Resolve to "aborted" when the signal aborts; `off` removes the listener again. */
function abortWatch(signal: AbortSignal | undefined): { promise: Promise<"aborted">; off: () => void } {
  let off = () => {};
  const promise = new Promise<"aborted">((resolve) => {
    off = onAbort(signal, () => resolve("aborted"));
  });
  return { promise, off };
}

// ── Background spawn ─────────────────────────────────────────────────────────

function spawnBackground(command: string, cwd: string, ctx: ExtensionToolContext | undefined): BgResult {
  const job = spawnJob(command, cwd, ctx, true);
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
  "bg_stop kills a task; bg_wait waits for any task to finish and lists every background task with its status, run time, output size, and log path.",
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
      const grace = sleep(SIGTERM_GRACE_MS + 1000);
      await Promise.race([getDone(job), grace.promise]);
      grace.cancel();

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

type WaitOutcome = "job" | "timeout" | "aborted" | "none";

/** Task fields in the shape a programmatic caller expects, matching the bash tool's snake_case. */
function structuredTask(info: TaskInfo) {
  return {
    id: info.id,
    status: info.status,
    pid: info.pid,
    exit_code: info.exitCode,
    signal: info.signal,
    command: info.command,
    runtime_seconds: info.runtimeSeconds,
    log_path: info.logPath,
    log_exists: info.logExists,
    bytes: info.bytes,
    chars: info.chars,
    lines: info.lines,
    counts_partial: info.countsPartial,
    adopted: info.adopted,
  };
}

/** Every bg_wait answer: one line about the wait, then the whole task table. */
function waitResult(summary: string, outcome: WaitOutcome, finished: string[], timeoutSec?: number, isError = false): BgResult {
  const infos = backgroundTasks();
  const running = infos.filter((info) => info.status === "running").map((info) => info.id);
  const timedOut = outcome === "timeout";

  return {
    content: [{ type: "text", text: [summary, ...taskSection(infos)].join("\n") } as TextContent],
    details: {
      running,
      finished,
      tasks: infos,
      ...(timedOut ? { timeout: timeoutSec } : {}),
    },
    structuredContent: {
      outcome,
      finished,
      running,
      ...(timedOut ? { timeout: timeoutSec } : {}),
      tasks: infos.map(structuredTask),
    },
    ...(isError ? { isError: true } : {}),
  };
}

function registerBgWait(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bg_wait",
    label: "Background Task Wait",
    description:
      "Wait for ANY running background task to finish (like bash `wait -n`), then list every background task of this " +
      "session with its status, run time, output lines and characters, exit code, and log path. Has a timeout (default 1 hour).",
    parameters: Type.Object({
      timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default: ${DEFAULT_BG_WAIT_TIMEOUT_SEC})` })),
    }),

    async execute(_toolCallId, params, signal): Promise<BgResult> {
      const { timeout } = params as { timeout?: number };
      const timeoutSec = timeout === undefined ? DEFAULT_BG_WAIT_TIMEOUT_SEC : resolveTimeout(timeout);

      // Watched tasks are tracked as they become background tasks, so a command backgrounded while
      // this call is already running is waited on too, and nothing that ends during the wait goes
      // unreported.
      const watched = new Map<string, BgJob>();
      let announce = (_job: BgJob) => {};
      const anyFinished = new Promise<"job">((resolve) => {
        announce = (job) => {
          watched.set(job.id, job);
          void getDone(job).then(() => resolve("job"));
        };
      });
      const listen = (job: BgJob) => {
        if (job.status === "running") announce(job);
      };
      for (const job of jobs.values()) {
        if (job.backgrounded) listen(job);
      }

      if (watched.size === 0) {
        return waitResult("No background tasks are running.", "none", []);
      }
      backgroundListeners.add(listen);

      const timer = sleep(timeoutSec * 1000);
      const aborting = abortWatch(signal);

      let outcome: WaitOutcome;
      try {
        outcome = await Promise.race([anyFinished, timer.promise.then(() => "timeout" as const), aborting.promise]);
      } finally {
        backgroundListeners.delete(listen);
        timer.cancel();
        aborting.off();
      }

      const finishedJobs = [...watched.values()].filter((job) => job.status !== "running");
      const finished = finishedJobs.map((job) => job.id);
      const finishedNote =
        finishedJobs.length > 0
          ? `${finishedJobs.length} task(s) finished: ${finishedJobs.map((job) => describeJob(job)).join(", ")}`
          : "No task finished.";

      if (outcome === "timeout") {
        return waitResult(`Timeout reached (${timeoutSec} sec). ${finishedNote}`, outcome, finished, timeoutSec);
      }
      if (outcome === "aborted") {
        // Background jobs keep running; only the wait was cancelled.
        return waitResult(`Wait aborted; background tasks keep running. ${finishedNote}`, outcome, finished, undefined, true);
      }

      return waitResult(finishedNote, outcome, finished);
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

async function killAllJobs(): Promise<void> {
  const running = [...jobs.values()].filter((job) => job.status === "running");
  if (running.length === 0) return;
  for (const job of running) killJob(job);

  const grace = sleep(SIGTERM_GRACE_MS + 1000);
  try {
    await Promise.race([Promise.all(running.map((job) => getDone(job))), grace.promise]);
  } finally {
    grace.cancel();
  }
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
