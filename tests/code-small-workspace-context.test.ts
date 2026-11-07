import { describe, expect, it } from "vitest";
import { smallWorkspaceContext } from "../apps/agent-api/src/code-small-workspace-context";

const read = (files: Record<string, string>) => async (path: string) => files[path] ?? "";

describe("small workspace context", () => {
  it("describes a new project so the agent does not list it or read .gitignore", async () => {
    const text = await smallWorkspaceContext([{ path: ".gitignore", size: 30 }], read({ ".gitignore": "node_modules/\ndist/\n" }));
    expect(text).toContain("Workspace files (all 1");
    expect(text).toContain("node_modules/");
    expect(text).toContain("start writing the requested files directly");
  });
  it("lists a few source files without their contents", async () => {
    const text = await smallWorkspaceContext([{ path: "index.html" }, { path: "app.js" }, { path: "node_modules/x/index.js" }], read({ "index.html": "<h1>secret</h1>" }));
    expect(text).toContain("- index.html");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("start writing");
  });
  it("says nothing about a larger project", async () => {
    expect(await smallWorkspaceContext(Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.js` })), read({}))).toBeNull();
  });
});
