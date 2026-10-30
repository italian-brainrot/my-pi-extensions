/**
 * The host-pin check is the only thing standing between a dependency bump and a repository whose types
 * describe a module Pi never loads, so it is tested against fixture trees rather than hoped for: the
 * dependabot shape (our copy newer than the host's), an unpinned range, and a local Pi the pins have not
 * caught up with.
 *
 * The fixtures are the two trees the script reads — node_modules for the pinned Pi's own manifest, and a
 * managed-install directory for the Pi on the machine. It never runs npm, and never looks at the real
 * ~/.pi.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers/extension.ts";

const script = resolve(repoRoot, "scripts", "check-pi-pin.mjs");

const HOST = "@earendil-works/pi-coding-agent";
const HOST_VERSION = "1.4.0";
const TYPEBOX = "1.3.27";
const JITI = "2.7.0";

/** What the fixture Pi declares for the modules it provides to extensions. */
const HOST_PINS: Record<string, string> = {
  "@earendil-works/pi-ai": HOST_VERSION,
  "@earendil-works/pi-agent-core": HOST_VERSION,
  "@earendil-works/pi-tui": HOST_VERSION,
  typebox: TYPEBOX,
  jiti: JITI,
};

interface FixtureOptions {
  /** The repository's devDependencies. Defaults to exactly what the fixture Pi ships. */
  devDependencies?: Record<string, string>;
  /** Which version of each module npm actually installed, when that differs from the host's pin. */
  installed?: Record<string, string>;
  /** A second copy of the module under the Pi package, which is what npm writes on a conflict. */
  nested?: Record<string, string>;
  /** Version in the fixture managed install, or null for a machine with no Pi on it. */
  localPi?: string | null;
}

function fixture(options: FixtureOptions = {}): { path: string; dispose: () => void } {
  const temp = makeTempDir("pi-pin-check-");
  const declared = options.devDependencies ?? { [HOST]: HOST_VERSION, ...HOST_PINS };

  const write = (path: string, value: unknown) => {
    mkdirSync(join(temp.path, path).replace(/[^/]+$/, ""), { recursive: true });
    writeFileSync(join(temp.path, path), `${JSON.stringify(value, null, 2)}\n`);
  };

  mkdirSync(join(temp.path, "scripts"), { recursive: true });
  writeFileSync(join(temp.path, "scripts", "check-pi-pin.mjs"), readFileSync(script, "utf8"));
  write("package.json", { name: "fixture", version: "1.0.0", private: true, devDependencies: declared });

  write(`node_modules/${HOST}/package.json`, { name: HOST, version: HOST_VERSION, dependencies: HOST_PINS });
  for (const name of Object.keys(declared)) {
    if (name === HOST) continue;
    write(`node_modules/${name}/package.json`, { name, version: options.installed?.[name] ?? HOST_PINS[name] });
  }
  for (const [name, version] of Object.entries(options.nested ?? {})) {
    write(`node_modules/${HOST}/node_modules/${name}/package.json`, { name, version });
  }

  const localPi = options.localPi === undefined ? HOST_VERSION : options.localPi;
  if (localPi !== null) {
    // current-version is plain text in the real managed install, not JSON.
    mkdirSync(join(temp.path, "managed"), { recursive: true });
    writeFileSync(join(temp.path, "managed", "current-version"), `${localPi}\n`);
    write(`managed/releases/${localPi}/node_modules/${HOST}/package.json`, { name: HOST, version: localPi });
  }

  return { path: temp.path, dispose: temp.dispose };
}

function run(cwd: string) {
  return spawnSync("node", [join(cwd, "scripts", "check-pi-pin.mjs")], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, PI_MANAGED_INSTALL_ROOT: join(cwd, "managed") },
  });
}

describe("check-pi-pin.mjs", () => {
  it("is wired into npm run check", () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    expect(manifest.scripts["deps:check"]).toContain("check-pi-pin.mjs");
    expect(manifest.scripts.check).toContain("deps:check");
  });

  it("passes against this repository", () => {
    const result = spawnSync("node", [script], { encoding: "utf8", cwd: repoRoot });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Host pins are in sync/);
  });

  it("pins every host-provided module exactly, as the host itself does", () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    for (const name of [HOST, ...Object.keys(HOST_PINS)]) {
      expect(manifest.devDependencies[name], name).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("fails when a host-provided module is newer than the one the host loads", () => {
    const fix = fixture({
      devDependencies: { [HOST]: HOST_VERSION, ...HOST_PINS, typebox: "1.4.3" },
      installed: { typebox: "1.4.3" },
      nested: { typebox: TYPEBOX },
    });
    try {
      const result = run(fix.path);
      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`typebox: package.json declares "1.4.3" but Pi ${HOST_VERSION} pins it exactly at "${TYPEBOX}"`);
      expect(output).toContain("node_modules/@earendil-works/pi-coding-agent/node_modules/typebox");
      expect(output).toContain("npm install -D typebox@1.3.27");
    } finally {
      fix.dispose();
    }
  });

  it("fails when a host-provided module is left as a range", () => {
    const fix = fixture({ devDependencies: { [HOST]: HOST_VERSION, ...HOST_PINS, typebox: `^${TYPEBOX}` } });
    try {
      const result = run(fix.path);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain('typebox: package.json declares "^1.3.27"');
    } finally {
      fix.dispose();
    }
  });

  it("fails when the Pi on the machine has moved past the pins", () => {
    const fix = fixture({ localPi: "1.5.0" });
    try {
      const result = run(fix.path);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("the Pi on this machine is 1.5.0");
    } finally {
      fix.dispose();
    }
  });

  it("says nothing about a local Pi when there is no managed install, which is CI", () => {
    const fix = fixture({ localPi: null });
    try {
      const result = run(fix.path);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("no Pi installed on this machine");
    } finally {
      fix.dispose();
    }
  });
});
