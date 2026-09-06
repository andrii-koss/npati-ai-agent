import { randomUUID } from "node:crypto";

export interface AgentModelConfig {
  agentId: string;
  preferredModelId: string;
  fallbackModelId?: string;
  temperature?: number;
  maxTokens?: number;
  systemPromptPrefix?: string;
  pinnedProvider?: string;
}

export interface MultiAgentMessage {
  id: string;
  sessionId: string;
  threadId?: string;
  fromAgentId: string;
  toAgentId: string; // specific agentId or "*" for broadcast
  messageType: "text" | "task_request" | "task_response" | "state_sync" | "event";
  content: string;
  data?: Record<string, unknown>;
  timestamp: string;
  isDelivered: boolean;
}

export class AgentModelPreferenceRegistry {
  private readonly configs = new Map<string, AgentModelConfig>();

  setAgentConfig(config: AgentModelConfig): void {
    this.configs.set(config.agentId, config);
  }

  getAgentConfig(agentId: string): AgentModelConfig {
    return (
      this.configs.get(agentId) ?? {
        agentId,
        preferredModelId: "openai/gpt-4o",
        temperature: 0.7,
      }
    );
  }
}

export class MultiAgentMessageBus {
  private readonly messages: MultiAgentMessage[] = [];
  private readonly inboxes = new Map<string, MultiAgentMessage[]>();

  /**
   * 1. Send / Session messaging
   * Direct agent-to-agent message within a shared session
   */
  sendMessage(params: {
    sessionId: string;
    threadId?: string;
    fromAgentId: string;
    toAgentId: string;
    messageType?: MultiAgentMessage["messageType"];
    content: string;
    data?: Record<string, unknown>;
  }): MultiAgentMessage {
    const msg: MultiAgentMessage = {
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      sessionId: params.sessionId,
      threadId: params.threadId,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      messageType: params.messageType ?? "text",
      content: params.content.trim(),
      data: params.data,
      timestamp: new Date().toISOString(),
      isDelivered: false,
    };

    this.messages.push(msg);

    // Deliver to recipient inbox
    if (params.toAgentId !== "*") {
      const inbox = this.inboxes.get(params.toAgentId) || [];
      inbox.push(msg);
      this.inboxes.set(params.toAgentId, inbox);
    }

    return msg;
  }

  /**
   * 2. Multi-agent routing: Broadcast message to all agents in the session
   */
  broadcastToSession(
    sessionId: string,
    fromAgentId: string,
    content: string,
    allSessionAgentIds: string[],
    data?: Record<string, unknown>
  ): MultiAgentMessage[] {
    const deliveredMessages: MultiAgentMessage[] = [];

    for (const targetAgentId of allSessionAgentIds) {
      if (targetAgentId !== fromAgentId) {
        const msg = this.sendMessage({
          sessionId,
          fromAgentId,
          toAgentId: targetAgentId,
          messageType: "state_sync",
          content,
          data,
        });
        deliveredMessages.push(msg);
      }
    }

    return deliveredMessages;
  }

  /**
   * Get unread messages in agent's inbox
   */
  getInbox(agentId: string, sessionId?: string): MultiAgentMessage[] {
    const raw = this.inboxes.get(agentId) || [];
    if (sessionId) {
      return raw.filter((m) => m.sessionId === sessionId);
    }
    return [...raw];
  }

  /**
   * Mark message as delivered and acknowledged
   */
  markDelivered(messageId: string, agentId: string): boolean {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return false;

    const msg = inbox.find((m) => m.id === messageId);
    if (msg) {
      msg.isDelivered = true;
      return true;
    }
    return false;
  }

  /**
   * Get complete conversation history for a session
   */
  getSessionHistory(sessionId: string): MultiAgentMessage[] {
    return this.messages.filter((m) => m.sessionId === sessionId);
  }
}
