import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectVerificationTools } from "../apps/agent-api/src/code-project-verification-tools";
import type { CodeSessionRunInput } from "../apps/agent-api/src/code-session-run-executor";
import { movePathSafe, type CodeWritePort } from "../apps/agent-api/src/code-tools-write";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { protectedMoveStopMessage } from "../apps/agent-api/src/code-protected-move-stop";

describe("D09 actual project verification resolver", () => {
  const input = (overrides = {}) => ({ ctx: {}, session: { companyId: "c", projectId: "p", mode: "auto" }, ...overrides } as CodeSessionRunInput);
  it.each([
    ["HTML/CSS", {}, []],
    ["HTML/CSS", { test: "npm test" }, ["test"]],
    ["HTML/CSS", { build: "npm run build", test: "npm test" }, ["build", "test"]],
    ["HTML/CSS", { test: " " }, []],
    ["Astro", {}, ["build"]],
    ["Astro", { test: "npm test" }, ["build", "test"]],
  ])("uses actual commands for %s: %j", async (framework, commands, expected) => {
    const projects = { get: vi.fn().mockResolvedValue({ type: "website", framework }) };
    const code = { resolveVerifyCommands: vi.fn().mockResolvedValue(commands) };
    expect(await resolveProjectVerificationTools(input(), projects, code)).toEqual(expected);
    expect(code.resolveVerifyCommands).toHaveBeenCalledOnce();
  });
  it("rediscovers newly generated commands instead of caching the initial static workspace", async () => {
    const projects = { get: vi.fn().mockResolvedValue({ type: "website", framework: "HTML/CSS" }) };
    const code = { resolveVerifyCommands: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ test: "npm test" }) };
    expect(await resolveProjectVerificationTools(input(), projects, code)).toEqual([]);
    expect(await resolveProjectVerificationTools(input(), projects, code)).toEqual(["test"]);
  });
  it.each([{ readOnlyIntent: true }, { session: { companyId: "c", projectId: "p", mode: "plan" } }])("does not execute checks for readonly/plan inputs", async overrides => {
    const code = { resolveVerifyCommands: vi.fn() };
    expect(await resolveProjectVerificationTools(input(overrides), { get: vi.fn().mockResolvedValue({ type: "website" }) }, code)).toBeUndefined();
    expect(code.resolveVerifyCommands).not.toHaveBeenCalled();
  });
  it("does not convert discovery failures to a verification skip", async () => {
    const failure = new Error("workspace unavailable");
    await expect(resolveProjectVerificationTools(input(), { get: vi.fn().mockResolvedValue({ type: "website", framework: "HTML/CSS" }) },
      { resolveVerifyCommands: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });
});

describe("D10 protection-changing moves", () => {
  it("does not stop a reparable new write or an unrelated move failure as a protected rename", () => {
    const refused = {ok: false as const, error: {code: "secret_content" as const, status: 403, message: "refused", retryable: false, step: "guard"}};
    expect(protectedMoveStopMessage("code.fs.write", refused)).toBeNull();
    expect(protectedMoveStopMessage("code.fs.move", {...refused, error: {...refused.error, code: "revision_conflict"}})).toBeNull();
    expect(protectedMoveStopMessage("code.fs.move", refused, "en", "Build an app and repair its own newly generated files")).toBeNull();
    expect(protectedMoveStopMessage("code.fs.move", refused, "en", "Move the generated app into place", true)).toBeNull();
  });
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("npati-move-regression-")) throw Error("Unexpected temporary root"); await rm(root, { recursive: true, force: true }); } });
  const synthetic = JSON.stringify({ name: "synthetic-metadata", token: "synthetic-regression-fixture" });
  it("refuses before calling the move port and preserves both original and existing destination", async () => {
    const movePath = vi.fn();
    const port = { stat: vi.fn().mockResolvedValue({ exists: true, type: "file" }), readFile: vi.fn().mockResolvedValue({ content: synthetic }), movePath } as unknown as CodeWritePort;
    await expect(movePathSafe({ from: "package.json", to: "metadata.json", overwrite: true }, port)).rejects.toMatchObject({ code: "secret_content", status: 403 });
    expect(movePath).not.toHaveBeenCalled();
  });
  it("keeps allowed manifest-to-manifest and ordinary file moves available", async () => {
    const movePath = vi.fn();
    const port = { stat: vi.fn(async (p: string) => p.startsWith("old/") ? { exists: true, type: "file" } : { exists: false }), readFile: vi.fn().mockResolvedValue({ content: synthetic }), movePath } as unknown as CodeWritePort;
    await expect(movePathSafe({ from: "old/package.json", to: "new/package.json" }, port)).resolves.toMatchObject({ moved: true });
    expect(movePath).toHaveBeenCalledOnce();
    port.readFile = vi.fn().mockResolvedValue({ content: "export const ready = true;" });
    await expect(movePathSafe({ from: "old/a.js", to: "new/a.js" }, port)).resolves.toMatchObject({ moved: true });
  });
  it("does not require a text read to move a binary file under the same protection policy", async () => {
    const port = { stat: vi.fn(async (p: string) => p === "old.png" ? { exists: true, type: "file" } : { exists: false }),
      readFile: vi.fn().mockRejectedValue(new Error("binary text reads are unsupported")), movePath: vi.fn() } as unknown as CodeWritePort;
    await expect(movePathSafe({ from: "old.png", to: "new.png" }, port)).resolves.toMatchObject({ moved: true });
    expect(port.readFile).not.toHaveBeenCalled();
  });
  it("checks bytes under the authoritative workspace lock even when the engine is bypassed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-move-regression-")); roots.push(root);
    const ctx = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "business:manage"] };
    const workspace = new LocalProjectWorkspace({ get: vi.fn().mockResolvedValue({ id: "p", companyId: "c", workspaceId: "w", revision: 1 }) }, { root });
    const source = await workspace.createFile(ctx, "c", "p", "package.json", synthetic);
    await expect(workspace.moveFile(ctx, "c", "p", "package.json", "metadata.json", source.revision)).rejects.toMatchObject({ code: "secret_content", status: 403 });
    expect((await workspace.readFile(ctx, "c", "p", "package.json")).content).toBe(synthetic);
    await expect(workspace.readFile(ctx, "c", "p", "metadata.json")).rejects.toMatchObject({ status: 404 });
  });
});
