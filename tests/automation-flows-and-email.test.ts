import { describe, expect, it } from "vitest";
import {
  TaskFlowEngine,
  StandingOrdersManager,
  ImapEmailTrigger,
  type TaskFlowDefinition,
} from "../apps/agent-api/src/automation-flow-engine";

describe("Task Flow Engine (TaskFlowEngine)", () => {
  it("executes multi-step declarative flow with conditional branching", async () => {
    const engine = new TaskFlowEngine();

    const flow: TaskFlowDefinition = {
      id: "flow-order-processing",
      companyId: "comp-auto-1",
      name: "VIP Order Processing",
      entryStepId: "step-1",
      steps: [
        {
          id: "step-1",
          name: "Extract Order Amount",
          type: "action",
          handler: (ctx) => ctx.orderTotal * 1.05, // Apply tax
          nextStepId: "step-2",
        },
        {
          id: "step-2",
          name: "Is VIP Customer?",
          type: "condition",
          handler: (ctx) => ctx.isVip === true,
          onTrueStepId: "step-vip",
          onFalseStepId: "step-standard",
        },
        {
          id: "step-vip",
          name: "Apply VIP 20% Discount",
          type: "action",
          handler: (ctx) => ctx["output_step-1"] * 0.8,
        },
        {
          id: "step-standard",
          name: "Apply Standard Rate",
          type: "action",
          handler: (ctx) => ctx["output_step-1"],
        },
      ],
    };

    engine.registerFlow(flow);

    // Test VIP Branch
    const vipRun = await engine.executeFlow("flow-order-processing", { orderTotal: 1000, isVip: true });
    expect(vipRun.status).toBe("completed");
    expect(vipRun.executionPath).toEqual(["step-1", "step-2", "step-vip"]);
    expect(vipRun.context["output_step-vip"]).toBe(840); // (1000 * 1.05) * 0.8

    // Test Standard Branch
    const stdRun = await engine.executeFlow("flow-order-processing", { orderTotal: 1000, isVip: false });
    expect(stdRun.status).toBe("completed");
    expect(stdRun.executionPath).toEqual(["step-1", "step-2", "step-standard"]);
    expect(stdRun.context["output_step-standard"]).toBe(1050);
  });
});

describe("Standing Orders Manager (StandingOrdersManager)", () => {
  it("triggers standing orders when condition matches", async () => {
    const manager = new StandingOrdersManager();
    const companyId = "comp-sec";

    let alertTriggered = false;

    manager.registerOrder({
      id: "order-low-balance",
      companyId,
      title: "Low Token Balance Alert",
      condition: (event) => event.balanceUsd < 20,
      action: async (event) => {
        alertTriggered = true;
        return { alertSent: true, balance: event.balanceUsd };
      },
      isEnabled: true,
      triggerCount: 0,
    });

    // Event 1: Normal balance (should not trigger)
    const res1 = await manager.evaluateOrders(companyId, { balanceUsd: 150 });
    expect(res1[0].triggered).toBe(false);
    expect(alertTriggered).toBe(false);

    // Event 2: Low balance (triggers action)
    const res2 = await manager.evaluateOrders(companyId, { balanceUsd: 12 });
    expect(res2[0].triggered).toBe(true);
    expect(alertTriggered).toBe(true);
    expect(res2[0].result.balance).toBe(12);
  });
});

describe("IMAP Email Trigger (ImapEmailTrigger)", () => {
  it("parses inbound email and converts to agent task prompt", () => {
    const raw = {
      from: "client@example.com",
      to: "support@mycompany.ai",
      subject: "Urgent: Refund Request for Order #9912",
      body: "Hello, I would like to request a refund for order #9912 due to damaged packaging.",
      attachments: [{ filename: "damage_photo.jpg", contentType: "image/jpeg", sizeBytes: 154000 }],
    };

    const email = ImapEmailTrigger.parseEmail(raw);
    expect(email.from).toBe("client@example.com");
    expect(email.subject).toBe("Urgent: Refund Request for Order #9912");
    expect(email.attachments?.length).toBe(1);

    const task = ImapEmailTrigger.emailToAgentTask(email);
    expect(task.taskPrompt).toContain("Inbound Email Received from: client@example.com");
    expect(task.taskPrompt).toContain("Refund Request for Order #9912");
    expect(task.taskPrompt).toContain("damage_photo.jpg");
  });
});
