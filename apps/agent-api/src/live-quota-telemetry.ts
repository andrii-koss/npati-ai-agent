export interface ProviderQuotaLimits {
  maxRpm: number;
  maxTpm: number;
  maxDailySpendUsd?: number;
}

export interface QuotaUsageEvent {
  timestamp: number;
  tokens: number;
  costUsd?: number;
}

export interface LiveQuotaSnapshot {
  provider: string;
  model: string;
  currentRpm: number;
  maxRpm: number;
  currentTpm: number;
  maxTpm: number;
  rpmSaturationPercent: number;
  tpmSaturationPercent: number;
  status: "healthy" | "approaching_limit" | "saturated";
  recommendFallback: boolean;
}

export class LiveQuotaTelemetry {
  private readonly usageHistory = new Map<string, QuotaUsageEvent[]>();
  private readonly limits = new Map<string, ProviderQuotaLimits>();

  /**
   * Configure limits for a specific provider/model
   */
  setLimits(key: string, limits: ProviderQuotaLimits): void {
    this.limits.set(key.toLowerCase(), limits);
  }

  private getKey(provider: string, model: string): string {
    return `${provider.toLowerCase()}:${model.toLowerCase()}`;
  }

  /**
   * Record a call with tokens and cost
   */
  recordUsage(provider: string, model: string, tokens: number, costUsd = 0): void {
    const key = this.getKey(provider, model);
    let events = this.usageHistory.get(key);
    if (!events) {
      events = [];
      this.usageHistory.set(key, events);
    }

    const now = Date.now();
    events.push({ timestamp: now, tokens, costUsd });

    // Clean up events older than 60 seconds
    const windowStart = now - 60_000;
    this.usageHistory.set(
      key,
      events.filter((e) => e.timestamp > windowStart)
    );
  }

  /**
   * Get real-time quota telemetry snapshot
   */
  getSnapshot(provider: string, model: string): LiveQuotaSnapshot {
    const key = this.getKey(provider, model);
    const now = Date.now();
    const windowStart = now - 60_000;

    const rawEvents = this.usageHistory.get(key) || [];
    const activeEvents = rawEvents.filter((e) => e.timestamp > windowStart);
    this.usageHistory.set(key, activeEvents);

    const limits = this.limits.get(key) ||
      this.limits.get(provider.toLowerCase()) || {
        maxRpm: 60,
        maxTpm: 100_000,
      };

    const currentRpm = activeEvents.length;
    const currentTpm = activeEvents.reduce((sum, e) => sum + e.tokens, 0);

    const rpmSaturationPercent = Math.min(100, Math.round((currentRpm / limits.maxRpm) * 100));
    const tpmSaturationPercent = Math.min(100, Math.round((currentTpm / limits.maxTpm) * 100));
    const maxSaturation = Math.max(rpmSaturationPercent, tpmSaturationPercent);

    let status: LiveQuotaSnapshot["status"] = "healthy";
    let recommendFallback = false;

    if (maxSaturation >= 95) {
      status = "saturated";
      recommendFallback = true;
    } else if (maxSaturation >= 80) {
      status = "approaching_limit";
      recommendFallback = false;
    }

    return {
      provider,
      model,
      currentRpm,
      maxRpm: limits.maxRpm,
      currentTpm,
      maxTpm: limits.maxTpm,
      rpmSaturationPercent,
      tpmSaturationPercent,
      status,
      recommendFallback,
    };
  }
}
