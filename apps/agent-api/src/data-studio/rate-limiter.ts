import { usageQuotasEnabled } from "../usage-quota-policy";
export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

export class ProjectApiRateLimiter {
  private readonly records = new Map<string, { count: number; windowStartMs: number }>();
  private lastCleanup = Date.now();

  constructor(
    private readonly windowMs: number = 60_000,
  ) {}

  /**
   * Checks and consumes one rate limit token.
   */
  check(identifier: string, limit: number): RateLimitCheckResult {
    if (!usageQuotasEnabled()) return { allowed: true, limit: 0, remaining: 0, resetMs: 0 };
    const now = Date.now();
    this.maybeCleanup(now);

    const record = this.records.get(identifier);

    if (!record || now - record.windowStartMs >= this.windowMs) {
      this.records.set(identifier, { count: 1, windowStartMs: now });
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - 1),
        resetMs: this.windowMs,
      };
    }

    if (record.count >= limit) {
      const resetMs = Math.max(0, this.windowMs - (now - record.windowStartMs));
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetMs,
      };
    }

    record.count += 1;
    const remaining = Math.max(0, limit - record.count);
    const resetMs = Math.max(0, this.windowMs - (now - record.windowStartMs));
    return {
      allowed: true,
      limit,
      remaining,
      resetMs,
    };
  }

  private maybeCleanup(now: number) {
    if (now - this.lastCleanup < this.windowMs * 2) return;
    this.lastCleanup = now;

    for (const [key, record] of this.records.entries()) {
      if (now - record.windowStartMs >= this.windowMs) {
        this.records.delete(key);
      }
    }
  }

  reset(identifier?: string) {
    if (identifier) {
      this.records.delete(identifier);
    } else {
      this.records.clear();
    }
  }
}
