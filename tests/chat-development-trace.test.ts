import { describe, expect, it, vi } from "vitest";
import { sanitizeExecutionTrace, type DevelopmentProcess } from "@npati/shared";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { executionResultDetails, developmentTrace, selectDevelopmentTraceRuns } from "../apps/agent-api/src/chat-development-trace";
const ctx: AuthContext = { workspaceId: "workspace", userId: "user", permissions: ["*"] };
const process: DevelopmentProcess = { id: "process", companyId: "company", projectId: "project", sessionId: "session", runId: "run", parentConversationId: "parent", name: "Next.js", framework: "Next.js", status: "running", hidden: false, createdAt: "2026-10-13T10:00:00Z", updatedAt: "2026-10-13T10:00:00Z" };
function fixture(status = "running", workspaceId = "workspace") {
  const startedAt = new Date("2026-10-13T10:00:01Z");
  const calls = [
    { toolCallId: "read-1", tool: "code.read", outcome: "ok", startedAt, finishedAt: new Date(startedAt.getTime() + 20) },
    { toolCallId: "read-2", tool: "code.read", outcome: "unknown_outcome", startedAt, finishedAt: null },
    { toolCallId: "shell", tool: "code.shell", outcome: "unknown_outcome", startedAt, finishedAt: null },
    { toolCallId: "approval", tool: "code.shell", outcome: "failed", errorCode: "approval_required", startedAt, finishedAt: new Date(startedAt.getTime() + 20) },
  ];
  const store = {
    getCodeRunState: vi.fn().mockResolvedValue({ ...process, workspaceId, status, details: {} }),
    listCodeRunTurns: vi.fn().mockResolvedValue([{ toolCalls: calls }]),
    getReplayBundle: vi.fn().mockResolvedValue({ id: "bundle" }),
    listReplayBundleSteps: vi.fn().mockResolvedValue([
      { kind: "model_step", payload: { response: { toolCalls: [{ id: "shell", arguments: JSON.stringify({ command: "npm run build", cwd: "/real/project" }) }, { id: "read-1", arguments: JSON.stringify({ path: "app/page.tsx" }) }] } } },
      { kind: "tool_call", toolCallId: "read-1", payload: { settledResult: JSON.stringify({ ok: true, result: { stdout: "token=secret123", stderr: "", exitCode: 0 } }) } },
    ]),
    listCodeActivityEvents: vi.fn().mockResolvedValue([{ id: "duplicate", createdAt: startedAt, payload: { tool: "code.read", toolCallId: "read-1", ok: true } }]),
  };
  return { calls, store: store as unknown as WorkspaceStore, mocks: store };
}
it("distinguishes command transport success from failed exit codes and reads canonical patch changes", () => {
  expect(executionResultDetails({exitCode:1,stdout:"compile error"})).toMatchObject({status:"failed",exitCode:1});
  expect(executionResultDetails({files:[{path:"app/page.tsx",action:"update",linesAdded:4,linesRemoved:2},{path:"app/contact.tsx",action:"add"}],tests:{total:24,passed:23,failed:1,skipped:0}})).toMatchObject({files:[{path:"app/page.tsx",action:"modified"},{path:"app/contact.tsx",action:"created"}],tests:{total:24,failed:1}});
});
describe("existing runtime execution trace projection", () => {
  it("shows concurrent unfinished calls, actual arguments/results and deduplicates Activity", async () => {
    const f = fixture(); const events = await developmentTrace(f.store, ctx, process);
    expect(events).toHaveLength(4);
    expect(events.find(e => e.id === "run:shell")).toMatchObject({ status: "running", command: "npm run build", cwd: "/real/project" });
    expect(events.find(e => e.id === "run:read-1")).toMatchObject({ status: "completed", file: "app/page.tsx", exitCode: 0, durationMs: 20 });
    expect(events.find(e => e.id === "run:approval")?.status).toBe("waiting_for_approval");
    expect(events.filter(e => e.status === "running")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("secret123");
  });
  it("reads PostgreSQL JSONB tool-call timestamps after a JSON round trip", async () => {
    const f = fixture();
    f.mocks.listCodeRunTurns.mockResolvedValue(JSON.parse(JSON.stringify([{ toolCalls: f.calls }])));
    const events = await developmentTrace(f.store, ctx, process);
    expect(events).toHaveLength(4);
    expect(events.find(e => e.id === "run:read-1")).toMatchObject({ at: "2026-10-13T10:00:01.000Z", status: "completed", durationMs: 20 });
    expect(events.find(e => e.id === "run:shell")).toMatchObject({ status: "running" });
    expect(events.find(e => e.id === "run:shell")?.durationMs).toBeUndefined();
  });
  it("handles missing or malformed timestamps without dropping the operation or breaking the chat", async () => {
    const f = fixture();
    f.mocks.listCodeRunTurns.mockResolvedValue([{ toolCalls: [{ ...f.calls[0], startedAt: "invalid", finishedAt: "invalid" }] }]);
    const events = await developmentTrace(f.store, ctx, process);
    expect(events.find(e => e.id === "run:read-1")).toMatchObject({ at: process.createdAt, status: "completed" });
    expect(events.find(e => e.id === "run:read-1")?.durationMs).toBeUndefined();
  });
  it("restores persisted calls after reload and settles cancellation and failed calls", async () => {
    const f = fixture("cancelled");
    const first = await developmentTrace(f.store, ctx, process);
    expect(await developmentTrace(f.store, ctx, process)).toEqual(first);
    expect(first.find(e => e.id === "run:shell")?.status).toBe("cancelled");
    const failed = fixture("failed");
    expect((await developmentTrace(failed.store, ctx, process)).find(e => e.id === "run:shell")?.status).toBe("failed");
  });
  it("refuses foreign workspace/project/session run details", async () => {
    const f = fixture("running", "foreign");
    expect(await developmentTrace(f.store, ctx, process)).toEqual([]);
    expect(f.mocks.listReplayBundleSteps).not.toHaveBeenCalled();
    f.mocks.getCodeRunState.mockResolvedValue({ ...process, workspaceId: "workspace", projectId: "other", status: "running" });
    expect(await developmentTrace(f.store, ctx, process)).toEqual([]);
  });
  it("includes linked child agents and excludes foreign or unrelated runs", () => {
    const root = { ...process, runId: "run", workspaceId: ctx.workspaceId, details: {} };
    const child = { ...root, runId: "child", sessionId: "child-session", details: { parentRunId: "run", agentType: "designer" } };
    const unrelated = { ...child, runId: "unrelated", details: { parentRunId: "foreign-root" } };
    const foreign = { ...child, runId: "foreign", workspaceId: "other" };
    const selected = selectDevelopmentTraceRuns([root, child, unrelated, foreign] as unknown as Parameters<typeof selectDevelopmentTraceRuns>[0], ctx, process);
    expect(selected.roots.map(r => r.runId)).toEqual(["run"]); expect(selected.children.map(r => r.runId)).toEqual(["child"]);
  });
  it("masks JSON credentials, short passwords, database URLs, JWTs and private keys", () => {
    const input = '{"password":"p","API_TOKEN":"sensitive-value"} postgres://alice:pass@localhost/db Bearer hello.secret.value sk-proj-abcdefghijklmnop';
    const output = sanitizeExecutionTrace(input);
    expect(output).not.toContain('"p"'); expect(output).not.toContain("sensitive-value"); expect(output).not.toContain("alice:pass"); expect(output).not.toContain("hello.secret.value"); expect(output).not.toContain("sk-proj-");
  });
});
