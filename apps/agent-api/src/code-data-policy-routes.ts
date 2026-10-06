import type { FastifyInstance, FastifyReply } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError, type AuthContext } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError } from "./code-rbac";
import {
  PROVIDER_CONTENT_TYPES,
  ProviderDataPolicyError,
  isProviderContentType,
  validatePathRule,
  type ProviderContentType,
  type ProjectDataPolicyPathRule,
} from "./provider-data-policy";
import {
  CODE_DATA_POLICY_ACTIONS,
  ProviderDataPolicyAdminService,
  type ProviderEligibilityCandidate,
  type UpsertProviderPolicyCommand,
  type UpsertProjectPolicyCommand,
} from "./provider-data-policy-service";

/**
 * C5b (part 4) — provider data policy administration routes.
 *
 * Every route goes through `ProviderDataPolicyAdminService`, which authorizes through the shared C5a gate
 * (`authorizeCodeAction`, deny by default) on the **company role**: legacy workspace permissions are
 * dropped for these company-scoped paths, so a workspace-wide grant cannot widen them and a caller
 * without a membership row is refused. Reading the policy is `workspace:read`; changing it is the
 * privileged `code.policy.manage` (owner-level) — and `admin:all` alone never grants that (see
 * `permissionsForRole`), which is what makes "who may send our code to a provider" an owner decision.
 *
 * Refusal codes are part of the contract because the UI has to explain them:
 *   permission_denied · agent_cannot_change_policy · action_not_mapped · permission_action_mismatch
 *   invalid_arguments · invalid_policy_field · invalid_classification · invalid_retention
 *   invalid_policy_path_rule · data_policy_revision_conflict · data_policy_not_found
 *   provider_data_policy_not_found · audit_unavailable · unauthorized
 */
export class CodeDataPolicyRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeDataPolicyRouteError";
    this.retryable = retryable;
  }
}

/** Codes this surface can produce, with the status used when the error carries none. */
const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  invalid_policy_field: 400,
  invalid_classification: 400,
  invalid_retention: 400,
  invalid_policy_path_rule: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  code_policy_manage_required: 403,
  data_policy_not_found: 404,
  provider_data_policy_not_found: 404,
  data_policy_revision_conflict: 409,
  audit_unavailable: 503,
};

interface CompanyParams { companyId: string }
interface ProviderParams extends CompanyParams { providerId: string }
interface ProjectParams extends CompanyParams { projectId: string }

function resolveErrorCode(error: unknown): string {
  if (error instanceof ProviderDataPolicyError || error instanceof CodeDataPolicyRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) {
    // The store refuses a stale write with the tree-wide optimistic-concurrency error.
    return /changed by another request/i.test(error.message) ? "data_policy_revision_conflict" : "permission_denied";
  }
  if (error instanceof WorkspaceNotFoundError) return "data_policy_not_found";
  return "data_policy_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
  const shaped = error as { httpStatus?: unknown; status?: unknown } | null;
  const explicit = Number(shaped?.httpStatus ?? shaped?.status ?? Number.NaN);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599 && code !== "data_policy_request_failed") {
    return explicit;
  }
  return ROUTE_ERROR_STATUS[code] ?? 500;
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status ?? 401).send({
      ...withApiVersion({}),
      error: { code: error.code ?? "unauthorized", message: error.message, retryable: false },
    });
  }
  const code = resolveErrorCode(error);
  const status = resolveErrorStatus(error, code);
  const details = (error as { details?: unknown } | null)?.details;
  const message = code === "data_policy_request_failed"
    ? "Provider data policy request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Provider data policy request failed");
  return reply.code(status).send({
    ...withApiVersion({}),
    error: {
      code,
      message,
      retryable: (error as { retryable?: unknown } | null)?.retryable === true,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function badRequest(message: string, details: Record<string, unknown> = {}): CodeDataPolicyRouteError {
  return new CodeDataPolicyRouteError("invalid_arguments", message, 400, details);
}

function readBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`${field} must be a boolean`, { field });
  return value;
}

function readStringOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string or null`, { field });
  return value;
}

function readStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array of strings`, { field });
  return value.map((entry) => {
    if (typeof entry !== "string") throw badRequest(`${field} must be an array of strings`, { field });
    return entry;
  });
}

function readContentTypes(value: unknown): ProviderContentType[] | undefined {
  const list = readStringArray(value, "allowedContentTypes");
  if (list === undefined) return undefined;
  return list.map((entry) => {
    if (!isProviderContentType(entry)) {
      throw badRequest(`Unsupported content type: ${entry}`, { field: "allowedContentTypes", allowed: PROVIDER_CONTENT_TYPES });
    }
    return entry;
  });
}

function readPathRules(value: unknown): ProjectDataPolicyPathRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest("pathRules must be an array", { field: "pathRules" });
  // Validated here as well as in the service: an escaping pattern must be refused before anything is read.
  return value.map((entry) => validatePathRule(entry));
}

function readExpectedPolicyVersion(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw badRequest("expectedPolicyVersion must be a non-negative integer or null", { field: "expectedPolicyVersion" });
  }
  return value;
}

