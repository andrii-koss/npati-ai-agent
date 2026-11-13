import { describe, expect, it } from "vitest";
import { canonicalJson, type AuthContext } from "@npati/workspace";
import { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";
import { CodeShellRuntime } from "../apps/agent-api/src/code-shell-runtime";
import { canonicalShellExecutors } from "../apps/agent-api/src/code-tool-executors-shell";
import { createCodePortsWiring, type CreateCodePortsWiringDeps } from "../apps/agent-api/src/code-ports-wiring";
import { CodeToolRuntime } from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";

// V6 step 08 (D08-01): a shell command that needs the person's permission refused at once. The run went on, the "Allow"
// click approved a request nothing waited for, the command never ran and the reply said it was denied. The tool call now
// waits for the answer, as a file or database change does, and runs the same call once with that approval.
function setup(decision: "approved" | "rejected" | "none") {
  const ctx: AuthContext = { workspaceId: "ws", userId: "owner", permissions: ["workspace:write"] };
  let row: Record<string, unknown> = {}; let consumed = 0; let requested = 0; const ran: string[] = []; const waited: string[] = [];
  const policy = new PolicyEngine({
    flags: { assertEnabled: async () => true },
    capabilities: { get: () => ({ id: "code.shell.exec", status: "active", version: 1 }) },
    classifier: () => ({ risk: "approval" }),
    sessionMode: async () => "edit",
    approvals: {
      requestApproval: async (_c, _co, input) => { row = input; requested++; return { id: "approval-1" }; },
      consumeApproved: async (_c, _co, id, input) => {
        if (decision !== "approved" || consumed || id !== "approval-1" || canonicalJson(input.inputPayload) !== canonicalJson(row.inputPayload)) {
          throw Object.assign(new Error("Approval does not match"), { code: "APPROVAL_INVALID" });
        }
        consumed++;
      },
    },
  });
  const shell = new CodeShellRuntime({ policy, sandbox: { execute: async input => { ran.push(input.command); return { exitCode: 0, stdout: "22 tests OK", stderr: "", durationMs: 1, status: "completed", sandboxId: "sbx" }; } } });
  const ports = createCodePortsWiring({ config: {}, log: { warn() {}, info() {} }, codeShellRuntime: shell,
    projectSandbox: {}, featureFlagService: {}, secretLeases: {} } as unknown as CreateCodePortsWiringDeps);
  const runtime = new CodeToolRuntime({
    flags: { assertEnabled: async () => true } as never,
    schemas: CODE_TOOL_SCHEMAS,
    executors: canonicalShellExecutors({ shellRuntime: ports.codeShellRuntimePort }),
    toPort: () => ({}) as never,
    ...(decision === "none" ? {} : { approvalDecision: {
      timeoutMs: 1_000,
      wait: async ({ approvalId }: { approvalId: string }) => { waited.push(approvalId); return decision === "approved" ? { status: "approved" as const } : { status: "rejected" as const, comment: "no" }; },
    } }),
  });
  const invoke = () => runtime.invoke(ctx, { companyId: "company", projectId: "project", sessionId: "session", turnId: "turn",
    toolCallId: "call-1", runId: "run", agentId: "agent", tool: "code.shell.exec", args: { command: "python3 -m venv .venv" } });
  return { invoke, ran, waited, counts: () => ({ requested, consumed }) };
}

describe("a shell command waits for the person's permission", () => {
  it("runs the command once after Allow, with the approval consumed", async () => {
    const s = setup("approved");
    const result = await s.invoke();
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain("22 tests OK");
    expect(s.ran).toEqual(["python3 -m venv .venv"]);
    expect(s.waited).toEqual(["approval-1"]);
    expect(s.counts()).toEqual({ requested: 1, consumed: 1 });
  });

  it("does not run it after Deny and says it was denied", async () => {
    const s = setup("rejected");
    const result = await s.invoke();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("approval_denied");
    expect(s.ran).toEqual([]);
    expect(s.counts().consumed).toBe(0);
  });

  it("without a decision channel it still refuses with approval_required and runs nothing", async () => {
    const s = setup("none");
    const result = await s.invoke();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("approval_required");
    expect(s.ran).toEqual([]);
  });
});
