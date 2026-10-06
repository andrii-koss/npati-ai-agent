/**
 * Thin adapters over the authoritative provider data policy resolver (C5b).
 *
 * There is exactly **one** policy implementation: `resolveEffectivePolicy` in `provider-data-policy.ts`
 * (priority: model-specific → provider-wide → platform → fail-closed floor, mandatory secret redaction for
 * every provider kind, staleness reporting). This module adds nothing but the two shapes its consumers need:
 *
 * - the engine guard (`provider-data-guard.ts`) wants an asynchronous, context-aware lookup that reads the
 *   store (`companyId` → company rows, `null` → platform rows);
 * - the outbound guard (`outbound-exfiltration-guard.ts`) wants a **synchronous, channel-keyed** resolver,
 *   which is the structural reason its wiring previously degraded to `() => null`.
 *
 * Everything policy-shaped — priority, defaults, staleness, the fail-closed floor — comes from
 * `resolveEffectivePolicy`. If a consumer needs something that function cannot express, extend *it*; do not
 * grow a second resolver here.
 */

import { resolveEffectivePolicy, type ProviderDataPolicyRecord, type ProviderRedactionKind, type ResolvedProviderDataPolicy } from "./provider-data-policy";
import type { DataClassification, EffectiveDataPolicy } from "./provider-data-guard";
import { requiredRedactionKindsFromPolicy } from "./provider-data-guard";

/** Minimal structural view of the storage port; the storage layer owns the real type. */
export interface ProviderDataPolicyLookupPort {
  listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]>;
}

export interface ActiveOutboundContext {
  companyId: string;
  projectId?: string;
  sessionId?: string;
  dataClassification?: DataClassification;
}

export interface ResolvedPolicyView {
  /** The same effective policy the engine guard uses, adapted to its shape. */
  policy: EffectiveDataPolicy;
  /** Which layer produced it — surfaced so a caller can tell "configured" from "fail-closed floor". */
  source: ResolvedProviderDataPolicy["source"];
  matchedPolicyId: string | null;
  staleReason: string | null;
  projectClassification?: DataClassification;
}

export function toEffectiveDataPolicy(
  resolved: ResolvedProviderDataPolicy,
  providerId: string,
): EffectiveDataPolicy {
  const policy = resolved.policy;
  return {
    providerId,
    kind: policy.kind as EffectiveDataPolicy["kind"],
    allowPrivateRepoCode: policy.allowPrivateRepoCode,
    maxDataClassification: policy.maxDataClassification as DataClassification,
    allowPromptCaching: policy.allowPromptCaching,
    trainingPolicy: policy.trainingPolicy as EffectiveDataPolicy["trainingPolicy"],
    externalRetention: policy.externalRetention as EffectiveDataPolicy["externalRetention"],
    // Boundary adaptation through the single mapping: the policy layer names redaction kinds in the plural,
    // the guard's scanner emits the singular ones. Without this bridge a required redaction would never match.
    requiredRedactions: requiredRedactionKindsFromPolicy(policy.requiredRedactions as readonly ProviderRedactionKind[]),
    allowedContentTypes: policy.allowedContentTypes as EffectiveDataPolicy["allowedContentTypes"],
    policyVersion: resolved.policyVersion ?? 0,
    stale: resolved.stale,
    region: policy.region ?? undefined,
    jurisdiction: policy.jurisdiction ?? undefined,
  };
}

function providerIdFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const [head] = model.split("/");
  return head && head !== model ? head : undefined;
}

/**
 * The engine-side resolver: reads both scopes from the store and delegates every decision to
 * `resolveEffectivePolicy`, so the engine can never be more permissive than the stored policy.
 */
