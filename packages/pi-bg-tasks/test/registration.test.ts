import type { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-bg-tasks") });
});

afterAll(() => {
  ext?.dispose();
});

describe("registration", () => {
  it("replaces the bash tool and adds bg_stop and bg_wait", () => {
    expect([...ext.tools.keys()].sort()).toEqual(["bash", "bg_stop", "bg_wait"]);
  });

  it("adds timeout and blocking to the bash parameters", () => {
    const parameters = ext.tools.get("bash")!.parameters as unknown as Type.TProperties;
    const properties = (parameters as any).properties;
    expect(Object.keys(properties).sort()).toEqual(expect.arrayContaining(["command", "timeout"]));
    expect(properties.timeout.type).toBe("number");
    expect(properties.blocking.type).toBe("boolean");
  });

  it("documents the background workflow in the tool description and guidelines", () => {
    const bash = ext.tools.get("bash")!;
    expect(bash.description).toContain("moved to the background");
    expect(bash.promptGuidelines?.some((line) => line.includes("timeout: 0"))).toBe(true);
    expect(bash.promptGuidelines?.some((line) => line.includes("bg_stop"))).toBe(true);
  });

  it("registers session lifecycle handlers", () => {
    expect([...ext.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start"]);
  });

  it("does not reach for extension APIs the harness has not modelled", () => {
    expect(ext.calls.map((call) => call.prop).sort()).toEqual(expect.arrayContaining(["on", "registerTool"]));
  });
});
