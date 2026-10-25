import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterAll(() => {
  ext?.dispose();
});

function text(result: any): string {
  return result.content.map((part: any) => part.text).join("");
}

function readLogIfContains(name: string, needle: string): boolean {
  try {
    return readFileSync(join(ext.agentDir, "bg-tasks", name), "utf8").includes(needle);
  } catch {
    return false;
  }
}

function logFiles(): string[] {
  const dir = join(ext.agentDir, "bg-tasks");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".log")) : [];
}

describe("foreground commands", () => {
  it("returns output, exit code, and structured content for a fast command", async () => {
    const result = await ext.callTool("bash", { command: "echo hello" });

    expect(text(result)).toBe("hello\n");
    expect(result.isError).toBeUndefined();
    expect(result.details.status).toBe("completed");
    expect(result.details.exitCode).toBe(0);
    expect(result.structuredContent).toMatchObject({ output: "hello\n", truncated: false, exit_code: 0 });
    expect(typeof result.structuredContent.wall_time_seconds).toBe("number");
  });

  it("keeps no log for output that fits, so the temp dir stays clean", async () => {
    await ext.callTool("bash", { command: "echo small" });
    expect(logFiles()).toEqual([]);
  });

  it("reports a non-zero exit as an error with the code", async () => {
    const result = await ext.callTool("bash", { command: "echo oops; exit 3" });

    expect(result.isError).toBe(true);
    expect(result.details.exitCode).toBe(3);
    expect(result.details.status).toBe("failed");
    expect(text(result)).toContain("oops");
    expect(text(result)).toContain("Command exited with code 3");
  });

  it("truncates long output with pi's limits and keeps the full log", async () => {
    const result = await ext.callTool("bash", { command: "seq 1 3000" });

    expect(result.details.exitCode).toBe(0);
    expect(result.details.truncation.truncated).toBe(true);
    expect(result.details.truncation.totalLines).toBe(3000);
    expect(text(result)).toContain("Showing lines 1001-3000 of 3000");
    expect(result.details.logPath).toBeTruthy();
    expect(result.details.fullOutputPath).toBe(result.details.logPath);
    expect(existsSync(result.details.logPath)).toBe(true);
  });

  it("streams partial output while a command runs", async () => {
    const partials: any[] = [];
    const result = await ext.callTool(
      "bash",
      { command: "echo first; sleep 1.5; echo second" },
      {
        onUpdate: (partial) => partials.push(partial),
      },
    );

    expect(text(result)).toContain("second");
    expect(partials.length).toBeGreaterThan(0);
    expect(partials.at(-1).content[0].text).toContain("first");
    expect(partials.at(-1).details.status).toBe("running");
  });

  it("refuses an empty command", async () => {
    await expect(ext.callTool("bash", { command: "   " })).rejects.toThrow(/Command is empty/);
  });

  it("rejects timeouts outside the allowed range", async () => {
    await expect(ext.callTool("bash", { command: "echo hi", timeout: -1 })).rejects.toThrow(/Invalid timeout/);
    await expect(ext.callTool("bash", { command: "echo hi", timeout: Number.NaN })).rejects.toThrow(/Invalid timeout/);
  });

  it("does not start a command when the tool call is already aborted", async () => {
    const logsBefore = logFiles();
    const result = await ext.callTool("bash", { command: "echo never" }, { signal: AbortSignal.abort() });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Command not started");
    expect(logFiles()).toEqual(logsBefore);
    expect(logFiles().some((name) => name && readLogIfContains(name, "never"))).toBe(false);
  });

  it("kills the command when the call is aborted while it runs", async () => {
    const controller = new AbortController();
    const pending = ext.callTool("bash", { command: "sleep 30", timeout: 20 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);

    const result = await pending;
    expect(result.details.status).toBe("killed");
    expect(text(result)).toContain("Command aborted");
  });
});
