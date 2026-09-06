import { describe, it, expect } from "vitest";
import {
  TOOL_TEST_MATRIX,
  getToolTestMatrix,
  CAPABILITY_CATALOG,
  HybridRouter,
} from "@npati/shared";

describe("Section 11: Tool Test Matrix for Agent-Callable Capabilities", () => {
  it("covers all 42 agent-callable capabilities without omission", () => {
    const callableFromCatalog = CAPABILITY_CATALOG.filter((c) => c.agentCallable);
    expect(callableFromCatalog.length).toBe(42);
    expect(TOOL_TEST_MATRIX.length).toBe(42);

    const matrixIds = new Set(TOOL_TEST_MATRIX.map((t) => t.tool_id));
    for (const cap of callableFromCatalog) {
      expect(matrixIds.has(cap.id)).toBe(true);
    }
  });

  it("strictly validates that each entry adheres to the Section 11 schema", () => {
    for (const entry of TOOL_TEST_MATRIX) {
      expect(entry.tool_id).toBeDefined();
      expect(entry.name).toBeDefined();
      expect(entry.domain).toBeDefined();

      // Prompts
      expect(entry.positive_prompts.length).toBeGreaterThanOrEqual(2);
      expect(entry.negative_prompts.length).toBeGreaterThanOrEqual(2);

      // Skill & Call expectations
      expect(typeof entry.expected_skill).toBe("string");
      expect(entry.expected_called).toBe(true);

      // Forbidden tools
      expect(entry.forbidden_tools.length).toBeGreaterThanOrEqual(1);

      // Permission cases
      expect(entry.permission_cases).toEqual(["allowed", "denied at company", "denied at agent"]);

      // Failure cases
      expect(entry.failure_cases).toEqual(["timeout", "provider_429", "provider_5xx", "malformed_response"]);

      // Concurrency cases
      expect(entry.concurrency_cases).toEqual(["duplicate_submission"]);

      // Audit flag
      expect(entry.audit_required).toBe(true);
    }
  });

  it("finds tool matrix entries by ID or suffix via getToolTestMatrix", () => {
    const searchMatrix = getToolTestMatrix("research.web_search");
    expect(searchMatrix).toBeDefined();
    expect(searchMatrix?.name).toBe("Web search");

    const suffixMatrix = getToolTestMatrix("web_search");
    expect(suffixMatrix).toBeDefined();
    expect(suffixMatrix?.tool_id).toBe("research.web_search");
  });

  it("verifies positive and negative prompt routing behavior on representative tools", () => {
    const router = new HybridRouter();
    const searchMatrix = getToolTestMatrix("research.web_search")!;

    // 1. Positive prompt routing
    const positiveDecision = router.route({
      message: searchMatrix.positive_prompts[0]!,
      resolutionContext: {
        auth: { workspaceId: "ws-1", userId: "u-1", permissions: ["workspace:write", "research:execute"] },
        activeContext: { contextType: "company", companyId: "comp-1" },
        company: { id: "comp-1", revision: 1 },
        agent: { id: "ag-1", revision: 1, tools: ["*"] },
        activeConnections: ["crawler", "postgres", "redis"],
      },
    });
    expect(positiveDecision.isNoTool).toBe(false);

    // 2. Negative prompt routing
    const negativeDecision = router.route({
      message: searchMatrix.negative_prompts[0]!,
      resolutionContext: {
        auth: { workspaceId: "ws-1", userId: "u-1", permissions: ["workspace:write"] },
        activeContext: { contextType: "chat" },
      },
    });
    expect(negativeDecision.isNoTool).toBe(true);
    expect(negativeDecision.candidateTools.length).toBe(0);
  });
});
