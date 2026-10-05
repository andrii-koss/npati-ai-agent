import {
  SANDBOX_IMAGE_REFERENCE_PATTERN,
  type AuthContext,
  type SandboxImage,
  type SandboxImageInput,
  type SandboxImageStatus,
  type SandboxImageVariant,
  type WorkspaceStore,
} from "@npati/workspace";
import { NullImageSignatureVerifier, type ImageSignatureVerifier } from "./sandbox-image-signature";
import { defaultCatalogPath, loadSandboxImageCatalog, type SandboxImageCatalog, type SandboxImageCatalogEntry } from "./sandbox-image-catalog";

/** Structured admission failure: the code is stable, the message is for humans, details are for logs. */
export class SandboxImageError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string, readonly status: 403 | 409 = 403, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SandboxImageError";
  }
  toJSON() {
    return { code: this.code, message: this.message, status: this.status, retryable: this.retryable, details: this.details };
  }
}

export interface SandboxImageAdmissionInput {
  companyId: string;
  reference: string;
  variant?: SandboxImageVariant;
  /** Set by development-only entry points; production call sites must not set it. */
  devMode?: boolean;
}

export interface SandboxImageAdmissionResult {
  allowed: true;
  reference: string;
  digest: string;
  variant: SandboxImageVariant;
  /** True when a development exception was used (unverified locally built image). */
  dev: boolean;
  /** Present when the previously pinned digest was revoked and a replacement is required. */
  forcedUpgrade?: boolean;
  replacement?: string | null;
}

export interface SandboxImageAdmission {
  admit(context: AuthContext, input: SandboxImageAdmissionInput): Promise<SandboxImageAdmissionResult>;
}

/**
 * Admin input for `allow`. It accepts the flat persisted shape and the nested shape the admin API
 * uses (`scan`/`waiver`), so the router can call the policy directly.
 */
export interface SandboxImageAllowInput {
  companyId: string;
  variant: SandboxImageVariant;
  reference: string;
  digest?: string;
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
  scan?: { tool: string; critical: number; high: number; at?: string };
  waiver?: { owner: string; expiresAt?: string | null };
}

