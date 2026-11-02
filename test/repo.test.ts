/**
 * Repository conventions. These checks keep the monorepo honest as more extensions land:
 * every package is packaged the way Pi expects, and every package is reachable from the
 * root manifest so `pi install <repo>` loads them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_CONFIG_ENV_KEYS, HOST_ENV_KEYS, repoRoot } from "./helpers/extension.ts";

const HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

interface PackageInfo {
  dir: string;
  name: string;
  manifest: any;
  files: string[];
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageInfos(): PackageInfo[] {
  const packagesRoot = resolve(repoRoot, "packages");
  return readdirSync(packagesRoot)
    .filter((name) => existsSync(join(packagesRoot, name, "package.json")))
    .map((name) => {
      const dir = join(packagesRoot, name);
      return {
        dir,
        name,
        manifest: readJson(join(dir, "package.json")),
        files: readdirSync(dir, { recursive: true }) as string[],
      };
    });
}

const packages = packageInfos();
const rootManifest = readJson(resolve(repoRoot, "package.json"));

function importedHostPackages(dir: string): string[] {
  const found = new Set<string>();
  const sourceFiles = (readdirSync(join(dir, "src"), { recursive: true }) as string[]).filter((name) => name.endsWith(".ts"));

  for (const file of sourceFiles) {
    const text = readFileSync(join(dir, "src", file), "utf8");
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier && HOST_PACKAGES.includes(specifier)) found.add(specifier);
    }
  }
  return [...found];
}

describe("the repository", () => {
  it("has at least one extension package", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it("has a LICENSE and a README", () => {
    expect(existsSync(resolve(repoRoot, "LICENSE"))).toBe(true);
    expect(existsSync(resolve(repoRoot, "README.md"))).toBe(true);
  });

  it("lists every package entry in the root Pi manifest", () => {
    const declared = new Set(rootManifest.pi?.extensions ?? []);
    for (const info of packages) {
      for (const entry of info.manifest.pi?.extensions ?? []) {
        expect(declared, `${info.name} entry ${entry}`).toContain(`./packages/${info.name}/${entry.replace(/^\.\//, "")}`);
      }
    }
  });

  it("declares no package in the root manifest that is missing on disk", () => {
    for (const entry of rootManifest.pi?.extensions ?? []) {
      expect(existsSync(resolve(repoRoot, entry)), `root manifest entry ${entry}`).toBe(true);
    }
  });

  it("ignores node_modules and logs in git", () => {
    const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules");
  });
});

/** Every `process.env.PI_*` an extension reads, with the package that reads it for the failure message. */
function envKeysRead(dir: string): string[] {
  const found = new Set<string>();
  const sourceFiles = (readdirSync(join(dir, "src"), { recursive: true }) as string[]).filter((name) => name.endsWith(".ts"));
  for (const file of sourceFiles) {
    const text = readFileSync(join(dir, "src", file), "utf8");
    for (const match of text.matchAll(/process\.env\.(PI_[A-Z0-9_]+)\b/g)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

const scrubbed = new Set<string>(EXTENSION_CONFIG_ENV_KEYS);
const hostOwned = new Set<string>(HOST_ENV_KEYS);
const envReadByPackages = packages.flatMap((info) => envKeysRead(info.dir).map((key) => ({ key, name: info.name })));

describe("the environment the extensions read", () => {
  it("is scrubbed by the test harness, or belongs to the host", () => {
    // A variable an extension reads as configuration and the harness does not scrub makes the suite mean
    // something different in every shell: see test/env-hermetic.test.ts.
    for (const { key, name } of envReadByPackages) {
      expect(scrubbed.has(key) || hostOwned.has(key), `${name} reads ${key}, which is in neither harness list`).toBe(true);
    }
  });

  it("lists no variable no extension reads", () => {
    // The other half of the guard: a list that only grows rots, and a stale entry hides the fact that the
    // variable it names is gone.
    const read = new Set(envReadByPackages.map(({ key }) => key));
    for (const key of scrubbed) expect(read.has(key), `scrubbed key ${key} is read by no extension`).toBe(true);
  });

  it("is scrubbed by every dev script that starts a throwaway pi", () => {
    // A dev script prints evidence a human reads, so it has to be as hermetic as the suite: an ambient
    // `PI_TAKEOVER_MAX_CHAIN` used to reach the `pi` `scripts/extension-smoke.mjs` spawns, and every
    // lineage entry in its output reported the shell's cap as if it were the extension's.
    //
    // `scripts/dev.mjs` is deliberately out: it starts the user's own pi, where their own configuration is
    // the point. The invariant is about a run pointed at a temporary agent dir — one that owns its whole
    // environment and prints what it measured.
    for (const name of readdirSync(resolve(repoRoot, "scripts")).filter((entry) => entry.endsWith(".mjs"))) {
      const text = readFileSync(resolve(repoRoot, "scripts", name), "utf8");
      if (!/spawn(Sync)?\(/.test(text) || !/mkdtemp/.test(text)) continue;

      expect(text, `scripts/${name} runs a pi in a temp dir but does not import the scrub list`).toContain("test/helpers/config-env.mjs");
      expect(text, `scripts/${name} spreads the shell's environment into the pi it spawns`).not.toMatch(/\.\.\.\s*process\.env/);
    }
  });
});

describe.each(packages.map((info) => ({ ...info, title: info.name })))("package $title", (info) => {
  it("names the package after its directory", () => {
    expect(info.manifest.name).toBe(info.name);
    expect(info.manifest.name).toMatch(/^pi-/);
  });

  it("describes itself for a package gallery", () => {
    expect(typeof info.manifest.description).toBe("string");
    expect(info.manifest.description.length).toBeGreaterThan(20);
    expect(info.manifest.keywords).toEqual(expect.arrayContaining(["pi-package", "pi-extension", "pi"]));
  });

  it("declares its extension entry points and they exist", () => {
    const entries = info.manifest.pi?.extensions;
    expect(Array.isArray(entries) && entries.length > 0).toBe(true);
    for (const entry of entries) {
      expect(existsSync(join(info.dir, entry)), `entry ${entry}`).toBe(true);
    }
  });

  it("ships its source and README in the tarball", () => {
    expect(info.manifest.files).toEqual(expect.arrayContaining(["src", "README.md"]));
    expect(info.files.map(String)).toContain("README.md");
  });

  it("declares host packages as peers only, never as dependencies", () => {
    const imported = importedHostPackages(info.dir);
    expect(imported.length).toBeGreaterThan(0);

    const peers = Object.keys(info.manifest.peerDependencies ?? {});
    for (const specifier of imported) {
      expect(peers, `${info.name} imports ${specifier} but does not peer-depend on it`).toContain(specifier);
      expect(info.manifest.dependencies ?? {}, `${info.name} must bundle ${specifier}`).not.toHaveProperty(specifier);
    }
    for (const peer of peers) {
      expect(info.manifest.peerDependencies[peer], `peer range for ${peer}`).toBe("*");
    }
  });

  it("pins its Pi version through the root devDependencies", () => {
    const dev = rootManifest.devDependencies;
    for (const peer of Object.keys(info.manifest.peerDependencies ?? {})) {
      expect(dev, `root devDependencies should provide ${peer}`).toHaveProperty(peer);
    }
  });

  it("has tests and a README with an install section", () => {
    const testFiles = info.files.map(String).filter((name) => name.startsWith("test/") && name.endsWith(".test.ts"));
    expect(testFiles.length).toBeGreaterThan(0);

    const readme = readFileSync(join(info.dir, "README.md"), "utf8");
    expect(readme).toContain("pi install");
    expect(readme.toLowerCase()).toContain("usage");
  });

  it("is not published before it is ready", () => {
    // Flip `private` to false only together with a publish workflow and an npm scope.
    expect(info.manifest.private).toBe(true);
  });
});
