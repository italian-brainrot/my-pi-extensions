/**
 * Skills travel with this repo through the root Pi manifest, so they have to satisfy Pi's own
 * Agent Skills loader and their helper scripts have to stay runnable. None of this needs the
 * network or an Obscura binary: the scripts are only checked for syntax, usage output, and the
 * error path when no binary can be found.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeTempDir, repoRoot } from "./helpers/extension.ts";

const skillsDir = resolve(repoRoot, "skills");
const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

function skillDirs(): string[] {
  return existsSync(skillsDir) ? readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md"))) : [];
}

function scriptPaths(): string[] {
  return skillDirs().flatMap((name) => {
    const dir = join(skillsDir, name, "scripts");
    return existsSync(dir) ? readdirSync(dir).map((file) => join(dir, file)) : [];
  });
}

describe("the skills directory", () => {
  it("is declared in the root Pi manifest and exists", () => {
    expect(rootManifest.pi?.skills).toContain("./skills");
    expect(existsSync(skillsDir)).toBe(true);
  });

  it("loads through Pi's own skill loader without diagnostics", () => {
    const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "test" });
    expect(diagnostics).toEqual([]);
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.description.length).toBeGreaterThan(40);
      expect(existsSync(skill.filePath)).toBe(true);
    }
  });

  it("names each skill after its directory", () => {
    for (const name of skillDirs()) {
      const frontmatter = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8").split(/^---$/m)[1] ?? "";
      expect(frontmatter, name).toContain(`name: ${name}`);
    }
  });
});

describe.each(scriptPaths().map((path) => ({ path })))("skill script $path", ({ path }) => {
  it("is executable", () => {
    expect(statSync(path).mode & constants.S_IXUSR).not.toBe(0);
  });

  it("parses", () => {
    const interpreter = path.endsWith(".mjs") ? "node" : "bash";
    const flag = path.endsWith(".mjs") ? "--check" : "-n";
    execFileSync(interpreter, [flag, path], { stdio: "pipe" });
  });

  it("explains itself when called without arguments", () => {
    const result = spawnSync(path, { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/browse\.mjs|web\.sh/);
  });

  it("fails loudly when the Obscura binary is missing", () => {
    const result = spawnSync(path, ["doctor", "--port", "40002"], {
      encoding: "utf8",
      env: { ...process.env, OBSCURA_BIN: join(skillsDir, "definitely-not-a-binary") },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/OBSCURA_BIN/);
  });
});

describe("browse.mjs lifecycle without a server", () => {
  it("reports not running instead of starting one", () => {
    const temp = makeTempDir("pi-skill-");
    const script = resolve(skillsDir, "web-browsing", "scripts", "browse.mjs");
    try {
      const result = spawnSync(script, ["status", "--port", "40001"], {
        encoding: "utf8",
        env: { ...process.env, WEB_CACHE_DIR: temp.path },
      });
      expect(result.stdout).toContain("not running");
      expect(result.status).toBe(1);
      // status must not have left a pid file behind, and no server should be listening.
      expect(existsSync(join(temp.path, "cdp", "40001", "pid"))).toBe(false);
    } finally {
      temp.dispose();
    }
  });
});
