import { describe, expect, it } from "vitest";
import { ToolPolicyEngine } from "../apps/agent-api/src/tool-policy-engine";
import { SessionToolRegistry } from "../apps/agent-api/src/session-tools";
import { GroupSessionManager } from "../apps/agent-api/src/group-sessions";

describe("Tool Policy Engine (ToolPolicyEngine)", () => {
  it("evaluates wildcard patterns and granular allow/deny rules", () => {
    const engine = new ToolPolicyEngine([
      { id: "allow-web", effect: "allow", toolPattern: "web.*", priority: 10 },
      { id: "deny-bash", effect: "deny", toolPattern: "mcp.bash.*", reason: "Bash execution is disabled", priority: 20 },
      { id: "approval-payment", effect: "require_approval", toolPattern: "payment.charge", priority: 15 },
    ]);

    // Allowed web tool
    const webEval = engine.evaluate("web.search");
    expect(webEval.allowed).toBe(true);
    expect(webEval.decision).toBe("allow");

    // Denied bash tool (higher priority rule)
    const bashEval = engine.evaluate("mcp.bash.exec");
    expect(bashEval.allowed).toBe(false);
    expect(bashEval.decision).toBe("deny");
    expect(bashEval.reason).toContain("Bash execution is disabled");

    // Tool requiring approval
    const paymentEval = engine.evaluate("payment.charge");
    expect(paymentEval.allowed).toBe(false);
    expect(paymentEval.requiresApproval).toBe(true);

    // Tool requiring approval with human confirmation
    const paymentConfirmed = engine.evaluate("payment.charge", { isHumanConfirmed: true });
    expect(paymentConfirmed.allowed).toBe(true);
  });

  it("enforces role-based tool restrictions", () => {
    const engine = new ToolPolicyEngine([
      { id: "admin-only-db", effect: "allow", toolPattern: "db.migrate", roles: ["admin"], priority: 10 },
      { id: "deny-all-db", effect: "deny", toolPattern: "db.*", priority: 5 },
    ]);

    // Admin role allowed
    const adminEval = engine.evaluate("db.migrate", { role: "admin" });
    expect(adminEval.allowed).toBe(true);

    // Regular user role denied
    const userEval = engine.evaluate("db.migrate", { role: "user" });
    expect(userEval.allowed).toBe(false);
    expect(userEval.decision).toBe("deny");
  });
});

describe("Session Tools (SessionToolRegistry)", () => {
  it("dynamically attaches and expires session tools", () => {
    const policyEngine = new ToolPolicyEngine([
      { id: "deny-dangerous", effect: "deny", toolPattern: "dangerous.*" },
    ]);
    const registry = new SessionToolRegistry(policyEngine);
    const sessionId = "session-123";

    // Attach valid session tool
    registry.attachTool(sessionId, "calculator.eval", { description: "Session math tool" });
    registry.attachTool(sessionId, "dangerous.wipe", { description: "Blocked tool" });

    // Active tools
    const active = registry.getActiveTools(sessionId);
    expect(active.length).toBe(2);

    // Effective resolution for agent with base tools
    const baseTools = ["web.search"];
    const resolved = registry.resolveEffectiveTools(sessionId, baseTools);

    expect(resolved.effectiveTools).toContain("web.search");
    expect(resolved.effectiveTools).toContain("calculator.eval");
    expect(resolved.effectiveTools).not.toContain("dangerous.wipe");
    expect(resolved.blockedTools.length).toBe(1);
    expect(resolved.blockedTools[0].tool).toBe("dangerous.wipe");
  });

  it("detaches and clears session tools", () => {
    const registry = new SessionToolRegistry();
    const sessionId = "session-cleanup";

    registry.attachTool(sessionId, "crawler.scrape");
    expect(registry.getActiveTools(sessionId).length).toBe(1);

    registry.detachTool(sessionId, "crawler.scrape");
    expect(registry.getActiveTools(sessionId).length).toBe(0);
  });
});

describe("Isolated Group Sessions (GroupSessionManager)", () => {
  it("creates group sessions with participants and isolated memory", async () => {
    const manager = new GroupSessionManager();
    const companyId = "company-group-1";
    const tenantId = "tenant-group-1";

    const session = await manager.createSession({
      companyId,
      tenantId,
      title: "Marketing & Strategy War Room",
      participants: [
        { id: "user-1", name: "Andrii", type: "user" },
        { id: "agent-cmo", name: "CMO Agent", type: "agent", role: "marketing" },
      ],
      initialTools: ["web.search", "social.analytics"],
    });

    expect(session.id).toBeDefined();
    expect(session.isIsolated).toBe(true);
    expect(session.participants.length).toBe(2);

    // Add another participant
    const updated = await manager.addParticipant(session.id, companyId, tenantId, {
      id: "agent-cto",
      name: "CTO Agent",
      type: "agent",
      role: "tech",
    });

    expect(updated?.participants.length).toBe(3);

    // Update isolated session memory (does not leak)
    await manager.updateIsolatedMemory(session.id, companyId, tenantId, "q4_budget", "$50,000");

    const fetched = await manager.getSession(session.id, companyId, tenantId);
    expect(fetched?.sessionState.isolatedMemory.q4_budget).toBe("$50,000");
  });

  it("enforces tenant isolation across group sessions", async () => {
    const manager = new GroupSessionManager();
    const session = await manager.createSession({
      companyId: "comp-a",
      tenantId: "tenant-a",
      title: "Tenant A Session",
    });

    // Attempt to access from Tenant B
    const crossTenant = await manager.getSession(session.id, "comp-a", "tenant-b");
    expect(crossTenant).toBeNull();

    const listA = await manager.listSessions("comp-a", "tenant-a");
    expect(listA.length).toBe(1);

    const listB = await manager.listSessions("comp-a", "tenant-b");
    expect(listB.length).toBe(0);
  });
});
