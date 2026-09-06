import { randomUUID } from "node:crypto";

export type A2AMessageType =
  | "handshake"
  | "handshake_ack"
  | "task_delegate"
  | "task_progress"
  | "task_result"
  | "task_error"
  | "heartbeat";

export interface A2AAgentEndpoint {
  agentId: string;
  companyId: string;
  tenantId: string;
  role?: string;
}

export interface A2AEnvelope<T = Record<string, unknown>> {
  id: string;
  version: "0.3";
  type: A2AMessageType;
  sender: A2AAgentEndpoint;
  recipient: A2AAgentEndpoint;
  correlationId: string;
  traceId: string;
  timestamp: string;
  payload: T;
  metadata?: Record<string, unknown>;
}

export class A2AProtocolV03 {
  static readonly PROTOCOL_VERSION = "0.3";

  /**
   * Create a standardized A2A v0.3 Message Envelope
   */
  static createEnvelope<T = Record<string, unknown>>(
    type: A2AMessageType,
    sender: A2AAgentEndpoint,
    recipient: A2AAgentEndpoint,
    payload: T,
    options: { correlationId?: string; traceId?: string; metadata?: Record<string, unknown> } = {}
  ): A2AEnvelope<T> {
    return {
      id: randomUUID(),
      version: this.PROTOCOL_VERSION,
      type,
      sender,
      recipient,
      correlationId: options.correlationId ?? randomUUID(),
      traceId: options.traceId ?? `tr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      timestamp: new Date().toISOString(),
      payload,
      metadata: options.metadata,
    };
  }

  /**
   * Validate incoming A2A message envelope
   */
  static validateEnvelope(envelope: unknown): { valid: true; envelope: A2AEnvelope } | { valid: false; error: string } {
    if (!envelope || typeof envelope !== "object") {
      return { valid: false, error: "A2A_INVALID_ENVELOPE: Envelope must be an object." };
    }

    const env = envelope as Record<string, any>;

    if (env.version !== this.PROTOCOL_VERSION) {
      return { valid: false, error: `A2A_VERSION_MISMATCH: Expected version '0.3', received '${env.version}'.` };
    }

    if (!env.id || !env.type || !env.sender || !env.recipient || !env.correlationId) {
      return { valid: false, error: "A2A_MISSING_REQUIRED_FIELDS: Missing id, type, sender, recipient, or correlationId." };
    }

    if (!env.sender.agentId || !env.sender.companyId || !env.recipient.agentId || !env.recipient.companyId) {
      return { valid: false, error: "A2A_INVALID_ENDPOINT: Endpoints must contain agentId and companyId." };
    }

    return { valid: true, envelope: env as A2AEnvelope };
  }

  /**
   * Create a response envelope to a previously received delegation message
   */
  static createResponseEnvelope<T = Record<string, unknown>>(
    incoming: A2AEnvelope,
    resultPayload: T
  ): A2AEnvelope<T> {
    return this.createEnvelope(
      "task_result",
      incoming.recipient, // Current recipient becomes sender
      incoming.sender,    // Original sender becomes recipient
      resultPayload,
      {
        correlationId: incoming.correlationId,
        traceId: incoming.traceId,
      }
    );
  }

  /**
   * Create an error response envelope to a delegation message
   */
  static createErrorEnvelope(
    incoming: A2AEnvelope,
    error: { code: string; message: string; details?: unknown }
  ): A2AEnvelope<{ error: { code: string; message: string; details?: unknown } }> {
    return this.createEnvelope(
      "task_error",
      incoming.recipient,
      incoming.sender,
      { error },
      {
        correlationId: incoming.correlationId,
        traceId: incoming.traceId,
      }
    );
  }
}
