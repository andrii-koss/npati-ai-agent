import { EgressEnforcementError, type EgressEnforcementReason } from "./sandbox-egress-enforcement";
import { signRunnerRequest, type RunnerReadinessReport } from "./runner-readiness";

/**
 * C4b (owner decision): `agent-api` does not probe Docker. Before any network-dependent execution it asks
 * the **runner** — the authoritative component — whether network enforcement is actually working, through
 * an authenticated readiness endpoint, and caches the verdict for a short TTL.
 *
 * Fail closed everywhere: a missing runner, a failed request, a malformed payload, a non-`overall_ready`
 * report or a disabled kill switch all mean "not enforced" → `network_enforcement_unavailable` (503).
 * The `NPATI_SANDBOX_EGRESS_ENFORCED` flag is never a source of `true`; it can only switch the feature off.
 */
export interface RunnerReadinessClientOptions {
  /** How many times a timeout or a dropped connection is asked again before it counts. Default 1. */
  attempts?: number;
  /** Runner base URL, e.g. `http://sandbox-runner:7865`. */
  baseUrl?: string;
  /** Shared runner secret (`NPATI_SANDBOX_RUNNER_SECRET`); short values are rejected at construction. */
  secret?: string;
  /** Cache TTL; clamped to at most 30 s so a stale "ready" verdict cannot outlive the check by much. */
  ttlMs?: number;
  timeoutMs?: number;
  /** Kill switch: `false` means "never claim enforcement" (the flag can only disable, never enable). */
  enabled?: boolean;
  transport?: typeof fetch;
  now?: () => number;
}

export interface RunnerReadinessState {
  available: boolean;
  ready: boolean;
  report?: RunnerReadinessReport;
  reason?: string;
  checkedAt: number;
  fromCache: boolean;
}

const DEFAULT_TTL_MS = 15_000;
const MAX_TTL_MS = 30_000;
const MIN_TTL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 4_000;

function clampTtl(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN) || (value ?? 0) <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.trunc(value as number)));
}

export function resolveRunnerReadinessTtl(env: NodeJS.ProcessEnv = process.env): number {
  return clampTtl(Number.parseInt(env.NPATI_SANDBOX_RUNNER_READINESS_TTL_MS ?? "", 10));
}

/** Maps a client-side failure onto the existing enforcement reason vocabulary (same error contract). */
function reasonFor(state: RunnerReadinessState): EgressEnforcementReason {
  if (state.reason === "disabled_by_configuration") return "disabled_by_configuration";
  if (state.reason === "runner_not_configured") return "probe_not_configured";
  const reasons = state.report?.reasons ?? [];
  if (reasons.some((value) => value.startsWith("egress_proxy"))) return "proxy_unhealthy";
  if (reasons.includes("direct_egress_open")) return "direct_egress_open";
  if (reasons.includes("dns_bypass_open")) return "dns_bypass_open";
  return "probe_unavailable";
}

export class RunnerReadinessClient {
  private readonly baseUrl?: string;
  private readonly secret?: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly enabled: boolean;
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  readonly ttlMs: number;
  private cached?: RunnerReadinessState;

  constructor(options: RunnerReadinessClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.secret = options.secret;
    this.ttlMs = clampTtl(options.ttlMs);
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.attempts = options.attempts && options.attempts > 0 ? options.attempts : 1;
    this.enabled = options.enabled ?? true;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Synchronous view for the PolicyEngine hook: `true` only while a **verified** `overall_ready` verdict is
   * still fresh. A promise-based hook would be a hole (a Promise is always truthy), so the phase reads this.
   */
  isReadySync(): boolean {
    if (!this.enabled) return false;
    if (!this.cached?.ready) return false;
    return this.cached.checkedAt + this.ttlMs > this.now();
  }

  lastReport(): RunnerReadinessReport | undefined { return this.cached?.report; }
  lastState(): RunnerReadinessState | undefined { return this.cached; }
  invalidate(): void { this.cached = undefined; }

  /** Asks the runner (unless the cached verdict is still fresh) and never throws. */
  async check(force = false): Promise<RunnerReadinessState> {
    // A slow answer is not a lost guarantee: a timeout or a dropped connection is asked again before it counts.
    let state = await this.checkOnce(force);
    for (let attempt = 1; attempt < this.attempts && (state.reason === "runner_timeout" || state.reason === "runner_unreachable"); attempt += 1) {
      state = await this.checkOnce(true);
    }
    return state;
  }

  private async checkOnce(force: boolean): Promise<RunnerReadinessState> {
    if (!this.enabled) return this.remember({ available: false, ready: false, reason: "disabled_by_configuration", checkedAt: this.now(), fromCache: false });
    if (!this.baseUrl || !this.secret || this.secret.length < 32) {
      return this.remember({ available: false, ready: false, reason: "runner_not_configured", checkedAt: this.now(), fromCache: false });
    }
    if (!force && this.cached && this.cached.checkedAt + this.ttlMs > this.now()) return { ...this.cached, fromCache: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = "{}";
      const response = await this.transport(`${this.baseUrl}/v1/readiness`, {
        method: "POST",
        headers: signRunnerRequest({ secret: this.secret, body, timestamp: this.now() }),
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.remember({ available: false, ready: false, reason: response.status === 401 || response.status === 403 ? "runner_auth_failed" : `runner_http_${response.status}`, checkedAt: this.now(), fromCache: false });
      }
      const payload = await response.json() as Partial<RunnerReadinessReport> | null;
      if (!payload || typeof payload.overall_ready !== "boolean") {
        return this.remember({ available: false, ready: false, reason: "runner_invalid_response", checkedAt: this.now(), fromCache: false });
      }
      return this.remember({
        available: true,
        ready: payload.overall_ready === true,
        report: payload as RunnerReadinessReport,
        reason: payload.overall_ready === true ? undefined : "runner_not_ready",
        checkedAt: this.now(),
        fromCache: false,
      });
    } catch (error) {
      const aborted = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
      return this.remember({ available: false, ready: false, reason: aborted ? "runner_timeout" : "runner_unreachable", checkedAt: this.now(), fromCache: false });
    } finally {
      clearTimeout(timer);
    }
  }

  async isReady(): Promise<boolean> {
    return (await this.check()).ready;
  }

  /** Gate for network-dependent work: throws `network_enforcement_unavailable` (503) unless proven. */
  async assertReady(): Promise<RunnerReadinessReport> {
    const state = await this.check();
    if (!state.ready || !state.report) {
      throw new EgressEnforcementError({
        enforced: false,
        reason: reasonFor(state),
        details: { source: "sandbox_runner_readiness", runnerReason: state.reason ?? null, available: state.available, runnerReport: state.report ?? null },
        checkedAt: state.checkedAt,
        fromCache: state.fromCache,
      });
    }
    return state.report;
  }

  private remember(state: RunnerReadinessState): RunnerReadinessState {
    this.cached = state;
    return state;
  }
}
