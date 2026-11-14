import type { CompanyAutomationsRepository, CompanyAutomation } from "./automations-repository";
import { automationRunEndStatus } from "./automations-repository";

export interface CronSchedulePreset {
  id: string;
  name: string;
  cron: string;
  description: string;
}

export const CRON_PRESETS: CronSchedulePreset[] = [
  { id: "daily_0900", name: "Щодня о 09:00", cron: "0 9 * * *", description: "Кожного дня о 9:00 ранку (Kyiv)" },
  { id: "daily_1800", name: "Щодня о 18:00", cron: "0 18 * * *", description: "Кожного дня о 18:00 вечора (Kyiv)" },
  { id: "weekly_mon", name: "Щопонеділка о 09:00", cron: "0 9 * * 1", description: "Кожного понеділка о 9:00 ранку" },
  { id: "weekly_fri", name: "Щоп'ятниці о 17:00", cron: "0 17 * * 5", description: "Кожної п'ятниці о 17:00 вечора" },
  { id: "hourly", name: "Щогодини", cron: "0 * * * *", description: "На початку кожної години" },
  { id: "every_15m", name: "Кожні 15 хвилин", cron: "*/15 * * * *", description: "Кожні 15 хвилин цілодобово" },
];

/**
 * Validates a standard 5-part cron expression: minute (0-59), hour (0-23), day (1-31), month (1-12), day-of-week (0-7).
 */
export function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  function isValidPart(part: string, min: number, max: number): boolean {
    const subParts = part.split(",");
    return subParts.every((sub) => {
      if (sub === "*") return true;
      if (/^\*\/\d+$/.test(sub)) {
        const step = parseInt(sub.slice(2), 10);
        return step > 0 && step <= max;
      }
      if (/^\d+$/.test(sub)) {
        const n = parseInt(sub, 10);
        return n >= min && n <= max;
      }
      if (/^\d+-\d+$/.test(sub)) {
        const [a, b] = sub.split("-").map((n) => parseInt(n, 10));
        return a! >= min && b! <= max && a! <= b!;
      }
      if (/^\d+-\d+\/\d+$/.test(sub)) {
        const [range, stepStr] = sub.split("/");
        const [a, b] = range!.split("-").map((n) => parseInt(n, 10));
        const step = parseInt(stepStr!, 10);
        return a! >= min && b! <= max && a! <= b! && step > 0;
      }
      return false;
    });
  }

  return (
    isValidPart(parts[0]!, 0, 59) &&
    isValidPart(parts[1]!, 0, 23) &&
    isValidPart(parts[2]!, 1, 31) &&
    isValidPart(parts[3]!, 1, 12) &&
    isValidPart(parts[4]!, 0, 7)
  );
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  if (field === "*") {
    for (let i = min; i <= max; i++) values.add(i);
    return values;
  }

  const items = field.split(",");
  for (const item of items) {
    if (item.includes("/")) {
      const [range, stepStr] = item.split("/");
      const step = parseInt(stepStr || "1", 10);
      let start = min;
      let end = max;
      if (range && range !== "*") {
        if (range.includes("-")) {
          const [r1, r2] = range.split("-");
          start = parseInt(r1!, 10);
          end = parseInt(r2!, 10);
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
    } else if (item.includes("-")) {
      const [r1, r2] = item.split("-");
      const start = parseInt(r1!, 10);
      const end = parseInt(r2!, 10);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i);
      }
    } else {
      const val = parseInt(item, 10);
      if (val >= min && val <= max) values.add(val);
    }
  }

  return values;
}

/**
 * Computes the next Date matching the given cron expression strictly after `fromDate`.
 */
