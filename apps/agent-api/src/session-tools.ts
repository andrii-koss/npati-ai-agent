import type { ToolPolicyEngine } from "./tool-policy-engine";

export interface SessionToolAttachment {
  toolName: string;
  description?: string;
  attachedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export class SessionToolRegistry {
  private readonly sessionTools = new Map<string, Map<string, SessionToolAttachment>>();

  constructor(private readonly policyEngine?: ToolPolicyEngine) {}

  /**
   * Attach a tool to a specific session
   */
  attachTool(
    sessionId: string,
    toolName: string,
    options: { description?: string; ttlSeconds?: number; metadata?: Record<string, unknown> } = {}
  ): SessionToolAttachment {
    const normalizedTool = toolName.trim().toLowerCase();
    let sessionMap = this.sessionTools.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.sessionTools.set(sessionId, sessionMap);
    }

    const now = new Date();
    const expiresAt = options.ttlSeconds && options.ttlSeconds > 0
      ? new Date(now.getTime() + options.ttlSeconds * 1000).toISOString()
      : undefined;

    const attachment: SessionToolAttachment = {
      toolName: normalizedTool,
      description: options.description,
      attachedAt: now.toISOString(),
      expiresAt,
      metadata: options.metadata,
    };

    sessionMap.set(normalizedTool, attachment);
    return attachment;
  }

  /**
   * Detach a tool from a specific session
   */
  detachTool(sessionId: string, toolName: string): boolean {
    const normalizedTool = toolName.trim().toLowerCase();
    const sessionMap = this.sessionTools.get(sessionId);
    if (!sessionMap) return false;
    const removed = sessionMap.delete(normalizedTool);
    if (sessionMap.size === 0) {
      this.sessionTools.delete(sessionId);
    }
    return removed;
  }

  /**
   * List all currently active tools attached to a session
   */
  getActiveTools(sessionId: string): SessionToolAttachment[] {
    const sessionMap = this.sessionTools.get(sessionId);
    if (!sessionMap) return [];

    const now = new Date();
    const active: SessionToolAttachment[] = [];

    for (const [toolName, attachment] of sessionMap.entries()) {
      if (attachment.expiresAt && new Date(attachment.expiresAt) <= now) {
        sessionMap.delete(toolName);
        continue;
      }
      active.push(attachment);
    }

    if (sessionMap.size === 0) {
      this.sessionTools.delete(sessionId);
    }

    return active;
  }

  /**
   * Resolve complete effective tool list for an agent in a specific session:
   * (Base Agent Tools + Active Session Tools) filtered through ToolPolicyEngine
   */
  resolveEffectiveTools(
    sessionId: string,
    baseAgentTools: string[],
    agentRole?: string
  ): { effectiveTools: string[]; blockedTools: Array<{ tool: string; reason: string }> } {
    const activeSessionTools = this.getActiveTools(sessionId).map((t) => t.toolName);
    const combinedSet = new Set([...baseAgentTools.map((t) => t.toLowerCase()), ...activeSessionTools]);

    const effectiveTools: string[] = [];
    const blockedTools: Array<{ tool: string; reason: string }> = [];

    for (const tool of combinedSet) {
      if (this.policyEngine) {
        const evaluation = this.policyEngine.evaluate(tool, { role: agentRole });
        if (evaluation.allowed) {
          effectiveTools.push(tool);
        } else {
          blockedTools.push({ tool, reason: evaluation.reason });
        }
      } else {
        effectiveTools.push(tool);
      }
    }

    return { effectiveTools, blockedTools };
  }

  /**
   * Clear all tools for a session (e.g. on session termination)
   */
  clearSession(sessionId: string): void {
    this.sessionTools.delete(sessionId);
  }
}
