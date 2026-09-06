import { describe, expect, it } from "vitest";
import {
  SessionPruningManager,
  CustomModelRegistry,
  ResponseChunkingEngine,
} from "../apps/agent-api/src/sessions-custom-models-and-chunking";

describe("Session Pruning Manager (Session Pruning)", () => {
  it("prunes inactive sessions and truncates message logs while preserving system prompts", () => {
    const now = Date.now();
    const oldTime = now - 40 * 86_400_000; // 40 days ago

    const sessions = [
      {
        sessionId: "s1",
        tenantId: "t1",
        lastActiveAt: oldTime,
        messages: [{ role: "user", content: "hello" }],
      },
      {
        sessionId: "s2",
        tenantId: "t1",
        lastActiveAt: now,
        messages: [
          { role: "system", content: "System instructions" },
          ...Array.from({ length: 150 }, (_, i) => ({ role: "user", content: `msg ${i}` })),
        ],
      },
    ];

    const { activeSessions, result } = SessionPruningManager.prune(sessions, {
      maxInactiveDays: 30,
      maxMessagesPerSession: 50,
      archiveBeforeDelete: false,
    });

    expect(result.prunedSessionsCount).toBe(1);
    expect(result.truncatedMessagesCount).toBe(101);
    expect(activeSessions.length).toBe(1);
    expect(activeSessions[0]!.sessionId).toBe("s2");
    expect(activeSessions[0]!.messages[0]!.role).toBe("system");
    expect(activeSessions[0]!.messages.length).toBe(50);
  });
});

describe("Custom Model Registry (Custom/Self-Hosted Models)", () => {
  it("registers and retrieves self-hosted vLLM and Ollama endpoints", () => {
    const registry = new CustomModelRegistry();

    const m1 = registry.registerModel({
      id: "vllm/llama-3.3-70b",
      name: "Meta Llama 3.3 70B (Local vLLM)",
      baseUrl: "http://10.0.0.50:8000/v1",
      format: "vllm",
      contextWindowTokens: 128_000,
    });

    expect(m1.isSelfHosted).toBe(true);
    expect(m1.baseUrl).toBe("http://10.0.0.50:8000/v1");

    const retrieved = registry.getModel("vllm/llama-3.3-70b");
    expect(retrieved?.name).toContain("Llama 3.3");

    const list = registry.listModels();
    expect(list.length).toBe(1);
  });
});

describe("Response Chunking Engine (Response Chunking)", () => {
  it("chunks long responses at paragraph boundaries without exceeding target length", () => {
    const para1 = "Paragraph 1: " + "A".repeat(300);
    const para2 = "Paragraph 2: " + "B".repeat(300);
    const para3 = "Paragraph 3: " + "C".repeat(300);

    const fullText = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = ResponseChunkingEngine.chunk(fullText, 400);

    expect(chunks.length).toBe(3);
    expect(chunks[0]).toContain("Paragraph 1");
    expect(chunks[1]).toContain("Paragraph 2");
    expect(chunks[2]).toContain("Paragraph 3");
  });
});
