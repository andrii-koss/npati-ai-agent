import { describe, expect, it, vi } from "vitest";
import { createCodePortsWiring, type CreateCodePortsWiringDeps } from "../apps/agent-api/src/code-ports-wiring";

function fixture() {
  let questions: CreateCodePortsWiringDeps["codeUserQuestionReaperPort"] = null;
  let release: CreateCodePortsWiringDeps["mcpApprovalPauseRelease"] = null;
  const expire = vi.fn(async () => ({ expired: 1, rows: [{ id: "approval", companyId: "tenant-company", inputPayload: { kind: "mcp_runtime_tool_call", runId: "run" } }] }));
  const deps = {
    config: {}, log: { warn: vi.fn(), info: vi.fn() }, approvalsRepo: { expireStaleApprovalsDetailed: expire },
    get codeUserQuestionReaperPort() { return questions; }, get mcpApprovalPauseRelease() { return release; },
    codeActivitySink: { record: vi.fn() }, codeDataRetention: { preview: async () => ({ expired: 0, retained: 0, retainedReasons: [] }), apply: async () => ({ expired: 0, purged: 0, retained: 0, retainedReasons: [] }) },
    codeProcessManager: { reapIdle: () => 0 }, codeShellRuntime: { reap: () => 0 }, secretLeases: { list: () => [], reap: async () => 0 },
    codeProjectTrust: {}, featureFlagService: {}, projectService: {}, projectWorkspace: {},
  } as unknown as CreateCodePortsWiringDeps;
  const { codeReaper } = createCodePortsWiring(deps);
  return { codeReaper, expire, bind(q: typeof questions, r: typeof release) { questions = q; release = r; } };
}

describe("Step 10 reaper late lifecycle ports", () => {
  it("uses the real ports bound after construction instead of captured nulls", async () => {
    const h = fixture(), expire = vi.fn(async () => 1), release = vi.fn(async () => "released");
    h.bind({ expireCodeUserQuestions: expire, previewCodeUserQuestions: async () => [] }, release);
    const summary = await h.codeReaper.run();
    expect(summary.errors).toEqual([]);
    expect(summary.cleaned.expiredUserQuestions).toBe(1);
    expect(h.expire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ companyId: "tenant-company", runId: "run", approvalId: "approval", reason: "expired" });
  });
  it("does not expire approvals if the release lifecycle port is missing", async () => {
    const h = fixture();
    const summary = await h.codeReaper.run();
    expect(h.expire).not.toHaveBeenCalled();
    expect(summary.errors).toEqual(expect.arrayContaining([expect.objectContaining({ step: "stale_approvals", message: "mcp_approval_pause_release_not_ready" })]));
  });
});
