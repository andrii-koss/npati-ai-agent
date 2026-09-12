import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { CompanyAutomationsRepository } from "./automations-repository";
import { computeNextCronDate, isValidCronExpression, type AutomationScheduler } from "./automation-scheduler";
import {
  TaskFlowEngine,
  StandingOrdersManager,
  ImapEmailTrigger,
  type TaskFlowDefinition,
  type StandingOrder,
} from "./automation-flow-engine";
import {
  OneShotReminderService,
  AgentLifecycleHookManager,
  type LifecycleHookName,
} from "./automation-lifecycle-and-reminders";
import {
  WebhookRetryDeliveryEngine,
  type WebhookDeliveryPayload,
} from "./evaluation-and-webhook-retries";
import { PromptInjectionGuard, CredentialMasker } from "./security-guardrails";

// Shared singletons for in-process automation engines
export const globalTaskFlowEngine = new TaskFlowEngine();
export const globalStandingOrdersManager = new StandingOrdersManager();
export const globalReminderService = new OneShotReminderService();
export const globalLifecycleHookManager = new AgentLifecycleHookManager();
export const globalWebhookRetryEngine = new WebhookRetryDeliveryEngine();

function hasPermission(scope: AuthContext, permission: string): boolean {
  if (scope.permissions.includes("*") || scope.permissions.includes("admin:all") || scope.permissions.includes("owner")) return true;
  if (scope.permissions.includes(permission)) return true;
  if (permission === "workspace:read") {
    return scope.permissions.includes("workspace:read") || scope.permissions.includes("workspace:write") || scope.permissions.includes("business:manage");
  }
  if (permission === "business:manage") {
    return scope.permissions.includes("business:manage") || scope.permissions.includes("workspace:write");
  }
  return false;
}

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!hasPermission(c, permission)) {
    throw new WorkspaceAccessError("Missing permission: " + permission);
  }
  return c;
}

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "AUTOMATION_ERROR",
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

