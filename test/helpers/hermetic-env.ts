/**
 * Vitest setup file: start every test file from an environment the tests chose.
 *
 * Every extension in this repository reads its configuration from the environment, so a shell that
 * configures them — a `PI_TAKEOVER_MAX_CHAIN` in a `.bashrc`, a `PI_MEMORY_FILENAME` exported for one
 * project — changes what the suite means without a line of code changing. `loadExtension` scrubs these
 * variables for the lifetime of a load, and that has to stay, but it is not the only way an ambient value
 * gets in:
 *
 * - a test file that imports its extension's source directly (`import { MEMORY_NOTE } from "../src/index.ts"`)
 *   evaluates that module, and reads its configuration, before any load happens;
 * - a test that loads an extension through Pi's own loader (`test/load.test.ts`) never goes near
 *   `loadExtension`;
 * - a test that starts a real `pi` (`packages/pi-takeover/test/session.test.ts`) hands the whole
 *   environment to the child process.
 *
 * So this runs once per test file, before Vitest imports it, and deletes them — the extensions'
 * configuration and Pi's own session state alike. Deleting the host keys is what makes the allowance in
 * `test/repo.test.ts` honest: a variable a package reads is either scrubbed or a host variable, and a host
 * variable that no load can override is just a hole in the same wall. A test that wants one sets it itself
 * — through `loadExtension({ env })`, or with `test/helpers/env.ts`.
 */

import { SCRUBBED_ENV_KEYS } from "./config-env.mjs";

for (const key of SCRUBBED_ENV_KEYS) delete process.env[key];
