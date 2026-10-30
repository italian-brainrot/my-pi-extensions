/**
 * The lockfile check is what stands between "added a package" and CI's `npm ci` refusing to install,
 * so it is tested the way the drift actually happens: against a fixture repository, with a workspace
 * the lock has never heard of, an edited range, and an entry left behind by a deleted package.
 *
 * It never runs npm. `npm ci --dry-run` looks like the obvious check and deletes node_modules on the
 * way to proving nothing, so scripts/check-lock.mjs only reads files.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers/extension.ts";

const script = resolve(repoRoot, "scripts", "check-lock.mjs");

const rootManifest = {
  name: "fixture",
  version: "1.0.0",
  private: true,
  workspaces: ["packages/*"],
  devDependencies: { typescript: "^5.9.3" },
};

const workspaceManifest = {
  name: "alpha",
  version: "0.1.0",
  private: true,
  peerDependencies: { typebox: "*" },
};

function lockFile(): Record<string, unknown> {
  return {
    name: rootManifest.name,
    version: rootManifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: rootManifest.name,
        version: rootManifest.version,
        workspaces: rootManifest.workspaces,
        devDependencies: rootManifest.devDependencies,
      },
      "node_modules/alpha": { resolved: "packages/alpha", link: true },
      "packages/alpha": { version: workspaceManifest.version, peerDependencies: workspaceManifest.peerDependencies },
    },
  };
}

/** A repository the checker is happy with, which every drift case then breaks. */
function fixture(): { path: string; dispose: () => void } {
  const temp = makeTempDir("pi-lock-check-");
  const write = (path: string, value: unknown) => {
    mkdirSync(join(temp.path, path).replace(/[^/]+$/, ""), { recursive: true });
    writeFileSync(join(temp.path, path), `${JSON.stringify(value, null, 2)}\n`);
  };

  mkdirSync(join(temp.path, "scripts"), { recursive: true });
  writeFileSync(join(temp.path, "scripts", "check-lock.mjs"), readFileSync(script, "utf8"));
  write("package.json", rootManifest);
  write("packages/alpha/package.json", workspaceManifest);
  write("package-lock.json", lockFile());

  return { path: temp.path, dispose: temp.dispose };
}

const run = (cwd: string) => spawnSync("node", [join(cwd, "scripts", "check-lock.mjs")], { encoding: "utf8", cwd });

describe("check-lock.mjs", () => {
  it("is wired into npm run check", () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    expect(manifest.scripts["deps:check"]).toBe("node scripts/check-lock.mjs");
    expect(manifest.scripts.check).toContain("deps:check");
    // npm ci --dry-run would wipe node_modules instead; see the header of this file.
    expect(manifest.scripts["deps:check"]).not.toContain("npm ci");
  });

  it("passes against this repository", () => {
    const result = spawnSync("node", [script], { encoding: "utf8", cwd: repoRoot });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/in sync/);
  });

  it("fails when a workspace is missing from the lock file", () => {
    const fix = fixture();
    try {
      expect(run(fix.path).status).toBe(0);

      // This is exactly what CI looked like: npm ci stopped at "Missing: pi-memory@0.1.0 from lock file"
      // and never got to the tests.
      mkdirSync(join(fix.path, "packages/beta"), { recursive: true });
      writeFileSync(join(fix.path, "packages/beta/package.json"), `${JSON.stringify({ ...workspaceManifest, name: "beta" }, null, 2)}\n`);

      const result = run(fix.path);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("packages/beta: missing from the lock file");
      expect(`${result.stdout}${result.stderr}`).toContain("npm install");
    } finally {
      fix.dispose();
    }
  });

  it("fails when a dependency range moves without the lock file", () => {
    const fix = fixture();
    try {
      const manifest = { ...rootManifest, devDependencies: { typescript: "^6.0.0" } };
      writeFileSync(join(fix.path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      const result = run(fix.path);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'devDependencies "typescript" is "^5.9.3" in the lock file, "^6.0.0" in package.json',
      );
    } finally {
      fix.dispose();
    }
  });

  it("fails when the lock file still describes a package that is gone", () => {
    const fix = fixture();
    try {
      rmSync(join(fix.path, "packages/alpha"), { recursive: true, force: true });

      const result = run(fix.path);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("packages/alpha");
    } finally {
      fix.dispose();
    }
  });

  it("fails when a workspace entry has no node_modules link", () => {
    const fix = fixture();
    try {
      const lock = lockFile();
      delete (lock.packages as Record<string, unknown>)["node_modules/alpha"];
      writeFileSync(join(fix.path, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

      const result = run(fix.path);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("not linked");
    } finally {
      fix.dispose();
    }
  });
});
