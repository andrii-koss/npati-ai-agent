import { describe, expect, it, vi } from "vitest";
import {
  computeNextCronDate,
  isValidCronExpression,
  AutomationScheduler,
  CRON_PRESETS,
} from "../apps/agent-api/src/automation-scheduler";
import type {
  CompanyAutomation,
  CompanyAutomationsRepository,
} from "../apps/agent-api/src/automations-repository";

describe("Automations and Cron Scheduler (Automations System)", () => {
  describe("Cron Validation & Parsing", () => {
    it("validates standard 5-part cron expressions correctly", () => {
      expect(isValidCronExpression("0 9 * * *")).toBe(true); // Daily 09:00
      expect(isValidCronExpression("*/15 * * * *")).toBe(true); // Every 15 mins
      expect(isValidCronExpression("0 0 1 1 *")).toBe(true); // Jan 1st midnight
      expect(isValidCronExpression("0 18 * * 1-5")).toBe(true); // Weekdays 18:00
      expect(isValidCronExpression("30 8 * * 1,3,5")).toBe(true); // Mon, Wed, Fri 08:30

      // Invalid expressions
      expect(isValidCronExpression("invalid")).toBe(false);
      expect(isValidCronExpression("* * * *")).toBe(false); // 4 parts
      expect(isValidCronExpression("* * * * * *")).toBe(false); // 6 parts
      expect(isValidCronExpression("60 * * * *")).toBe(false); // Minute out of range
      expect(isValidCronExpression("* 25 * * *")).toBe(false); // Hour out of range
    });

    it("verifies all default presets have valid cron expressions", () => {
      expect(CRON_PRESETS.length).toBeGreaterThanOrEqual(5);
      for (const preset of CRON_PRESETS) {
        expect(isValidCronExpression(preset.cron)).toBe(true);
      }
    });

    it("computes strictly future next execution date", () => {
      const baseDate = new Date("2026-09-01T08:00:00.000Z");
      const nextRun = computeNextCronDate("0 9 * * *", baseDate);

      expect(nextRun.getTime()).toBeGreaterThan(baseDate.getTime());
      expect(nextRun.getMinutes()).toBe(0);
      expect(nextRun.getHours()).toBe(9);
    });

    it("computes next execution date when current time is past today's target", () => {
      const baseDate = new Date("2026-09-01T10:00:00.000Z");
      const nextRun = computeNextCronDate("0 9 * * *", baseDate);

      expect(nextRun.getTime()).toBeGreaterThan(baseDate.getTime());
      expect(nextRun.getMinutes()).toBe(0);
      expect(nextRun.getHours()).toBe(9);
      // Next execution should be the next day
      expect(nextRun.getDate()).toBe(2);
    });

    it("computes the configured wall-clock hour in the automation timezone", () => {
      const baseDate = new Date("2026-09-01T05:30:00.000Z");
      const nextRun = computeNextCronDate("0 9 * * *", baseDate, "Europe/Kyiv");
      expect(nextRun.toISOString()).toBe("2026-09-01T06:00:00.000Z");
    });
  });

  describe("AutomationScheduler Execution & Lease Locking", () => {
    it("claims due automations, executes task, and computes next_run_at", async () => {
      const dueTask: CompanyAutomation = {
        id: "auto-1",
        workspaceId: "ws-1",
        companyId: "comp-1",
        userId: "usr-1",
        agentId: "agent-1",
        name: "Morning Competitor Scan",
        prompt: "Scan prices of top 3 competitors",
        cronExpression: "0 9 * * *",
        timezone: "Europe/Kyiv",
        status: "active",
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const recordRunStart = vi.fn().mockResolvedValue({ id: "run-1", automationId: "auto-1", status: "running" });
      const recordRunComplete = vi.fn().mockResolvedValue(undefined);
      const recordRunFail = vi.fn();

      const mockRepo: Partial<CompanyAutomationsRepository> = {
        claimDueAutomations: vi.fn().mockResolvedValueOnce([dueTask]).mockResolvedValue([]),
        recordRunStart: recordRunStart as any,
        recordRunComplete: recordRunComplete as any,
        recordRunFail: recordRunFail as any,
      };

      const executor = vi.fn().mockResolvedValue({ result: "Report generated: No price changes." });

      const scheduler = new AutomationScheduler(
        mockRepo as CompanyAutomationsRepository,
        executor,
        "worker-test-1",
        100000
      );

      const processed = await scheduler.tick();

      expect(processed).toBe(1);
      expect(mockRepo.claimDueAutomations).toHaveBeenCalled();
      expect(recordRunStart).toHaveBeenCalledWith(dueTask);
      expect(executor).toHaveBeenCalledWith(dueTask);
      expect(recordRunComplete).toHaveBeenCalledWith(
        "run-1",
        "auto-1",
        expect.any(String),
        "Report generated: No price changes.",
        expect.any(Number)
      );
      expect(recordRunFail).not.toHaveBeenCalled();
    });

    it("handles execution errors gracefully and records failure with next run scheduled", async () => {
      const failingTask: CompanyAutomation = {
        id: "auto-2",
        workspaceId: "ws-1",
        companyId: "comp-1",
        userId: "usr-1",
        name: "Broken task",
        prompt: "Will fail",
        cronExpression: "*/15 * * * *",
        timezone: "Europe/Kyiv",
        status: "active",
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const recordRunStart = vi.fn().mockResolvedValue({ id: "run-2", automationId: "auto-2", status: "running" });
      const recordRunComplete = vi.fn();
      const recordRunFail = vi.fn().mockResolvedValue(undefined);

      const mockRepo: Partial<CompanyAutomationsRepository> = {
        claimDueAutomations: vi.fn().mockResolvedValueOnce([failingTask]).mockResolvedValue([]),
        recordRunStart: recordRunStart as any,
        recordRunComplete: recordRunComplete as any,
        recordRunFail: recordRunFail as any,
      };

      const executor = vi.fn().mockRejectedValue(new Error("API quota exceeded"));

      const scheduler = new AutomationScheduler(
        mockRepo as CompanyAutomationsRepository,
        executor,
        "worker-test-2",
        100000
      );

      const processed = await scheduler.tick();

      expect(processed).toBe(1);
      expect(recordRunStart).toHaveBeenCalledWith(failingTask);
      expect(recordRunFail).toHaveBeenCalledWith(
        "run-2",
        "auto-2",
        expect.any(String),
        "API quota exceeded",
        expect.any(Number)
      );
      expect(recordRunComplete).not.toHaveBeenCalled();
    });
  });
});
