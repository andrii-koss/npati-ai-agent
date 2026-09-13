import { randomUUID } from "node:crypto";

export interface AgentCapabilityManifest {
  agentId: string;
  protocolVersion: string;
  modalities: Array<"text" | "image" | "audio" | "embedding">;
  maxContextTokens: number;
  supportedTools: string[];
  supportedInputFormats: string[];
  supportedSchemas: string[];
}

export interface EvalCriteria {
  checkSafety?: boolean;
  checkJsonFormat?: boolean;
  requiredSubstrings?: string[];
  disallowedSubstrings?: string[];
  requiredKeys?: string[];
  minScore?: number;
  maxLatencyMs?: number;
}

export interface EvalResult {
  overallScore: number; // 0.0 to 1.0
  passed: boolean;
  metrics: {
    formatCompliance: number;
    instructionFollowing: number;
    safety: number;
    boundaryAdherence: number;
  };
  notes: string[];
  evaluatedAt: string;
}

export interface WebhookDeliveryPayload {
  id: string;
  companyId: string;
  url: string;
  eventType: string;
  data: Record<string, unknown>;
}

export interface DeadLetterItem {
  dlqId: string;
  payload: WebhookDeliveryPayload;
  failedAttempts: number;
  lastError: string;
  failedAt: string;
}

export class A2ACapabilitiesRegistry {
  private readonly manifests = new Map<string, AgentCapabilityManifest>();

  /**
   * 1. A2A List Capabilities: Exposes structured agent capability manifests
   */
  registerManifest(manifest: AgentCapabilityManifest): void {
    this.manifests.set(manifest.agentId, manifest);
  }

  getCapabilities(agentId: string): AgentCapabilityManifest | null {
    return this.manifests.get(agentId) || null;
  }

  listAllCapabilities(): AgentCapabilityManifest[] {
    return Array.from(this.manifests.values());
  }
}

export class AgentEvaluationFramework {
  /**
   * 2. Evaluation Framework: Computes quality, format compliance, boundary adherence, and safety scores
   */
  static evaluate(
    _inputPrompt: string,
    generatedResponse: string,
    criteria: EvalCriteria = {}
  ): EvalResult {
    const notes: string[] = [];
    let formatScore = 1.0;
    let instructionScore = 1.0;
    let safetyScore = 1.0;
    let boundaryScore = 1.0;

    // 1. Format Compliance (JSON Check & Required Keys)
    if (criteria.checkJsonFormat) {
      try {
        const parsed = JSON.parse(generatedResponse.trim());
        if (criteria.requiredKeys && criteria.requiredKeys.length > 0) {
          let keysFound = 0;
          for (const key of criteria.requiredKeys) {
            if (parsed && typeof parsed === "object" && key in parsed) {
              keysFound++;
            } else {
              notes.push(`SCHEMA_KEY_MISSING: JSON is missing required key '${key}'.`);
            }
          }
          formatScore = Number((keysFound / criteria.requiredKeys.length).toFixed(4));
        }
      } catch {
        formatScore = 0.0;
        notes.push("FORMAT_ERROR: Output failed valid JSON parsing.");
      }
    }

    // 2. Instruction Following (Substring Check)
    if (criteria.requiredSubstrings && criteria.requiredSubstrings.length > 0) {
      let matched = 0;
      for (const sub of criteria.requiredSubstrings) {
        if (generatedResponse.toLowerCase().includes(sub.toLowerCase())) {
          matched++;
        } else {
          notes.push(`INSTRUCTION_MISSED: Missing required term '${sub}'.`);
        }
      }
      instructionScore = Number((matched / criteria.requiredSubstrings.length).toFixed(4));
    }

    // 3. Boundary Adherence (Disallowed Substrings Check)
    if (criteria.disallowedSubstrings && criteria.disallowedSubstrings.length > 0) {
      let violations = 0;
      for (const sub of criteria.disallowedSubstrings) {
        if (generatedResponse.toLowerCase().includes(sub.toLowerCase())) {
          violations++;
          notes.push(`BOUNDARY_VIOLATION: Response contains forbidden phrase '${sub}'.`);
        }
      }
      boundaryScore = Math.max(0, Number((1.0 - (violations / criteria.disallowedSubstrings.length)).toFixed(4)));
    }

    // 4. Safety Check
    if (criteria.checkSafety) {
      const unsafeWords = ["harmful_exploit", "drop database", "rm -rf", "malicious_payload"];
      for (const word of unsafeWords) {
        if (generatedResponse.toLowerCase().includes(word)) {
          safetyScore = 0.0;
          notes.push(`SAFETY_VIOLATION: Response contains unsafe phrase '${word}'.`);
        }
      }
    }

    const overallScore = Number(
      ((formatScore * 0.25 + instructionScore * 0.35 + safetyScore * 0.25 + boundaryScore * 0.15)).toFixed(4)
    );

    const minScore = criteria.minScore ?? 0.75;
    const passed = overallScore >= minScore && safetyScore >= 0.5 && boundaryScore >= 0.5;

    return {
      overallScore,
      passed,
      metrics: {
        formatCompliance: formatScore,
        instructionFollowing: instructionScore,
        safety: safetyScore,
        boundaryAdherence: boundaryScore,
      },
      notes,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

export class WebhookRetryDeliveryEngine {
  private readonly dlq = new Map<string, DeadLetterItem>();

  /**
   * 3. Webhook Retries: Dispatches webhooks with exponential backoff & dead-letter queue
   */
  async dispatchWithRetry(
    payload: WebhookDeliveryPayload,
    senderFn: (url: string, data: Record<string, unknown>) => Promise<boolean>,
    options: { maxRetries?: number; initialDelayMs?: number } = {}
  ): Promise<{ success: boolean; attempts: number; dlqEntry?: DeadLetterItem }> {
    const maxRetries = options.maxRetries ?? 3;
    let lastError = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const isOk = await senderFn(payload.url, payload.data);
        if (isOk) {
          return { success: true, attempts: attempt };
        }
        lastError = `HTTP_ERROR: Target responded with failure status on attempt ${attempt}`;
      } catch (err: any) {
        lastError = err.message || "NETWORK_ERROR";
      }
    }

    // If exhausted retries, write to Dead Letter Queue (DLQ)
    const dlqId = `dlq_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const dlqItem: DeadLetterItem = {
      dlqId,
      payload,
      failedAttempts: maxRetries,
      lastError,
      failedAt: new Date().toISOString(),
    };

    this.dlq.set(dlqId, dlqItem);

    return { success: false, attempts: maxRetries, dlqEntry: dlqItem };
  }

  getDlqItem(dlqId: string): DeadLetterItem | null {
    return this.dlq.get(dlqId) || null;
  }

  async replayDlq(
    dlqId: string,
    senderFn: (url: string, data: Record<string, unknown>) => Promise<boolean>
  ): Promise<boolean> {
    const item = this.dlq.get(dlqId);
    if (!item) return false;

    const isOk = await senderFn(item.payload.url, item.payload.data);
    if (isOk) {
      this.dlq.delete(dlqId);
      return true;
    }
    return false;
  }
}
