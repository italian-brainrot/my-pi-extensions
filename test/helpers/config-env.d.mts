/** Types for `config-env.mjs`, which is plain JavaScript so the dev scripts can import it too. */

export declare const EXTENSION_CONFIG_ENV_KEYS: readonly string[];
export declare const HOST_ENV_KEYS: readonly string[];
export declare const SCRUBBED_ENV_KEYS: readonly string[];

export interface ScrubbedEnv {
  env: Record<string, string | undefined>;
  removed: string[];
}

export declare function withoutScrubbedEnv(env: Record<string, string | undefined>, keys?: readonly string[]): ScrubbedEnv;
