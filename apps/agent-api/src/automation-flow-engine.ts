import { randomUUID } from "node:crypto";

export interface FlowStep {
  id: string;
  name: string;
  type: "action" | "condition" | "loop" | "agent_task";
  actionType?: string;
  conditionExpr?: string; // e.g. "context.orderAmount > 1000"
  loopItemsExpr?: string; // e.g. "context.items"
  nextStepId?: string;
  onTrueStepId?: string;
  onFalseStepId?: string;
  handler?: (context: Record<string, any>) => Promise<any> | any;
}

export interface TaskFlowDefinition {
  id: string;
  companyId: string;
  name: string;
  steps: FlowStep[];
  entryStepId: string;
}

export interface FlowExecutionResult {
  flowId: string;
  status: "completed" | "failed";
  executionPath: string[];
  context: Record<string, any>;
  durationMs: number;
}

export interface StandingOrder {
  id: string;
  companyId: string;
  title: string;
  condition: (eventData: Record<string, any>) => boolean;
  action: (eventData: Record<string, any>) => Promise<Record<string, any>> | Record<string, any>;
  isEnabled: boolean;
  triggerCount: number;
  lastTriggeredAt?: string;
}

export interface InboundEmail {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>;
  receivedAt: string;
}

export class TaskFlowEngine {
  private readonly flows = new Map<string, TaskFlowDefinition>();

  registerFlow(flow: TaskFlowDefinition): void {
    this.flows.set(flow.id, flow);
  }

  /**
   * 1. Task Flow: Executes multi-step declarative workflow with conditions and branching
   */
  async executeFlow(flowId: string, initialContext: Record<string, any> = {}): Promise<FlowExecutionResult> {
    const flow = this.flows.get(flowId);
    if (!flow) {
      throw new Error(`FLOW_NOT_FOUND: Flow '${flowId}' is not registered.`);
    }

    const startAll = Date.now();
    const context = { ...initialContext };
    const executionPath: string[] = [];

    let currentStepId: string | undefined = flow.entryStepId;

    while (currentStepId) {
      const step = flow.steps.find((s) => s.id === currentStepId);
      if (!step) break;

      executionPath.push(step.id);

      if (step.type === "action" || step.type === "agent_task") {
        if (step.handler) {
          const res = await step.handler(context);
          context[`output_${step.id}`] = res;
        }
        currentStepId = step.nextStepId;
      } else if (step.type === "condition") {
        let isTrue = false;
        if (step.handler) {
          isTrue = Boolean(await step.handler(context));
        } else if (step.conditionExpr) {
          // Safe condition evaluation helper
          isTrue = Boolean(context[step.conditionExpr]);
        }

        currentStepId = isTrue ? step.onTrueStepId : step.onFalseStepId;
      } else {
        currentStepId = step.nextStepId;
      }
    }

    return {
      flowId,
      status: "completed",
      executionPath,
      context,
      durationMs: Date.now() - startAll,
    };
  }
}

export class StandingOrdersManager {
  private readonly orders = new Map<string, StandingOrder>();

  registerOrder(order: StandingOrder): void {
    this.orders.set(order.id, order);
  }

  /**
   * 2. Standing Orders: Evaluates incoming events and triggers continuous policy actions
   */
  async evaluateOrders(
    companyId: string,
    eventData: Record<string, any>
  ): Promise<Array<{ orderId: string; triggered: boolean; result?: any }>> {
    const companyOrders = Array.from(this.orders.values()).filter(
      (o) => o.companyId === companyId && o.isEnabled
    );

    const results: Array<{ orderId: string; triggered: boolean; result?: any }> = [];

    for (const order of companyOrders) {
      try {
        if (order.condition(eventData)) {
          order.triggerCount += 1;
          order.lastTriggeredAt = new Date().toISOString();
          const actionResult = await order.action(eventData);
          results.push({ orderId: order.id, triggered: true, result: actionResult });
        } else {
          results.push({ orderId: order.id, triggered: false });
        }
      } catch (err: any) {
        results.push({ orderId: order.id, triggered: true, result: { error: err.message } });
      }
    }

    return results;
  }
}

export class ImapEmailTrigger {
  /**
   * 3. IMAP Email Trigger: Parses raw email MIME message and converts to structured agent event
   */
  static parseEmail(rawPayload: {
    from: string;
    to: string;
    subject: string;
    body: string;
    attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>;
  }): InboundEmail {
    const messageId = `email_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    // Clean and sanitize subject and body
    const cleanSubject = (rawPayload.subject || "No Subject").trim();
    const cleanBody = (rawPayload.body || "").trim();

    return {
      messageId,
      from: rawPayload.from.trim().toLowerCase(),
      to: rawPayload.to.trim().toLowerCase(),
      subject: cleanSubject,
      bodyText: cleanBody,
      attachments: rawPayload.attachments ?? [],
      receivedAt: new Date().toISOString(),
    };
  }

  /**
   * Convert parsed email into an actionable agent workflow prompt
   */
  static emailToAgentTask(email: InboundEmail): { taskPrompt: string; sender: string; subject: string } {
    const lines = [
      `Inbound Email Received from: ${email.from}`,
      `Subject: ${email.subject}`,
      `Date: ${email.receivedAt}`,
      "",
      "Email Content:",
      email.bodyText,
    ];

    if (email.attachments && email.attachments.length > 0) {
      lines.push("", "Attachments:", ...email.attachments.map((a) => `- ${a.filename} (${a.contentType}, ${a.sizeBytes} bytes)`));
    }

    return {
      taskPrompt: lines.join("\n"),
      sender: email.from,
      subject: email.subject,
    };
  }
}
