import { randomUUID } from "node:crypto";

export interface ScheduledReminder {
  id: string;
  companyId: string;
  recipientId: string;
  title: string;
  payload: Record<string, unknown>;
  targetAt: string;
  status: "pending" | "dispatched" | "cancelled";
  createdAt: string;
}

export interface WorkerHeartbeatRecord {
  workerId: string;
  lastHeartbeatAt: string;
  metadata?: Record<string, unknown>;
  status: "healthy" | "stale";
}

export type LifecycleHookName =
  | "agent:init"
  | "session:start"
  | "step:before"
  | "step:after"
  | "tool:before"
  | "tool:after"
  | "session:end"
  | "agent:shutdown";

export type HookHandler = (context: Record<string, unknown>) => Promise<void> | void;

export class OneShotReminderService {
  private readonly reminders = new Map<string, ScheduledReminder>();

  /**
   * 1. One-Shot Reminders: Schedules and dispatches timed one-off reminders
   */
  scheduleReminder(params: {
    companyId: string;
    recipientId: string;
    title: string;
    targetAt: string;
    payload?: Record<string, unknown>;
  }): ScheduledReminder {
    const id = `rem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const reminder: ScheduledReminder = {
      id,
      companyId: params.companyId,
      recipientId: params.recipientId,
      title: params.title,
      payload: params.payload ?? {},
      targetAt: params.targetAt,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.reminders.set(id, reminder);
    return reminder;
  }

  cancelReminder(reminderId: string): boolean {
    const reminder = this.reminders.get(reminderId);
    if (!reminder || reminder.status !== "pending") return false;
    reminder.status = "cancelled";
    return true;
  }

  checkDueReminders(currentTime: Date = new Date()): ScheduledReminder[] {
    const dueList: ScheduledReminder[] = [];
    const currentMs = currentTime.getTime();

    for (const reminder of this.reminders.values()) {
      if (reminder.status === "pending" && new Date(reminder.targetAt).getTime() <= currentMs) {
        reminder.status = "dispatched";
        dueList.push(reminder);
      }
    }

    return dueList;
  }
}

export class DaemonHeartbeatMonitor {
  private readonly workers = new Map<string, WorkerHeartbeatRecord>();

  /**
   * 2. Heartbeat: Monitors worker process pulses and detects stalled processes
   */
  recordHeartbeat(workerId: string, metadata?: Record<string, unknown>): WorkerHeartbeatRecord {
    const record: WorkerHeartbeatRecord = {
      workerId,
      lastHeartbeatAt: new Date().toISOString(),
      metadata,
      status: "healthy",
    };
    this.workers.set(workerId, record);
    return record;
  }

  evaluateWorkerHealth(timeoutMs = 30_000, referenceTime = new Date()): {
    healthyWorkers: string[];
    staleWorkers: string[];
  } {
    const nowMs = referenceTime.getTime();
    const healthy: string[] = [];
    const stale: string[] = [];

    for (const worker of this.workers.values()) {
      const elapsed = nowMs - new Date(worker.lastHeartbeatAt).getTime();
      if (elapsed > timeoutMs) {
        worker.status = "stale";
        stale.push(worker.workerId);
      } else {
        worker.status = "healthy";
        healthy.push(worker.workerId);
      }
    }

    return { healthyWorkers: healthy, staleWorkers: stale };
  }
}

export class AgentLifecycleHookManager {
  private readonly hooks = new Map<
    LifecycleHookName,
    Array<{ priority: number; handler: HookHandler }>
  >();

  /**
   * 3. Lifecycle Hooks: Emits and listens to standardized agent workflow events
   */
  registerHook(
    hookName: LifecycleHookName,
    handler: HookHandler,
    priority = 10
  ): void {
    const list = this.hooks.get(hookName) || [];
    list.push({ priority, handler });
    list.sort((a, b) => b.priority - a.priority); // Higher priority runs first
    this.hooks.set(hookName, list);
  }

  async emitHook(hookName: LifecycleHookName, context: Record<string, unknown>): Promise<void> {
    const list = this.hooks.get(hookName) || [];
    for (const item of list) {
      await item.handler(context);
    }
  }

  getRegisteredHooksCount(): Record<LifecycleHookName, number> {
    const summary: Partial<Record<LifecycleHookName, number>> = {};
    for (const [key, val] of this.hooks.entries()) {
      summary[key] = val.length;
    }
    return summary as Record<LifecycleHookName, number>;
  }
}
