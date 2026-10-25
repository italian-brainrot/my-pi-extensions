/**
 * Shared test harness for loading an extension the way Pi loads it, without a model.
 *
 * `loadExtension` imports the package entry point with a recording `ExtensionAPI`, so tests
 * can assert what an extension registers and then call a registered tool's `execute` directly
 * with a hand-built `ExtensionToolContext`. Real processes, real files: only the model is absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ToolExecute = (
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: any) => void) | undefined,
  ctx: ExtensionToolContext,
) => Promise<any>;

export interface RecordedCall {
  prop: string;
  args: unknown[];
}

export interface LoadedExtension {
  /** The recording stand-in handed to the extension factory. */
  api: ExtensionAPI;
  /** Tools the extension registered, by tool name. */
  tools: Map<string, ToolDefinition>;
  /** Event handlers registered with `pi.on(event, handler)`. */
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  /** Every `pi.*` member the extension touched, in order. Fails loudly for unknown members. */
  calls: RecordedCall[];
  agentDir: string;
  cwd: string;
  /** Run a registered tool's execute with a default context. */
  callTool(name: string, params: unknown, options?: CallOptions): Promise<any>;
  /** Build a tool context; every field is overridable per test. */
  makeContext(overrides?: Partial<Record<string, unknown>>): ExtensionToolContext;
  /** Deliver an event to every handler registered for its type, in registration order. */
  emit(event: { type: string; [key: string]: unknown }, ctx?: ExtensionToolContext): Promise<unknown[]>;
  dispose(): void;
}

export interface CallOptions {
  signal?: AbortSignal;
  onUpdate?: (partial: any) => void;
  context?: Partial<Record<string, unknown>>;
  toolCallId?: string;
}

export interface LoadOptions {
  /** Package directory containing `package.json` and `src/index.ts`. */
  packageDir: string;
  /** Entry point inside the package, relative to the package dir. Defaults to `src/index.ts`. */
  entry?: string;
  /** Extra environment for the extension factory and later calls. Set before import. */
  env?: Record<string, string | undefined>;
  /** Working directory the extension runs in. Defaults to a temp dir. */
  cwd?: string;
  /** Reuse an existing agent dir, which models a reload: same on-disk configuration, new runtime. */
  agentDir?: string;
}

/**
 * Load one extension in isolation.
 *
 * The agent dir is a temp directory, so anything the extension derives from `getAgentDir()`
 * (log directories, settings lookups) stays inside the test. Environment is restored on dispose.
 *
 * Vitest caches imported modules per test file. An extension that reads configuration at module
 * load (job registries, log directories, depth guards) needs `vi.resetModules()` before a second
 * load in the same file, otherwise the first load's environment is reused.
 */
