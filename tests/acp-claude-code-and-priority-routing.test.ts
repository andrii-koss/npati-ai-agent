import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  ClaudeCodeAcpBridge,
} from "../apps/agent-api/src/acp-sessions-and-claude-code";
import { RoutingStrategiesManager } from "../apps/agent-api/src/routing-strategies";

describe("ACP Session Manager (AcpSessionManager)", () => {
  it("creates, queries, handles JSON-RPC calls, and terminates ACP sessions", () => {
    const manager = new AcpSessionManager();

    const session = manager.createSession({ agentName: "claude-code" });
    expect(session.sessionId).toMatch(/^acp_/);
    expect(session.status).toBe("active");
    expect(session.capabilities.length).toBeGreaterThan(0);

    const rpcRes = manager.handleRpcCall(session.sessionId, "fs/read_file", { path: "package.json" });
    expect(rpcRes.error).toBeUndefined();
    expect(rpcRes.jsonrpc).toBe("2.0");

    manager.terminateSession(session.sessionId);
    const terminatedRpc = manager.handleRpcCall(session.sessionId, "fs/read_file");
    expect(terminatedRpc.error).toBeDefined();
  });
});

describe("Claude Code via ACP (ClaudeCodeAcpBridge)", () => {
  it("executes coding tasks over ACP session and returns diff patches", async () => {
    const manager = new AcpSessionManager();
    const session = manager.createSession({ agentName: "claude-code" });

    const result = await ClaudeCodeAcpBridge.executeTaskViaAcp(
      session,
      "Implement ACP session handler",
      { autoApprove: true }
    );

    expect(result.executionId).toMatch(/^cc_exec_/);
    expect(result.status).toBe("success");
    expect(result.diffPatches.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Claude Code completed task");
  });
});

describe("Priority Routing Strategy (RoutingStrategiesManager)", () => {
  it("selects the highest priority healthy model candidate", () => {
    const router = new RoutingStrategiesManager();

    // Default primary anthropic is healthy
    const res1 = router.resolveStrategy("priority", {
      priorityList: ["anthropic", "openai", "google"],
      healthyProviders: ["anthropic", "openai", "google"],
    });
    expect(res1.strategy).toBe("priority");
    expect(res1.provider).toBe("anthropic");

    // Primary anthropic is down -> falls back to openai
    const res2 = router.resolveStrategy("priority", {
      priorityList: ["anthropic", "openai", "google"],
      healthyProviders: ["openai", "google"],
    });
    expect(res2.provider).toBe("openai");
    expect(res2.selectedModelId).toBe("openai/gpt-4o");
  });
});
