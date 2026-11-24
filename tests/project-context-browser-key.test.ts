import { describe, expect, it, vi } from "vitest";
import { PROJECT_DATA_API_CONTRACT, formatSchemaForProjectContext, projectBrowserAccess } from "../apps/agent-api/src/data-studio/agent-data-service";
import { PROJECT_BROWSER_CONFIG_FILE_NAME, ensureProjectBrowserConfigFile, renderProjectBrowserConfig } from "../apps/agent-api/src/data-studio/project-sdk-file";

/**
 * A plain HTML site with a database needs the public publishable key in browser code. The agent first refused to write
 * it (a contradictory rule), then copied it by hand and mistyped the prefix (`pk_live_…`, `npati_pk_…` for
 * `npati_pk_dev_…`), so every request was refused and the repair passes looped. The server now writes the key into
 * npati-config.js, and the context tells the agent to load that file instead of copying the key.
 */
const KEY = "npati_pk_dev_6bc658e3f2624c0887564a1b2c3d4e5f";

describe("project context: the publishable key in a plain HTML site", () => {
  it("limits the 'environment only' rule to server code and points a plain site to npati-config.js", () => {
    expect(PROJECT_DATA_API_CONTRACT.serverEnvironment).toMatch(/^Only server code/);
    expect(PROJECT_DATA_API_CONTRACT.serverEnvironment).toContain("it loads the generated npati-config.js");
    const context = formatSchemaForProjectContext("Backend", { tables: [] }, "project-1");
    expect(context).toContain('<script src="npati-config.js"></script>');
    expect(context).toContain("window.NPATI_PROJECT.publishableKey");
    expect(context).toContain("never type or copy the key by hand");
    expect(projectBrowserAccess("project-1", KEY).use).toContain("npati-config.js");
  });

  it("still keeps secrets out of client code", () => {
    expect(formatSchemaForProjectContext("Backend", { tables: [] })).toContain("Never put PROJECT_SECRET_KEY, DATABASE_URL or any database credential into generated client code.");
  });
});

describe("npati-config.js", () => {
  it("carries the exact key and the relative API base", () => {
    const content = renderProjectBrowserConfig("f02644c3-a782-4b5a-b5a0-4eb8e51e9a98", KEY);
    const window: { NPATI_PROJECT?: { apiBase: string; publishableKey: string } } = {};
    new Function("window", content)(window);
    expect(window.NPATI_PROJECT).toEqual({ apiBase: "/v1/projects/f02644c3-a782-4b5a-b5a0-4eb8e51e9a98", publishableKey: KEY });
  });

  it("refuses anything but a publishable key", () => {
    expect(() => renderProjectBrowserConfig("p", "npati_sk_dev_6bc658e3f2624c0887564a1b2c3d4e5f")).toThrow(/publishable/);
    expect(() => renderProjectBrowserConfig("p", "pk_live_6bc658e3f2624c08")).toThrow(/publishable/);
  });

  it("is created once and rewritten only when the key changes", async () => {
    const files = new Map<string, string>();
    const workspace = {
      readFile: vi.fn(async (_c: unknown, _co: string, _p: string, name: string) => { if (!files.has(name)) throw new Error("missing"); return { content: files.get(name)!, revision: "r" }; }),
      createFile: vi.fn(async (_c: unknown, _co: string, _p: string, name: string, content: string) => { files.set(name, content); }),
      writeFile: vi.fn(async (_c: unknown, _co: string, _p: string, name: string, content: string) => { files.set(name, content); }),
    };
    expect(await ensureProjectBrowserConfigFile({} as never, "c", "p", KEY, workspace as never)).toBe("written");
    expect(await ensureProjectBrowserConfigFile({} as never, "c", "p", KEY, workspace as never)).toBe("unchanged");
    expect(files.get(PROJECT_BROWSER_CONFIG_FILE_NAME)).toContain(KEY);
  });
});
