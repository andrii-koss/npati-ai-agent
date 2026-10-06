import { hasAdminPermission } from "./code-rbac";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  WorkspaceAccessError, WorkspaceNotFoundError,
  type AuthContext, type SandboxImage, type SandboxImageStatus, type WorkspaceStore,
} from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { API_VERSION, withApiVersion } from "./api-versioning";
import {
  sandboxImagePolicyConfig,
  type SandboxImageAdmissionInput,
  type SandboxImageAdmissionResult,
} from "./sandbox-image-policy";

/**
 * C1b: sandbox image API.
 *
 * The policy (`SandboxImagePolicy`) decides admission; this router only exposes it. Two facts about
 * the data model matter here:
 * - images are **workspace-scoped** records (the store has no company column), so the company in the
 *   path is used for authorization and ownership, not as a filter;
 * - a reference is only valid when it is digest-pinned, which is enforced again here (the policy also
 *   enforces it) so a client never gets a surprising 500.
 *
 * The admin port below is the surface this router consumes; `SandboxImagePolicy` satisfies it
 * structurally, so wiring is one registration call.
 */
export interface SandboxImageAdmin {
  admit(ctx: AuthContext, input: SandboxImageAdmissionInput): Promise<SandboxImageAdmissionResult>;
  allow(ctx: AuthContext, input: { companyId: string; variant: SandboxImage["variant"]; reference: string; status?: SandboxImageStatus; signature?: string | null; sbomPath?: string | null; scan?: SandboxImageScan; waiver?: SandboxImageWaiver }): Promise<SandboxImage>;
  revoke(ctx: AuthContext, companyId: string, reference: string, reason: string): Promise<SandboxImage>;
  recordScan(ctx: AuthContext, reference: string, scan: { tool: string; critical: number; high: number; at: string; sbomPath?: string | null }): Promise<SandboxImage>;
  /** Optional: present on the real policy, used to report the catalog state in the UI. */
  catalogState?(): { configured: boolean; path?: string };
}

export interface SandboxImageScan { tool: string; critical: number; high: number; at?: string }
export interface SandboxImageWaiver { owner: string; expiresAt?: string | null }

/** Listing subset of `WorkspaceStore`; the store itself satisfies it. */
export interface SandboxImageLister {
  listSandboxImages(ctx: AuthContext): Promise<SandboxImage[]>;
  getCompany?(ctx: AuthContext, companyId: string): Promise<unknown>;
}

type CompanyParams = { companyId: string };
type ImageParams = { companyId: string; imageId: string };

const PINNED_REFERENCE = /@sha256:[0-9a-f]{64}$/;
const IMAGE_VARIANTS = ["base", "node", "python", "php", "go", "rust", "java", "full"] as const;

/** Known policy failures mapped to stable HTTP contracts; anything else is a 500 without internals. */
const IMAGE_ERROR_STATUS: Record<string, number> = {
  image_not_pinned: 400,
  image_admin_required: 403,
  image_not_allowed: 403,
  image_not_found: 404,
  image_revoked: 409,
  image_digest_mismatch: 409,
  image_scan_stale: 409,
  image_waiver_expired: 409,
  image_scan_failed: 422,
  image_signature_invalid: 502,
  image_unavailable: 503,
  // Unexpected internal failures must surface as 500 (never as a validation 400) while still hiding
  // stack traces and internal messages.
  image_error: 500,
};

function imageError(reply: FastifyReply, code: string, message: string, retryable = false, details?: unknown) {
  return reply.code(IMAGE_ERROR_STATUS[code] ?? 400).send({ ...withApiVersion({}), error: { code, message, retryable, ...(details === undefined ? {} : { details }) } });
}

function fail(reply: FastifyReply, error: unknown) {
  // Authentication failures keep the status carried by the error itself (401), so an anonymous caller
  // is never answered with a validation-style 400.
  if (error instanceof AuthenticationError) {
    return reply.code(error.status ?? 401).send({
      ...withApiVersion({}),
      error: { code: error.code, message: error.message, retryable: false },
    });
  }
  const shaped = error as { code?: unknown; status?: unknown; retryable?: unknown; details?: unknown; message?: unknown };
  if (typeof shaped?.code === "string" && shaped.code.startsWith("image_")) {
    const code = shaped.code;
    const status = typeof shaped.status === "number" ? shaped.status : (IMAGE_ERROR_STATUS[code] ?? 400);
    return reply.code(status).send({
      ...withApiVersion({}),
      error: {
        code: shaped.code,
        message: typeof shaped.message === "string" ? shaped.message : shaped.code,
        retryable: shaped.retryable === true,
        ...(shaped.details === undefined ? {} : { details: shaped.details }),
      },
    });
  }
  if (error instanceof WorkspaceAccessError) return imageError(reply, "image_admin_required", error.message);
  if (error instanceof WorkspaceNotFoundError) return imageError(reply, "image_not_found", error.message);
  return imageError(reply, "image_error", "Sandbox image request failed", true);
}

