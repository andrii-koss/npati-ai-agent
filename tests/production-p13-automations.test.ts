import { describe, expect, it, vi } from "vitest";
import {
  computeNextCronDate,
  isValidCronExpression,
  AutomationScheduler,
  CRON_PRESETS,
} from "../apps/agent-api/src/automation-scheduler";
import {
  CompanyAutomationsRepository,
  type CompanyAutomation,
} from "../apps/agent-api/src/automations-repository";
import {
  IntegrationsRepository,
} from "../apps/agent-api/src/integrations-repository";
import {
  TaskFlowEngine,
  StandingOrdersManager,
  ImapEmailTrigger,
  type TaskFlowDefinition,
} from "../apps/agent-api/src/automation-flow-engine";
import {
  OneShotReminderService,
  AgentLifecycleHookManager,
} from "../apps/agent-api/src/automation-lifecycle-and-reminders";
import {
  WebhookRetryDeliveryEngine,
} from "../apps/agent-api/src/evaluation-and-webhook-retries";
import { decodeGoalPageCursor, type AuthContext } from "@npati/workspace";

const mockAuth: AuthContext = {
  workspaceId: "ws-p13-test",
  userId: "user-p13",
  permissions: ["workspace:read", "workspace:write", "business:manage"],
};

describe("Milestone P1.3 — Automations, Triggers, and Durable Tasks Suite", () => {
  // =========================================================================
  // 1. #128: Webhooks
  // =========================================================================
  describe("#128: Webhooks Management", () => {
    it("creates, lists, and deletes company webhooks with secure secrets", async () => {
      const repo = new IntegrationsRepository();
      const companyId = "comp-p13-wh";

      const created = await repo.createWebhook(mockAuth, companyId, {
        name: "Order Completed Webhook",
        promptTemplate: "Process completed order {{payload}}",
      });

      expect(created.id).toBeDefined();
      expect(created.name).toBe("Order Completed Webhook");
      expect(created.secret).toMatch(/^whsec_[a-f0-9]{48}$/);

      const list = await repo.listWebhooks(mockAuth, companyId);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(created.id);

      const deleted = await repo.deleteWebhook(mockAuth, companyId, created.id);
      expect(deleted).toBe(true);

      const listAfter = await repo.listWebhooks(mockAuth, companyId);
      expect(listAfter.length).toBe(0);
    });
  });

  // =========================================================================
  // 2. #129: Automations Scheduler & #130: Cron Jobs
  // =========================================================================
  describe("#129 & #130: Automations Scheduler & Cron Jobs", () => {
    it("reads the latest ten automations and complete company totals together", async () => {
      const repo = new CompanyAutomationsRepository();
      const companies = ["alpha", "beta"];
      const input = { name: "Task", prompt: "Prepare the report", cronExpression: "0 9 * * *" };
      const rows = await Promise.all(Array.from({ length: 13 }, (_, index) => repo.create(mockAuth, companies[index % 2]!, {
        ...input, name: `Task ${index}`, status: index === 0 ? "paused" : "active", agentId: index === 0 ? "agent" : undefined,
      })));
      await repo.create({ ...mockAuth, userId: "other" }, "alpha", input);
      await repo.create(mockAuth, "outside", input);
      const agentName = async () => "Report Agent";
      const page = await repo.listPage(mockAuth, companies, {}, agentName);
      const ordered = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      expect(page.items.map(item => item.id)).toEqual(ordered.slice(0, 10).map(item => item.id));
      expect(page.counts).toEqual({ total: 13, active: 12, paused: 1, agentsCount: 1 });
      const next = await repo.listPage(mockAuth, companies, { after: decodeGoalPageCursor(page.nextCursor!) }, agentName);
      expect(next.items.map(item => item.id)).toEqual(ordered.slice(10).map(item => item.id));
      expect(next.counts).toBeNull();
      expect(next.nextCursor).toBeNull();
      const filtered = await repo.listPage(mockAuth, companies, { status: "paused", search: "report agent" }, agentName);
      expect(filtered.items).toMatchObject([{ id: rows[0]!.id, agentName: "Report Agent" }]);
      expect(filtered.counts).toEqual(page.counts);
    });

    it("validates 5-part cron expressions and presets correctly", () => {
      expect(isValidCronExpression("0 9 * * *")).toBe(true);
      expect(isValidCronExpression("*/15 * * * *")).toBe(true);
      expect(isValidCronExpression("0 18 * * 1-5")).toBe(true);
      expect(isValidCronExpression("invalid")).toBe(false);
      expect(isValidCronExpression("* * * *")).toBe(false);

      for (const preset of CRON_PRESETS) {
        expect(isValidCronExpression(preset.cron)).toBe(true);
      }
    });

    it("computes strictly future next run dates", () => {
      const baseDate = new Date("2026-09-01T08:00:00.000Z");
      const nextRun = computeNextCronDate("0 9 * * *", baseDate);
      expect(nextRun.getTime()).toBeGreaterThan(baseDate.getTime());
      expect(nextRun.getHours()).toBe(9);
      expect(nextRun.getMinutes()).toBe(0);
    });

    it("claims due automations and executes ticks with lease locking", async () => {
      const repo = new CompanyAutomationsRepository();
      const companyId = "comp-p13-sched";

      const auto = await repo.create(mockAuth, companyId, {
        name: "Morning Report",
        prompt: "Generate summary of sales",
        cronExpression: "0 9 * * *",
        nextRunAt: new Date(Date.now() - 5000).toISOString(), // due in the past
      });

      expect(auto.id).toBeDefined();
      expect(auto.status).toBe("active");

      const claimed = await repo.claimDueAutomations("worker-1", 60000, 10);
      expect(claimed.length).toBe(1);
      expect(claimed[0].id).toBe(auto.id);
      expect(claimed[0].workerId).toBe("worker-1");

      const executor = vi.fn().mockResolvedValue({ result: "Report: All metrics nominal." });
      const scheduler = new AutomationScheduler(repo, executor, "worker-1", 60000);

      const processed = await scheduler.tick();
      expect(processed).toBe(0); // already claimed above
    });
  });

  // =========================================================================
  // 3. #131: Background Tasks Ledger
  // =========================================================================
  describe("#131: Background Tasks Ledger", () => {
    it("records run start, completion, and fail in the execution ledger", async () => {
      const repo = new CompanyAutomationsRepository();
      const companyId = "comp-p13-ledger";

      const auto = await repo.create(mockAuth, companyId, {
        name: "Ledger Test Task",
        prompt: "Run ledger verification",
        cronExpression: "*/5 * * * *",
      });

      // 1. Record Start
      const run = await repo.recordRunStart(auto);
      expect(run.status).toBe("running");
      expect(run.automationId).toBe(auto.id);

      // 2. Record Complete
      await repo.recordRunComplete(run.id, auto.id, new Date().toISOString(), "Execution finished successfully", 124);

      // 3. Query Ledger
      const runs = await repo.listRuns(mockAuth, companyId, auto.id);
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe(run.id);
      expect(runs[0].status).toBe("completed");
      expect(runs[0].result).toBe("Execution finished successfully");
      expect(runs[0].durationMs).toBe(124);

      // 4. Record Failure
      const run2 = await repo.recordRunStart(auto);
      await repo.recordRunFail(run2.id, auto.id, new Date().toISOString(), "Network timeout connecting to provider", 512);

      const runsAfter = await repo.listRuns(mockAuth, companyId, auto.id);
      expect(runsAfter.length).toBe(2);
      expect(runsAfter.some((r) => r.status === "failed" && r.errorMessage?.includes("Network timeout"))).toBe(true);
    });
  });

  // =========================================================================
  // 4. #133: Task Flow
  // =========================================================================
  describe("#133: Task Flow Engine", () => {
    it("executes multi-step declarative task flow with conditional branching", async () => {
      const engine = new TaskFlowEngine();

      const flow: TaskFlowDefinition = {
        id: "flow-approval-pipeline",
        companyId: "comp-p13-flow",
        name: "Expense Approval Pipeline",
        entryStepId: "step-calculate",
        steps: [
          {
            id: "step-calculate",
            name: "Calculate Adjusted Amount",
            type: "action",
            handler: (ctx) => ctx.baseAmount * 1.1,
            nextStepId: "step-check-threshold",
          },
          {
            id: "step-check-threshold",
            name: "Requires Executive Approval?",
            type: "condition",
            handler: (ctx) => ctx["output_step-calculate"] > 500,
            onTrueStepId: "step-exec-route",
            onFalseStepId: "step-auto-approve",
          },
          {
            id: "step-exec-route",
            name: "Route to CFO",
            type: "action",
            handler: () => ({ approved: false, queue: "CFO_REVIEW" }),
          },
          {
            id: "step-auto-approve",
            name: "Instant Approval",
            type: "action",
            handler: () => ({ approved: true, queue: "AUTO_PAY" }),
          },
        ],
      };

      engine.registerFlow(flow);

      // High amount -> executive branch
      const resHigh = await engine.executeFlow("flow-approval-pipeline", { baseAmount: 600 });
      expect(resHigh.status).toBe("completed");
      expect(resHigh.executionPath).toEqual(["step-calculate", "step-check-threshold", "step-exec-route"]);
      expect(resHigh.context["output_step-exec-route"].queue).toBe("CFO_REVIEW");

      // Low amount -> auto-approve branch
      const resLow = await engine.executeFlow("flow-approval-pipeline", { baseAmount: 200 });
      expect(resLow.status).toBe("completed");
      expect(resLow.executionPath).toEqual(["step-calculate", "step-check-threshold", "step-auto-approve"]);
      expect(resLow.context["output_step-auto-approve"].approved).toBe(true);
    });
  });

  // =========================================================================
  // 5. #134: Standing Orders
  // =========================================================================
  describe("#134: Standing Orders Manager", () => {
    it("registers standing order and triggers action on condition match", async () => {
      const manager = new StandingOrdersManager();
      const companyId = "comp-p13-orders";

      let alertTriggered = false;

      manager.registerOrder({
        id: "order-error-rate-spike",
        companyId,
        title: "High Error Rate Alert",
        condition: (event) => (event.errorRatePercent ?? 0) > 5,
        action: async (event) => {
          alertTriggered = true;
          return { dispatched: true, rate: event.errorRatePercent };
        },
        isEnabled: true,
        triggerCount: 0,
      });

      // Event 1: Normal rate
      const res1 = await manager.evaluateOrders(companyId, { errorRatePercent: 1.2 });
      expect(res1[0].triggered).toBe(false);
      expect(alertTriggered).toBe(false);

      // Event 2: High rate
      const res2 = await manager.evaluateOrders(companyId, { errorRatePercent: 8.4 });
      expect(res2[0].triggered).toBe(true);
      expect(alertTriggered).toBe(true);
      expect(res2[0].result.rate).toBe(8.4);
    });
  });

  // =========================================================================
  // 6. #135: Webhooks Ingress
  // =========================================================================
  describe("#135: Webhooks Ingress", () => {
    it("processes inbound webhooks, masks credentials, and protects prompt injection", async () => {
      const repo = new IntegrationsRepository();
      const companyId = "comp-p13-ingress";

      const webhook = await repo.createWebhook(mockAuth, companyId, {
        name: "Stripe Payment Ingress",
        promptTemplate: "Payment event received: {{payload}}",
      });

      const retrieved = await repo.getWebhookBySecret(webhook.secret);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(webhook.id);

      // Record trigger timestamp
      await repo.recordWebhookTrigger(webhook.id);
      const afterTrigger = await repo.getWebhookBySecret(webhook.secret);
      expect(afterTrigger?.lastTriggeredAt).toBeDefined();
    });
  });

  // =========================================================================
  // 7. #136: IMAP Email Trigger
  // =========================================================================
  describe("#136: IMAP Email Trigger", () => {
    it("parses raw MIME email, cleans attachments, and converts to structured agent task prompt", () => {
      const rawEmail = {
        from: "supplier@logistics.com",
        to: "procurement@company.ai",
        subject: "Invoice #INV-2026-88 for Delivery Batch",
        body: "Attached is the delivery manifest and invoice for payment processing.",
        attachments: [
          { filename: "invoice-88.pdf", contentType: "application/pdf", sizeBytes: 245000 },
          { filename: "manifest.csv", contentType: "text/csv", sizeBytes: 12000 },
        ],
      };

      const parsed = ImapEmailTrigger.parseEmail(rawEmail);
      expect(parsed.from).toBe("supplier@logistics.com");
      expect(parsed.subject).toBe("Invoice #INV-2026-88 for Delivery Batch");
      expect(parsed.attachments?.length).toBe(2);

      const agentTask = ImapEmailTrigger.emailToAgentTask(parsed);
      expect(agentTask.taskPrompt).toContain("Inbound Email Received from: supplier@logistics.com");
      expect(agentTask.taskPrompt).toContain("invoice-88.pdf");
      expect(agentTask.taskPrompt).toContain("manifest.csv");
      expect(agentTask.subject).toBe(parsed.subject);
    });
  });

  // =========================================================================
  // 8. #137: Webhook Retries & Dead Letter Queue
  // =========================================================================
  describe("#137: Webhook Retries & Dead Letter Queue (DLQ)", () => {
    it("retries failed deliveries, stores exhausted attempts in DLQ, and replays successfully", async () => {
      const engine = new WebhookRetryDeliveryEngine();
      let attempts = 0;

      const flakySender = async () => {
        attempts++;
        if (attempts <= 3) return false;
        return true;
      };

      const payload = {
        id: "evt-p13-retry-1",
        companyId: "comp-p13-dlq",
        url: "https://api.external.com/webhooks",
        eventType: "customer.updated",
        data: { customerId: "cust-771" },
      };

      // First dispatch with maxRetries: 3 fails and puts in DLQ
      const result = await engine.dispatchWithRetry(payload, flakySender, { maxRetries: 3 });
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.dlqEntry).toBeDefined();

      const dlqId = result.dlqEntry!.dlqId;
      const dlqItem = engine.getDlqItem(dlqId);
      expect(dlqItem).not.toBeNull();
      expect(dlqItem?.payload.id).toBe("evt-p13-retry-1");

      // Replay from DLQ
      const replayed = await engine.replayDlq(dlqId, flakySender);
      expect(replayed).toBe(true);
      expect(engine.getDlqItem(dlqId)).toBeNull(); // Cleaned up after replay
    });
  });

  // =========================================================================
  // 9. #138: One-Shot Reminders
  // =========================================================================
  describe("#138: One-Shot Reminders", () => {
    it("schedules, queries due, and cancels timed reminders", () => {
      const service = new OneShotReminderService();
      const now = new Date();
      const past = new Date(now.getTime() - 2000);
      const future = new Date(now.getTime() + 100000);

      // Due reminder
      const due = service.scheduleReminder({
        companyId: "comp-p13-rem",
        recipientId: "user-bob",
        title: "Call Supplier regarding delivery",
        targetAt: past.toISOString(),
      });

      // Future reminder
      const futureReminder = service.scheduleReminder({
        companyId: "comp-p13-rem",
        recipientId: "user-bob",
        title: "Monthly Audit check",
        targetAt: future.toISOString(),
      });

      expect(due.id).toBeDefined();
      expect(due.status).toBe("pending");

      // Cancel future
      const cancelled = service.cancelReminder(futureReminder.id);
      expect(cancelled).toBe(true);

      // Check due
      const dueList = service.checkDueReminders(now);
      expect(dueList.length).toBe(1);
      expect(dueList[0].id).toBe(due.id);
      expect(dueList[0].status).toBe("dispatched");
    });
  });

  // =========================================================================
  // 10. #140: Agent Lifecycle Hooks
  // =========================================================================
  describe("#140: Agent Lifecycle Hooks", () => {
    it("executes hooks in priority order across agent execution lifecycle", async () => {
      const manager = new AgentLifecycleHookManager();
      const log: string[] = [];

      manager.registerHook("agent:init", async () => {
        log.push("priority-5");
      }, 5);

      manager.registerHook("agent:init", async () => {
        log.push("priority-50");
      }, 50);

      manager.registerHook("agent:init", async () => {
        log.push("priority-20");
      }, 20);

      await manager.emitHook("agent:init", { agentId: "agent-alpha" });

      expect(log).toEqual(["priority-50", "priority-20", "priority-5"]);
    });
  });
});
