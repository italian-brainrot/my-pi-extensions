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
 * So this runs once per test file, before Vitest imports it, and deletes them. A test that wants one of
 * these variables sets it itself — through `loadExtension({ env })`, or with `test/helpers/env.ts` — and
 * `test/repo.test.ts` keeps the list in step with what the packages actually read.
 */

import { EXTENSION_CONFIG_ENV_KEYS } from "./extension.ts";

for (const key of EXTENSION_CONFIG_ENV_KEYS) delete process.env[key];
