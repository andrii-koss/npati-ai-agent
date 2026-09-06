import { describe, expect, it } from "vitest";
import {
  AgentModelPreferenceRegistry,
  MultiAgentMessageBus,
} from "../apps/agent-api/src/multi-agent-message-bus";

describe("Per-Agent Model Choice (AgentModelPreferenceRegistry)", () => {
  it("stores and retrieves customized model overrides per agent", () => {
    const registry = new AgentModelPreferenceRegistry();

    registry.setAgentConfig({
      agentId: "agent-coder-99",
      preferredModelId: "anthropic/claude-3-7-sonnet",
      fallbackModelId: "deepseek/deepseek-coder",
      temperature: 0.1,
      pinnedProvider: "anthropic",
    });

    const coderConfig = registry.getAgentConfig("agent-coder-99");
    expect(coderConfig.preferredModelId).toBe("anthropic/claude-3-7-sonnet");
    expect(coderConfig.temperature).toBe(0.1);

    // Fallback for unconfigured agent
    const defaultConfig = registry.getAgentConfig("agent-unknown");
    expect(defaultConfig.preferredModelId).toBe("openai/gpt-4o");
  });
});

describe("Multi-Agent Session Messaging (MultiAgentMessageBus)", () => {
  it("routes direct agent-to-agent messages within a session", () => {
    const bus = new MultiAgentMessageBus();
    const sessionId = "session-collab-1";

    const msg = bus.sendMessage({
      sessionId,
      threadId: "th-456",
      fromAgentId: "agent-planner",
      toAgentId: "agent-executor",
      messageType: "task_request",
      content: "Please execute step 1: database migration.",
      data: { stepIndex: 1 },
    });

    expect(msg.id).toMatch(/^msg_/);
    expect(msg.isDelivered).toBe(false);

    // Check recipient inbox
    const executorInbox = bus.getInbox("agent-executor", sessionId);
    expect(executorInbox.length).toBe(1);
    expect(executorInbox[0].content).toContain("database migration");

    // Acknowledge delivery
    const marked = bus.markDelivered(msg.id, "agent-executor");
    expect(marked).toBe(true);
    expect(executorInbox[0].isDelivered).toBe(true);
  });

  it("broadcasts updates across all participating session agents", () => {
    const bus = new MultiAgentMessageBus();
    const sessionId = "session-team-9";

    const allAgents = ["agent-lead", "agent-coder", "agent-reviewer", "agent-deployer"];

    const broadcastResults = bus.broadcastToSession(
      sessionId,
      "agent-lead",
      "Release v1.5 is scheduled for deployment.",
      allAgents,
      { releaseVersion: "1.5.0" }
    );

    expect(broadcastResults.length).toBe(3); // 3 recipients (excluding sender)

    const coderInbox = bus.getInbox("agent-coder", sessionId);
    const reviewerInbox = bus.getInbox("agent-reviewer", sessionId);

    expect(coderInbox.length).toBe(1);
    expect(reviewerInbox.length).toBe(1);
    expect(coderInbox[0].content).toContain("Release v1.5");
  });
});
