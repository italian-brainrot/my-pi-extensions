/**
 * Skills are installed as user skills rather than shipped in the Pi package, so they have to satisfy
 * Pi's own Agent Skills loader and their helper scripts have to stay runnable. None of this needs the
 * network or an Obscura binary: the scripts are only checked for syntax, usage output, and the error
 * path when no binary can be found.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  it("exists and is kept out of the root Pi manifest", () => {
    expect(existsSync(skillsDir)).toBe(true);
    // Declaring skills in the manifest while they are also installed to ~/.agents/skills gives Pi two
    // directories with the same skill name: it warns about the collision and the first one wins. One
    // route only, and it is `npm run install:skills`.
    expect(rootManifest.pi?.skills ?? []).toEqual([]);
    // …and that route has to exist, otherwise the installed copy drifts in silence.
    expect(rootManifest.scripts?.["install:skills"]).toBe("node scripts/install-skills.mjs");
    expect(rootManifest.scripts?.["skills:check"]).toBe("node scripts/install-skills.mjs --check");
    expect(rootManifest.scripts?.check).toContain("skills:check");
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

describe("install-skills.mjs keeps the installed copy honest", () => {
  const script = resolve(repoRoot, "scripts", "install-skills.mjs");

  const run = (target: string, ...args: string[]) =>
    spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, PI_SKILLS_DIR: target } });

  it("installs, detects an edit, and stops detecting it after another install", () => {
    const temp = makeTempDir("pi-skills-install-");
    try {
      const installed = join(temp.path, "skills");
      const first = run(installed);
      expect(first.status, first.stderr).toBe(0);
      expect(run(installed, "--check").status).toBe(0);

      // A repository edit that has not been installed yet is drift, and the message names the command
      // that fixes it — that is the whole point of running this in npm run check.
      const skill = skillDirs()[0]!;
      const file = join(installed, skill, "SKILL.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n<!-- installed copy edited -->\n`);
      const drifted = run(installed, "--check");
      expect(drifted.status).toBe(1);
      expect(`${drifted.stdout}${drifted.stderr}`).toContain("install:skills");

      expect(run(installed).status).toBe(0);
      expect(run(installed, "--check").status).toBe(0);
    } finally {
      temp.dispose();
    }
  });

  it("leaves a skill it did not install alone", () => {
    const temp = makeTempDir("pi-skills-foreign-");
    try {
      const installed = join(temp.path, "skills");
      const skill = skillDirs()[0]!;
      mkdirSync(join(installed, skill), { recursive: true });
      writeFileSync(join(installed, skill, "SKILL.md"), "# not mine\n");

      const result = run(installed, "--check");
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("not managed by this script");
      expect(readFileSync(join(installed, skill, "SKILL.md"), "utf8")).toBe("# not mine\n");
    } finally {
      temp.dispose();
    }
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
