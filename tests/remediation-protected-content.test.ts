import { describe, expect, it } from "vitest";
import { ProjectFileError } from "../apps/agent-api/src/project-workspace";
import { SandboxProviderError } from "../apps/agent-api/src/sandbox-provider";
import { toFailure } from "../apps/agent-api/src/code-tool-runtime-hooks";
import { writeFileSafe, type CodeWritePort } from "../apps/agent-api/src/code-tools-write";
import { commitPatchMutations } from "../apps/agent-api/src/code-patch-transaction";
import { isWorkspaceContentProtected } from "../apps/agent-api/src/workspace-protected-content";

describe("D10 protected content is a refusal, not a retryable server error", () => {
  it("refuses unreadable content before persistence, then accepts a safe correction on the same path", async () => {
    const files = new Map<string, string>(); let writes = 0;
    const port: CodeWritePort = {
      stat: async path => ({ exists: files.has(path), type: "file" }),
      readFile: async path => ({ content: files.get(path)! }),
      writeFile: async (path, content) => { writes++; files.set(path, content); return { sha256: "revision" }; },
      deletePath: async () => {}, movePath: async () => {},
    };
    await expect(writeFileSafe({ path: "test/api.test.js", content: "const password = 'fixed-password-for-tests';" }, port)).rejects.toMatchObject({ code: "secret_content", status: 403 });
    expect(writes).toBe(0);
    await expect(writeFileSafe({ path: "test/api.test.js", content: "const password = 'fixed-password-for-tests';" }, port)).rejects.toMatchObject({ details: { approvalCanOverride: false } });
    expect(files.has("test/api.test.js")).toBe(false);
    const safe = "import { randomBytes } from 'node:crypto';\nconst password = randomBytes(24).toString('base64url');";
    await writeFileSafe({ path: "test/api.test.js", content: safe }, port);
    expect(files.get("test/api.test.js")).toBe(safe);
    expect(isWorkspaceContentProtected("test/api.test.js", files.get("test/api.test.js")!)).toBe(false);
  });
  it("validates the whole patch before committing any sibling file", async () => {
    let committed = false;
    const port = { applyPatchTransaction: async () => { committed = true; return []; } } as unknown as CodeWritePort;
    await expect(commitPatchMutations([
      { path: "ok.js", before: "", after: "export const ok = true;", existing: false },
      { path: "test.js", before: "", after: "const password = 'fixed-password-for-tests';", existing: false },
    ], port, {})).rejects.toMatchObject({ code: "secret_content" });
    expect(committed).toBe(false);
  });
  it("keeps the existing read protection and manifest policy unchanged", () => {
    expect(isWorkspaceContentProtected("auth.js", "const password = 'fixed-password-for-tests';")).toBe(true);
    expect(isWorkspaceContentProtected("key.pem", "-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(isWorkspaceContentProtected("package-lock.json", '{"token":"registry-metadata-value"}')).toBe(false);
    expect(isWorkspaceContentProtected("auth.js", "const token = randomBytes(32).toString('hex');")).toBe(false);
  });
  it.each(["code.fs.read", "code.shell.exec", "code.verify.run"])("preserves workspace protection for %s", tool => {
    const result = toFailure(new ProjectFileError("secret_content", "Protected file content", 403), tool);
    expect(result).toMatchObject({ ok: false, error: { code: "secret_content", status: 403, retryable: false, tool } });
    if (!result.ok) expect(result.error.message).toContain("runtime-generated test credentials");
  });
  it("preserves sandbox download protection without exposing source content", () => {
    const result = toFailure(new SandboxProviderError("secret_content", "Sandbox produced protected file content", 403, "download"), "code.shell.exec");
    expect(result).toMatchObject({ ok: false, error: { code: "secret_content", status: 403, retryable: false } });
  });
  it("still reports unexpected implementation faults as server failures", () => {
    expect(toFailure(new Error("unexpected"), "code.fs.read")).toMatchObject({ ok: false, error: { code: "tool_failed", status: 500 } });
  });
});
