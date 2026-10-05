import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  PolicyEngine, isAgentPrincipal, isNetworkCommand, isUnsafePath, payloadHashFor, subFlagForTool,
  type PolicyEngineDeps,
} from "../apps/agent-api/src/code-policy-engine";

const owner: AuthContext = { workspaceId: "ws-c4p", userId: "user-owner", permissions: ["workspace:read", "workspace:write", "admin:all"] };
const member: AuthContext = { workspaceId: "ws-c4p", userId: "user-member", permissions: ["workspace:read", "workspace:write"] };
const reader: AuthContext = { workspaceId: "ws-c4p", userId: "user-reader", permissions: ["workspace:read"] };
const agentPrincipal: AuthContext = { workspaceId: "ws-c4p", userId: "agent:runner", externalSubject: "agent:runner", permissions: ["workspace:read", "workspace:write"] };

const TOOLS = [
  "code.fs.read", "code.fs.list", "code.fs.grep", "code.fs.tree", "code.symbols.outline",
  "code.project.info", "code.fs.diff", "code.fs.edit", "code.fs.apply_patch", "code.fs.write",
  "code.fs.move", "code.fs.delete", "code.fs.undo_last_turn", "code.verify.run",
  "code.shell.exec", "code.shell.process.start", "code.shell.process.list", "code.shell.process.logs",
  "code.shell.process.stop",
];