export interface SandboxImagePolicyOptions {
  /** Development-only escape hatch (`NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES`, default false). */
  allowUnverifiedImages?: boolean;
  /** `NPATI_CODE_MAX_IMAGE_AGE_DAYS`, default 14. */
  maxImageAgeDays?: number;
  catalogPath?: string;
  catalog?: SandboxImageCatalog;
  verifier?: ImageSignatureVerifier;
  signer?: { identity: string; issuer: string };
  /** Deployment environment; anything other than "development" refuses the dev escape hatch. */
  environment?: string;
  /** C1a feature flags, used both for the dev restriction and for digest rollout. */
  flags?: { isEnabled(context: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<boolean> };
  audit?: AuditRecorder;
  workspaceId?: string;
  now?: () => Date;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/** The subset of `AuditLogService` this policy needs (kept structural to avoid a cycle). */
export interface AuditRecorder {
  record(context: AuthContext, input: {
    companyId: string; actor: string; actorRole: string; action: string; resourceType: string;
    resourceId?: string; projectId?: string; decision: "allowed" | "denied" | "approved" | "rejected";
    payload?: unknown; metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

const ADMIN_PERMISSIONS = ["*", "owner", "admin:all"];

function isAdmin(context: AuthContext): boolean {
  return context.permissions.some((permission) => ADMIN_PERMISSIONS.includes(permission));
}

function digestOf(reference: string): string {
  return reference.split("@")[1] ?? "";
}

/** The bare hex part of a recorded digest, used where only `[a-z0-9._-]` is allowed (flag keys). */
function hexDigest(digest: string): string {
  return digest.replace(/^sha256:/, "");
}

/**
 * C1b: sandbox image admission control.
 *
 * Everything the sandbox runs comes from here. The rules are deliberately absolute:
 * - an image must be digest-pinned (a tag is not an identity);
 * - it must be present in the reviewed catalogue or the database with status `verified`;
 * - its signature must verify against the expected signer;
 * - its scan must be recent, and critical findings need a signed-off, unexpired waiver;
 * - a revoked digest is refused and the caller is told to upgrade.
 *
 * Every allow/revoke/waiver decision is written to the tamper-evident journal **before** it is
 * applied, so an audit outage refuses the change instead of performing it unaudited.
 */
export class SandboxImagePolicy implements SandboxImageAdmission {
  private readonly verifier: ImageSignatureVerifier;
  private readonly allowUnverifiedImages: boolean;
  private readonly maxImageAgeDays: number;
  private readonly catalogPath: string;
  private readonly now: () => Date;
  private catalog: SandboxImageCatalog;
  private catalogLoaded = false;

  constructor(private readonly store: WorkspaceStore, private readonly options: SandboxImagePolicyOptions = {}) {
    // Deny by default: no verifier configured means no image is trusted.
    this.verifier = options.verifier ?? new NullImageSignatureVerifier();
    this.allowUnverifiedImages = options.allowUnverifiedImages ?? process.env.NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES === "true";
    this.maxImageAgeDays = options.maxImageAgeDays ?? (Number(process.env.NPATI_CODE_MAX_IMAGE_AGE_DAYS) || 14);
    this.catalogPath = options.catalogPath ?? defaultCatalogPath();
    this.catalog = options.catalog ?? { images: [] };
    this.now = options.now ?? (() => new Date());
  }

  private log(message: string, meta?: Record<string, unknown>) {
    (this.options.log ?? ((text, data) => console.info(`[sandbox-image-policy] ${text} ${JSON.stringify(data ?? {})}`)))(message, meta);
  }

  /** Catalogue state for the admin API/UI (synchronous on purpose: routers read it directly). */
  catalogState(): { configured: boolean; path?: string; images: number; loaded: boolean } {
    return { configured: this.catalog.images.length > 0, path: this.catalogPath, images: this.catalog.images.length, loaded: this.catalogLoaded };
  }

  private async catalogEntries(): Promise<SandboxImageCatalog> {
    if (this.catalogLoaded || this.options.catalog) return this.catalog;
    this.catalog = await loadSandboxImageCatalog(this.catalogPath, (message, meta) => this.log(message, meta));
    this.catalogLoaded = true;
    return this.catalog;
  }

  /** Admission decision for a sandbox start. Throws `SandboxImageError` on any refusal. */
  async admit(context: AuthContext, input: SandboxImageAdmissionInput): Promise<SandboxImageAdmissionResult> {
    const reference = input.reference;
    if (!SANDBOX_IMAGE_REFERENCE_PATTERN.test(reference)) {
      this.log("sandbox_image_admission_denied", { code: "image_not_pinned", reference, companyId: input.companyId });
      throw new SandboxImageError("image_not_pinned", "Sandbox images must be pinned by digest (repo@sha256:<64 hex>); tags and :latest are refused", 403, { reference });
    }
    const digest = digestOf(reference);
    const variant = input.variant ?? this.variantFor(reference) ?? "base";
    const existing = await this.store.getSandboxImage(context, reference);

    if (existing?.status === "revoked") {
      const replacement = await this.replacementFor(context, variant, reference);
      this.log("sandbox_image_admission_denied", { code: "image_revoked", reference, companyId: input.companyId });
      throw new SandboxImageError("image_revoked", "Sandbox image was revoked; a new digest is required", 409, {
        reference, revokedAt: existing.revokedAt, revokedBy: existing.revokedBy, revokeReason: existing.revokeReason,
        forcedUpgrade: true, replacement,
      });
    }
    if (existing && existing.digest !== digest) {
      this.log("sandbox_image_admission_denied", { code: "image_digest_mismatch", reference, companyId: input.companyId });
      throw new SandboxImageError("image_digest_mismatch", "Sandbox image reference does not match the digest recorded in the catalogue", 409, { reference, expected: existing.digest, actual: digest });
    }

    let image = existing;
    if (!image) {
      const entry = (await this.catalogEntries()).images.find((candidate) => candidate.reference === reference);
      if (!entry) {
        // Unknown images are allowed only as an explicit development exception.
        return this.devAdmission(context, input, variant, digest, "not_in_catalogue");
      }
      if (entry.status === "revoked") {
        throw new SandboxImageError("image_revoked", "Sandbox image was revoked; a new digest is required", 409, { reference, forcedUpgrade: true, replacement: await this.replacementFor(context, variant, reference) });
      }
      if (entry.status !== "verified") {
        const dev = await this.tryDevAdmission(context, input, variant, digest, "catalogue_status_" + entry.status, entry);
        if (dev) return dev;
        throw new SandboxImageError("image_not_allowed", "Sandbox image is not verified in the catalogue", 403, { reference, status: entry.status });
      }
      image = await this.seedFromCatalog(context, entry);
    }

    const status = image.status as SandboxImageStatus;
    if (status === "revoked") {
      throw new SandboxImageError("image_revoked", "Sandbox image was revoked; a new digest is required", 409, { reference, forcedUpgrade: true, replacement: await this.replacementFor(context, variant, reference) });
    }
    if (status !== "verified") {
      const dev = await this.tryDevAdmission(context, input, variant, digest, "status_" + status, undefined);
      if (dev) return dev;
      throw new SandboxImageError("image_not_allowed", "Sandbox image is not verified; an owner must allow it explicitly", 403, { reference, status });
    }

    // Scan freshness: an old scan says nothing about the image that is about to run.
    if (!image.scanAt) {
      this.log("sandbox_image_admission_denied", { code: "image_scan_failed", reference, reason: "scan_missing" });
      throw new SandboxImageError("image_scan_failed", "Sandbox image has no scan result", 403, { reference, reason: "scan_missing" });
    }
    const scannedAt = Date.parse(image.scanAt);
    const ageDays = (this.now().getTime() - scannedAt) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays > this.maxImageAgeDays) {
      this.log("sandbox_image_admission_denied", { code: "image_scan_stale", reference, ageDays: Math.round(ageDays) });
      throw new SandboxImageError("image_scan_stale", `Sandbox image scan is older than ${this.maxImageAgeDays} day(s); rebuild and rescan`, 409, { reference, scanAt: image.scanAt, maxImageAgeDays: this.maxImageAgeDays });
    }
    if (image.scanCritical > 0) {
      const waiverExpiry = image.waiverExpiresAt ? Date.parse(image.waiverExpiresAt) : NaN;
      if (!image.waiverOwner || !Number.isFinite(waiverExpiry)) {
        this.log("sandbox_image_admission_denied", { code: "image_scan_failed", reference, critical: image.scanCritical });
        throw new SandboxImageError("image_scan_failed", "Sandbox image has unresolved critical findings and no waiver", 403, { reference, scanCritical: image.scanCritical, scanHigh: image.scanHigh });
      }
      if (waiverExpiry < this.now().getTime()) {
        this.log("sandbox_image_admission_denied", { code: "image_waiver_expired", reference });
        throw new SandboxImageError("image_waiver_expired", "The critical-finding waiver for this image has expired", 409, { reference, waiverOwner: image.waiverOwner, waiverExpiresAt: image.waiverExpiresAt });
      }
      this.log("sandbox_image_admission_waived", { reference, waiverOwner: image.waiverOwner, scanCritical: image.scanCritical });
    }

    const signature = await this.verifier.verify(reference, this.options.signer ?? { identity: "", issuer: "" });
    if (!signature.ok) {
      this.log("sandbox_image_admission_denied", { code: "image_signature_invalid", reference, reason: signature.reason });
      throw new SandboxImageError("image_signature_invalid", "Sandbox image signature could not be verified", 403, { reference, reason: signature.reason ?? "unknown" });
    }

    this.log("sandbox_image_admission_allowed", { reference, variant, signer: signature.signer, companyId: input.companyId });
    return { allowed: true, reference, digest, variant, dev: false };
  }

  /** Development-only path. Never allowed when the deployment is not development or a prod flag is on. */
  private async devAdmission(context: AuthContext, input: SandboxImageAdmissionInput, variant: SandboxImageVariant, digest: string, reason: string): Promise<SandboxImageAdmissionResult> {
    const dev = await this.tryDevAdmission(context, input, variant, digest, reason, undefined);
    if (dev) return dev;
    throw new SandboxImageError("image_not_allowed", "Sandbox image is not in the verified catalogue", 403, { reference: input.reference, reason });
  }

  private async tryDevAdmission(context: AuthContext, input: SandboxImageAdmissionInput, variant: SandboxImageVariant, digest: string, reason: string, entry: SandboxImageCatalogEntry | undefined): Promise<SandboxImageAdmissionResult | null> {
    if (!this.allowUnverifiedImages) return null;
    const environment = this.options.environment ?? process.env.NPATI_ENVIRONMENT ?? process.env.NODE_ENV ?? "production";
    if (environment !== "development" && environment !== "test") {
      this.log("sandbox_image_dev_escape_denied", { reference: input.reference, reason: "environment_not_development", environment });
      return null;
    }
    // A production-capable flag means this company is not a development sandbox any more.
    if (this.options.flags && await this.options.flags.isEnabled(context, "code.full_auto_sandbox", { companyId: input.companyId }).catch(() => true)) {
      this.log("sandbox_image_dev_escape_denied", { reference: input.reference, reason: "production_flag_enabled" });
      return null;
    }
    if (input.devMode === false) return null;
    // Record the image as unverified so it is never confused with a reviewed digest later.
    await this.store.upsertSandboxImage(context, {
      variant, reference: input.reference, digest, status: "unverified",
      sbomPath: entry?.sbomPath ?? null, scanAt: entry?.scanAt ?? null, scanTool: entry?.scanTool ?? "dev-local",
      previousReference: null,
    }).catch(() => undefined);
    this.log("sandbox_image_admission_dev_allowed", { reference: input.reference, variant, reason });
    return { allowed: true, reference: input.reference, digest, variant, dev: true };
  }

  private async seedFromCatalog(context: AuthContext, entry: SandboxImageCatalogEntry): Promise<SandboxImage> {
    return this.store.upsertSandboxImage(context, {
      variant: entry.variant, reference: entry.reference, digest: digestOf(entry.reference), status: "verified",
      signature: entry.signature ?? null, signatureIssuer: entry.signatureIssuer ?? null, sbomPath: entry.sbomPath,
      scanTool: entry.scanTool ?? "catalog", scanAt: entry.scanAt, scanCritical: entry.scanCritical ?? 0, scanHigh: entry.scanHigh ?? 0,
      waiverOwner: entry.waiverOwner ?? null, waiverExpiresAt: entry.waiverExpiresAt ?? null, waiverReason: entry.waiverReason ?? null,
      previousReference: entry.previousReference ?? null,
    });
  }

  private variantFor(reference: string): SandboxImageVariant | null {
    for (const variant of ["node", "python", "go", "rust", "java", "php", "base"] as SandboxImageVariant[]) {
      if (new RegExp(`(?:^|[/-])${variant}(?:[/-]|@|$)`).test(reference)) return variant;
    }
    return null;
  }

  private async replacementFor(context: AuthContext, variant: SandboxImageVariant, reference: string): Promise<string | null> {
    const candidate = await this.store.latestVerifiedSandboxImage(context, variant).catch(() => null);
    return candidate && candidate.reference !== reference ? candidate.reference : null;
  }

  /** Owner/admin only; the journal write happens first, so an audit outage refuses the change. */
  async allow(context: AuthContext, input: SandboxImageAllowInput): Promise<SandboxImage> {
    this.assertAdmin(context);
    if (!SANDBOX_IMAGE_REFERENCE_PATTERN.test(input.reference)) {
      throw new SandboxImageError("image_not_pinned", "Sandbox images must be pinned by digest", 403, { reference: input.reference });
    }
    // Accepts both the flat store shape and the nested shape used by the admin API.
    const scanAt = input.scan?.at ?? input.scanAt ?? null;
    const scanTool = input.scan?.tool ?? input.scanTool ?? null;
    const scanCritical = input.scan?.critical ?? input.scanCritical ?? 0;
    const scanHigh = input.scan?.high ?? input.scanHigh ?? 0;
    const waiverOwner = input.waiver?.owner ?? input.waiverOwner ?? null;
    const waiverExpiresAt = input.waiver?.expiresAt ?? input.waiverExpiresAt ?? null;
    await this.recordDecision(context, input.companyId, "sandbox_image.allow", input.reference, {
      variant: input.variant, status: input.status ?? "verified", scanAt, scanCritical, scanTool,
      waiverOwner, waiverExpiresAt,
    });
    return this.store.upsertSandboxImage(context, {
      variant: input.variant, reference: input.reference, digest: input.digest || digestOf(input.reference),
      status: input.status ?? "verified", signature: input.signature ?? null, signatureIssuer: input.signatureIssuer ?? null,
      sbomPath: input.sbomPath ?? null, scanTool, scanAt, scanCritical, scanHigh,
      waiverOwner, waiverExpiresAt, waiverReason: input.waiverReason ?? null, previousReference: input.previousReference ?? null,
    });
  }

  async revoke(context: AuthContext, companyId: string, reference: string, reason: string): Promise<SandboxImage> {
    this.assertAdmin(context);
    await this.recordDecision(context, companyId, "sandbox_image.revoke", reference, { reason });
    return this.store.revokeSandboxImage(context, reference, { actor: context.userId, reason });
  }

  /** Critical-finding waiver: explicit owner, explicit expiry, explicit reason. */
  async waive(context: AuthContext, companyId: string, reference: string, input: { owner: string; expiresAt: string; reason: string }): Promise<SandboxImage> {
    this.assertAdmin(context);
    if (!input.owner || !input.reason) throw new SandboxImageError("invalid_waiver", "A waiver requires an owner and a reason", 400 as 403, { reference });
    if (!Number.isFinite(Date.parse(input.expiresAt))) throw new SandboxImageError("invalid_waiver", "A waiver requires an expiry date", 400 as 403, { reference });
    await this.recordDecision(context, companyId, "sandbox_image.waiver", reference, { owner: input.owner, expiresAt: input.expiresAt });
    const existing = await this.store.getSandboxImage(context, reference);
    if (!existing) throw new SandboxImageError("image_not_allowed", "Sandbox image is not in the catalogue", 403, { reference });
    return this.store.upsertSandboxImage(context, {
      variant: existing.variant, reference, digest: existing.digest, status: existing.status,
      signature: existing.signature, signatureIssuer: existing.signatureIssuer, sbomPath: existing.sbomPath,
      scanTool: existing.scanTool, scanAt: existing.scanAt, scanCritical: existing.scanCritical, scanHigh: existing.scanHigh,
      waiverOwner: input.owner, waiverExpiresAt: input.expiresAt, waiverReason: input.reason, previousReference: existing.previousReference,
    });
  }

  /** CI or a scheduled job records the scan result; the admission policy then reads it. */
  async recordScan(context: AuthContext, reference: string, scan: { tool: string; at: string; critical: number; high: number; sbomPath?: string | null }): Promise<SandboxImage> {
    this.assertAdmin(context);
    const existing = await this.store.getSandboxImage(context, reference);
    if (!existing) throw new SandboxImageError("image_not_allowed", "Sandbox image is not in the catalogue", 403, { reference });
    return this.store.upsertSandboxImage(context, {
      variant: existing.variant, reference, digest: existing.digest, status: existing.status,
      signature: existing.signature, signatureIssuer: existing.signatureIssuer, sbomPath: scan.sbomPath ?? existing.sbomPath,
      scanTool: scan.tool, scanAt: scan.at, scanCritical: scan.critical, scanHigh: scan.high,
      waiverOwner: existing.waiverOwner, waiverExpiresAt: existing.waiverExpiresAt, waiverReason: existing.waiverReason,
      previousReference: existing.previousReference,
    });
  }

  /**
   * Digest rollout: a session keeps the digest it was created with (the caller stores it on the
   * session), and a new digest is adopted only when the corresponding flag
   * (`code.sandbox_image.<digest prefix>`) is enabled for the company. A revoked digest is never
   * reused: the result asks the caller to upgrade.
   */
  async selectForRollout(context: AuthContext, input: { companyId: string; variant: SandboxImageVariant; currentReference?: string | null }): Promise<{ reference: string | null; digest: string | null; forcedUpgrade: boolean; reason: string }> {
    const current = input.currentReference ?? null;
    if (current) {
      const existing = await this.store.getSandboxImage(context, current).catch(() => null);
      if (existing?.status === "revoked") {
        const replacement = await this.replacementFor(context, input.variant, current);
        return { reference: replacement, digest: replacement ? digestOf(replacement) : null, forcedUpgrade: true, reason: "current_digest_revoked" };
      }
      const adopted = await this.newDigestAdopted(context, input.companyId, input.variant, current);
      if (adopted) return adopted;
      return { reference: current, digest: digestOf(current), forcedUpgrade: false, reason: "session_pinned_digest" };
    }
    const latest = await this.store.latestVerifiedSandboxImage(context, input.variant).catch(() => null);
    return { reference: latest?.reference ?? null, digest: latest?.digest ?? null, forcedUpgrade: false, reason: latest ? "latest_verified" : "no_verified_image" };
  }

  private async newDigestAdopted(context: AuthContext, companyId: string, variant: SandboxImageVariant, current: string) {
    if (!this.options.flags) return null;
    const latest = await this.store.latestVerifiedSandboxImage(context, variant).catch(() => null);
    if (!latest || latest.reference === current) return null;
    // Flag keys live in the `code.` namespace, which only allows `[a-z0-9._-]`, while a recorded digest
    // is canonical (`sha256:<64 hex>`). The rollout key therefore uses the hex prefix, exactly as the
    // plan specifies: `code.sandbox_image.<digest-prefix8>`.
    const flagKey = `code.sandbox_image.${hexDigest(latest.digest).slice(0, 8)}`;
    const enabled = await this.options.flags.isEnabled(context, flagKey, { companyId }).catch(() => false);
    if (!enabled) return null;
    return { reference: latest.reference, digest: latest.digest, forcedUpgrade: false, reason: "rollout_flag_enabled" };
  }

  private assertAdmin(context: AuthContext) {
    if (!isAdmin(context)) throw new SandboxImageError("image_admin_required", "Changing sandbox image policy requires the owner/admin role", 403, {});
  }

  private async recordDecision(context: AuthContext, companyId: string, action: string, reference: string, metadata: Record<string, unknown>) {
    if (!this.options.audit) throw new SandboxImageError("sandbox_image_policy_unavailable", "Sandbox image changes require the audit journal, which is not configured", 403, { action, reference });
    await this.options.audit.record(context, {
      companyId, actor: context.userId, actorRole: isAdmin(context) ? "admin" : "user",
      action, resourceType: "sandbox_image", resourceId: reference, decision: "allowed",
      payload: { action, reference }, metadata,
    });
  }
}

export function sandboxImagePolicyConfig(env: NodeJS.ProcessEnv = process.env, dataDirectory?: string) {
  return {
    allowUnverifiedImages: env.NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES === "true",
    maxImageAgeDays: Number(env.NPATI_CODE_MAX_IMAGE_AGE_DAYS) || 14,
    catalogPath: env.NPATI_SANDBOX_IMAGE_CATALOG || (dataDirectory ? `${dataDirectory}/sandbox-images.json` : defaultCatalogPath(env)),
    signer: {
      // Both spellings are accepted: `NPATI_SANDBOX_SIGNATURE_*` is the documented pair.
      identity: env.NPATI_SANDBOX_SIGNATURE_IDENTITY ?? env.NPATI_SANDBOX_IMAGE_IDENTITY ?? "",
      issuer: env.NPATI_SANDBOX_SIGNATURE_ISSUER ?? env.NPATI_SANDBOX_IMAGE_OIDC_ISSUER ?? "",
    },
    environment: env.NPATI_ENVIRONMENT ?? env.NODE_ENV ?? "production",
  };
}
