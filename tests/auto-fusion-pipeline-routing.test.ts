import { describe, expect, it } from "vitest";
import { AdvancedRoutingEngine, type PipelineStage } from "../apps/agent-api/src/advanced-routing-engine";

describe("Auto Multi-Criteria Routing Strategy (AdvancedRoutingEngine.resolveAutoStrategy)", () => {
  it("routes complex coding prompts to Claude 3.7 Sonnet", () => {
    const prompt = "Please analyze and refactor this TypeScript microservice code:\n```typescript\nconst a = 1;\n```";
    const result = AdvancedRoutingEngine.resolveAutoStrategy({
      prompt,
      requiresCode: true,
      costSensitivity: "low",
    });

    expect(result.strategy).toBe("auto");
    expect(result.selectedModelId).toBe("anthropic/claude-3-7-sonnet");
    expect(result.decisionFactors.hasCodeKeywords).toBe(true);
    expect(result.reason).toContain("Claude 3.7");
  });

  it("routes simple or cost-sensitive tasks to Gemini 2.5 Flash", () => {
    const prompt = "What is the capital of Ukraine?";
    const result = AdvancedRoutingEngine.resolveAutoStrategy({
      prompt,
      costSensitivity: "high",
    });

    expect(result.strategy).toBe("auto");
    expect(result.selectedModelId).toBe("google/gemini-2.5-flash");
  });
});

describe("Fusion Strategy (AdvancedRoutingEngine.synthesizeFusion)", () => {
  it("fuses multiple model candidate outputs and computes consensus score", () => {
    const candidates = [
      {
        modelId: "anthropic/claude-3-7-sonnet",
        response: "The primary root cause of the memory leak is an unclosed EventEmitter listener.",
        confidenceScore: 0.95,
      },
      {
        modelId: "openai/gpt-4o",
        response: "EventEmitter listener was left open causing heap growth.",
        confidenceScore: 0.9,
      },
    ];

    const fusion = AdvancedRoutingEngine.synthesizeFusion(candidates);

    expect(fusion.strategy).toBe("fusion");
    expect(fusion.consensusScore).toBe(93); // (0.95 + 0.9) / 2 * 100
    expect(fusion.fusedResponse).toContain("EventEmitter listener");
    expect(fusion.fusedResponse).toContain("Fusion Consensus: Verified across 2 models");
  });
});

describe("Pipeline Strategy (AdvancedRoutingEngine.executePipeline)", () => {
  it("executes multi-stage sequential prompt pipeline", async () => {
    const stages: PipelineStage[] = [
      {
        name: "Stage 1: Planner",
        modelId: "anthropic/claude-3-7-sonnet",
        systemInstruction: "Create step-by-step implementation plan.",
      },
      {
        name: "Stage 2: Code Generator",
        modelId: "deepseek/deepseek-coder",
        systemInstruction: "Generate code according to plan.",
      },
      {
        name: "Stage 3: Validator",
        modelId: "openai/gpt-4o-mini",
        systemInstruction: "Validate syntax and verify edge cases.",
      },
    ];

    const initialTask = "Implement a rate limiter in TypeScript.";
    const result = await AdvancedRoutingEngine.executePipeline(stages, initialTask);

    expect(result.strategy).toBe("pipeline");
    expect(result.stages.length).toBe(3);
    expect(result.stages[0].stageName).toBe("Stage 1: Planner");
    expect(result.stages[1].stageName).toBe("Stage 2: Code Generator");
    expect(result.stages[2].stageName).toBe("Stage 3: Validator");
    expect(result.finalOutput).toContain("Stage 3: Validator");
  });
});
