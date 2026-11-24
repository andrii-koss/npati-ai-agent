import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { CodeToolRuntime, type CodeReadPort } from "../apps/agent-api/src/code-tool-runtime";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";

/**
 * One approval per request: once the person approved a database change in a run, the run's further ordinary database
 * changes (policies, seed rows) go ahead without a new request. Irreversible changes (deleting rows, tables or
 * columns) still ask, and a run without an earlier approval asks as before.
 */
const ctx: AuthContext = { userId: "owner", workspaceId: "w", permissions: ["admin:all", "workspace:read", "workspace:write"] };
const port: CodeReadPort = { listDir: vi.fn(), readFile: vi.fn(), runSearch: vi.fn() };

function setup(approvedInRun: () => Promise<boolean>) {
  const request = vi.fn(async () => ({ approvalId: "new-request" }));
  const consume = vi.fn(async () => {});
  const approvedDataChangeInRun = vi.fn(approvedInRun);
  const seed = vi.fn(async () => ({ applied: true }));
  const remove = vi.fn(async () => ({ applied: true }));
  const runtime = new CodeToolRuntime({
    flags: { assertEnabled: async () => true } as unknown as FeatureFlagService,
    approvals: { request, consume, approvedDataChangeInRun }, toPort: () => port,
    executors: { "code.data.rows.seed": seed, "code.data.rows.delete": remove },
  });
  const invoke = (tool: string, args: Record<string, unknown>, runId = "run-1:qa-repair:1") =>
    runtime.invoke(ctx, { companyId: "company", projectId: "project", runId, tool, args, toolCallId: crypto.randomUUID() });
  return { invoke, request, approvedDataChangeInRun, seed, remove };
}
const seedArgs = { expectedBackendId: "backend", collection: "notes", rows: [{ title: "Hello" }], dryRun: false };

describe("database changes: one approval covers the run", () => {
  it("after an approval in this run, a further ordinary change runs without a new request", async () => {
    const f = setup(async () => true);
    const result = await f.invoke("code.data.rows.seed", seedArgs);
    expect(result.ok).toBe(true);
    expect(f.seed).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.approvedDataChangeInRun).toHaveBeenCalledWith({ ctx, companyId: "company", runId: "run-1:qa-repair:1" });
  });

  it("without an earlier approval in the run, it asks as before", async () => {
    const f = setup(async () => false);
    const result = await f.invoke("code.data.rows.seed", seedArgs);
    expect(result.ok).toBe(false);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.seed).not.toHaveBeenCalled();
  });

  it("an irreversible change still asks, even after an approval in the run", async () => {
    const f = setup(async () => true);
    const result = await f.invoke("code.data.rows.delete", { expectedBackendId: "backend", collection: "notes", where: { id: "1" }, dryRun: false });
    expect(result.ok).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.approvedDataChangeInRun).not.toHaveBeenCalled();
  });

  it("an answer that cannot be read counts as 'ask'", async () => {
    const f = setup(async () => { throw new Error("database down"); });
    expect((await f.invoke("code.data.rows.seed", seedArgs)).ok).toBe(false);
    expect(f.seed).not.toHaveBeenCalled();
  });
});
