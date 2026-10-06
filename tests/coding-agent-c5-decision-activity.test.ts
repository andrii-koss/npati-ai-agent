import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  PolicyDecisionRecorder, assertNoSensitivePolicyDecision, emptyPolicyDecisionSummary, redactPolicyDecision,
} from "../apps/agent-api/src/policy-decision-activity";
import { PolicyEngine, type PolicyEngineDeps } from "../apps/agent-api/src/code-policy-engine";

const owner: AuthContext = { workspaceId: "ws-c5a", userId: "user-owner", permissions: ["workspace:read", "workspace:write", "admin:all"] };

const TOOLS = ["code.fs.read", "code.fs.write", "code.shell.exec", "code.deps.add"];

function engineDeps(overrides: Partial<PolicyEngineDeps> = {}): PolicyEngineDeps {
  return {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (TOOLS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    classifier: (command: string) => {
      if (/rm -rf \//.test(command)) return { risk: "hard_deny" as const };
      if (/npm test|vitest|tsc|ls\b/.test(command)) return { risk: "safe" as const };
      return { risk: "approval" as const };
    },
    approvals: {
      async requestApproval() { return { id: "approval-1" }; },
      async consumeApproved() { return { id: "approval-1" }; },
    },
    // Egress enforcement is guaranteed here so the network gate is not the phase under test; the
    // dedicated case below closes it again to prove the gate is recorded when it does fire.
    networkEnforcement: () => true,
    ...overrides,
  };
}

describe("security-gate: C5 policy decision activity", () => {
  it("records who acted, what was attempted, the mode, the phase, the rule and the outcome", async () => {
    const recorder = new PolicyDecisionRecorder({ now: () => new Date("2026-01-02T03:04:05.000Z") });
    const event = await recorder.record({
      companyId: "company-1",
      projectId: "project-1",
      sessionId: "session-1",
      runId: "run-1",
      tool: "code.fs.write",
      action: "code.fs.write",
      mode: "ask",
      phase: "session_mode",
      decision: "deny",
      code: "session_mode_denied",
      ruleRef: { scope: "project", id: "rule-7" },
      actor: "user-owner",
      actorKind: "user",
      agentId: "agent-9",
    });

    expect(event).toMatchObject({
      kind: "policy_decision",
      companyId: "company-1",
      projectId: "project-1",
      sessionId: "session-1",
      runId: "run-1",
      tool: "code.fs.write",
      action: "code.fs.write",
      mode: "ask",
      phase: "session_mode",
      decision: "deny",
      code: "session_mode_denied",
      ruleRef: { scope: "project", id: "rule-7" },
      actor: "user-owner",
      actorKind: "user",
      agentId: "agent-9",
      at: "2026-01-02T03:04:05.000Z",
    });
    // The event carries identifiers and reasons only: no content-bearing field exists on it.
    expect(Object.keys(event).some((key) => ["command", "content", "body", "headers"].includes(key))).toBe(false);
  });

  it("refuses to carry command lines, file content, headers or URLs", () => {
    const base = redactPolicyDecision({
      companyId: "c", action: "code.fs.read", phase: "capability", decision: "allow", actor: "u",
    });
    for (const key of ["command", "content", "body", "headers", "stdout", "diff", "patch"]) {
      expect(() => assertNoSensitivePolicyDecision({ ...(base as never as Record<string, unknown>), [key]: "x" } as never))
        .toThrow(new RegExp(`policy_decision_must_not_carry:${key}`));
    }
    expect(() => assertNoSensitivePolicyDecision({ ...base, code: "see https://internal.example.com/run" } as never))
      .toThrow(/policy_decision_must_not_carry_full_url/);
    expect(() => assertNoSensitivePolicyDecision({ ...base, action: "fetch?token=abc" } as never))
      .toThrow(/policy_decision_must_not_carry_query/);
  });

  it("masks secret-shaped material instead of storing it", async () => {
    const recorder = new PolicyDecisionRecorder();
    const event = await recorder.record({
      companyId: "c",
      action: "export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      phase: "approval",
      decision: "deny",
      actor: "u",
    });
    expect(event.action).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(event.action).toMatch(/\[REDACTED/);
    // Masking happens before the assertion, so even a caller mistake cannot produce a leaking event.
    expect(() => assertNoSensitivePolicyDecision(event)).not.toThrow();
  });

  it("counts allow, deny and require_approval per company, phase and rule", async () => {
    const recorder = new PolicyDecisionRecorder();
    await recorder.record({ companyId: "c1", action: "a", phase: "capability", decision: "allow", actor: "u" });
    await recorder.record({ companyId: "c1", action: "a", phase: "session_mode", decision: "deny", code: "session_mode_denied", actor: "u", ruleRef: { scope: "project", id: "r1" } });
    await recorder.record({ companyId: "c1", action: "a", phase: "approval", decision: "require_approval", actor: "u", ruleRef: { scope: "project", id: "r1" } });
    await recorder.record({ companyId: "c2", action: "a", phase: "capability", decision: "allow", actor: "u" });

    const summary = recorder.summary("c1");
    expect(summary.allowed).toBe(1);
    expect(summary.denied).toBe(1);
    expect(summary.requireApproval).toBe(1);
    expect(summary.byPhase.session_mode).toEqual({ allowed: 0, denied: 1, requireApproval: 0 });
    expect(summary.byPhase.approval).toEqual({ allowed: 0, denied: 0, requireApproval: 1 });
    expect(summary.topDeniedCodes[0]).toEqual({ code: "session_mode_denied", count: 1 });
    expect(summary.topRules[0]).toEqual({ rule: "project:r1", count: 2 });
    expect(recorder.summary("c2").allowed).toBe(1);
    expect(recorder.summary("nobody")).toEqual(emptyPolicyDecisionSummary());
    expect(recorder.recentEvents("c1")).toHaveLength(3);
  });

  it("records a decision for allow, deny and require_approval through the engine", async () => {
    const events: Array<Record<string, unknown>> = [];
    const engine = new PolicyEngine(engineDeps({
      decisionRecorder: (request, result) => {
        events.push({ tool: request.tool, phase: result.phase, decision: result.decision, code: result.code ?? null, mode: request.sessionMode ?? null });
      },
    }));

    await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read", sessionMode: "plan" });
    await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.write", sessionMode: "plan" });
    await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm publish", sessionMode: "edit" });

    expect(events[0]).toMatchObject({ tool: "code.fs.read", decision: "allow" });
    expect(events[1]).toMatchObject({ tool: "code.fs.write", decision: "deny", code: "session_mode_denied", mode: "plan" });
    expect(events[2]).toMatchObject({ tool: "code.shell.exec", decision: "require_approval" });
    expect(events).toHaveLength(3);
  });

  it("records the rule that drove the decision when a scoped rule applied", async () => {
    const seen: Array<{ scope: string; id: string } | null | undefined> = [];
    const engine = new PolicyEngine(engineDeps({
      approvalRules: {
        async findRule() { return { scope: "project", id: "rule-42" }; },
      },
      decisionRecorder: (request) => { seen.push(request.ruleRef); },
    }));

    const result = await engine.evaluate({ ctx: owner, companyId: "c", projectId: "p", tool: "code.shell.exec", command: "npm publish", sessionMode: "edit" });
    expect(result.decision).toBe("allow");
    expect(seen[0]).toEqual({ scope: "project", id: "rule-42" });
  });

  it("never lets a failing recorder change the verdict (observability is not a gate)", async () => {
    const warnings: unknown[] = [];
    const engine = new PolicyEngine(engineDeps({
      decisionRecorder: () => { throw new Error("sink down"); },
      logger: { warn: (obj) => { warnings.push(obj); } },
    }));

    // Allow stays allow, deny stays deny — the failure is logged, never silently converted.
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read", sessionMode: "plan" }))
      .toMatchObject({ decision: "allow" });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.write", sessionMode: "plan" }))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
    expect(warnings).toHaveLength(2);
    expect(String((warnings[0] as { err?: Error }).err?.message)).toContain("sink down");
  });

  it("records the network gate denial with its structured code", async () => {
    const recorded: Array<{ decision: string; code?: string; phase: string }> = [];
    const engine = new PolicyEngine(engineDeps({
      networkEnforcement: () => false,
      decisionRecorder: (_request, result) => { recorded.push({ decision: result.decision, code: result.code, phase: result.phase }); },
    }));

    await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "curl https://registry.npmjs.org", sessionMode: "full_auto" });
    expect(recorded[0]).toMatchObject({ decision: "deny", code: "network_enforcement_unavailable", phase: "network_enforcement" });
  });
});
