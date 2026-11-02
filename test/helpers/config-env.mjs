/**
 * Every environment variable an extension in this repository reads as configuration.
 *
 * A load is a fresh runtime, so the runtime's owner chooses its environment: what the shell around it
 * exports must not reach an extension unless it is asked for by name. It used to, and the suite then
 * meant different things in different shells — `PI_TAKEOVER_MAX_CHAIN=100` in a `.bashrc`, or
 * `PI_MEMORY_FILENAME` set for one project, fails tests in packages no change touched. This is the same
 * guard `pi-bg-tasks` applies to the commands it spawns ("no `PI_*` leftovers from a parent pi process"),
 * pointed at the processes this repository starts.
 *
 * It is a plain `.mjs` module because everything that needs it must agree on one list: the Vitest harness
 * (`test/helpers/extension.ts`), the per-file scrub (`test/helpers/hermetic-env.ts`), and the dev scripts
 * that spawn a real `pi` (`scripts/extension-smoke.mjs`). `test/repo.test.ts` checks it against what the
 * packages actually read, in both directions, so a variable cannot join an extension without joining it.
 */
export const EXTENSION_CONFIG_ENV_KEYS = [
  "PI_BG_TASKS_KEEP_RUNNING",
  "PI_MEMORY_DEBUG",
  "PI_MEMORY_FILENAME",
  "PI_MEMORY_MAX_BYTES",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_MAX_DEPTH",
  "PI_TAKEOVER_CONFIRM",
  "PI_TAKEOVER_DEBUG",
  "PI_TAKEOVER_MAX_CHAIN",
  "PI_TAKEOVER_NAME",
];

/**
 * Keys that are not an extension's own configuration, so an ambient one is either meaningless or the
 * thing under test: `PI_CODING_AGENT_DIR` is set by the harness and the scripts themselves, and the
 * session variables are Pi's, which `pi-bg-tasks` clears from the environment of every command it starts
 * and re-derives from the context. A `pi` started from inside another `pi` — which is exactly what runs
 * this repository's tests and scripts — has all of them set.
 */
export const HOST_ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

/** Every key that must not be inherited: configuration, then the host's own session state. */
export const SCRUBBED_ENV_KEYS = [...EXTENSION_CONFIG_ENV_KEYS, ...HOST_ENV_KEYS];

/**
 * A copy of `env` with the scrubbed keys removed, for whatever is about to be spawned.
 *
 * Returns the copy rather than mutating, so the caller can say what it removed: a run whose output a
 * human reads has to say what it was configured with.
 */
export function withoutScrubbedEnv(env, keys = SCRUBBED_ENV_KEYS) {
  const removed = [];
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (keys.includes(key)) removed.push(key);
    else clean[key] = value;
  }
  return { env: clean, removed };
}
