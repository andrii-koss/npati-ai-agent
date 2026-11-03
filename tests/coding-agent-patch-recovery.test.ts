import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "../apps/agent-api/src/code-tools-patch";
import type { CodeWritePort } from "../apps/agent-api/src/code-tools-write";
import { canonicalWriteExecutors } from "../apps/agent-api/src/code-tool-executors-write";
import { createProjectWorkspaceReadPort, type CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";

function workspace() {
  const files = new Map([["old.txt", "original\n"], ["last.txt", "last\n"]]);
  const port: CodeWritePort = {
    async stat(path) { return { exists: files.has(path), type: "file" }; },
    async readFile(path) { if (!files.has(path)) throw new Error("Missing file"); return { content: files.get(path)!, revision: files.get(path)! }; },
    async writeFile(path, content) { files.set(path, content); return { sha256: content, revision: content }; },
    async deletePath(path) { files.delete(path); },
    async movePath() { throw new Error("Unused"); },
  };
  return { files, port };
}
const mixedPatch = ["*** Begin Patch", "*** Add File: new.txt", "+new", "*** Delete File: old.txt", "*** Update File: last.txt", "@@ -1 +1 @@", "-last", "+LAST", "*** End Patch"].join("\n");

describe("security-gate: patch failure recovery", () => {
  it.each([
    ["code.fs.edit", { path: "large.txt", old_string: "old", new_string: "new" }],
    ["code.fs.apply_patch", { patch: "--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-old\n+new" }],
    ["code.fs.apply_patch", { patch: "*** Begin Patch\n*** Update File: large.txt\n@@ -1 +1 @@\n-old\n+new\n*** End Patch" }],
  ])("edits %s past the read display limit and keeps the tail", async (tool, args) => {
    const write = vi.fn();
    const port = createProjectWorkspaceReadPort({ getFileTree: async () => [], readFile: async () => ({ path: "large.txt", content: "old\n" + "tail".repeat(100), size: 404, revision: "full-file-revision" }) });
    const input = { ctx: { userId: "u", workspaceId: "w", permissions: [] }, companyId: "c", projectId: "p", sessionId: "s", tool: { name: tool, version: 1 }, args, port, writePort: { writeFile: write, createFile: write }, limits: { ...resolveCodeAgentLimits(), readFileBytes: 4 } } as unknown as CodeToolExecutionContext;
    await canonicalWriteExecutors()[tool]!(input).catch(() => undefined);
    expect(write).toHaveBeenCalled();
    expect(String(write.mock.calls[0]![0].content ?? write.mock.calls[0]![1])).toContain("tail".repeat(100));
  });

  it("restores deleted files and removes new files after a later write fails", async () => {
    const { files, port } = workspace();
    const initial = [...files];
    const write = port.writeFile;
    port.writeFile = async (path, content, opts) => { if (path === "last.txt") throw new Error("disk full"); return write(path, content, opts); };
    await expect(applyPatch({ patch: mixedPatch }, port, { approved: true })).rejects.toThrow("disk full");
    expect([...files].sort()).toEqual(initial.sort());
  });

  it("reports incomplete rollback without overwriting another writer's changes", async () => {
    const { files, port } = workspace();
    const write = port.writeFile;
    port.writeFile = async (path, content, opts) => {
      if (path === "last.txt") { files.set("new.txt", "concurrent edit"); throw new Error("disk full"); }
      return write(path, content, opts);
    };
    await expect(applyPatch({ patch: mixedPatch }, port, { approved: true })).rejects.toMatchObject({ code: "write_failed", retryable: false, details: { rollbackIncomplete: true, paths: ["new.txt"] } });
    expect(files.get("new.txt")).toBe("concurrent edit");
    expect(files.get("old.txt")).toBe("original\n");
  });

  it.each([
    mixedPatch.replace("*** End Patch", ""),
    mixedPatch + "\n*** Add File: ignored.txt\n+ignored",
    mixedPatch.replace("*** Begin Patch", "*** Begin Patch extra"),
    mixedPatch.replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
    mixedPatch.replace("*** Add File: new.txt", "*** Begin Patch\n*** Add File: new.txt"),
  ])("refuses incomplete or malformed patches before any write", async patch => {
    const { files, port } = workspace(); const initial = [...files];
    await expect(applyPatch({ patch }, port, { approved: true })).rejects.toMatchObject({ code: "patch_invalid" });
    expect([...files]).toEqual(initial);
  });

  it("enforces the output size budget before applying any file", async () => {
    const { files, port } = workspace();
    await expect(applyPatch({ patch: mixedPatch }, port, { approved: true, limits: { maxEditBytes: 2 } })).rejects.toMatchObject({ code: "edit_too_large" });
    expect(files.has("new.txt")).toBe(false);
    expect(files.get("old.txt")).toBe("original\n");
  });
});
