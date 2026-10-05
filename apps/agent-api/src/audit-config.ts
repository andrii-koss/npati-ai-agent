/**
 * C1c: audit log configuration.
 *
 * Retention is expressed as a class/config only; the real windows are decided in R1 (the plan keeps
 * audit metadata longer than ordinary logs because it only stores ids, hashes and redacted metadata).
 */
export interface AuditConfig {
  /** Where signed daily anchors are written (outside the Core database). */
  anchorDirectory?: string;
  /** Background chain verification interval. */
  verifyIntervalMs: number;
  /** How often the process checks whether a daily anchor is still missing. */
  anchorIntervalMs: number;
  /** Retention for audit metadata (R1 implements the pruning; C1c only records the intent). */
  retentionDays: number;
  /** When true (default), a detected chain break blocks new privileged audit writes. */
  blockOnBreak: boolean;
  /** HMAC key for anchor signatures; falls back to the encryption key. */
  signingKey?: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAuditConfig(env: NodeJS.ProcessEnv = process.env, dataDirectory?: string): AuditConfig {
  return {
    anchorDirectory: env.NPATI_AUDIT_ANCHOR_DIR || (dataDirectory ? `${dataDirectory}/audit-anchors` : undefined),
    verifyIntervalMs: positiveInt(env.NPATI_AUDIT_VERIFY_INTERVAL_MS, 6 * 60 * 60 * 1000),
    anchorIntervalMs: positiveInt(env.NPATI_AUDIT_ANCHOR_INTERVAL_MS, 60 * 60 * 1000),
    retentionDays: positiveInt(env.NPATI_AUDIT_RETENTION_DAYS, 365),
    blockOnBreak: env.NPATI_AUDIT_BLOCK_ON_BREAK !== "false",
    signingKey: env.NPATI_AUDIT_ANCHOR_KEY || env.NPATI_ENCRYPTION_KEY,
  };
}
