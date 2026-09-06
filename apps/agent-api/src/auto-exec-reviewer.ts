export type ExecRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ExecDecision = "APPROVED" | "REQUIRE_APPROVAL" | "BLOCKED";

export interface ExecReviewResult {
  decision: ExecDecision;
  riskLevel: ExecRiskLevel;
  reasons: string[];
  sanitizedPayload?: string;
  reviewedAt: string;
}

export class AutoExecReviewer {
  private static readonly CRITICAL_COMMANDS = [
    /\brm\s+-(?:r|f|rf|fr)\s+[\/\~]/i,
    /\b(mkfs|dd\s+if=|fdisk|format\s+[a-z]:)/i,
    /\b(curl|wget)\s+[^|]+\|\s*(ba)?sh\b/i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // Fork bomb
  ];

  private static readonly CRITICAL_SQL = [
    /\bDROP\s+(DATABASE|SCHEMA)\b/i,
    /\bTRUNCATE\s+TABLE\b/i,
    /\bDELETE\s+FROM\s+[a-z0-9_]+\s*(?:;|$)/i, // DELETE without WHERE
  ];

  private static readonly HIGH_RISK_COMMANDS = [
    /\bsudo\s+/i,
    /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/i,
    /\bchown\s+/i,
    /\bkillall\b/i,
  ];

  /**
   * 1. Autonomous Security Reviewer for Tool & Command Execution
   */
  static reviewExecution(params: {
    type: "shell" | "sql" | "tool";
    payload: string;
    allowedCommands?: string[];
  }): ExecReviewResult {
    const payload = params.payload.trim();
    const reasons: string[] = [];

    // Check Shell Commands
    if (params.type === "shell") {
      for (const pattern of this.CRITICAL_COMMANDS) {
        if (pattern.test(payload)) {
          reasons.push(`CRITICAL_DESTRUCTIVE_COMMAND: Pattern matched ${pattern.source}`);
          return {
            decision: "BLOCKED",
            riskLevel: "CRITICAL",
            reasons,
            reviewedAt: new Date().toISOString(),
          };
        }
      }

      for (const pattern of this.HIGH_RISK_COMMANDS) {
        if (pattern.test(payload)) {
          reasons.push(`HIGH_RISK_PRIVILEGE_OPERATION: Pattern matched ${pattern.source}`);
          return {
            decision: "REQUIRE_APPROVAL",
            riskLevel: "HIGH",
            reasons,
            reviewedAt: new Date().toISOString(),
          };
        }
      }
    }

    // Check SQL Operations
    if (params.type === "sql") {
      for (const pattern of this.CRITICAL_SQL) {
        if (pattern.test(payload)) {
          reasons.push(`CRITICAL_DATA_LOSS_SQL: Pattern matched ${pattern.source}`);
          return {
            decision: "BLOCKED",
            riskLevel: "CRITICAL",
            reasons,
            reviewedAt: new Date().toISOString(),
          };
        }
      }
    }

    return {
      decision: "APPROVED",
      riskLevel: "LOW",
      reasons: ["Operation passed automated security review."],
      sanitizedPayload: payload,
      reviewedAt: new Date().toISOString(),
    };
  }
}
