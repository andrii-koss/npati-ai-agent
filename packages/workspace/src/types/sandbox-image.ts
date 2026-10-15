export type SandboxImageVariant = "base" | "node" | "python" | "go" | "rust" | "java" | "php";
export const SANDBOX_IMAGE_VARIANTS: readonly SandboxImageVariant[] = ["base", "node", "python", "go", "rust", "java", "php"] as const;
export type SandboxImageStatus = "unverified" | "verified" | "deprecated" | "revoked";
export const SANDBOX_IMAGE_STATUSES: readonly SandboxImageStatus[] = ["unverified", "verified", "deprecated", "revoked"] as const;
export interface SandboxImage {
  id: string;
  workspaceId: string;
  variant: SandboxImageVariant;
  /** Always `repo@sha256:<64 hex>`; a tag is never a valid identity. */
  reference: string;
  digest: string;
  status: SandboxImageStatus;
  signature?: string | null;
  signatureIssuer?: string | null;
  sbomPath?: string | null;
  scanTool?: string | null;
  scanAt?: string | null;
  scanCritical: number;
  scanHigh: number;
  waiverOwner?: string | null;
  waiverExpiresAt?: string | null;
  waiverReason?: string | null;
  previousReference?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  revokeReason?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface SandboxImageInput {
  variant: SandboxImageVariant;
  reference: string;
  digest: string;
  status?: SandboxImageStatus;
  signature?: string | null;
  signatureIssuer?: string | null;
  sbomPath?: string | null;
  scanTool?: string | null;
  scanAt?: string | null;
  scanCritical?: number;
  scanHigh?: number;
  waiverOwner?: string | null;
  waiverExpiresAt?: string | null;
  waiverReason?: string | null;
  previousReference?: string | null;
}
/** The exact shape of `repo@sha256:<64 hex>`; used by both the store and the admission policy. */
export const SANDBOX_IMAGE_REFERENCE_PATTERN = /^(?:[a-z0-9][a-z0-9.-]*:[0-9]+\/)?[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