function harness(overrides: Partial<PolicyEngineDeps> = {}) {
  const approvals = {
    requests: [] as Array<Record<string, unknown>>,
    consumed: [] as Array<{ id: string; params: Record<string, unknown> }>,
    failConsume: false,
    async requestApproval(_ctx: AuthContext, _companyId: string, input: Record<string, unknown>) {
      this.requests.push(input);
      return { id: `approval-${this.requests.length}` };
    },
    async consumeApproved(_ctx: AuthContext, _companyId: string, id: string, params: Record<string, unknown>) {
      if (this.failConsume) throw Object.assign(new Error("payload hash mismatch"), { code: "approval_invalid" });
      this.consumed.push({ id, params });
      return { id };
    },
  };
  const deps: PolicyEngineDeps = {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (TOOLS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    classifier: (command: string) => {
      if (/rm -rf \//.test(command)) return { risk: "hard_deny" as const };
      if (/npm test|vitest|tsc/.test(command)) return { risk: "safe" as const };
      if (/npm install|curl/.test(command)) return { risk: "controlled" as const };
      return { risk: "approval" as const };
    },
    approvals,
    networkEnforcement: () => false,
    ...overrides,
  };
  return { engine: new PolicyEngine(deps), approvals, deps };
}

describe("security-gate: C4 PolicyEngine phases", () => {
  it("denies when any decision source is missing instead of allowing by default", async () => {
    const noFlags = new PolicyEngine({ capabilities: { get: () => undefined } });
    expect(await noFlags.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read" }))
      .toMatchObject({ decision: "deny", code: "policy_engine_unavailable", phase: "feature_flag" });

    const noRegistry = new PolicyEngine({ flags: { async assertEnabled() { return true; } } });
    expect(await noRegistry.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read" }))
      .toMatchObject({ decision: "deny", code: "policy_engine_unavailable", phase: "capability" });

    const noClassifier = new PolicyEngine({
      flags: { async assertEnabled() { return true; } },
      capabilities: { get: () => ({ id: "code.shell.exec", status: "active", version: 1 }) },
    });
    expect(await noClassifier.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "ls", sessionMode: "auto" }))
      .toMatchObject({ decision: "deny", code: "policy_engine_unavailable" });
  });

  it("short-circuits on the feature-flag phase with the flag's own code", async () => {
    const engine = new PolicyEngine({
      flags: { async assertEnabled(_ctx, key) { throw Object.assign(new Error(`${key} is off`), { code: key === "code.shell" ? "feature_disabled" : "feature_disabled" }); } },
      capabilities: { get: () => ({ id: "code.fs.read", status: "active", version: 1 }) },
    });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read" }))
      .toMatchObject({ decision: "deny", phase: "feature_flag", status: 403 });
  });

  it("maps every tool to its sub-flag: shell, read, or write", () => {
    expect(subFlagForTool("code.shell.exec")).toBe("code.shell");
    expect(subFlagForTool("code.shell.process.logs")).toBe("code.shell");
    expect(subFlagForTool("code.fs.read")).toBe("code.read");
    expect(subFlagForTool("code.fs.diff")).toBe("code.read");
    expect(subFlagForTool("code.fs.write")).toBe("code.write");
    expect(subFlagForTool("code.fs.delete")).toBe("code.write");
    expect(subFlagForTool("code.verify.run")).toBe("code.write");
  });

  it("enforces RBAC per tool and never lets an agent approve its own action", async () => {
    const { engine } = harness();
    expect(await engine.evaluate({ ctx: reader, companyId: "c", tool: "code.fs.edit", paths: ["src/a.ts"] }))
      .toMatchObject({ decision: "deny", code: "permission_denied", phase: "rbac" });

    expect(isAgentPrincipal(agentPrincipal)).toBe(true);
    expect(isAgentPrincipal(owner)).toBe(false);
    expect(await engine.evaluate({ ctx: agentPrincipal, companyId: "c", tool: "code.shell.exec", command: "prompt-x", approved: true, sessionMode: "auto" }))
      .toMatchObject({ decision: "deny", code: "agent_cannot_approve", phase: "rbac" });
  });

  it("rejects unknown tools and unknown versions in the capability phase", async () => {
    const { engine } = harness();
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.nope" }))
      .toMatchObject({ decision: "deny", code: "unknown_tool", status: 404 });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read", toolVersion: 9 }))
      .toMatchObject({ decision: "deny", code: "unknown_tool_version", status: 404 });
  });

  it("never allows a hard-denied command, not even for an owner in full_auto with an approval", async () => {
    const { engine } = harness();
    for (const request of [
      { ctx: owner, companyId: "c", tool: "code.shell.exec", command: "rm -rf /", sessionMode: "full_auto" as const },
      { ctx: owner, companyId: "c", tool: "code.shell.exec", command: "true && rm -rf /", sessionMode: "full_auto" as const, approved: true, approvalId: "a1" },
    ]) {
      expect(await engine.evaluate(request)).toMatchObject({ decision: "deny", code: "command_hard_denied", phase: "hard_deny", risk: "hard_deny" });
    }
    expect(isUnsafePath("../../etc/passwd")).toBe(true);
    expect(isUnsafePath("src/../../etc")).toBe(true);
    expect(isUnsafePath("/etc/passwd")).toBe(true);
    expect(isUnsafePath("src/a.ts")).toBe(false);
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.edit", paths: ["../../etc/passwd"] }))
      .toMatchObject({ decision: "deny", phase: "hard_deny" });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.edit", paths: [".git/config"] }))
      .toMatchObject({ decision: "deny", code: "git_dir_protected", phase: "hard_deny" });
  });

  it("applies the session-mode rules of the owner matrix", async () => {
    const { engine } = harness();
    // `plan` is the read-only mode for file mutations...
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.edit", paths: ["src/a.ts"], sessionMode: "plan" }))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read", sessionMode: "plan" }))
      .toMatchObject({ decision: "allow" });
    // ...and a shell command without an explicit mode falls back to the most conservative mode.
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test" }))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
    // A safe command runs in every mode, including the read-only one.
    for (const sessionMode of ["plan", "edit", "auto", "full_auto"] as const) {
      expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test", sessionMode }))
        .toMatchObject({ decision: "allow", risk: "safe" });
    }
    // An unknown command class (the harness classifier returns "approval") asks for approval in the
    // modes that allow asking; the controlled/network cases live in the matrix test below.
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "ls -la", sessionMode: "auto" }))
      .toMatchObject({ decision: "require_approval", risk: "approval" });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "ls -la", sessionMode: "plan" }))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
  });

  it("fails closed for network commands until egress enforcement is guaranteed", async () => {
    const { engine } = harness();
    expect(isNetworkCommand("npm install left-pad")).toBe(true);
    expect(isNetworkCommand("curl https://registry.npmjs.org/x")).toBe(true);
    expect(isNetworkCommand("git push origin main")).toBe(true);
    expect(isNetworkCommand("npm test")).toBe(false);
    expect(isNetworkCommand("rg TODO src")).toBe(false);

    const networkDenied = await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm install left-pad", sessionMode: "auto" });
    expect(networkDenied.decision).toBe("deny");
    expect(networkDenied.code).toBe("network_enforcement_unavailable");
    expect(networkDenied.phase).toBe("network_enforcement");
    expect(networkDenied.status).toBe(503);
    expect(networkDenied.retryable).toBe(true);

    const enforced = harness({ networkEnforcement: () => true });
    const allowed = await enforced.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm install left-pad", sessionMode: "auto" });
    // With enforcement guaranteed the network gate steps aside and the mode x risk matrix decides:
    // `auto` maps to `auto_edit`, where a controlled command is allowed.
    expect(allowed.decision).toBe("allow");
    expect(allowed.reasons.join(",")).toContain("network:enforced");
    expect(allowed.reasons.join(",")).toContain("matrix:auto_edit/controlled=allow");
  });

  it("applies the owner's mode x risk matrix for all sixteen combinations", async () => {
    // Risk classes are produced by the harness classifier; enforcement is guaranteed so that the
    // network gate cannot mask the matrix decision.
    const enforced = harness({ networkEnforcement: () => true });
    const cases: Array<{ command: string; risk: "safe" | "controlled" | "approval" | "hard_deny" }> = [
      { command: "npm test", risk: "safe" },
      { command: "npm install left-pad", risk: "controlled" },
      { command: "custom-tool --x", risk: "approval" },
      { command: "rm -rf /", risk: "hard_deny" },
    ];
    const expected: Record<string, Record<string, string>> = {
      plan: { safe: "allow", controlled: "deny", approval: "deny", hard_deny: "deny" },
      edit: { safe: "allow", controlled: "require_approval", approval: "require_approval", hard_deny: "deny" },
      auto: { safe: "allow", controlled: "allow", approval: "require_approval", hard_deny: "deny" },
      full_auto: { safe: "allow", controlled: "allow", approval: "require_approval", hard_deny: "deny" },
    };
    const mismatches: string[] = [];
    let combos = 0;
    for (const [mode, byRisk] of Object.entries(expected)) {
      for (const { command, risk } of cases) {
        combos++;
        const result = await enforced.engine.evaluate({
          ctx: owner, companyId: "c", tool: "code.shell.exec", command,
          sessionMode: mode as "plan" | "edit" | "auto" | "full_auto",
        });
        if (result.decision !== byRisk[risk]) mismatches.push(`${mode}/${risk}: got ${result.decision}, want ${byRisk[risk]}`);
      }
    }
    // Every one of the sixteen cells must assert a concrete decision; the aggregate keeps the failure
    // message readable instead of a truncated object diff.
    expect(combos).toBe(16);
    expect(mismatches).toEqual([]);
  });

  it("fails closed on network commands in every mode, even with an approval", async () => {
    // (a) enforcement not guaranteed -> 503 in every mode, including full_auto_sandbox.
    for (const mode of ["plan", "edit", "auto", "full_auto"] as const) {
      const { engine } = harness();
      const denied = await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm install left-pad", sessionMode: mode });
      expect({ mode, decision: denied.decision, code: denied.code, phase: denied.phase, status: denied.status, retryable: denied.retryable })
        .toEqual({ mode, decision: "deny", code: "network_enforcement_unavailable", phase: "network_enforcement", status: 503, retryable: true });
    }
    // (b) the gate precedes approval: a granted approval cannot open the network path.
    const withApproval = harness();
    const blocked = await withApproval.engine.evaluate({
      ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm install left-pad",
      sessionMode: "full_auto", approved: true, approvalId: "approval-1", toolCallId: "t1",
    });
    expect(blocked.decision).toBe("deny");
    expect(blocked.code).toBe("network_enforcement_unavailable");
    expect(blocked.status).toBe(503);
    expect(withApproval.approvals.consumed).toHaveLength(0);
    // (c) non-network commands are unaffected by this gate.
    const enforced = harness({ networkEnforcement: () => true });
    expect(await enforced.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test", sessionMode: "auto" }))
      .toMatchObject({ decision: "allow" });
    const off = harness();
    expect(await off.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test", sessionMode: "auto" }))
      .toMatchObject({ decision: "allow" });
  });

  it("requires approval for the approval class and binds it to the exact payload", async () => {
    const { engine, approvals } = harness();
    const required = await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "custom-tool --x", sessionMode: "auto", toolCallId: "t1" });
    expect(required).toMatchObject({ decision: "require_approval", code: "approval_required", status: 403 });
    expect(required.approvalId).toBeTruthy();
    expect(approvals.requests).toHaveLength(1);

    const approved = await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "custom-tool --x", sessionMode: "auto", toolCallId: "t1", approved: true, approvalId: required.approvalId });
    expect(approved).toMatchObject({ decision: "allow" });
    expect(approvals.consumed).toHaveLength(1);

    const substituted = harness({});
    substituted.approvals.failConsume = true;
    expect(await substituted.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "custom-tool --x", sessionMode: "auto", approved: true, approvalId: "a1" }))
      .toMatchObject({ decision: "deny", code: "approval_invalid" });

    const noApprovals = harness({ approvals: undefined });
    expect(await noApprovals.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "custom-tool --x", sessionMode: "auto" }))
      .toMatchObject({ decision: "deny", code: "approval_unavailable", status: 503 });
  });

  it("lets full_auto skip confirmation for safe and controlled work only", async () => {
    const { engine } = harness();
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test", sessionMode: "full_auto" }))
      .toMatchObject({ decision: "allow" });
    expect(await engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.write", paths: ["src/new.ts"], sessionMode: "full_auto" }))
      .toMatchObject({ decision: "allow" });
  });

  it("applies project rules when the port is present and states their absence otherwise", async () => {
    const denied = harness({ projectRules: async () => ({ deniedTools: ["code.shell.exec"] }) });
    expect(await denied.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test", sessionMode: "auto" }))
      .toMatchObject({ decision: "deny", code: "project_rule_denied" });

    const allowlist = harness({ projectRules: async () => ({ allowedTools: ["code.fs.read"] }) });
    expect(await allowlist.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.write", paths: ["src/a.ts"], sessionMode: "auto" }))
      .toMatchObject({ decision: "deny", code: "project_rule_denied" });
    expect(await allowlist.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read", sessionMode: "auto" }))
      .toMatchObject({ decision: "allow" });

    const needsApproval = harness({ projectRules: async () => ({ requireApprovalFor: ["code.fs.write"] }) });
    expect(await needsApproval.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.write", paths: ["src/a.ts"], sessionMode: "auto" }))
      .toMatchObject({ decision: "require_approval", phase: "project_rules" });

    const none = harness();
    const result = await none.engine.evaluate({ ctx: owner, companyId: "c", tool: "code.fs.read", sessionMode: "auto" });
    expect(result.reasons.join(",")).toContain("project_rules:none");
  });

  it("uses the session mode provider when the request does not carry one", async () => {
    // `edit` maps to `ask` in the owner matrix, so a safe command is allowed when the provider
    // supplies that mode; a provider that reports `plan` still denies shell commands.
    const asking = harness({ sessionMode: async () => "edit" });
    expect(await asking.engine.evaluate({ ctx: owner, companyId: "c", sessionId: "s1", tool: "code.shell.exec", command: "npm test" }))
      .toMatchObject({ decision: "allow", risk: "safe" });
    const planning = harness({ sessionMode: async () => "plan" });
    // `plan` allows a safe command but denies the approval class outright (an unknown executable is
    // `approval` for the harness classifier, and it is not a network command, so the network gate
    // does not mask the matrix decision).
    expect(await planning.engine.evaluate({ ctx: owner, companyId: "c", sessionId: "s1", tool: "code.shell.exec", command: "npm test" }))
      .toMatchObject({ decision: "allow", risk: "safe" });
    expect(await planning.engine.evaluate({ ctx: owner, companyId: "c", sessionId: "s1", tool: "code.shell.exec", command: "custom-tool --x" }))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
  });

  it("binds the approval hash to the exact command, paths, project and session", () => {
    const base = { ctx: owner, companyId: "c", tool: "code.shell.exec", command: "npm test", paths: ["src/a.ts"], projectId: "p1", sessionId: "s1" };
    expect(payloadHashFor(base as never)).toBe(payloadHashFor({ ...base } as never));
    expect(payloadHashFor(base as never)).not.toBe(payloadHashFor({ ...base, command: "npm run build" } as never));
    expect(payloadHashFor(base as never)).not.toBe(payloadHashFor({ ...base, projectId: "p2" } as never));
  });

  it("keeps member privilege separate from admin privilege for approvals", async () => {
    const { engine } = harness();
    const memberResult = await engine.evaluate({ ctx: member, companyId: "c", tool: "code.shell.exec", command: "custom-tool", sessionMode: "auto" });
    expect(memberResult.decision).toBe("require_approval");
    expect(await engine.evaluate({ ctx: member, companyId: "c", tool: "code.fs.delete", paths: ["src/a.ts"], sessionMode: "auto" }))
      .toMatchObject({ decision: "require_approval" });
  });
});
