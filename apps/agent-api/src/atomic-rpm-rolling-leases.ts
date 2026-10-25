import { usageQuotasEnabled } from "./usage-quota-policy";
import { randomUUID } from "node:crypto";

export interface RollingLease {
  leaseId: string;
  provider: string;
  tokens: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseAcquireResult {
  leaseId?: string;
  granted: boolean;
  provider: string;
  remainingTokens: number;
  currentInFlight: number;
  maxRpm: number;
  expiresAt?: string;
  reason: string;
}

export class AtomicRpmLeaseManager {
  private readonly activeLeases = new Map<string, RollingLease>();
  private readonly defaultWindowMs: number;

  constructor(defaultWindowMs = 60_000) {
    this.defaultWindowMs = defaultWindowMs;
  }

  /**
   * 1. Atomic RPM Rolling Leases:
   * Thread-safe atomic sliding window reservation preventing race conditions across agents
   */
  acquireLease(params: {
    provider: string;
    maxRpm: number;
    tokens?: number;
    windowMs?: number;
  }): LeaseAcquireResult {
    this.cleanupExpired();

    const now = Date.now();
    const tokens = params.tokens ?? 1;
    const windowMs = params.windowMs ?? this.defaultWindowMs;

    // Sum active leases for this provider
    let usedTokens = 0;
    for (const lease of this.activeLeases.values()) {
      if (lease.provider === params.provider) {
        usedTokens += lease.tokens;
      }
    }

    if (usageQuotasEnabled() && usedTokens + tokens > params.maxRpm) {
      return {
        granted: false,
        provider: params.provider,
        remainingTokens: Math.max(0, params.maxRpm - usedTokens),
        currentInFlight: usedTokens,
        maxRpm: params.maxRpm,
        reason: `RPM limit exceeded for '${params.provider}' (${usedTokens + tokens}/${params.maxRpm} tokens in window)`,
      };
    }

    const leaseId = `lease_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const lease: RollingLease = {
      leaseId,
      provider: params.provider,
      tokens,
      acquiredAt: now,
      expiresAt: now + windowMs,
    };

    this.activeLeases.set(leaseId, lease);

    return {
      leaseId,
      granted: true,
      provider: params.provider,
      remainingTokens: params.maxRpm - (usedTokens + tokens),
      currentInFlight: usedTokens + tokens,
      maxRpm: params.maxRpm,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      reason: `Granted rolling lease ${leaseId} for '${params.provider}'`,
    };
  }

  releaseLease(leaseId: string): boolean {
    return this.activeLeases.delete(leaseId);
  }

  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, lease] of this.activeLeases.entries()) {
      if (lease.expiresAt <= now) {
        this.activeLeases.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  getActiveLeases(provider?: string): RollingLease[] {
    const all = Array.from(this.activeLeases.values());
    return provider ? all.filter((l) => l.provider === provider) : all;
  }
}
