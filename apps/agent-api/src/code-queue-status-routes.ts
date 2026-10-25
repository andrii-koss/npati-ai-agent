import { usageQuotasEnabled } from "./usage-quota-policy";
/**
 * R1 (section A, item 3, "видимий стан у UI"): the read-only **status surface** for the code-run queue.
 *
 * `CodeRunQueue.state()` has existed since C10 with a full answer — active/queued counts, per-Company and
 * per-user activity, and the waiting tickets in service order — and **zero callers**. A limit nobody can see is
 * a limit whose refusals look like a hang: "the run did not start" and "the deployment is at capacity" were
 * indistinguishable from outside. This module is the missing caller.
 *
 * Two properties are deliberate, and both are security properties rather than features:
 *
 *  1. **It is read-only and never starts anything.** No queue slot is taken, no lease is created, nothing is
 *     mutated by a request to this route — which is why it can stay reachable while the Coding Agent's feature
 *     flags are off, exactly as History/Activity/Export do. A status page that requires the feature it reports
 *     on is useless precisely when it is needed.
 *  2. **It is tenant-scoped in the answer, not only in the request.** The raw `state()` is deployment-wide:
 *     it lists other Companies' session ids. The response is therefore projected down to the caller's own
 *     Company plus non-identifying global totals, and the projection is a pure function
 *     (`buildCodeQueueStatusView`) so it is testable directly. The path also carries `:companyId`, which the
 *     auth provider already refuses when it differs from the authenticated tenant.
 */

import type { FastifyInstance } from "fastify";
import { WorkspaceAccessError } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { CodeRunQueueEntry, CodeRunQueueState } from "./code-run-queue";
import type { CodeRunRateLimitState } from "./code-run-rate-limit";

export interface CodeQueueStatusView {
  /** Global, non-identifying totals. */
  active: number;
  queued: number;
  limits: CodeRunQueueState["limits"];
  /** The Company this answer is scoped to. */
  companyId: string;
  /** This Company's own activity, and this user's. */
  companyActive: number;
  userActive: number;
  /** Only this Company's waiting tickets, in service order. */
  queue: CodeRunQueueEntry[];
  /** R1 A.1: the periodic limit as it stands for this user and this Company. */
  rateLimits: {
    enabled?: boolean;
    limits: CodeRunRateLimitState["limits"];
    user: { used: number; limit: number; resetAt: string | null };
    company: { used: number; limit: number; resetAt: string | null };
  };
}

/**
 * Projects the deployment-wide queue state onto one tenant. `used`/`limit` for the periodic counters are read
 * from the same rows `state()` reports, so the numbers a user sees are the numbers the limiter enforces.
 */
export function buildCodeQueueStatusView(
  state: CodeRunQueueState,
  rateLimits: CodeRunRateLimitState,
  principal: { userId: string; companyId: string },
): CodeQueueStatusView {
  const companyRow = state.activePerCompany.find((row) => row.companyId === principal.companyId);
  const userRow = state.activePerUser.find((row) => row.userId === principal.userId);
  const rateRow = (
    scope: "user" | "company",
    id: string,
    limit: number,
  ): { used: number; limit: number; resetAt: string | null } => {
    const row = rateLimits.windows.find((entry) => entry.scope === scope && entry.id === id);
    return { used: row?.used ?? 0, limit: row?.limit ?? limit, resetAt: row?.resetAt ?? null };
  };
  return {
    active: state.active,
    queued: state.queued,
    limits: { ...state.limits },
    companyId: principal.companyId,
    companyActive: companyRow?.active ?? 0,
    userActive: userRow?.active ?? 0,
    queue: state.queue.filter((entry) => entry.companyId === principal.companyId),
    rateLimits: {
      enabled: usageQuotasEnabled(),
      limits: { ...rateLimits.limits },
      user: rateRow("user", principal.userId, rateLimits.limits.maxRunsPerUserPerPeriod),
      company: rateRow("company", principal.companyId, rateLimits.limits.maxRunsPerCompanyPerPeriod),
    },
  };
}

export interface CodeQueueStatusDeps {
  auth: AuthProvider;
  /** The live queue. Only `state()` is used: this route cannot admit or cancel anything. */
  queue: { state(): CodeRunQueueState };
  /** R1 A.1: the periodic limiter's counters, so the panel shows the whole limit story in one place. */
  rateLimits: { state(): CodeRunRateLimitState };
}

export function registerCodeQueueStatusRoutes(app: FastifyInstance, deps: CodeQueueStatusDeps): void {
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/code/runs/queue", async (request, reply) => {
    try {
      const ctx = await deps.auth.authenticate(request);
      // The same read permission every other read-only code surface requires. Deliberately not the master
      // feature flag: this route changes nothing, and a status page must work while the feature is off.
      if (!ctx.permissions.includes("workspace:read") && !ctx.permissions.includes("*")) {
        throw new WorkspaceAccessError("Missing permission: workspace:read");
      }
      return buildCodeQueueStatusView(deps.queue.state(), deps.rateLimits.state(), {
        userId: ctx.userId,
        companyId: request.params.companyId,
      });
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: "ACCESS_DENIED", message: error.message } });
      }
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }
  });
}
