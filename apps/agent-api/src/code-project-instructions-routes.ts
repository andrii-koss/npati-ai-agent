import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import {
  PROJECT_INSTRUCTIONS_SCHEMA_VERSION,
  type ProjectInstructions,
} from "./code-project-instructions";
import { INSTRUCTIONS_INIT_SCHEMA_VERSION, type InstructionsDraft } from "./code-instructions-init";

/**
 * C8 — read surface for project instructions, plus the `init` draft.
 *
 * Two things this module deliberately does **not** do:
 *
 * 1. It never writes `NPATI.md`. `POST …/instructions/init` returns a draft; persisting it is a separate act
 *    through the existing `code.fs.write` tool path, which is where RBAC, classification and approval already
 *    live. A route that could create an instruction file directly would be a way to influence a future system
 *    prompt without passing the machinery that governs writes.
 * 2. It never returns policy-mutation *evidence*. The classifier captures slices of repository text; serving
 *    them would push file content onto a surface the UI renders. The response carries the rule names and the
 *    file they were found in — enough to act on, nothing to re-inject.
 *
 * The response also states `canChangePolicy: false` explicitly: a client should not have to infer from
 * documentation that the block is inert.
 */

export class CodeProjectInstructionsRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeProjectInstructionsRouteError";
    this.retryable = retryable;
  }
}

/** Named actions, so the permission is derived from the action rather than from a caller-supplied label. */
export const CODE_PROJECT_INSTRUCTIONS_ACTIONS = Object.freeze({
  read: "code.instructions.read",
  init: "code.instructions.init",
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  agent_cannot_change_policy: 403,
  project_not_found: 404,
  instructions_unavailable: 503,
  instructions_draft_secret_detected: 422,
  code_project_instructions_request_failed: 500,
};

interface ProjectParams { companyId: string; projectId: string }

export interface CodeProjectInstructionsRouteDeps {
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  /** Loads and classifies the effective instructions. Injected, so the route holds no file I/O. */
  loadInstructions(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    targetPaths?: readonly string[];
  }): Promise<ProjectInstructions>;
  /** Builds the `init` draft. Must not write anything. */
  buildDraft(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
  }): Promise<InstructionsDraft>;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeProjectInstructionsRouteError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) return "permission_denied";
  if (error instanceof WorkspaceNotFoundError) return "project_not_found";
  return "code_project_instructions_request_failed";
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
  const details = (error as { details?: unknown } | null)?.details;
  const message = code === "code_project_instructions_request_failed"
    ? "Code project instructions request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code project instructions request failed");
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

/** Metadata-only view of a loaded instructions result. No file text leaves this function. */
function toStatus(instructions: ProjectInstructions) {
  return {
    schemaVersion: PROJECT_INSTRUCTIONS_SCHEMA_VERSION,
    trusted: instructions.trusted,
    header: instructions.header,
    contentHash: instructions.contentHash,
    truncated: instructions.truncated,
    canChangePolicy: false as const,
    applied: instructions.applied.map((file) => ({
      path: file.path,
      scope: file.scope,
      chars: file.chars,
      originalChars: file.originalChars,
      truncated: file.truncated,
    })),
    excluded: instructions.excluded.map((file) => ({
      path: file.path,
      reason: file.reason,
      ...(file.kinds === undefined ? {} : { kinds: file.kinds }),
    })),
    policyMutationAttempts: instructions.policyMutationAttempts.map((attempt) => ({
      path: attempt.path,
      rule: attempt.rule,
    })),
    injectionNoteCount: instructions.injectionNotes.length,
  };
}

export async function registerCodeProjectInstructionsRoutes(
  instance: FastifyInstance,
  deps: CodeProjectInstructionsRouteDeps,
) {
  const authorizeAction = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = deps.getAuthContext(request);
    if (!ctx) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  instance.get(
    "/companies/:companyId/projects/:projectId/code/instructions",
    async (request, reply) => {
      const { companyId, projectId } = request.params as ProjectParams;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_INSTRUCTIONS_ACTIONS.read);
        const query = request.query as { paths?: string };
        const targetPaths = typeof query.paths === "string" && query.paths.trim().length > 0
          ? query.paths.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 50)
          : undefined;
        const instructions = await deps.loadInstructions({
          ctx,
          companyId,
          projectId,
          ...(targetPaths === undefined ? {} : { targetPaths }),
        });
        return reply.code(200).send({
          ...withApiVersion({}),
          status: "ok",
          instructions: toStatus(instructions),
        });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_project_instructions_read_failed");
        return fail(reply, error);
      }
    },
  );

  instance.post(
    "/companies/:companyId/projects/:projectId/code/instructions/init",
    async (request, reply) => {
      const { companyId, projectId } = request.params as ProjectParams;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_PROJECT_INSTRUCTIONS_ACTIONS.init);
        const draft = await deps.buildDraft({ ctx, companyId, projectId });
        return reply.code(200).send({
          ...withApiVersion({}),
          status: "ok",
          // A draft, never a write: `written` stays false and the caller must go through `code.fs.write`.
          draft: {
            schemaVersion: INSTRUCTIONS_INIT_SCHEMA_VERSION,
            path: draft.path,
            content: draft.content,
            contentHash: draft.contentHash,
            requiresApproval: true as const,
            written: false as const,
            writeVia: draft.writeVia,
            generatedFrom: draft.generatedFrom,
            truncated: draft.truncated,
          },
        });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_project_instructions_init_failed");
        return fail(reply, error);
      }
    },
  );
}
