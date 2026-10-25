/**
 * `readConfiguredShell()` looks at the **pi process** working directory, not the tool context's
 * `cwd`, because that is where pi's own settings lookup lives. These tests pin that behaviour:
 * a project `.pi/settings.json` in the process cwd wins over the agent settings.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, makeTempDir, packageDir } from "../../../test/helpers/extension.ts";

const originalCwd = process.cwd();
let project: ReturnType<typeof makeTempDir>;
let ext: LoadedExtension;

beforeAll(async () => {
  project = makeTempDir("pi-ext-project-");
  mkdirSync(join(project.path, ".pi"), { recursive: true });
  writeFileSync(join(project.path, ".pi", "settings.json"), JSON.stringify({ shellPath: "sh" }));

  process.chdir(project.path);
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
  writeFileSync(join(ext.agentDir, "settings.json"), JSON.stringify({ shellPath: "bash" }));
});

afterAll(() => {
  ext?.dispose();
  process.chdir(originalCwd);
  project?.dispose();
});

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

describe("shell precedence", () => {
  it("prefers the project settings of the process working directory", async () => {
    const result = await ext.callTool("bash", { command: "echo BASH=${BASH_VERSION:-none}" });
    expect(text(result)).toContain("BASH=none");
  });
});
