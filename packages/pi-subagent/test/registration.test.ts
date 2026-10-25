import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LoadedExtension, loadExtension, packageDir } from "../../../test/helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ packageDir: packageDir("pi-subagent") });
});

afterAll(() => {
  ext?.dispose();
});

describe("registration", () => {
  it("adds one subagent tool", () => {
    expect([...ext.tools.keys()]).toEqual(["subagent"]);
  });

  it("requires a non-empty prompt and renders its own call and result", () => {
    const tool = ext.tools.get("subagent")!;
    const properties = (tool.parameters as any).properties;

    expect(properties.prompt.minLength).toBeGreaterThan(0);
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.renderCall).toBe("function");
    expect(typeof tool.renderResult).toBe("function");
    expect(tool.description).toContain("subagent");
  });

  it("does not hand the tool to a subagent, so delegation does not cascade", async () => {
    // The depth guard is read at module load, so each env variant needs its own module instance.
    vi.resetModules();
    const nested = await loadExtension({ packageDir: packageDir("pi-subagent"), env: { PI_SUBAGENT_DEPTH: "1" } });
    expect([...nested.tools.keys()]).toEqual([]);
    nested.dispose();
  });

  it("stops delegation entirely when the maximum depth is zero", async () => {
    vi.resetModules();
    const none = await loadExtension({ packageDir: packageDir("pi-subagent"), env: { PI_SUBAGENT_MAX_DEPTH: "0" } });
    expect([...none.tools.keys()]).toEqual([]);
    none.dispose();
  });

  it("allows deeper delegation when PI_SUBAGENT_MAX_DEPTH is raised", async () => {
    vi.resetModules();
    const deeper = await loadExtension({
      packageDir: packageDir("pi-subagent"),
      env: { PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" },
    });
    expect([...deeper.tools.keys()]).toEqual(["subagent"]);
    deeper.dispose();
  });

  it("falls back to the default depth for unusable environment values", async () => {
    for (const value of ["", "abc", "-2", "NaN", "Infinity"]) {
      vi.resetModules();
      const loaded = await loadExtension({ packageDir: packageDir("pi-subagent"), env: { PI_SUBAGENT_MAX_DEPTH: value } });
      expect([...loaded.tools.keys()], `PI_SUBAGENT_MAX_DEPTH=${JSON.stringify(value)}`).toEqual(["subagent"]);
      loaded.dispose();
    }
  });
});
