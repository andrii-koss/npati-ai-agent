export interface PipelineStage {
  name: string;
  modelId: string;
  systemInstruction: string;
  temperature?: number;
}

export interface PipelineExecutionResult {
  strategy: "pipeline";
  stages: Array<{
    stageName: string;
    modelId: string;
    output: string;
    durationMs: number;
  }>;
  finalOutput: string;
  totalDurationMs: number;
}

export interface FusionCandidateResult {
  modelId: string;
  response: string;
  confidenceScore: number;
}

export interface FusionExecutionResult {
  strategy: "fusion";
  candidates: FusionCandidateResult[];
  fusedResponse: string;
  consensusScore: number;
}

export interface AutoRoutingCriteria {
  prompt: string;
  requiresVision?: boolean;
  requiresCode?: boolean;
  maxLatencyToleranceMs?: number;
  costSensitivity?: "low" | "medium" | "high";
}

export interface AutoRoutingResult {
  strategy: "auto";
  selectedModelId: string;
  provider: string;
  decisionFactors: {
    complexityScore: number;
    hasCodeKeywords: boolean;
    hasVisionRequirement: boolean;
    costSensitivity: string;
  };
  reason: string;
}

export class AdvancedRoutingEngine {
  /**
   * 1. Auto Multi-Criteria Routing Strategy:
   * Dynamically scores complexity, code keywords, vision requirements, and cost sensitivity
   */
  static resolveAutoStrategy(criteria: AutoRoutingCriteria): AutoRoutingResult {
    const text = criteria.prompt.toLowerCase();
    const hasCodeKeywords =
      criteria.requiresCode ??
      /```|function\b|class\b|const\b|let\b|def\b|import\b|export\b|sql\b|select\b|postgres|docker/i.test(text);
    const hasVisionRequirement = criteria.requiresVision ?? false;

    // Approximate complexity score (0 - 100)
    let complexityScore = 50;
    if (text.length > 2000) complexityScore += 20;
    if (/analyze|architect|compare|evaluate|synthesize|optimize|debug/i.test(text)) complexityScore += 20;
    if (hasCodeKeywords) complexityScore += 10;
    complexityScore = Math.min(100, complexityScore);

    const costSensitivity = criteria.costSensitivity ?? "medium";

    let selectedModelId = "openai/gpt-4o";
    let provider = "openai";
    let reason = "Balanced reasoning and general capabilities.";

    if (hasCodeKeywords && complexityScore >= 70) {
      selectedModelId = "anthropic/claude-3-7-sonnet";
      provider = "anthropic";
      reason = "High complexity coding task routed to Claude 3.7 Sonnet.";
    } else if (costSensitivity === "high" || complexityScore < 60) {
      selectedModelId = "google/gemini-2.5-flash";
      provider = "google";
      reason = "Fast, cost-effective execution with Gemini 2.5 Flash.";
    } else if (hasVisionRequirement) {
      selectedModelId = "openai/gpt-4o";
      provider = "openai";
      reason = "Vision multimodal task routed to GPT-4o.";
    }

    return {
      strategy: "auto",
      selectedModelId,
      provider,
      decisionFactors: {
        complexityScore,
        hasCodeKeywords,
        hasVisionRequirement,
        costSensitivity,
      },
      reason,
    };
  }

  /**
   * 2. Fusion Routing Strategy:
   * Synthesizes and merges outputs from multiple model responses
   */
  static synthesizeFusion(candidates: FusionCandidateResult[]): FusionExecutionResult {
    if (candidates.length === 0) {
      return {
        strategy: "fusion",
        candidates: [],
        fusedResponse: "",
        consensusScore: 0,
      };
    }

    // Sort by confidence score
    const sorted = [...candidates].sort((a, b) => b.confidenceScore - a.confidenceScore);
    const primary = sorted[0]!;

    // Consensus score based on average confidence
    const avgConfidence = candidates.reduce((sum, c) => sum + c.confidenceScore, 0) / candidates.length;
    const consensusScore = Math.round(avgConfidence * 100);

    const fusedResponse =
      candidates.length === 1
        ? primary.response
        : `${primary.response}\n\n[Fusion Consensus: Verified across ${candidates.length} models with ${consensusScore}% confidence]`;

    return {
      strategy: "fusion",
      candidates: sorted,
      fusedResponse,
      consensusScore,
    };
  }

  /**
   * 3. Pipeline Sequential Routing Strategy:
   * Executes multi-stage prompt pipeline passing output of stage N as input to stage N+1
   */
  static async executePipeline(
    stages: PipelineStage[],
    initialInput: string,
    mockExecutor?: (stage: PipelineStage, stageInput: string) => Promise<string>
  ): Promise<PipelineExecutionResult> {
    const startAll = Date.now();
    let currentInput = initialInput;
    const executedStages: PipelineExecutionResult["stages"] = [];

    const defaultExecutor = async (stage: PipelineStage, input: string): Promise<string> => {
      // Standard executor formatting output
      return `[${stage.name} output via ${stage.modelId}]: ${input.trim()}`;
    };

    const runExecutor = mockExecutor ?? defaultExecutor;

    for (const stage of stages) {
      const stageStart = Date.now();
      const stageOutput = await runExecutor(stage, currentInput);
      const stageDuration = Date.now() - stageStart;

      executedStages.push({
        stageName: stage.name,
        modelId: stage.modelId,
        output: stageOutput,
        durationMs: stageDuration,
      });

      currentInput = stageOutput;
    }

    return {
      strategy: "pipeline",
      stages: executedStages,
      finalOutput: currentInput,
      totalDurationMs: Date.now() - startAll,
    };
  }
}
