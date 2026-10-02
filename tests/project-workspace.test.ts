import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalProjectWorkspace, ProjectFileError } from "../apps/agent-api/src/project-workspace";

const context = { userId: "user-a", workspaceId: "tenant-a", permissions: ["workspace:read", "business:manage"] };
const project = { id: "project-a", companyId: "company-a", workspaceId: "tenant-a", status: "ready", repositoryBranch: "main", revision: 1 };
const projectService = { get: async (ctx: typeof context, companyId: string, projectId: string) => {
  if (ctx.userId !== "user-a" || companyId !== project.companyId || projectId !== project.id) throw new Error("Access denied");
  return project;
} };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-project-files-")); roots.push(root);
  return { root, workspace: new LocalProjectWorkspace(projectService, { root, maxFileBytes: 4096, maxFiles: 3 }) };
}
describe("Project workspace", () => {
  it.each(["../../etc/passwd", "/etc/passwd", "a/../../b", "a\\..\\b", "a\0b"])("rejects unsafe path %s", async (filePath) => {
    const { workspace } = await fixture();
    await expect(workspace.createFile(context, "company-a", "project-a", filePath, "x")).rejects.toMatchObject({ code: "invalid_path" });
  });
  it("rejects external symlinks", async () => {
    const { root, workspace } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "npati-external-")); roots.push(outside);
    await writeFile(path.join(outside, "public.txt"), "secret");
    const base = path.join(root, "company-a", "project-a");
    await workspace.getFileTree(context, "company-a", "project-a");
    await symlink(outside, path.join(base, "escape"), "junction");
    await expect(workspace.readFile(context, "company-a", "project-a", "escape/public.txt")).rejects.toMatchObject({ code: "invalid_path" });
  });
  it("isolates company, user, and workspace IDs", async () => {
    const { workspace } = await fixture();
    await expect(workspace.getFileTree(context, "company-b", "project-a")).rejects.toThrow();
    await expect(workspace.getFileTree({ ...context, userId: "user-b" }, "company-a", "project-a")).rejects.toThrow();
    await expect(workspace.getFileTree(context, "company-a", "project-a", "forged-workspace")).rejects.toMatchObject({ code: "workspace_mismatch" });
  });
  it("requires expected revision for edits", async () => {
    const { workspace } = await fixture();
    const created = await workspace.createFile(context, "company-a", "project-a", "index.html", "one");
    const updated = await workspace.writeFile(context, "company-a", "project-a", "index.html", "two", created.revision);
    await expect(workspace.editFile(context, "company-a", "project-a", "index.html", "two", "three", created.revision)).rejects.toMatchObject({ code: "revision_conflict", currentRevision: updated.revision });
  });
  it("enforces file count and size limits", async () => {
    const { workspace } = await fixture();
    await expect(workspace.createFile(context, "company-a", "project-a", "big.txt", "x".repeat(4097))).rejects.toMatchObject({ code: "file_too_large" });
    for (const name of ["a", "b", "c"]) await workspace.createFile(context, "company-a", "project-a", name, "x");
    await expect(workspace.createFile(context, "company-a", "project-a", "d", "x")).rejects.toMatchObject({ code: "file_limit" });
  });
});

describe("Project workspace confidentiality and concurrency", () => {
  it("blocks protected paths and secret content from reads", async () => {
    const { workspace } = await fixture();
    await expect(workspace.createFile(context, "company-a", "project-a", ".env", "TOKEN=hidden")).rejects.toMatchObject({ code: "secret_path" });
    await workspace.createFile(context, "company-a", "project-a", "config.txt", 'api_key="long-secret-value"');
    await expect(workspace.readFile(context, "company-a", "project-a", "config.txt")).rejects.toMatchObject({ code: "secret_content" });
  });
  it("serializes revisions across workspace instances", async () => {
    const { root, workspace } = await fixture();
    const other = new LocalProjectWorkspace(projectService, { root, maxFileBytes: 4096, maxFiles: 3 });
    const created = await workspace.createFile(context, "company-a", "project-a", "index.txt", "first");
    const results = await Promise.allSettled([
      workspace.writeFile(context, "company-a", "project-a", "index.txt", "second", created.revision),
      other.writeFile(context, "company-a", "project-a", "index.txt", "third", created.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "revision_conflict" } }]);
  });
});
