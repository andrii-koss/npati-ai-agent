import { describe, expect, it } from "vitest";
import { MultiUserSessionManager } from "../apps/agent-api/src/multi-user-session";
import { DmPairingManager } from "../apps/agent-api/src/dm-pairing-allowlist";
import { SubagentToolPolicyGuard } from "../apps/agent-api/src/subagent-tool-policy";
import { ToolPolicyEngine } from "../apps/agent-api/src/tool-policy-engine";

describe("Multi-User Sessions (MultiUserSessionManager)", () => {
  it("tracks members, roles, and presence updates in a session", () => {
    const manager = new MultiUserSessionManager();
    const sessionId = "session-collab-1";
    const companyId = "company-1";
    const tenantId = "tenant-1";

    // User A joins as owner
    const owner = manager.joinSession(sessionId, companyId, tenantId, {
      userId: "user-owner",
      displayName: "Alice Owner",
      role: "owner",
    });
    expect(owner.presence).toBe("online");

    // User B joins as viewer
    const viewer = manager.joinSession(sessionId, companyId, tenantId, {
      userId: "user-viewer",
      displayName: "Bob Viewer",
      role: "viewer",
    });
    expect(viewer.role).toBe("viewer");

    // Check permissions
    expect(manager.canPerformAction(sessionId, "user-owner", "send_message")).toBe(true);
    expect(manager.canPerformAction(sessionId, "user-owner", "manage_members")).toBe(true);
    expect(manager.canPerformAction(sessionId, "user-viewer", "send_message")).toBe(false);

    // Update typing presence
    manager.updatePresence(sessionId, "user-owner", "typing");
    const snapshot = manager.getSessionSnapshot(sessionId);
    expect(snapshot?.activeTypers).toContain("user-owner");
    expect(snapshot?.members.length).toBe(2);

    // User leaves
    manager.leaveSession(sessionId, "user-viewer");
    const afterLeave = manager.getSessionSnapshot(sessionId);
    expect(afterLeave?.members.length).toBe(1);
  });
});

describe("DM Allowlist & Pairing (DmPairingManager)", () => {
  it("generates pairing codes, completes pairing, and verifies sender allowlist", async () => {
    const manager = new DmPairingManager();
    const companyId = "company-dm";
    const tenantId = "tenant-dm";

    // 1. Create a pairing request for Telegram channel
    const pairing = await manager.createPairing({
      companyId,
      tenantId,
      channelType: "telegram",
      agentId: "agent-support-1",
    });

    expect(pairing.pairingCode).toMatch(/^PAIR-\d{4}-[0-9A-F]{4}$/);
    expect(pairing.isApproved).toBe(false);

    // Sender is initially rejected before pairing
    const beforeCheck = await manager.isSenderAllowed({
      companyId,
      tenantId,
      channelType: "telegram",
      senderId: "tg_user_9988",
    });
    expect(beforeCheck.allowed).toBe(false);

    // 2. Sender inputs pairing code
    const pairResult = await manager.verifyAndPair(pairing.pairingCode, "tg_user_9988");
    expect(pairResult.success).toBe(true);

    // 3. Sender is now allowed to message the agent
    const afterCheck = await manager.isSenderAllowed({
      companyId,
      tenantId,
      channelType: "telegram",
      senderId: "tg_user_9988",
    });
    expect(afterCheck.allowed).toBe(true);

    // Reusing the same pairing code fails
    const reuseResult = await manager.verifyAndPair(pairing.pairingCode, "tg_user_other");
    expect(reuseResult.success).toBe(false);
  });

  it("blocks senders explicitly present in the blocklist", async () => {
    const manager = new DmPairingManager();
    await manager.createPairing({
      companyId: "comp-block",
      tenantId: "tenant-block",
      channelType: "slack",
      allowlistRules: {
        allowedSenders: ["*"], // allow all
        blockedSenders: ["spammer_123"], // except spammer
      },
    });

    const allowed = await manager.isSenderAllowed({
      companyId: "comp-block",
      tenantId: "tenant-block",
      channelType: "slack",
      senderId: "good_user",
    });
    expect(allowed.allowed).toBe(true);

    const blocked = await manager.isSenderAllowed({
      companyId: "comp-block",
      tenantId: "tenant-block",
      channelType: "slack",
      senderId: "spammer_123",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("blocklist");
  });
});

describe("Per-Subagent Tool Policy (SubagentToolPolicyGuard)", () => {
  it("prevents privilege escalation when child agent requests tools not permitted for parent", () => {
    const guard = new SubagentToolPolicyGuard();

    const scope = {
      parentAgentId: "agent-researcher",
      parentAllowedTools: ["web.search", "web.fetch"],
      childAgentId: "agent-worker",
      childBaseTools: ["web.search", "files.delete", "mcp.bash.exec"],
    };

    const result = guard.evaluateSubagentTools(scope);

    // Only web.search is permitted because parent only has web.search & web.fetch
    expect(result.permittedTools).toEqual(["web.search"]);
    expect(result.escalationAttempts).toContain("files.delete");
    expect(result.escalationAttempts).toContain("mcp.bash.exec");
    expect(result.deniedTools.length).toBe(2);
  });

  it("applies global policy engine rules to sub-agents", () => {
    const policyEngine = new ToolPolicyEngine([
      { id: "deny-dangerous", effect: "deny", toolPattern: "mcp.dangerous.*", priority: 10 },
    ]);
    const guard = new SubagentToolPolicyGuard(policyEngine);

    const scope = {
      parentAgentId: "agent-manager",
      parentAllowedTools: ["*"], // parent has wildcard
      childAgentId: "agent-sub",
      childBaseTools: ["web.search", "mcp.dangerous.wipe"],
      /**
       * C12 (refinement, not a weakening): a wildcard is a placeholder for the deployment's canonical universe,
       * not a universal key. Before this the wildcard short-circuited the escalation invariant entirely, so the
       * parent's real surface was never consulted. The suite's own subject is unchanged — the policy engine,
       * not the wildcard, is what refuses `mcp.dangerous.wipe` — so the universe is now supplied explicitly.
       */
      canonicalTools: ["web.search", "mcp.dangerous.wipe"],
    };

    const result = guard.evaluateSubagentTools(scope);
    expect(result.permittedTools).toContain("web.search");
    expect(result.permittedTools).not.toContain("mcp.dangerous.wipe");
    expect(result.deniedTools.length).toBe(1);
    expect(result.effectiveParentTools).toEqual(["web.search", "mcp.dangerous.wipe"]);
  });

  it("treats a wildcard with no canonical universe as granting nothing", () => {
    const guard = new SubagentToolPolicyGuard();
    const result = guard.evaluateSubagentTools({
      parentAgentId: "agent-manager",
      parentAllowedTools: ["*"],
      childAgentId: "agent-sub",
      childBaseTools: ["web.search", "files.delete"],
    });

    expect(result.wildcardUnresolved).toBe(true);
    expect(result.effectiveParentTools).toEqual([]);
    expect(result.permittedTools).toEqual([]);
    // The request is reported as an escalation attempt rather than silently dropped, so the manager above this
    // guard refuses the spawn instead of creating a child whose grant nobody could resolve.
    expect(result.escalationAttempts).toEqual(["web.search", "files.delete"]);
    expect(result.deniedTools[0]!.reason).toContain("PARENT_WILDCARD_SCOPE_UNRESOLVED");
  });
});