export async function loadExtension(options: LoadOptions): Promise<LoadedExtension> {
  const packageDir = resolve(options.packageDir);
  const entry = options.entry ?? "src/index.ts";
  const agentDir = options.agentDir ? resolve(options.agentDir) : mkdtempSync(join(tmpdir(), "pi-ext-agent-"));
  // A caller-supplied agent dir outlives the load: it belongs to the test, not to this helper.
  const ownsAgentDir = options.agentDir === undefined;
  const cwd = options.cwd ? resolve(options.cwd) : mkdtempSync(join(tmpdir(), "pi-ext-cwd-"));

  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["PI_CODING_AGENT_DIR", ...Object.keys(options.env ?? {})];
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const calls: RecordedCall[] = [];

  const api = new Proxy({} as ExtensionAPI, {
    get(_target, member: string) {
      calls.push({ prop: member, args: [] });

      switch (member) {
        case "registerTool":
          return (tool: ToolDefinition) => {
            if (tools.has(tool.name)) {
              throw new Error(`Extension registered tool "${tool.name}" twice`);
            }
            tools.set(tool.name, tool);
          };
        case "on":
          return (event: string, handler: (event: any, ctx: any) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
            return () => {
              handlers.set(
                event,
                list.filter((entry) => entry !== handler),
              );
            };
          };
        case "registerCommand":
        case "registerShortcut":
        case "registerFlag":
        case "registerMessageRenderer":
        case "registerEntryRenderer":
        case "registerToolRenderer":
          return () => () => {};
        case "getFlagValue":
          return () => undefined;
        default:
          throw new Error(
            `The extension used pi.${member}, which the test harness does not implement. ` +
              `Add it to test/helpers/extension.ts so tests keep exercising the real code path.`,
          );
      }
    },
    has() {
      return true;
    },
  });

  let disposeState = true;
  try {
    const module = await importModule(join(packageDir, entry));
    const factory = module.default ?? module;
    await factory(api);
  } catch (error) {
    disposeState = false;
    if (ownsAgentDir) rmSync(agentDir, { recursive: true, force: true });
    throw error;
  }

  const loaded: LoadedExtension = {
    api,
    tools,
    handlers,
    calls,
    agentDir,
    cwd,
    makeContext(overrides) {
      return makeToolContext({ cwd, agentDir, ...overrides });
    },
    async callTool(name, params, callOptions = {}) {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Tool "${name}" is not registered. Registered: ${[...tools.keys()].join(", ") || "none"}.`);
      }
      const execute = tool.execute as unknown as ToolExecute;
      const ctx = loaded.makeContext(callOptions.context);
      return execute(callOptions.toolCallId ?? `call-${name}`, params, callOptions.signal, callOptions.onUpdate, ctx);
    },
    async emit(event, ctx) {
      const list = handlers.get(event.type) ?? [];
      const context = ctx ?? loaded.makeContext();
      const results: unknown[] = [];
      for (const handler of list) {
        results.push(await handler(event, context));
      }
      return results;
    },
    dispose() {
      if (!disposeState) return;
      disposeState = false;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (ownsAgentDir) rmSync(agentDir, { recursive: true, force: true });
    },
  };

  return loaded;
}

/** A tool context with just enough behaviour for the extensions under test. */
export function makeToolContext(options: { cwd: string; agentDir: string; [key: string]: unknown }): ExtensionToolContext {
  const sessionId = (options.sessionId as string) ?? "test-session";
  const sessionFile = (options.sessionFile as string) ?? join(options.agentDir, "sessions", `${sessionId}.jsonl`);

  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getSessionDir: () => join(options.agentDir, "sessions"),
    getEntries: () => [],
    getLeafId: () => null,
  };

  const context = {
    mode: "print",
    hasUI: false,
    ui: undefined,
    sessionManager,
    modelRegistry: {},
    model: undefined,
    scopedModels: [],
    thinkingLevel: undefined,
    isIdle: () => false,
    isProjectTrusted: () => false,
    signal: AbortSignal.abort(),
    abort: () => {},
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({}),
    tools: [],
    executeTool: async () => {
      throw new Error("executeTool is not available in tests");
    },
    ...options,
  };

  return context as unknown as ExtensionToolContext;
}

/**
 * Import a module fresh. Vitest gives every test file its own module registry, so module-level
 * extension state is per file. Use `vi.resetModules()` when one file needs a second instance.
 */
export async function importModule(path: string): Promise<any> {
  return import(pathToFileURL(path).href);
}

/** Repository root, resolved from this file so tests can run from any working directory. */
export const repoRoot = resolve(import.meta.dirname, "..", "..");

export function packageDir(name: string): string {
  return resolve(repoRoot, "packages", name);
}

export interface TempDir {
  path: string;
  dispose(): void;
}

export function makeTempDir(prefix = "pi-ext-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    dispose() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with `process.argv[1]` replaced, which is how extensions locate the `pi` entry point. */
export async function withPiArgv<T>(scriptPath: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.argv[1];
  process.argv[1] = scriptPath;
  try {
    return await fn();
  } finally {
    process.argv[1] = saved ?? "";
  }
}
