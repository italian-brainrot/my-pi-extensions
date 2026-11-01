/**
 * Skills are installed as user skills rather than shipped in the Pi package, so they have to satisfy
 * Pi's own Agent Skills loader and their helper scripts have to stay runnable. None of this needs the
 * network or an Obscura binary: the scripts are only checked for syntax, usage output, and the error
 * path when no binary can be found.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
    expect(`${result.stdout}${result.stderr}`).toContain(basename(path));
  });
});

// Only the Obscura-backed skill has an external binary to go missing; every other skill's scripts are
// plain shell over the repo, so they get only the checks above.
describe.each(["browse.mjs", "web.sh"].map((name) => ({ name, path: join(skillsDir, "web-browsing", "scripts", name) })))(
  "web-browsing script $name",
  ({ path }) => {
    it("fails loudly when the Obscura binary is missing", () => {
      expect(existsSync(path), `${path} should exist`).toBe(true);
      const result = spawnSync(path, ["doctor", "--port", "40002"], {
        encoding: "utf8",
        env: { ...process.env, OBSCURA_BIN: join(skillsDir, "definitely-not-a-binary") },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/OBSCURA_BIN/);
    });
  },
);

// loop.sh is the one skill script with logic of its own: it reads a repo's git state and its audit log so
// a pass does not re-derive either from a 3000-line file.
describe("audit-loop loop.sh", () => {
  const script = join(skillsDir, "audit-loop", "scripts", "loop.sh");

  const run = (args: string[]) => spawnSync(script, args, { encoding: "utf8" });
  const git = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=loop", "-c", "user.email=loop@example.invalid", ...args], { stdio: "pipe" });

  const AUDIT = [
    "# Audit log",
    "",
    "## Pass 1 — 2026-01-01 (tester)",
    "",
    "Gate at the start: 10 vitest, 0 fail.",
    "",
    "### R1-01 — BUG — the first",
    "",
    "repro",
    "",
    "### R1-02 — PAPERCUT — the second",
    "",
    "repro",
    "",
    "## Pass 1 fixes — 2026-01-01 (fixer)",
    "",
    "Gate: green again.",
    "",
    "### R1-01 — fixed where the string is bounded",
    "",
    "how",
    "",
    "## Pass 2 audit — 2026-01-02 (tester)",
    "",
    "Gate inherited: 12 vitest, 0 fail. Gate left: 14 vitest, 2 fail on purpose.",
    "",
    "### R2-01 — BUG — the third",
    "",
    "repro",
    "",
  ].join("\n");

  function fakeRepo(path: string) {
    mkdirSync(join(path, "docs"), { recursive: true });
    writeFileSync(join(path, "docs", "AUDIT.md"), AUDIT);
    writeFileSync(
      join(path, "MEMORY.md"),
      "# Notes\n\n- An unrelated bullet.\n- Audit loop state: **pass 2 (tester) complete, one finding. Gate: 14 vitest, 2 red on purpose.**\n- Another bullet.\n",
    );
    git(path, "init", "-q", "-b", "main");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "pass 2 (tester): a finding with a test that stays red");
    writeFileSync(join(path, "uncommitted.txt"), "a pass left the tree dirty\n");
    return path;
  }

  it("reports the git state, every pass, the newest gate line, and the status bullet", () => {
    const temp = makeTempDir("pi-skill-loop-");
    try {
      const result = run(["status", fakeRepo(temp.path)]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/branch\s+main/);
      expect(result.stdout).toMatch(/dirty\s+1 path\(s\)/);
      expect(result.stdout).toContain("pass 2 (tester): a finding with a test that stays red");
      expect(result.stdout).toMatch(/Pass 1 — 2026-01-01 \(tester\)\s+2 finding\(s\)/);
      expect(result.stdout).toMatch(/Pass 2 audit — 2026-01-02 \(tester\)\s+1 finding\(s\)/);
      expect(result.stdout).toContain("Gate inherited: 12 vitest, 0 fail.");
      expect(result.stdout).toContain("Audit loop state: **pass 2 (tester) complete");
      // The bullet stops at the next one; dumping the whole memory file is not orientation.
      expect(result.stdout).not.toContain("Another bullet.");
    } finally {
      temp.dispose();
    }
  });

  it("prints one audit-log section, newest by default", () => {
    const temp = makeTempDir("pi-skill-loop-");
    try {
      const repo = fakeRepo(temp.path);
      const newest = run(["pass", repo]);
      expect(newest.status, newest.stderr).toBe(0);
      expect(newest.stdout).toContain("### R2-01 — BUG — the third");
      expect(newest.stdout).not.toContain("### R1-01");

      const named = run(["pass", repo, "Pass 1 fixes"]);
      expect(named.stdout).toContain("### R1-01 — fixed where the string is bounded");
      expect(named.stdout).not.toContain("### R2-01");
    } finally {
      temp.dispose();
    }
  });

  it("says so when the repo has no audit log yet", () => {
    const temp = makeTempDir("pi-skill-loop-");
    try {
      const status = run(["status", temp.path]);
      expect(status.stdout).toContain("no audit log yet");
      expect(status.stdout).toContain("not a git repository");
      expect(run(["pass", temp.path]).status).toBe(2);
    } finally {
      temp.dispose();
    }
  });

  it("reports nothing for a pattern no process matches", () => {
    const result = run(["strays", "definitely-not-a-process-90210"]);
    expect(result.stdout).toMatch(/== processes matching: definitely-not-a-process-90210[^\n]*\n {2}none/);
  });

  // A stray is a process in some other process group: one the pass started and never reaped. Its own
  // command's group is filtered out, so the ps/awk running the check never reports itself.
  it("finds a detached process and exits 1 so it can gate a pass", () => {
    const marker = `pi-loop-stray-${process.pid}`;
    const probe = spawnSync("setsid", ["--fork", "bash", "-c", `exec -a ${marker} sleep 30`], { stdio: "ignore" });
    if (probe.status !== 0) return; // no setsid on this box: the two checks above are the portable ones
    try {
      const found = run(["strays", marker]);
      expect(found.stdout).toContain(marker);
      expect(found.stdout).toMatch(/trap 'kill \$\(jobs -p\)/);
      expect(found.status).toBe(1);
    } finally {
      spawnSync("pkill", ["-f", marker], { stdio: "pipe" });
    }
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
