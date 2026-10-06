import type { FastifyInstance } from "fastify";
import type { AuthContext, CodeSession, CodeSessionMode, WorkspaceStore } from "@npati/workspace";
import {
  createRoleRegistry,
  type CodeCanonicalSessionMode,
  type CodeRoleRegistry,
} from "./code-rbac";
import { isAgentPrincipal, type PolicyChangeKind } from "./code-policy-engine";
import type { CodeAuditPort } from "./code-project-trust";

/**
 * C5: the session mode is changed **only by a user**.
 *
 * A model (an agent principal) has no path to change the session mode, the project rules, the
 * allowlist or trust: `assertPrincipalMayChangePolicy` rejects that with `agent_cannot_change_policy`
 * and the PolicyEngine consults it as well, so a tool call cannot slip past the routes. What a model
 * *can* do is suggest — a suggestion is recorded for the user and changes nothing.
 */

/**
 * C5a (D6) — the session-mode vocabulary.
 *
 * The plan and `code-policy-engine.ts` name the four modes `plan`, `ask`, `auto_edit` and
 * `full_auto_sandbox` (`MatrixMode`); the C1 API accepted only `plan`/`edit`/`auto`/`full_auto`, and it
 * accepted them only from an owner or an admin. Both halves are fixed here:
 *
 *  - a request may use the canonical matrix name (including **`full_auto_sandbox`**, which used to be
 *    answered with `invalid_mode`) or the C1 spelling, which stays accepted as a legacy alias;
 *  - the authorization decision is made on the **canonical** mode, against the role -> mode matrix in
 *    `code-rbac.ts` (`sessionModesFor`), never against a hardcoded role list;
 *  - the persisted value stays the C1 spelling, because `code_sessions.mode` carries the CHECK
 *    constraint of migration 065 (`mode IN ('plan','edit','auto','full_auto')`) and widening it would
 *    mean altering an existing table. `matrixModeFor()` maps the stored value onto the same canonical
 *    mode, so the decision and the storage agree.
 */
export interface SessionModeResolution {
  /** Canonical matrix mode, the one the PolicyEngine and the mode matrix use. */
  mode: CodeCanonicalSessionMode;
  /** The C1 spelling persisted in `code_sessions.mode` (migration 065 vocabulary). */
  persisted: CodeSessionMode;
  /** True when the request used a legacy spelling (C1 name, or `full_auto` for `full_auto_sandbox`). */
  legacyAlias: boolean;
}

/** Resolves a requested mode string, or `null` when nothing recognises it. */
export function resolveSessionMode(value: unknown): SessionModeResolution | null {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "plan":
      return { mode: "plan", persisted: "plan", legacyAlias: false };
    case "ask":
      return { mode: "ask", persisted: "edit", legacyAlias: false };
    case "edit":
      return { mode: "ask", persisted: "edit", legacyAlias: true };
    case "auto_edit":
      return { mode: "auto_edit", persisted: "auto", legacyAlias: false };
    case "auto":
      return { mode: "auto_edit", persisted: "auto", legacyAlias: true };
    case "full_auto_sandbox":
      return { mode: "full_auto_sandbox", persisted: "full_auto", legacyAlias: false };
    case "full_auto":
      // The legacy spelling of the unattended mode: normalised onto the canonical name.
      return { mode: "full_auto_sandbox", persisted: "full_auto", legacyAlias: true };
    default:
      return null;
  }
}

export class CodeSessionModeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeSessionModeError";
  }
}

export type { PolicyChangeKind };

/** The single guard used by the routes; the PolicyEngine carries the authoritative equivalent check. */
export function assertPrincipalMayChangePolicy(context: AuthContext, kind: PolicyChangeKind): void {
  if (isAgentPrincipal(context)) {
    throw new CodeSessionModeError("agent_cannot_change_policy", "An agent cannot change session mode or policy", 403, {
      reason: "agent_cannot_change_policy",
      kind,
    });
  }
}

export interface ModeSuggestion {
  sessionId: string;
  requestedMode: CodeSessionMode;
  reason?: string;
  suggestedBy: string;
  agentId?: string | null;
  at: string;
}