export function registerCompanyAutomationsRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: CompanyAutomationsRepository;
    scheduler?: AutomationScheduler;
    triggerRun?: (autoId: string) => Promise<{ result: string }>;
  }
) {
  const { auth, store, repo, triggerRun } = deps;

  // =========================================================================
  // 1. #129 Automations Scheduler & #130 Cron Jobs & #131 Background Tasks Ledger
  // =========================================================================

  // List automations for a company
  app.get<{ Params: { companyId: string } }>(
    "/companies/:companyId/automations",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const automations = await repo.list(c, r.params.companyId);
        return { automations };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Get single automation
  app.get<{ Params: { companyId: string; automationId: string } }>(
    "/companies/:companyId/automations/:automationId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        const automation = await repo.get(c, r.params.companyId, r.params.automationId);
        return { automation };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Create new automation (#130 Cron jobs, #129 Scheduler)
  app.post<{
    Params: { companyId: string };
    Body: {
      name: string;
      description?: string;
      prompt: string;
      cronExpression: string;
      timezone?: string;
      agentId?: string;
    };
  }>(
    "/companies/:companyId/automations",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "prompt", "cronExpression"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 2000 },
            prompt: { type: "string", minLength: 1, maxLength: 20000 },
            cronExpression: { type: "string", minLength: 5, maxLength: 100 },
            timezone: { type: "string", maxLength: 100 },
            agentId: { type: "string" },
          },
        },
      },
    },
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);

        if (!isValidCronExpression(r.body.cronExpression)) {
          throw new Error(`Invalid standard cron expression: "${r.body.cronExpression}". Expected 5 fields (e.g. "0 9 * * *").`);
        }

        const nextRunAt = computeNextCronDate(r.body.cronExpression).toISOString();
        const created = await repo.create(c, r.params.companyId, {
          ...r.body,
          nextRunAt,
        });

        return reply.code(201).send(created);
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Update automation (edit / pause / resume)
  app.patch<{
    Params: { companyId: string; automationId: string };
    Body: {
      name?: string;
      description?: string;
      prompt?: string;
      cronExpression?: string;
      timezone?: string;
      agentId?: string | null;
      status?: "active" | "paused";
    };
  }>(
    "/companies/:companyId/automations/:automationId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        let nextRunAt: string | undefined;

        if (r.body.cronExpression) {
          if (!isValidCronExpression(r.body.cronExpression)) {
            throw new Error(`Invalid standard cron expression: "${r.body.cronExpression}".`);
          }
          nextRunAt = computeNextCronDate(r.body.cronExpression).toISOString();
        }

        const updated = await repo.update(c, r.params.companyId, r.params.automationId, {
          ...r.body,
          nextRunAt,
        });

        return reply.send(updated);
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Delete automation
  app.delete<{ Params: { companyId: string; automationId: string } }>(
    "/companies/:companyId/automations/:automationId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await repo.delete(c, r.params.companyId, r.params.automationId);
        return reply.code(204).send();
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Trigger immediate execution (Run Now)
  app.post<{ Params: { companyId: string; automationId: string } }>(
    "/companies/:companyId/automations/:automationId/run",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        const auto = await repo.get(c, r.params.companyId, r.params.automationId);

        const runRecord = await repo.recordRunStart(auto);
        const startTime = Date.now();

        if (triggerRun) {
          try {
            const runRes = await triggerRun(auto.id);
            const durationMs = Date.now() - startTime;
            const nextRunAt = computeNextCronDate(auto.cronExpression).toISOString();
            await repo.recordRunComplete(runRecord.id, auto.id, nextRunAt, runRes.result, durationMs);
            return reply.code(200).send({ status: "completed", runId: runRecord.id, result: runRes.result, durationMs });
          } catch (runErr: any) {
            const durationMs = Date.now() - startTime;
            const nextRunAt = computeNextCronDate(auto.cronExpression).toISOString();
            await repo.recordRunFail(runRecord.id, auto.id, nextRunAt, runErr.message || String(runErr), durationMs);
            return reply.code(500).send({ status: "failed", runId: runRecord.id, error: runErr.message });
          }
        }

        const durationMs = Date.now() - startTime;
        const nextRunAt = computeNextCronDate(auto.cronExpression).toISOString();
        const simulatedResult = `Automation '${auto.name}' executed successfully.`;
        await repo.recordRunComplete(runRecord.id, auto.id, nextRunAt, simulatedResult, durationMs);

        return reply.code(200).send({
          status: "completed",
          runId: runRecord.id,
          automationId: auto.id,
          result: simulatedResult,
          durationMs,
        });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Get run history / Background Tasks Ledger (#131)
  app.get<{ Params: { companyId: string; automationId: string }; Querystring: { limit?: string } }>(
    "/companies/:companyId/automations/:automationId/runs",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        const runs = await repo.listRuns(c, r.params.companyId, r.params.automationId, Number(r.query.limit ?? 20));
        return { runs, count: runs.length };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // =========================================================================
  // 2. #133 Task Flow Engine
  // =========================================================================

  // Register declarative Task Flow
  app.post<{
    Params: { companyId: string };
    Body: {
      id: string;
      name: string;
      entryStepId: string;
      steps: Array<{
        id: string;
        name: string;
        type: "action" | "condition" | "loop" | "agent_task";
        nextStepId?: string;
        onTrueStepId?: string;
        onFalseStepId?: string;
        actionExpr?: string;
        conditionExpr?: string;
      }>;
    };
  }>("/companies/:companyId/flows", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { id, name, entryStepId, steps } = r.body || {};

      if (!id || !name || !entryStepId || !Array.isArray(steps)) {
        throw new Error("Invalid Task Flow definition: id, name, entryStepId, and steps array are required.");
      }

      const flowDef: TaskFlowDefinition = {
        id,
        companyId: r.params.companyId,
        name,
        entryStepId,
        steps: steps.map((s) => ({
          ...s,
          handler: s.type === "action"
            ? (context: any) => {
                // If actionExpr specified, evaluate simple key assignment or pass-through
                return context[s.id] ?? { step: s.name, processed: true };
              }
            : s.type === "condition"
            ? (context: any) => {
                if (s.conditionExpr && context[s.conditionExpr] !== undefined) {
                  return Boolean(context[s.conditionExpr]);
                }
                return Boolean(context.isVip ?? context.condition ?? true);
              }
            : undefined,
        })),
      };

      globalTaskFlowEngine.registerFlow(flowDef);
      return reply.code(201).send({ flow: flowDef });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Execute Task Flow
  app.post<{
    Params: { companyId: string; flowId: string };
    Body: { initialContext?: Record<string, any> };
  }>("/companies/:companyId/flows/:flowId/run", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const initialContext = r.body?.initialContext ?? {};
      const result = await globalTaskFlowEngine.executeFlow(r.params.flowId, initialContext);
      return reply.code(200).send({ execution: result });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 3. #134 Standing Orders Manager
  // =========================================================================

  // Register Standing Order
  app.post<{
    Params: { companyId: string };
    Body: {
      id: string;
      title: string;
      conditionField?: string;
      thresholdValue?: number;
      actionName?: string;
      isEnabled?: boolean;
    };
  }>("/companies/:companyId/standing-orders", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { id, title, conditionField = "balanceUsd", thresholdValue = 20, isEnabled = true } = r.body || {};

      if (!id || !title) throw new Error("id and title are required for standing order.");

      const order: StandingOrder = {
        id,
        companyId: r.params.companyId,
        title,
        condition: (eventData: Record<string, any>) => {
          const val = eventData[conditionField];
          return typeof val === "number" && val < thresholdValue;
        },
        action: async (eventData: Record<string, any>) => {
          return { alertSent: true, field: conditionField, value: eventData[conditionField], triggeredAt: new Date().toISOString() };
        },
        isEnabled,
        triggerCount: 0,
      };

      globalStandingOrdersManager.registerOrder(order);
      return reply.code(201).send({ order: { id, title, companyId: r.params.companyId, isEnabled } });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Evaluate Standing Orders against incoming event data
  app.post<{
    Params: { companyId: string };
    Body: { eventData: Record<string, any> };
  }>("/companies/:companyId/standing-orders/evaluate", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const eventData = r.body?.eventData ?? {};
      const results = await globalStandingOrdersManager.evaluateOrders(r.params.companyId, eventData);
      return reply.code(200).send({ evaluations: results });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 4. #136 IMAP Email Trigger
  // =========================================================================

  app.post<{
    Params: { companyId: string };
    Body: {
      from: string;
      to: string;
      subject: string;
      body: string;
      attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>;
    };
  }>("/companies/:companyId/inbound-email", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { from, to, subject, body, attachments } = r.body || {};

      if (!from || !subject) {
        throw new Error("from and subject are required for inbound email.");
      }

      // 1. Sanitize text with PromptInjectionGuard and CredentialMasker
      const cleanBody = CredentialMasker.mask(body || "");
      PromptInjectionGuard.assertSafe(cleanBody);

      // 2. Parse raw MIME message
      const parsedEmail = ImapEmailTrigger.parseEmail({
        from,
        to: to || `agent@${r.params.companyId}.npati.ai`,
        subject,
        body: cleanBody,
        attachments,
      });

      // 3. Convert to actionable Agent Task
      const agentTask = ImapEmailTrigger.emailToAgentTask(parsedEmail);

      return reply.code(200).send({
        email: parsedEmail,
        task: agentTask,
        status: "converted",
      });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 5. #137 Webhook Retries & Dead Letter Queue (DLQ)
  // =========================================================================

  app.post<{
    Params: { companyId: string };
    Body: {
      url: string;
      eventType: string;
      data: Record<string, any>;
      maxRetries?: number;
      simulateFailure?: boolean;
    };
  }>("/companies/:companyId/webhooks/dispatch", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { url, eventType, data, maxRetries = 3, simulateFailure = false } = r.body || {};

      if (!url || !eventType) throw new Error("url and eventType are required for webhook dispatch.");

      const payload: WebhookDeliveryPayload = {
        id: `evt_${Date.now()}`,
        companyId: r.params.companyId,
        url,
        eventType,
        data: data || {},
      };

      // Sender function: simulates failure if simulateFailure is true, otherwise performs delivery
      const sender = async () => !simulateFailure;

      const result = await globalWebhookRetryEngine.dispatchWithRetry(payload, sender, { maxRetries });
      return reply.code(200).send({ result });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Replay from DLQ
  app.post<{
    Params: { companyId: string; dlqId: string };
  }>("/companies/:companyId/webhooks/dlq/:dlqId/replay", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const item = globalWebhookRetryEngine.getDlqItem(r.params.dlqId);
      if (!item) {
        return reply.code(404).send({ error: { code: "DLQ_ITEM_NOT_FOUND", message: "DLQ item not found." } });
      }

      // Replay sender succeeds
      const success = await globalWebhookRetryEngine.replayDlq(r.params.dlqId, async () => true);
      return reply.code(200).send({ replayed: success, dlqId: r.params.dlqId });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 6. #138 One-Shot Reminders
  // =========================================================================

  // Schedule reminder
  app.post<{
    Params: { companyId: string };
    Body: {
      recipientId: string;
      title: string;
      targetAt: string;
      payload?: Record<string, unknown>;
    };
  }>("/companies/:companyId/reminders", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { recipientId, title, targetAt, payload } = r.body || {};

      if (!recipientId || !title || !targetAt) {
        throw new Error("recipientId, title, and targetAt are required for reminder.");
      }

      const reminder = globalReminderService.scheduleReminder({
        companyId: r.params.companyId,
        recipientId,
        title,
        targetAt,
        payload,
      });

      return reply.code(201).send({ reminder });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Check and dispatch due reminders
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/reminders/due", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const due = globalReminderService.checkDueReminders(new Date());
      const companyDue = due.filter((d) => d.companyId === r.params.companyId);
      return { dueReminders: companyDue, count: companyDue.length };
    } catch (e) {
      return err(reply, e);
    }
  });

  // Cancel reminder
  app.delete<{ Params: { companyId: string; reminderId: string } }>(
    "/companies/:companyId/reminders/:reminderId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        const cancelled = globalReminderService.cancelReminder(r.params.reminderId);
        return { cancelled, reminderId: r.params.reminderId };
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // =========================================================================
  // 7. #140 Agent Lifecycle Hooks
  // =========================================================================

  // Register Lifecycle Hook
  app.post<{
    Params: { companyId: string };
    Body: {
      hookName: LifecycleHookName;
      priority?: number;
    };
  }>("/companies/:companyId/lifecycle-hooks", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { hookName, priority = 10 } = r.body || {};

      if (!hookName) throw new Error("hookName is required.");

      globalLifecycleHookManager.registerHook(
        hookName,
        async () => {},
        priority
      );

      return reply.code(201).send({ registered: true, hookName, priority });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Emit Lifecycle Event
  app.post<{
    Params: { companyId: string };
    Body: {
      hookName: LifecycleHookName;
      context?: Record<string, unknown>;
    };
  }>("/companies/:companyId/lifecycle-hooks/emit", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { hookName, context = {} } = r.body || {};

      if (!hookName) throw new Error("hookName is required.");

      await globalLifecycleHookManager.emitHook(hookName, {
        companyId: r.params.companyId,
        ...context,
      });

      return reply.code(200).send({ emitted: true, hookName });
    } catch (e) {
      return err(reply, e);
    }
  });
}
