export type RouteTier = "free" | "pro" | "enterprise" | "custom";

export interface TierConfig {
  maxRequestsPerMinute: number;
  burstAllowance: number;
}

export interface RateLimitStatus {
  allowed: boolean;
  tier: RouteTier;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds?: number;
}

export const DEFAULT_TIER_CONFIGS: Record<RouteTier, TierConfig> = {
  free: {
    maxRequestsPerMinute: 20,
    burstAllowance: 5,
  },
  pro: {
    maxRequestsPerMinute: 120,
    burstAllowance: 30,
  },
  enterprise: {
    maxRequestsPerMinute: 1200,
    burstAllowance: 200,
  },
  custom: {
    maxRequestsPerMinute: 300,
    burstAllowance: 50,
  },
};

export class RouteGuardTiers {
  private readonly requestWindows = new Map<string, number[]>();
  private readonly tierConfigs: Record<RouteTier, TierConfig>;
  private readonly clientTiers = new Map<string, RouteTier>();

  constructor(customConfigs: Partial<Record<RouteTier, TierConfig>> = {}) {
    this.tierConfigs = { ...DEFAULT_TIER_CONFIGS, ...customConfigs };
  }

  /**
   * Set custom tier for a specific client/tenant/apiKey
   */
  setClientTier(clientId: string, tier: RouteTier): void {
    this.clientTiers.set(clientId, tier);
  }

  /**
   * Get tier for a client (defaults to "free")
   */
  getClientTier(clientId: string): RouteTier {
    return this.clientTiers.get(clientId) ?? "free";
  }

  /**
   * Evaluate a request against sliding window rate limit for the client's tier
   */
  checkRateLimit(clientId: string, customTier?: RouteTier): RateLimitStatus {
    const tier = customTier ?? this.getClientTier(clientId);
    const config = this.tierConfigs[tier] ?? this.tierConfigs.free;
    const now = Date.now();
    const windowStart = now - 60_000; // 1 minute sliding window

    let timestamps = this.requestWindows.get(clientId);
    if (!timestamps) {
      timestamps = [];
      this.requestWindows.set(clientId, timestamps);
    }

    // Filter timestamps to only retain those in the active 1-minute window
    timestamps = timestamps.filter((ts) => ts > windowStart);
    this.requestWindows.set(clientId, timestamps);

    const limit = config.maxRequestsPerMinute;
    const currentCount = timestamps.length;
    const remaining = Math.max(0, limit - currentCount - 1);
    
    // Calculate reset time (time until the oldest timestamp in window expires)
    const oldestTimestamp = timestamps.length > 0 && timestamps[0] !== undefined ? timestamps[0] : now;
    const resetSeconds = Math.max(1, Math.ceil((oldestTimestamp + 60_000 - now) / 1000));

    if (currentCount >= limit) {
      return {
        allowed: false,
        tier,
        limit,
        remaining: 0,
        resetSeconds,
        retryAfterSeconds: resetSeconds,
      };
    }

    // Record this request timestamp
    timestamps.push(now);

    return {
      allowed: true,
      tier,
      limit,
      remaining,
      resetSeconds,
    };
  }

  /**
   * Format standard rate limiting headers
   */
  static formatHeaders(status: RateLimitStatus): Record<string, string> {
    const headers: Record<string, string> = {
      "X-RateLimit-Tier": status.tier,
      "X-RateLimit-Limit": String(status.limit),
      "X-RateLimit-Remaining": String(status.remaining),
      "X-RateLimit-Reset": String(status.resetSeconds),
    };

    if (status.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(status.retryAfterSeconds);
    }

    return headers;
  }

  /**
   * Clean up stale client windows
   */
  cleanup(): void {
    const now = Date.now();
    const windowStart = now - 60_000;

    for (const [clientId, timestamps] of this.requestWindows.entries()) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        this.requestWindows.delete(clientId);
      } else {
        this.requestWindows.set(clientId, active);
      }
    }
  }
}
