import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import type { CodeMetricsReport } from "./code-metrics";

/**
 * C14 (owner decision 3) — the read-only metrics route.
 *
 * Transport only: the arithmetic lives in `code-metrics.ts` and the route returns **that** report unchanged
 * (under the shared `apiVersion` envelope), so the numbers a UI shows and the numbers a unit test asserts cannot
 * drift apart. Three properties are load-bearing:
 *
 * 1. **RBAC through the existing vocabulary.** The action is `code.metrics.read`, mapped to the ordinary
 *    `workspace:read` permission in `CODE_ACTION_PERMISSIONS`. It is a read surface — it aggregates counters
 *    over rows the caller can already read — so it is neither privileged nor a named read that could be reused
 *    to authorize something else. An unmapped action is a refusal (`action_not_mapped`), never a fallback to the
 *    caller's own label.
 * 2. **Tenant scope comes from the path, and only from the path.** `companyId` is the route parameter; the
 *    aggregation is asked for that tenant and the store applies its own `company_id` predicate. There is no
 *    "all companies" query parameter, so a metrics caller cannot ask for another tenant's numbers.
 * 3. **An unwired deployment says so.** With no `metrics` port the answer is `unavailable` with a reason — the
 *    same shape `usage_unavailable` uses — rather than an empty report whose zeros would read as measurements.
 *
 * Refusal codes are part of the contract because the UI explains them:
 *   unauthorized · invalid_arguments · permission_denied · action_not_mapped · permission_action_mismatch
 *   metrics_unavailable · metrics_request_failed
 */
export class CodeMetricsError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeMetricsError";
    this.retryable = retryable;
  }
}

/** The action vocabulary of this surface. One read action; the map above is where its permission lives. */
export const CODE_METRICS_ACTIONS = Object.freeze({
  read: "code.metrics.read",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  metrics_unavailable: 503,
  metrics_request_failed: 500,
};

interface CompanyParams { companyId: string }
interface MetricsQuery { since?: string; runLimit?: string; eventLimit?: string }

export interface CodeMetricsRouteDeps {
  /**
   * Optional: the aggregation over the existing stores. Absent means this deployment did not wire a metrics
   * source, which the route reports as `unavailable` instead of answering an empty report.
   */
  metrics?: (ctx: AuthContext, input: { companyId: string; since?: Date | null; runLimit?: number; eventLimit?: number }) => Promise<CodeMetricsReport>;
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
  now?: () => Date;
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeMetricsError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  return "metrics_request_failed";
}

function resolveErrorStatus(error: unknown, code: string): number {
  const fromCode = ROUTE_ERROR_STATUS[code];
  if (fromCode !== undefined) return fromCode;
  const shaped = error as { httpStatus?: unknown; status?: unknown } | null;
  const explicit = Number(shaped?.httpStatus ?? shaped?.status ?? Number.NaN);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return 500;
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
  const message = code === "metrics_request_failed"
    ? "Code metrics request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code metrics request failed");
  return reply.code(status).send({
    ...withApiVersion({}),
    error: { code, message, retryable: (error as { retryable?: unknown } | null)?.retryable === true },
  });
}

/**
 * Query validation, exported so the bounds are testable without a Fastify instance.
 *
 * A malformed bound is refused (`invalid_arguments`) rather than ignored: silently dropping `runLimit=abc`
 * would answer with a default page while the caller believes it asked for something else. `since` must be a
 * parseable instant for the same reason.
 */
export function resolveMetricsQuery(query: MetricsQuery | undefined): { since: Date | null; runLimit: number; eventLimit: number } {
  const raw = query ?? {};
  const parseBound = (value: string | undefined, fallback: number, min: number, max: number, field: string): number => {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new CodeMetricsError("invalid_arguments", `${field} must be a number`, 400, { field });
    }
    return Math.min(Math.max(Math.trunc(parsed), min), max);
  };
  let since: Date | null = null;
  if (raw.since !== undefined && raw.since !== "") {
    const parsed = new Date(raw.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new CodeMetricsError("invalid_arguments", "since must be an ISO-8601 instant", 400, { field: "since" });
    }
    since = parsed;
  }
  return {
    since,
    runLimit: parseBound(raw.runLimit, 500, 1, 500, "runLimit"),
    eventLimit: parseBound(raw.eventLimit, 500, 1, 1000, "eventLimit"),
  };
}

export async function registerCodeMetricsRoutes(instance: FastifyInstance, deps: CodeMetricsRouteDeps) {
  instance.get<{ Params: CompanyParams; Querystring: MetricsQuery }>(
    "/companies/:companyId/code/metrics",
    async (request, reply) => {
      try {
        const { companyId } = request.params;
        const ctx = deps.getAuthContext(request);
        if (!ctx) throw new AuthenticationError("Authentication required", 401, "unauthorized");
        await deps.authorize(ctx, companyId, {
          action: CODE_METRICS_ACTIONS.read,
          permission: requiredPermissionForAction(CODE_METRICS_ACTIONS.read) ?? "",
        });
        const bounds = resolveMetricsQuery(request.query);
        if (!deps.metrics) {
          return reply.send(withApiVersion({
            status: "unavailable",
            companyId,
            report: null,
            reason: "metrics_source_not_configured",
            message: "Metrics aggregation is not wired for code runs in this deployment (metrics_unavailable).",
          }));
        }
        const report = await deps.metrics(ctx, { companyId, since: bounds.since, runLimit: bounds.runLimit, eventLimit: bounds.eventLimit });
        // The report is forwarded as the aggregator produced it. A route that re-computed or rounded here would
        // be a second implementation of the metrics, which is exactly what this split avoids.
        return reply.send(withApiVersion({ status: "ok", companyId, report }));
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