export function createEnginePolicyResolver(
  port: ProviderDataPolicyLookupPort,
  options: { now?: () => Date } = {},
): (input: {
  model?: string;
  providerId?: string;
  policyContext?: { companyId: string };
}) => Promise<EffectiveDataPolicy> {
  return async (input) => {
    const model = input.model;
    // An unknown provider (including the "auto" pseudo-model) still resolves through the same function and
    // therefore lands on the fail-closed floor instead of an invented default.
    const providerId = input.providerId ?? providerIdFromModel(model) ?? model ?? "unknown";
    const companyId = input.policyContext?.companyId;
    const companyPolicies = companyId ? await port.listProviderDataPolicies(companyId) : [];
    const platformDefaults = await port.listProviderDataPolicies(null);
    const resolved = resolveEffectivePolicy({
      providerId,
      model: model ?? null,
      companyPolicies,
      platformDefaults,
      now: options.now?.(),
    });
    return toEffectiveDataPolicy(resolved, providerId);
  };
}

/**
 * Synchronous, channel-keyed snapshot for the outbound guard. It caches the **raw store rows** (not a
 * derived policy), so every verdict is computed by `resolveEffectivePolicy` at read time and two consumers
 * can never drift apart.
 */
export class OutboundPolicySnapshot {
  private active: ActiveOutboundContext | null = null;
  private companyPolicies: ProviderDataPolicyRecord[] = [];
  private platformDefaults: ProviderDataPolicyRecord[] = [];
  private loaded = false;
  private lastRefreshError: string | null = null;

  constructor(private readonly port: ProviderDataPolicyLookupPort, private readonly now: () => Date = () => new Date()) {}

  /** `TODO(C6)`: the Coding Agent runner sets this per run, before any outbound tool executes. */
  setActiveContext(context: ActiveOutboundContext | null): void {
    this.active = context;
  }

  getActiveContext(): ActiveOutboundContext | null {
    return this.active;
  }

  getLastRefreshError(): string | null {
    return this.lastRefreshError;
  }

  async refresh(): Promise<void> {
    const companyId = this.active?.companyId;
    try {
      this.companyPolicies = companyId ? await this.port.listProviderDataPolicies(companyId) : [];
      this.platformDefaults = await this.port.listProviderDataPolicies(null);
      this.loaded = true;
      this.lastRefreshError = null;
    } catch (error) {
      // An unreadable store must not look like "allowed": drop the cache and stay explicitly unavailable.
      this.companyPolicies = [];
      this.platformDefaults = [];
      this.loaded = false;
      this.lastRefreshError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Resolves one channel through the authoritative resolver; `null` when no context is active. */
  resolve(channel: string, model?: string): ResolvedPolicyView | null {
    if (!this.active) return null;
    const resolved = resolveEffectivePolicy({
      providerId: channel,
      model: model ?? null,
      companyPolicies: this.companyPolicies,
      platformDefaults: this.platformDefaults,
      now: this.now(),
    });
    return {
      policy: toEffectiveDataPolicy(resolved, channel),
      source: resolved.source,
      matchedPolicyId: resolved.matchedPolicyId,
      staleReason: resolved.staleReason,
      projectClassification: this.active.dataClassification,
    };
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

export type OutboundPolicyResolution =
  | { kind: "policy"; resolved: ResolvedPolicyView }
  | { kind: "context_required"; code: "provider_policy_context_required" | "provider_policy_unavailable"; reason: string };

/**
 * The exact shape `CreateOutboundGuardInput.resolvePolicy` needs (synchronous, channel-keyed), except that a
 * missing context is reported as an explicit refusal rather than a silent `null` — a silent `null` is
 * indistinguishable from "the policy forbids this" and hides legitimate traffic being blocked.
 */
export function resolveOutboundPolicyFromSnapshot(snapshot: OutboundPolicySnapshot, channel: string): OutboundPolicyResolution {
  if (!snapshot.getActiveContext()) {
    return { kind: "context_required", code: "provider_policy_context_required", reason: "outbound_policy_context_required" };
  }
  if (!snapshot.isLoaded()) {
    const error = snapshot.getLastRefreshError();
    return {
      kind: "context_required",
      code: "provider_policy_unavailable",
      reason: error ? `snapshot_refresh_failed:${error}` : "outbound_policy_not_loaded",
    };
  }
  const resolved = snapshot.resolve(channel);
  if (!resolved) {
    return { kind: "context_required", code: "provider_policy_context_required", reason: "outbound_policy_context_required" };
  }
  return { kind: "policy", resolved };
}