/** A reference must be digest-pinned: a tag (`latest` or otherwise) can be repointed after review. */
export function validateImageReference(reference: unknown): { ok: true; reference: string } | { ok: false; message: string } {
  if (typeof reference !== "string" || !reference.trim()) return { ok: false, message: "reference is required" };
  const value = reference.trim();
  if (value.includes(":latest")) return { ok: false, message: "A sandbox image must never be referenced by the 'latest' tag; use repo@sha256:<digest>" };
  if (!PINNED_REFERENCE.test(value)) return { ok: false, message: "A sandbox image must be digest-pinned (repo@sha256:<64 hex characters>), not a tag" };
  return { ok: true, reference: value };
}

function nonNegativeInteger(value: unknown, field: string): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return { ok: false, message: field + " must be a non-negative integer" };
  return { ok: true, value };
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * C1b: sandbox image administration.
 *
 * Reads require workspace:read; every mutation requires the existing administrative role, because
 * allowing or revoking an image changes what the sandbox is allowed to run. The admission-check route
 * is read-only by design: it answers "would this image be admitted?" without starting anything, so an
 * operator or the UI can verify the policy before a run.
 */
export function registerSandboxImageRoutes(app: FastifyInstance, auth: AuthProvider, policy?: SandboxImageAdmin, store?: SandboxImageLister) {
  const isAdmin = (ctx: AuthContext) => hasAdminPermission(ctx.permissions);

  const authorize = async (request: FastifyRequest, permission: "workspace:read" | "business:manage") => {
    const ctx = await auth.authenticate(request);
    if (!ctx.permissions.includes(permission) && !hasAdminPermission(ctx.permissions)) {
      throw new WorkspaceAccessError("Missing permission: " + permission);
    }
    if (!policy) throw Object.assign(new Error("Sandbox image policy is not configured"), { code: "image_unavailable", status: 503, retryable: true });
    return ctx;
  };

  /** Authorization first (explicit administrative role), then any lookup, mirroring the flag routes. */
  const authorizeAdmin = async (request: FastifyRequest) => {
    const ctx = await authorize(request, "business:manage");
    if (!isAdmin(ctx)) throw Object.assign(new Error("Managing sandbox images requires the owner/admin role"), { code: "image_admin_required", status: 403 });
    return ctx;
  };

  /** Company ownership: the caller must own the company in the path before anything is listed. */
  const assertOwnership = async (ctx: AuthContext, companyId: string) => {
    if (!store?.getCompany) return;
    try {
      await store.getCompany(ctx, companyId);
    } catch {
      // Deny without revealing whether the company exists, and never leak the store's own message.
      throw Object.assign(new Error("Company is not available to this caller"), { code: "image_not_allowed", status: 403 });
    }
  };

  const listImages = async (ctx: AuthContext): Promise<SandboxImage[]> => {
    if (!store) throw Object.assign(new Error("Sandbox image store is not configured"), { code: "image_unavailable", status: 503, retryable: true });
    return store.listSandboxImages(ctx);
  };

  app.get<{ Params: CompanyParams }>("/companies/:companyId/code/sandbox-images", async (request, reply) => {
    try {
      const ctx = await authorize(request, "workspace:read");
      await assertOwnership(ctx, request.params.companyId);
      const images = await listImages(ctx);
      const config = sandboxImagePolicyConfig();
      const catalog = policy!.catalogState?.() ?? { configured: images.length > 0, path: config.catalogPath };
      const limits = { maxScanAgeDays: config.maxImageAgeDays, allowUnverified: config.allowUnverifiedImages };
      return reply.send(withApiVersion({ images, catalog, policy: limits }));
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: CompanyParams; Body: { variant?: string; reference?: string; status?: SandboxImageStatus; signature?: string | null; sbomPath?: string | null; scan?: SandboxImageScan; waiver?: SandboxImageWaiver } }>(
    "/companies/:companyId/code/sandbox-images",
    async (request, reply) => {
      try {
        const ctx = await authorizeAdmin(request);
        const body = request.body ?? {};
        const reference = validateImageReference(body.reference);
        if (!reference.ok) return imageError(reply, "image_not_pinned", reference.message);
        if (typeof body.variant !== "string" || !body.variant.trim()) return imageError(reply, "image_not_pinned", "variant is required");
        if (body.scan) {
          const critical = nonNegativeInteger(body.scan.critical, "scan.critical");
          const high = nonNegativeInteger(body.scan.high, "scan.high");
          if (!critical.ok) return imageError(reply, "image_scan_failed", critical.message);
          if (!high.ok) return imageError(reply, "image_scan_failed", high.message);
          if (body.scan.at !== undefined && !isIsoTimestamp(body.scan.at)) return imageError(reply, "image_scan_failed", "scan.at must be an ISO timestamp");
        }
        const image = await policy!.allow(ctx, {
          companyId: request.params.companyId,
          variant: body.variant.trim() as SandboxImage["variant"],
          reference: reference.reference,
          status: body.status,
          signature: body.signature ?? null,
          sbomPath: body.sbomPath ?? null,
          scan: body.scan,
          waiver: body.waiver,
        });
        return reply.code(201).send(withApiVersion({ image }));
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: CompanyParams; Body: { reference?: string; reason?: string } }>(
    "/companies/:companyId/code/sandbox-images/revoke",
    async (request, reply) => {
      try {
        const ctx = await authorizeAdmin(request);
        const reference = validateImageReference(request.body?.reference);
        if (!reference.ok) return imageError(reply, "image_not_pinned", reference.message);
        if (typeof request.body?.reason !== "string" || !request.body.reason.trim()) return imageError(reply, "image_not_allowed", "reason is required");
        const image = await policy!.revoke(ctx, request.params.companyId, reference.reference, request.body.reason.trim());
        return reply.send(withApiVersion({ image }));
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: ImageParams; Body: { tool?: string; critical?: number; high?: number; at?: string } }>(
    "/companies/:companyId/code/sandbox-images/:imageId/scan",
    async (request, reply) => {
      try {
        const ctx = await authorizeAdmin(request);
        const body = request.body ?? {};
        if (typeof body.tool !== "string" || !body.tool.trim()) return imageError(reply, "image_scan_failed", "tool is required");
        const critical = nonNegativeInteger(body.critical, "critical");
        const high = nonNegativeInteger(body.high, "high");
        if (!critical.ok) return imageError(reply, "image_scan_failed", critical.message);
        if (!high.ok) return imageError(reply, "image_scan_failed", high.message);
        if (body.at !== undefined && !isIsoTimestamp(body.at)) return imageError(reply, "image_scan_failed", "at must be an ISO timestamp");
        const images = await listImages(ctx);
        const target = images.find((image) => image.id === request.params.imageId);
        if (!target) return imageError(reply, "image_not_found", "Unknown sandbox image");
        const image = await policy!.recordScan(ctx, target.reference, {
          tool: body.tool.trim(), critical: critical.value, high: high.value, at: body.at ?? new Date().toISOString(),
        });
        return reply.send(withApiVersion({ image }));
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: CompanyParams; Body: { reference?: string; variant?: string; devMode?: boolean } }>(
    "/companies/:companyId/code/sandbox-images/admission-check",
    async (request, reply) => {
      try {
        const ctx = await authorize(request, "business:manage");
        const body = request.body ?? {};
        const reference = validateImageReference(body.reference);
        if (!reference.ok) return imageError(reply, "image_not_pinned", reference.message);
        // `admit` either returns an allowed result or throws a structured SandboxImageError, which
        // `fail` maps to the policy's own code and status (never a stack trace).
        const admission = await policy!.admit(ctx, {
          companyId: request.params.companyId,
          reference: reference.reference,
          variant: typeof body.variant === "string" && body.variant.trim() ? (body.variant.trim() as SandboxImage["variant"]) : undefined,
          devMode: body.devMode === true,
        });
        return reply.send(withApiVersion({
          allowed: true, reference: admission.reference, digest: admission.digest, variant: admission.variant,
          dev: admission.dev, forcedUpgrade: admission.forcedUpgrade ?? false, replacement: admission.replacement ?? null,
        }));
      } catch (error) { return fail(reply, error); }
    },
  );

  return { apiVersion: API_VERSION, variants: IMAGE_VARIANTS };
}