function providerCommandFromBody(body: unknown): UpsertProviderPolicyCommand {
  const input = (body ?? {}) as Record<string, unknown>;
  const command: UpsertProviderPolicyCommand = {};
  if (input.kind !== undefined) {
    if (typeof input.kind !== "string") throw badRequest("kind must be a string", { field: "kind" });
    command.kind = input.kind as UpsertProviderPolicyCommand["kind"];
  }
  const allowPrivateRepoCode = readBoolean(input.allowPrivateRepoCode, "allowPrivateRepoCode");
  if (allowPrivateRepoCode !== undefined) command.allowPrivateRepoCode = allowPrivateRepoCode;
  const allowPromptCaching = readBoolean(input.allowPromptCaching, "allowPromptCaching");
  if (allowPromptCaching !== undefined) command.allowPromptCaching = allowPromptCaching;
  if (input.maxDataClassification !== undefined) {
    if (typeof input.maxDataClassification !== "string") {
      throw badRequest("maxDataClassification must be a string", { field: "maxDataClassification" });
    }
    command.maxDataClassification = input.maxDataClassification as UpsertProviderPolicyCommand["maxDataClassification"];
  }
  if (input.externalRetention !== undefined) {
    if (typeof input.externalRetention !== "string") {
      throw badRequest("externalRetention must be a string", { field: "externalRetention" });
    }
    command.externalRetention = input.externalRetention;
  }
  if (input.trainingPolicy !== undefined) {
    if (typeof input.trainingPolicy !== "string") throw badRequest("trainingPolicy must be a string", { field: "trainingPolicy" });
    command.trainingPolicy = input.trainingPolicy as UpsertProviderPolicyCommand["trainingPolicy"];
  }
  const region = readStringOrNull(input.region, "region");
  if (region !== undefined) command.region = region;
  const jurisdiction = readStringOrNull(input.jurisdiction, "jurisdiction");
  if (jurisdiction !== undefined) command.jurisdiction = jurisdiction;
  const termsUrl = readStringOrNull(input.termsUrl, "termsUrl");
  if (termsUrl !== undefined) command.termsUrl = termsUrl;
  const reviewedBy = readStringOrNull(input.reviewedBy, "reviewedBy");
  if (reviewedBy !== undefined) command.reviewedBy = reviewedBy;
  if (input.lastReviewedAt !== undefined) {
    if (input.lastReviewedAt !== null && typeof input.lastReviewedAt !== "string") {
      throw badRequest("lastReviewedAt must be an ISO date string or null", { field: "lastReviewedAt" });
    }
    command.lastReviewedAt = input.lastReviewedAt as string | null;
  }
  const requiredRedactions = readStringArray(input.requiredRedactions, "requiredRedactions");
  if (requiredRedactions !== undefined) {
    command.requiredRedactions = requiredRedactions as UpsertProviderPolicyCommand["requiredRedactions"];
  }
  const allowedContentTypes = readContentTypes(input.allowedContentTypes);
  if (allowedContentTypes !== undefined) command.allowedContentTypes = allowedContentTypes;
  if (input.modelPattern !== undefined) {
    if (input.modelPattern !== null && typeof input.modelPattern !== "string") {
      throw badRequest("modelPattern must be a string or null", { field: "modelPattern" });
    }
    command.modelPattern = input.modelPattern as string | null;
  }
  const expectedPolicyVersion = readExpectedPolicyVersion(input.expectedPolicyVersion);
  if (expectedPolicyVersion !== undefined) command.expectedPolicyVersion = expectedPolicyVersion;
  return command;
}

function projectCommandFromBody(body: unknown): UpsertProjectPolicyCommand {
  const input = (body ?? {}) as Record<string, unknown>;
  const command: UpsertProjectPolicyCommand = {};
  if (input.dataClassification !== undefined) {
    if (typeof input.dataClassification !== "string") {
      throw badRequest("dataClassification must be a string", { field: "dataClassification" });
    }
    command.dataClassification = input.dataClassification as UpsertProjectPolicyCommand["dataClassification"];
  }
  const pathRules = readPathRules(input.pathRules);
  if (pathRules !== undefined) command.pathRules = pathRules;
  const expectedPolicyVersion = readExpectedPolicyVersion(input.expectedPolicyVersion);
  if (expectedPolicyVersion !== undefined) command.expectedPolicyVersion = expectedPolicyVersion;
  return command;
}

export interface CodeDataPolicyRouteDeps {
  service: ProviderDataPolicyAdminService;
  /** Synchronous context accessor: a path-scoped `preHandler` resolves it once (C5 pattern). */
  getAuthContext: (request: unknown) => AuthContext | null;
}

