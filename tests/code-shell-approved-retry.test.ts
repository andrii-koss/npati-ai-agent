import { describe, expect, it } from "vitest";
import { canonicalJson, type AuthContext } from "@npati/workspace";
import { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";
import { CodeShellRuntime } from "../apps/agent-api/src/code-shell-runtime";
import { canonicalShellExecutors } from "../apps/agent-api/src/code-tool-executors-shell";
import { createCodePortsWiring, type CreateCodePortsWiringDeps } from "../apps/agent-api/src/code-ports-wiring";
import { DEFAULT_CODE_AGENT_LIMITS } from "../apps/agent-api/src/code-agent-config";
import type { CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";

describe("shell approval through the production executor and adapter", () => {
  it("redeems the exact approved call once and refuses command substitution", async () => {
    const ctx: AuthContext = { workspaceId: "ws", userId: "owner", permissions: ["workspace:write"] };
    let row: Record<string, unknown> = {};
    let consumed = false, approved = false, executions = 0;
    const policy = new PolicyEngine({
      flags: { assertEnabled: async () => true },
      capabilities: { get: () => ({ id: "code.shell.exec", status: "active", version: 1 }) },
      classifier: () => ({ risk: "controlled" }),
      sessionMode: async () => "edit",
      approvals: {
        requestApproval: async (_ctx, _companyId, input) => { row = input; return { id: "approval-1" }; },
        consumeApproved: async (_ctx, _companyId, id, input) => {
          // Mirror the durable repository: same identity, tool, and canonical payload; single use.
          if (!approved || consumed || id !== "approval-1" || input.runId !== row.runId || input.agentId !== row.agentId
            || input.toolName !== row.toolName || !row.inputPayload || canonicalJson(input.inputPayload) !== canonicalJson(row.inputPayload)) {
            throw Object.assign(new Error("Approval context or payload does not match"), { code: "APPROVAL_INVALID" });
          }
          consumed = true;
        },
      },
    });
    const shell = new CodeShellRuntime({ policy, sandbox: { execute: async input => { expect(input.approved).toBe(true); executions++; return { exitCode: 0, stdout: "proof", stderr: "", durationMs: 1, status: "completed", sandboxId: "sandbox" }; } } });
    const ports = createCodePortsWiring({ config: {}, log: { warn() {}, info() {} }, codeShellRuntime: shell,
      projectSandbox: {}, featureFlagService: {}, secretLeases: {} } as unknown as CreateCodePortsWiringDeps);
    const exec = canonicalShellExecutors({ shellRuntime: ports.codeShellRuntimePort })["code.shell.exec"]!;
    const input = { ctx, companyId: "company", projectId: "project", sessionId: "session", turnId: "turn", toolCallId: "call",
      tool: { name: "code.shell.exec", version: 1 }, args: { command: "node proof.js" }, limits: DEFAULT_CODE_AGENT_LIMITS,
    } as CodeToolExecutionContext;
    await expect(exec(input)).rejects.toMatchObject({ code: "approval_required" });
    expect(executions).toBe(0);
    approved = true;
    for (const args of [{ command: "node other.js" }, { command: "node proof.js", cwd: "different" },
      { command: "node proof.js", env: { PROOF: "changed" } }]) {
      await expect(exec({ ...input, approvalId: "approval-1", args })).rejects.toBeDefined();
    }
    expect(executions).toBe(0);
    expect(consumed).toBe(false);
    // Reset only the test table to the actual request; the refused mismatch cannot spend it.
    await expect(exec(input)).rejects.toMatchObject({ code: "approval_required" });
    await expect(exec({ ...input, approvalId: "approval-1" })).resolves.toMatchObject({ stdout: "proof" });
    expect(executions).toBe(1);
    await expect(exec({ ...input, approvalId: "approval-1" })).rejects.toBeDefined();
    expect(executions).toBe(1);
  });

  it("runs a command the company setting allowed, with the sandbox told it is approved, and still asks for a git push", async () => {
    const ctx: AuthContext = { workspaceId: "ws", userId: "owner", permissions: ["workspace:write"] };
    const requested: unknown[] = []; const sandboxCalls: Array<{ command: string; approved?: boolean }> = [];
    const policy = new PolicyEngine({
      flags: { assertEnabled: async () => true },
      capabilities: { get: () => ({ id: "code.shell.exec", status: "active", version: 1 }) },
      classifier: () => ({ risk: "approval" }),
      sessionMode: async () => "auto",
      approvals: { requestApproval: async (_c, _co, input) => { requested.push(input); return { id: "approval-x" }; }, consumeApproved: async () => {} },
      networkEnforcement: () => true,
      companyAutoAllow: async () => true,
    });
    const shell = new CodeShellRuntime({ policy, sandbox: { execute: async input => { sandboxCalls.push({ command: input.command, approved: input.approved }); return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, status: "completed", sandboxId: "sandbox" }; } } });
    const ports = createCodePortsWiring({ config: {}, log: { warn() {}, info() {} }, codeShellRuntime: shell,
      projectSandbox: {}, featureFlagService: {}, secretLeases: {} } as unknown as CreateCodePortsWiringDeps);
    const exec = canonicalShellExecutors({ shellRuntime: ports.codeShellRuntimePort })["code.shell.exec"]!;
    const input = { ctx, companyId: "company", projectId: "project", sessionId: "session", turnId: "turn", toolCallId: "call",
      tool: { name: "code.shell.exec", version: 1 }, args: { command: "rm temp-check.txt" }, limits: DEFAULT_CODE_AGENT_LIMITS,
    } as CodeToolExecutionContext;
    await expect(exec(input)).resolves.toMatchObject({ stdout: "ok" });
    expect(sandboxCalls).toEqual([{ command: "rm temp-check.txt", approved: true }]);
    await expect(exec({ ...input, toolCallId: "push", args: { command: "git push origin main" } })).rejects.toMatchObject({ code: "approval_required" });
    expect(sandboxCalls).toHaveLength(1);
    expect(requested).toHaveLength(1);
  });

  it("lets the sandbox run a command a standing rule allows, and refuses one the rule does not cover", async () => {
    const ctx: AuthContext = { workspaceId: "ws", userId: "owner", permissions: ["workspace:write"] };
    const sandboxCalls: Array<{ command: string; approved?: boolean }> = [];
    const policy = new PolicyEngine({
      flags: { assertEnabled: async () => true },
      capabilities: { get: () => ({ id: "code.shell.exec", status: "active", version: 1 }) },
      classifier: () => ({ risk: "approval" }),
      sessionMode: async () => "auto",
      approvals: { requestApproval: async () => ({ id: "approval-r" }), consumeApproved: async () => {} },
      networkEnforcement: () => true,
      approvalRules: { findRule: async (_ctx, query) => query.action === "code.shell.exec:npm:test" ? { id: "rule-1", scope: "project" } : null },
    });
    const shell = new CodeShellRuntime({ policy, sandbox: { execute: async input => { sandboxCalls.push({ command: input.command, approved: input.approved }); return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, status: "completed", sandboxId: "sandbox" }; } } });
    const ports = createCodePortsWiring({ config: {}, log: { warn() {}, info() {} }, codeShellRuntime: shell,
      projectSandbox: {}, featureFlagService: {}, secretLeases: {} } as unknown as CreateCodePortsWiringDeps);
    const exec = canonicalShellExecutors({ shellRuntime: ports.codeShellRuntimePort })["code.shell.exec"]!;
    const input = { ctx, companyId: "company", projectId: "project", sessionId: "session", turnId: "turn", toolCallId: "rule-call",
      tool: { name: "code.shell.exec", version: 1 }, args: { command: "npm test" }, limits: DEFAULT_CODE_AGENT_LIMITS,
    } as CodeToolExecutionContext;
    await expect(exec(input)).resolves.toMatchObject({ stdout: "ok" });
    expect(sandboxCalls).toEqual([{ command: "npm test", approved: true }]);
    await expect(exec({ ...input, toolCallId: "other", args: { command: "npm run deploy-db" } })).rejects.toMatchObject({ code: "approval_required" });
    expect(sandboxCalls).toHaveLength(1);
  });
});
