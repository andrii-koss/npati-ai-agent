export interface NoMemoryEvaluationResult {
  noMemoryActive: boolean;
  reason: string;
  readAllowed: boolean;
  writeAllowed: boolean;
}

export interface ConversationTurn {
  role: string;
  content: string;
  timestamp?: string;
}

export class PerRequestNoMemoryGate {
  /**
   * 1. Per-Request No-Memory: Ephemeral zero-retention mode for sensitive queries
   */
  static evaluate(
    headers: Record<string, string | string[] | undefined> = {},
    payload?: { noMemory?: boolean; ephemeral?: boolean }
  ): NoMemoryEvaluationResult {
    const headerValue = String(
      headers["x-npati-no-memory"] || headers["x-no-memory"] || ""
    ).toLowerCase();

    const isHeaderActive = headerValue === "true" || headerValue === "1";
    const isPayloadActive = !!(payload?.noMemory || payload?.ephemeral);

    const noMemoryActive = isHeaderActive || isPayloadActive;

    return {
      noMemoryActive,
      reason: noMemoryActive
        ? "Per-request no-memory flag active: memory read/write strictly bypassed."
        : "Standard memory mode active: long-term retention enabled.",
      readAllowed: !noMemoryActive,
      writeAllowed: !noMemoryActive,
    };
  }

  static filterInjections(
    injectedMemories: string[],
    noMemoryActive: boolean
  ): string[] {
    if (noMemoryActive) {
      return []; // Strip all injected long-term memory snippets
    }
    return injectedMemories;
  }

  static canPersist(noMemoryActive: boolean): boolean {
    return !noMemoryActive;
  }
}

export class RtkCompressionAdapter {
  /**
   * 2. RTK (Real-Time Knowledge / Token Compression) Native OmniRoute Integration
   */
  static buildRtkHeaders(
    options: { enabled?: boolean; targetRatio?: number } = {}
  ): Record<string, string> {
    const enabled = options.enabled ?? true;
    const ratio = options.targetRatio ?? 0.7;

    if (!enabled) {
      return {
        "x-omniroute-compression": "disabled",
      };
    }

    return {
      "x-omniroute-compression": "rtk",
      "x-omniroute-rtk-ratio": String(ratio),
      "x-omniroute-rtk-mode": "adaptive-realtime",
    };
  }

  static validateRtkHeaders(headers: Record<string, string>): boolean {
    return (
      headers["x-omniroute-compression"] === "rtk" &&
      typeof headers["x-omniroute-rtk-ratio"] === "string"
    );
  }
}