export async function registerCodeDataPolicyRoutes(instance: FastifyInstance, deps: CodeDataPolicyRouteDeps) {
  const authOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) {
      throw new CodeDataPolicyRouteError("unauthorized", "Authentication required", 401, { reason: "unauthorized" });
    }
    return context;
  };

  instance.get<{ Params: CompanyParams }>("/companies/:companyId/code/data-policy/providers", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const result = await deps.service.listProviderPolicies(context, request.params.companyId);
      return reply.send(withApiVersion({ action: CODE_DATA_POLICY_ACTIONS.providerList, ...result }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  instance.put<{ Params: ProviderParams }>(
    "/companies/:companyId/code/data-policy/providers/:providerId",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        // Authorization happens inside the service, before the body is interpreted as a policy.
        const command = providerCommandFromBody(request.body);
        const result = await deps.service.upsertProviderPolicy(
          context,
          request.params.companyId,
          request.params.providerId,
          command,
        );
        return reply.send(withApiVersion({ action: CODE_DATA_POLICY_ACTIONS.providerUpsert, policy: result.policy }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.get<{ Params: ProviderParams }>(
    "/companies/:companyId/code/data-policy/providers/:providerId/versions",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        const versions = await deps.service.listPolicyVersions(
          context,
          request.params.companyId,
          request.params.providerId,
        );
        return reply.send(withApiVersion({
          action: CODE_DATA_POLICY_ACTIONS.providerVersions,
          providerId: request.params.providerId,
          versions: versions.map((version) => ({
            policyVersion: version.policyVersion,
            modelPattern: version.modelPattern,
            actor: version.actor,
            createdAt: new Date(version.createdAt).toISOString(),
            payload: version.payload,
          })),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.get<{ Params: ProjectParams }>(
    "/companies/:companyId/code/data-policy/projects/:projectId",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        const policy = await deps.service.getProjectPolicy(context, request.params.companyId, request.params.projectId);
        return reply.send(withApiVersion({ action: CODE_DATA_POLICY_ACTIONS.projectRead, projectPolicy: policy }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.put<{ Params: ProjectParams }>(
    "/companies/:companyId/code/data-policy/projects/:projectId",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        const command = projectCommandFromBody(request.body);
        const result = await deps.service.upsertProjectPolicy(
          context,
          request.params.companyId,
          request.params.projectId,
          command,
        );
        return reply.send(withApiVersion({ ...result }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.post<{ Params: ProjectParams }>(
    "/companies/:companyId/code/data-policy/projects/:projectId/hosted-consent",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        const body = (request.body ?? {}) as { providerId?: unknown };
        if (typeof body.providerId !== "string" || !body.providerId.trim()) {
          throw badRequest("providerId is required", { field: "providerId" });
        }
        const result = await deps.service.grantHostedConsent(
          context,
          request.params.companyId,
          request.params.projectId,
          body.providerId.trim(),
        );
        return reply.send(withApiVersion({
          action: CODE_DATA_POLICY_ACTIONS.hostedConsentGrant,
          providerId: body.providerId.trim(),
          granted: true,
          grantedBy: result.consent.grantedBy,
          grantedAt: new Date(result.consent.grantedAt).toISOString(),
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.delete<{ Params: ProjectParams }>(
    "/companies/:companyId/code/data-policy/projects/:projectId/hosted-consent",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        const query = (request.query ?? {}) as { providerId?: unknown };
        if (typeof query.providerId !== "string" || !query.providerId.trim()) {
          throw badRequest("providerId is required", { field: "providerId" });
        }
        const result = await deps.service.revokeHostedConsent(
          context,
          request.params.companyId,
          request.params.projectId,
          query.providerId.trim(),
        );
        return reply.send(withApiVersion({
          action: CODE_DATA_POLICY_ACTIONS.hostedConsentRevoke,
          providerId: query.providerId.trim(),
          granted: false,
          revokedAt: result.consent.revokedAt ? new Date(result.consent.revokedAt).toISOString() : null,
        }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  instance.get<{ Params: ProjectParams }>(
    "/companies/:companyId/code/data-policy/projects/:projectId/eligibility",
    async (request, reply) => {
      try {
        const context = authOrFail(request);
        const query = (request.query ?? {}) as { providerId?: unknown; model?: unknown; contentTypes?: unknown };
        const candidates: ProviderEligibilityCandidate[] = [];
        const providerIds = typeof query.providerId === "string"
          ? [query.providerId]
          : Array.isArray(query.providerId)
            ? (query.providerId as unknown[]).filter((entry): entry is string => typeof entry === "string")
            : [];
        for (const providerId of providerIds) {
          if (!providerId.trim()) continue;
          candidates.push({ providerId: providerId.trim(), model: typeof query.model === "string" ? query.model : null });
        }
        let contentTypes: ProviderContentType[] | undefined;
        if (typeof query.contentTypes === "string" && query.contentTypes.trim()) {
          contentTypes = query.contentTypes.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
            if (!isProviderContentType(entry)) {
              throw badRequest(`Unsupported content type: ${entry}`, { field: "contentTypes", allowed: PROVIDER_CONTENT_TYPES });
            }
            return entry;
          });
        }
        const report = await deps.service.getEligibility(context, request.params.companyId, request.params.projectId, {
          ...(candidates.length ? { candidates } : {}),
          ...(contentTypes ? { contentTypes } : {}),
        });
        return reply.send(withApiVersion({ action: CODE_DATA_POLICY_ACTIONS.eligibility, ...report }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