export interface CodeSessionModeDeps {
  store: Pick<WorkspaceStore, "getCodeSession" | "updateCodeSession">;
  audit?: CodeAuditPort;
  /** Where a model's suggestion goes: an Activity/log sink. Recording it changes no state. */
  suggestionSink?: (suggestion: ModeSuggestion) => Promise<void> | void;
  /** C5a (D6): the role -> mode matrix. Injected so a company-specific matrix needs no code edit. */
  registry?: CodeRoleRegistry;
  logger?: { warn(payload: unknown, message?: string): void };
}

export class CodeSessionModeService {
  private readonly registry: CodeRoleRegistry;

  constructor(private readonly deps: CodeSessionModeDeps) {
    this.registry = deps.registry ?? createRoleRegistry();
  }

  private async auditOrFail(context: AuthContext, companyId: string, sessionId: string, metadata: Record<string, unknown>) {
    if (!this.deps.audit) {
      throw new CodeSessionModeError("audit_unavailable", "Changing the session mode requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
    try {
      await this.deps.audit.record({
        action: "code.session.mode_change",
        actor: context.userId,
        companyId,
        resourceType: "code_session",
        resourceId: sessionId,
        metadata,
      });
    } catch {
      throw new CodeSessionModeError("audit_unavailable", "Changing the session mode requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
  }

  /**
   * C5a (D7): a refused mode change is journalled too (`code.session.mode_change.denied`). Best effort:
   * the refusal has already happened, so an unavailable journal must not change it; the failure is
   * logged separately instead of replacing the refusal the caller is entitled to see.
   */
  private async auditDenial(
    context: AuthContext,
    companyId: string,
    sessionId: string,
    code: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const audit = this.deps.audit;
    if (!audit) {
      this.deps.logger?.warn({ code, companyId, sessionId }, "code_session_mode_denial_audit_unavailable");
      return;
    }
    try {
      await audit.record({
        action: "code.session.mode_change.denied",
        actor: String(context.userId ?? "unknown"),
        companyId,
        resourceType: "code_session",
        resourceId: sessionId,
        decision: "deny",
        metadata: { reason: code, principal: isAgentPrincipal(context) ? "agent" : "user", ...details },
      });
    } catch (error) {
      this.deps.logger?.warn({ err: error, code }, "code_session_mode_denial_audit_failed");
    }
  }

  /**
   * C5a (D6): the acting role decides which modes may be set. `plan`/`ask`/`auto_edit` are the working
   * modes of an owner, an admin **and a developer**; `full_auto_sandbox` is the unattended mode and
   * stays with owner/admin. A role with no mode at all (reviewer, or a principal whose role is not in
   * the matrix) keeps the original refusal code.
   */
  private async assertModeAllowed(
    context: AuthContext,
    companyId: string,
    sessionId: string,
    mode: CodeCanonicalSessionMode,
  ): Promise<void> {
    const role = this.registry.roleOf(context);
    const allowed = this.registry.sessionModesFor(role);
    if (allowed.includes(mode)) return;
    await this.auditDenial(context, companyId, sessionId, role ? "session_mode_not_permitted" : "session_mode_admin_required", {
      role,
      mode,
      allowedModes: allowed,
      requestedMode: mode,
    });
    if (!role || allowed.length === 0) {
      throw new CodeSessionModeError("session_mode_admin_required", "Only an owner or admin can change the session mode", 403, {
        reason: "session_mode_admin_required",
        role,
        mode,
      });
    }
    throw new CodeSessionModeError(
      "session_mode_not_permitted",
      `The ${role} role may not set session mode ${mode}`,
      403,
      { reason: "session_mode_not_permitted", role, mode, allowedModes: allowed },
    );
  }

  /** User-driven, role-gated, audited before the write, revision-checked. */
  async setMode(context: AuthContext, companyId: string, sessionId: string, input: { mode: string; expectedRevision: number; reason?: string }): Promise<CodeSession> {
    if (isAgentPrincipal(context)) {
      await this.auditDenial(context, companyId, sessionId, "agent_cannot_change_policy", { requestedMode: input.mode });
    }
    assertPrincipalMayChangePolicy(context, "session_mode");
    const resolved = resolveSessionMode(input.mode);
    if (!resolved) {
      throw new CodeSessionModeError("invalid_mode", "Unknown session mode", 400, {
        reason: "invalid_mode",
        mode: input.mode,
      });
    }
    await this.assertModeAllowed(context, companyId, sessionId, resolved.mode);
    const current = await this.deps.store.getCodeSession(context, companyId, sessionId);
    if (input.expectedRevision !== current.revision) {
      throw new CodeSessionModeError("mode_revision_conflict", "Session changed by another request. Reload and try again.", 409, {
        reason: "mode_revision_conflict",
      });
    }
    await this.auditOrFail(context, companyId, sessionId, {
      from: current.mode,
      to: resolved.mode,
      requestedMode: input.mode,
      legacyAlias: resolved.legacyAlias,
      expectedRevision: input.expectedRevision,
      reason: input.reason ?? null,
    });
    return this.deps.store.updateCodeSession(context, companyId, sessionId, {
      mode: resolved.persisted,
      expectedRevision: input.expectedRevision,
    });
  }

  /**
   * Model-initiated suggestion. Deliberately available to agents, and deliberately incapable of
   * changing anything: it only records a proposal for a user to act on. The suggestion goes through the
   * same canonicalisation, so a model may name `full_auto_sandbox` — it still changes no mode.
   */
  async suggestMode(context: AuthContext, companyId: string, sessionId: string, input: { mode: string; reason?: string }): Promise<{ suggestion: ModeSuggestion; mode: CodeSessionMode }> {
    const resolved = resolveSessionMode(input.mode);
    if (!resolved) {
      throw new CodeSessionModeError("invalid_mode", "Unknown session mode", 400, {
        reason: "invalid_mode",
        mode: input.mode,
      });
    }
    const current = await this.deps.store.getCodeSession(context, companyId, sessionId);
    const suggestion: ModeSuggestion = {
      sessionId,
      requestedMode: resolved.persisted,
      reason: input.reason,
      suggestedBy: isAgentPrincipal(context) ? "agent" : context.userId,
      agentId: current.agentId ?? null,
      at: new Date().toISOString(),
    };
    await this.deps.suggestionSink?.(suggestion);
    return { suggestion, mode: current.mode };
  }
}

export interface SessionModeRouteDeps extends CodeSessionModeDeps {
  service: CodeSessionModeService;
  getAuthContext: (request: unknown) => AuthContext | null;
}

/**
 * `PUT /companies/:companyId/code/sessions/:sessionId/mode` — user only.
 * `POST /companies/:companyId/code/sessions/:sessionId/mode/suggest` — agent-friendly, read-only.
 */
export async function registerCodeSessionModeRoutes(instance: FastifyInstance, deps: SessionModeRouteDeps) {
  const authOrFail = (request: unknown): AuthContext => {
    const context = deps.getAuthContext(request);
    if (!context) throw new CodeSessionModeError("unauthorized", "Authentication required", 401, { reason: "unauthorized" });
    return context;
  };

  instance.put("/companies/:companyId/code/sessions/:sessionId/mode", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string; sessionId: string };
      const body = (request.body ?? {}) as { mode?: string; expectedRevision?: number; reason?: string };
      if (!body.mode || typeof body.expectedRevision !== "number") {
        return reply.status(400).send({ status: "error", code: "invalid_arguments", message: "mode and expectedRevision are required" });
      }
      const session = await deps.service.setMode(context, params.companyId, params.sessionId, {
        mode: body.mode,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      return reply.send({ status: "ok", session });
    } catch (error) {
      const known = error as CodeSessionModeError;
      return reply.status(known.httpStatus ?? 500).send({
        status: "error",
        code: known.code ?? "mode_change_failed",
        message: known.message,
        details: known.details ?? {},
      });
    }
  });

  instance.post("/companies/:companyId/code/sessions/:sessionId/mode/suggest", async (request, reply) => {
    try {
      const context = authOrFail(request);
      const params = request.params as { companyId: string; sessionId: string };
      const body = (request.body ?? {}) as { mode?: string; reason?: string };
      if (!body.mode) return reply.status(400).send({ status: "error", code: "invalid_arguments", message: "mode is required" });
      const result = await deps.service.suggestMode(context, params.companyId, params.sessionId, {
        mode: body.mode,
        reason: body.reason,
      });
      return reply.send({ status: "ok", suggestion: result.suggestion, mode: result.mode, applied: false });
    } catch (error) {
      const known = error as CodeSessionModeError;
      return reply.status(known.httpStatus ?? 500).send({
        status: "error",
        code: known.code ?? "mode_suggestion_failed",
        message: known.message,
        details: known.details ?? {},
      });
    }
  });
}
