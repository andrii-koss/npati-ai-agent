export type FeatureFlagScope = "global" | "company" | "user";
export const FEATURE_FLAG_SCOPES: readonly FeatureFlagScope[] = ["global", "company", "user"] as const;
export type FeatureFlagStage = "off" | "internal" | "allowlist" | "percent" | "ga";
export const FEATURE_FLAG_STAGES: readonly FeatureFlagStage[] = ["off", "internal", "allowlist", "percent", "ga"] as const;

export interface FeatureFlag {
  id: string;
  workspaceId: string;
  scope: FeatureFlagScope;
  /** Empty string for the global scope; company id or user id otherwise. */
  scopeId: string;
  flagKey: string;
  stage: FeatureFlagStage;
  enabled: boolean;
  rolloutPercent: number;
  allowlist: string[];
  revision: number;
  updatedBy: string;
  updatedAt: string;
}
export interface FeatureFlagInput {
  scope: FeatureFlagScope;
  scopeId?: string;
  flagKey: string;
  stage?: FeatureFlagStage;
  enabled?: boolean;
  rolloutPercent?: number;
  allowlist?: string[];
  expectedRevision?: number;
}
export interface FeatureFlagHistoryEntry {
  id: string;
  workspaceId: string;
  flagKey: string;
  scope: FeatureFlagScope;
  scopeId: string;
  previousValue: Record<string, unknown> | null;
  nextValue: Record<string, unknown> | null;
  actor: string;
  createdAt: string;
}
/** A published tool-schema manifest: the exact set of `name@version` a session was created with. */
export interface CodeToolManifest {
  version: number;
  tools: Array<{ name: string; version: number; status: "active" | "deprecated"; deprecatedAt?: string | null }>;
  checksum: string;
  createdAt: string;
}

/** C1b: sandbox images addressed by digest, with the evidence an admission decision needs. */
