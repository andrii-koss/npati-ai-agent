import { describe, expect, it } from "vitest";
import {
  OneShotReminderService,
  DaemonHeartbeatMonitor,
  AgentLifecycleHookManager,
} from "../apps/agent-api/src/automation-lifecycle-and-reminders";

describe("One-Shot Reminders (OneShotReminderService)", () => {
  it("schedules, cancels, and triggers due reminders", () => {
    const service = new OneShotReminderService();
    const now = new Date();
    const pastTime = new Date(now.getTime() - 1000); // 1s ago
    const futureTime = new Date(now.getTime() + 60000); // in 1 min

    const dueReminder = service.scheduleReminder({
      companyId: "comp-rem-1",
      recipientId: "user-alex",
      title: "Review PR #45",
      targetAt: pastTime.toISOString(),
    });

    const futureReminder = service.scheduleReminder({
      companyId: "comp-rem-1",
      recipientId: "user-alex",
      title: "Standup meeting",
      targetAt: futureTime.toISOString(),
    });

    // Cancel future
    const cancelled = service.cancelReminder(futureReminder.id);
    expect(cancelled).toBe(true);

    // Check due
    const dueList = service.checkDueReminders(now);
    expect(dueList.length).toBe(1);
    expect(dueList[0].id).toBe(dueReminder.id);
    expect(dueList[0].status).toBe("dispatched");
  });
});

describe("Daemon Heartbeat Monitor (DaemonHeartbeatMonitor)", () => {
  it("tracks healthy worker heartbeats and flags stale workers after timeout", () => {
    const monitor = new DaemonHeartbeatMonitor();
    const now = new Date();

    // Active worker
    monitor.recordHeartbeat("worker-active-1");

    // Stale worker (simulated by checking against future time + 60s)
    const futureCheck = new Date(now.getTime() + 60000);
    const health = monitor.evaluateWorkerHealth(30000, futureCheck); // 30s timeout

    expect(health.staleWorkers).toContain("worker-active-1");
  });
});

describe("Agent Lifecycle Hook Manager (AgentLifecycleHookManager)", () => {
  it("executes registered lifecycle hooks in priority order", async () => {
    const manager = new AgentLifecycleHookManager();
    const executionOrder: string[] = [];

    manager.registerHook(
      "step:before",
      async () => {
        executionOrder.push("low-priority");
      },
      5
    );

    manager.registerHook(
      "step:before",
      async () => {
        executionOrder.push("high-priority");
      },
      20
    );

    await manager.emitHook("step:before", { stepIndex: 1 });

    expect(executionOrder).toEqual(["high-priority", "low-priority"]);
  });
});
