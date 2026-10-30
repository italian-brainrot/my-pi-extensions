#!/usr/bin/env node

/**
 * Scaffold a new extension package: `npm run new -- pi-wordcount --description "Count words"`.
 *
 * Creates the package, its README, a starter entry point, and a first test, then updates the root
 * manifest and the lock file so Pi and CI both see the new package.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function usage() {
  console.error('Usage: npm run new -- pi-<name> [--description "what it does"]');
  process.exit(1);
}

const args = process.argv.slice(2);
const name = args.find((arg) => !arg.startsWith("--"));
const descriptionIndex = args.indexOf("--description");
const description = descriptionIndex >= 0 ? args[descriptionIndex + 1] : undefined;

if (!name) usage();
if (!/^pi-[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`Package name must look like pi-<lowercase-name>, got "${name}".`);
  process.exit(1);
}
if (!description) {
  console.error('Pass a description: npm run new -- pi-<name> --description "..."');
  process.exit(1);
}

const packageDir = join(repoRoot, "packages", name);
if (existsSync(packageDir)) {
  console.error(`packages/${name} already exists.`);
  process.exit(1);
}

const toolName = name.replace(/^pi-/, "").replace(/-/g, "_");
const commandName = name.replace(/^pi-/, "");

mkdirSync(join(packageDir, "src"), { recursive: true });
mkdirSync(join(packageDir, "test"), { recursive: true });

writeFileSync(
  join(packageDir, "package.json"),
  `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      description,
      license: "MIT",
      keywords: ["pi-package", "pi-extension", "pi", commandName],
      files: ["src", "README.md"],
      pi: { extensions: ["./src/index.ts"] },
      peerDependencies: {
        "@earendil-works/pi-coding-agent": "*",
        typebox: "*",
      },
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(packageDir, "src", "index.ts"),
  `/**
 * ${name} — ${description}
 *
 * An extension exports a default factory that receives the Pi extension API. Register tools,
 * commands, shortcuts, flags, and event handlers from it. Do not start processes, timers, or
 * watchers in the factory: some Pi invocations load extensions without starting a session.
 * Start session-scoped work from "session_start" and clean it up from "session_shutdown".
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("${commandName}", {
    description: "${description}",
    handler: async (_args, ctx) => {
      ctx.ui.notify("${commandName} is working", "info");
    },
  });

  pi.registerTool({
    name: "${toolName}",
    label: "${commandName}",
    description: "${description}. Describe what the model should expect back.",
    parameters: Type.Object({
      input: Type.String({ description: "What to act on" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { input } = params as { input: string };
      return {
        content: [{ type: "text", text: \`Received: \${input}\` }],
        details: { input },
      };
    },
  });
}
`,
);

writeFileSync(
  join(packageDir, "test", "extension.test.ts"),
  `import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExtension, packageDir, type LoadedExtension } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("${name}") });
});

afterAll(() => {
  ext?.dispose();
});

describe("${name}", () => {
  it("registers the expected tool", () => {
    expect([...ext.tools.keys()]).toContain("${toolName}");
  });

  it("answers a call", async () => {
    const result = await ext.callTool("${toolName}", { input: "hello" });
    expect(result.content[0].text).toContain("hello");
  });
});
`,
);

writeFileSync(
  join(packageDir, "README.md"),
  `# ${name}

${description}

## Install

From this repository (loads every extension in it):

\`\`\`bash
pi install .
\`\`\`

Only this package:

\`\`\`bash
pi install ./packages/${name}
\`\`\`

Try it without adding it to your settings:

\`\`\`bash
pi -e ./packages/${name}/src/index.ts
\`\`\`

## Usage

Describe what the extension does once loaded: the \`${commandName}\` command and the \`${toolName}\` tool.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| none | | |

## Development

\`\`\`bash
npm run dev            # run pi with every extension in this repo loaded
npm test               # run the whole suite
\`\`\`
`,
);

const sync = spawnSync(process.execPath, [join(repoRoot, "scripts", "sync-manifest.mjs")], { stdio: "inherit" });
if (sync.status !== 0) process.exit(sync.status ?? 1);

// The lock file has to know about the workspace or `npm ci` — CI, and `npm run deps:check` — fails.
const install = spawnSync("npm", ["install"], { cwd: repoRoot, stdio: "inherit" });
if (install.status !== 0) {
  console.error("\nnpm install failed, so package-lock.json does not know about the new package.");
  console.error("Fix it before committing: npm install");
  process.exit(install.status ?? 1);
}

console.log(`
Created packages/${name}:
  package.json          Pi manifest, peer dependencies, npm metadata
  src/index.ts          starter extension
  test/extension.test.ts first test through the shared harness
  README.md             install and usage

Next:
  1. Edit src/index.ts and the test.
  2. Add ${name} to EXPECTED in test/load.test.ts (tools and lifecycle events it registers).
  3. Add a row to the Extensions table in the root README.md.
  4. npm run check
  5. npm run dev -- --only ${name}
`);
