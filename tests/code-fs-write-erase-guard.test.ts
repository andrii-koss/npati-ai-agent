import { describe, expect, it, vi } from "vitest";
import { canonicalWriteExecutors } from "../apps/agent-api/src/code-tool-executors-write";
import { createProjectWorkspaceReadPort, type CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";

// A QA repair run once replaced a 783-line script.js with 28 bytes. A whole-file write may not do that.
const script = Array.from({ length: 783 }, (_, line) => `const value${line} = ${line};`).join("\n");
function input(content: string, existing = script) {
  const write = vi.fn(async () => ({ sha256: "s", revision: "r" }));
  const port = createProjectWorkspaceReadPort({ getFileTree: async () => [],
    readFile: async () => ({ path: "script.js", content: existing, size: existing.length, revision: "rev" }) });
  const context = { ctx: { userId: "u", workspaceId: "w", permissions: [] }, companyId: "c", projectId: "p", sessionId: "s",
    tool: { name: "code.fs.write", version: 1 }, args: { path: "script.js", content }, port,
    writePort: { writeFile: write, createFile: write }, limits: resolveCodeAgentLimits() } as unknown as CodeToolExecutionContext;
  return { context, write };
}

describe("code.fs.write never silently erases most of a file", () => {
  it("refuses to replace a large file with a few bytes and says what to do instead", async () => {
    const { context, write } = input("// rest of file unchanged\n");
    await expect(canonicalWriteExecutors()["code.fs.write"]!(context)).rejects.toMatchObject({
      code: "write_would_erase_file", message: expect.stringContaining("783 lines"),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("still writes a complete new version of the file, and small files freely", async () => {
    const full = input(script.replace("value0", "first"));
    await canonicalWriteExecutors()["code.fs.write"]!(full.context).catch(() => undefined);
    expect(full.write).toHaveBeenCalled();
    const small = input("x", "tiny file");
    await canonicalWriteExecutors()["code.fs.write"]!(small.context).catch(() => undefined);
    expect(small.write).toHaveBeenCalled();
  });
});