export function computeNextCronDate(cron: string, fromDate = new Date(), timezone?: string): Date {
  if (!isValidCronExpression(cron)) {
    throw new Error(`Invalid cron expression: "${cron}"`);
  }

  const parts = cron.trim().split(/\s+/);
  const minuteSet = parseField(parts[0]!, 0, 59);
  const hourSet = parseField(parts[1]!, 0, 23);
  const dayOfMonthSet = parseField(parts[2]!, 1, 31);
  const monthSet = parseField(parts[3]!, 1, 12);
  const dayOfWeekSet = parseField(parts[4]!, 0, 7);

  // Map 7 (Sunday) to 0
  if (dayOfWeekSet.has(7)) dayOfWeekSet.add(0);

  if (timezone) {
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        minute: "2-digit", hour: "2-digit", hourCycle: "h23",
        day: "2-digit", month: "2-digit", weekday: "short",
      });
    } catch {
      throw new Error(`Invalid automation timezone: "${timezone}"`);
    }
    const weekdayNumbers: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const candidate = new Date(fromDate.getTime());
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    const MAX_ITERATIONS = 60 * 24 * 366;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const values = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
      const minute = Number(values.minute);
      const hour = Number(values.hour);
      const day = Number(values.day);
      const month = Number(values.month);
      const weekday = weekdayNumbers[values.weekday || ""];
      if (minuteSet.has(minute) && hourSet.has(hour) && dayOfMonthSet.has(day) &&
          monthSet.has(month) && weekday !== undefined && dayOfWeekSet.has(weekday)) return candidate;
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
    throw new Error(`Could not find next execution time within 1 year for cron "${cron}" in ${timezone}`);
  }

  // Start from the next whole minute
  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const MAX_ITERATIONS = 60 * 24 * 366; // Max 1 year of minutes
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const month = candidate.getMonth() + 1; // 1-12
    if (!monthSet.has(month)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay(); // 0-6

    // In cron, if both dayOfMonth and dayOfWeek are restricted, either can match
    const dayMatch = dayOfMonthSet.has(dayOfMonth) && dayOfWeekSet.has(dayOfWeek);
    if (!dayMatch) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = candidate.getHours();
    if (!hourSet.has(hour)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = candidate.getMinutes();
    if (!minuteSet.has(minute)) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    // Found exact matching minute
    return candidate;
  }

  throw new Error(`Could not find next execution time within 1 year for cron "${cron}"`);
}

export type AutomationExecutor = (
  auto: CompanyAutomation,
  signal?: AbortSignal
) => Promise<{ result: string }>;

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly repo: CompanyAutomationsRepository,
    private readonly executor: AutomationExecutor,
    private readonly workerId = `scheduler-${Math.random().toString(36).slice(2, 8)}`,
    private readonly tickIntervalMs = 15000
  ) {}

  start(): void {
    if (this.timer) return;
    // Runs a previous process left "running" are closed before the first tick (V6 step 12).
    const startedAt = new Date();
    void this.repo.failInterruptedRuns?.(startedAt).catch(() => 0);
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    if (this.isRunning) return 0;
    this.isRunning = true;
    let processed = 0;

    try {
      const dueTasks = await this.repo.claimDueAutomations(this.workerId, 180000, 10);
      for (const auto of dueTasks) {
        processed++;
        const startTime = Date.now();
        const nextDate = computeNextCronDate(auto.cronExpression, new Date(), auto.timezone);
        // The slot is consumed when claimed and the lease is kept while the run lasts: a long run outlived its lease
        // and the same slot could be claimed again (V6 step 12).
        await this.repo.advanceNextRun?.(auto.id, nextDate.toISOString());
        const run = await this.repo.recordRunStart(auto);
        const renew = setInterval(() => void this.repo.renewLease?.(auto.id, this.workerId, 180000).catch(() => undefined), 60000);
        renew.unref?.();

        try {
          const { result } = await this.executor(auto);
          const duration = Date.now() - startTime;
          await this.repo.recordRunComplete(run.id, auto.id, nextDate.toISOString(), result, duration);
        } catch (err) {
          const duration = Date.now() - startTime;
          const msg = err instanceof Error ? err.message : String(err);
          await this.repo.recordRunFail(run.id, auto.id, nextDate.toISOString(), msg, duration, automationRunEndStatus(err));
        } finally {
          clearInterval(renew);
        }
      }
    } catch {
      // Background scheduler tick errors are caught to avoid process death
    } finally {
      this.isRunning = false;
    }

    return processed;
  }
}
