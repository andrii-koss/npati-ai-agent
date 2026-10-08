import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthContext, MountedFolderMode, ProjectMountedFolder } from "@npati/workspace";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { withApiVersion } from "./api-versioning";
import { AuthenticationError } from "./auth";
import { CodeRbacError, requiredPermissionForAction, type AuthorizeCodeActionInput } from "./code-rbac";
import { CodeMountedFolderError } from "./code-mounted-folder";

/**
 * C15 — the transport of the mounted-folder surface.
 *
 * The shape is the project-trust route's, deliberately: a read, a confirm and a revoke, each on a named RBAC
 * action, with `expectedRevision` required on both mutations. The reason `expectedRevision` is mandatory is the
 * same one trust states and it is sharper here — a mounted folder is a directory on the operator's own host, so
 * a confirmation that silently survived someone else's revocation (or their move to another path) is a security
 * decision nobody made.
 *
 * The route adds transport only. The service still performs the flag check, the owner/admin check, the path
 * validation and the audit-before-write, so the fail-closed ordering cannot be lost in a wrapper, and every
 * refusal keeps the code the service chose.
 */

export class CodeMountedFolderRouteError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeMountedFolderRouteError";
    this.retryable = retryable;
  }
}

/** The actions this surface authorizes on. Both are mapped in `CODE_ACTION_PERMISSIONS`. */
export const CODE_MOUNTED_FOLDER_ACTIONS = Object.freeze({
  read: "code.project.mount" as const,
  confirm: "code.project.mount" as const,
  revoke: "code.project.unmount" as const,
});

const ROUTE_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_arguments: 400,
  invalid_mount_mode: 400,
  permission_denied: 403,
  permission_action_mismatch: 403,
  action_not_mapped: 403,
  code_mounted_folder_admin_required: 403,
  feature_disabled: 403,
  feature_unavailable: 503,
  mounted_folder_not_allowlisted: 403,
  mounted_folder_forbidden_root: 403,
  mounted_folder_inside_protected_root: 403,
  mounted_folder_contains_protected_root: 403,
  mounted_folder_roots_unconfigured: 403,
  symlink_escape: 403,
  mounted_folder_confirmation_required: 400,
  mounted_folder_invalid_path: 400,
  mounted_folder_not_a_directory: 400,
  mount_target_denied: 400,
  mounted_folder_not_found: 404,
  mounted_folder_revision_mismatch: 409,
  audit_unavailable: 503,
  code_mounted_folder_request_failed: 500,
};

interface ProjectParams { companyId: string; projectId: string }

export interface CodeMountedFolderRouteDeps {
  mountedFolder: {
    get(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null>;
    confirm(
      ctx: AuthContext,
      companyId: string,
      projectId: string,
      input: { path: string; mode: MountedFolderMode; expectedRevision: number; confirm?: boolean; reason?: string },
    ): Promise<ProjectMountedFolder>;
    revoke(
      ctx: AuthContext,
      companyId: string,
      projectId: string,
      input: { expectedRevision: number; reason?: string },
    ): Promise<ProjectMountedFolder>;
  };
  authorize(ctx: AuthContext, companyId: string, input: AuthorizeCodeActionInput): Promise<unknown>;
  getAuthContext(request: unknown): AuthContext | null;
  logger?: { warn(payload: unknown, message?: string): void };
}

function resolveErrorCode(error: unknown): string {
  if (error instanceof CodeMountedFolderRouteError) return error.code;
  if (error instanceof CodeMountedFolderError) return error.code;
  if (error instanceof CodeRbacError) return error.code;
  if (error instanceof WorkspaceAccessError) return "mounted_folder_revision_mismatch";
  if (error instanceof WorkspaceNotFoundError) return "project_not_found";
  return "code_mounted_folder_request_failed";
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
  const message = code === "code_mounted_folder_request_failed"
    ? "Code mounted folder request failed"
    : String((error as { message?: unknown } | null)?.message ?? "Code mounted folder request failed");
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

/** A never-cached statement of the mount. An absent record is "no mount at revision 0", never "mounted". */
function toStatus(record: ProjectMountedFolder | null) {
  const revision = Number(record?.revision ?? 0);
  return {
    mounted: record?.confirmedAt !== undefined && record?.confirmedAt !== null && record?.revokedAt == null,
    revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
    ...(record?.path === undefined ? {} : { path: record.path }),
    ...(record?.mode === undefined ? {} : { mode: record.mode }),
    ...(record?.confirmedBy === undefined ? {} : { confirmedBy: record.confirmedBy }),
    ...(record?.confirmedAt === undefined ? {} : { confirmedAt: record.confirmedAt }),
  };
}

export async function registerCodeMountedFolderRoutes(
  instance: FastifyInstance,
  deps: CodeMountedFolderRouteDeps,
) {
  const authorizeAction = async (request: unknown, companyId: string, action: string): Promise<AuthContext> => {
    const ctx = deps.getAuthContext(request);
    if (!ctx) throw new AuthenticationError("Authentication required", 401, "unauthorized");
    await deps.authorize(ctx, companyId, { action, permission: requiredPermissionForAction(action) ?? "" });
    return ctx;
  };

  instance.get(
    "/companies/:companyId/projects/:projectId/code/mounted-folder",
    async (request, reply) => {
      const { companyId, projectId } = request.params as ProjectParams;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_MOUNTED_FOLDER_ACTIONS.read);
        // Read fresh on every request: a revoked or revision-bumped mount must not survive in a client that
        // asked once, because the next request would create a container against a directory nobody confirmed.
        const record = await deps.mountedFolder.get(ctx, companyId, projectId);
        return reply.code(200).send({ ...withApiVersion({}), status: "ok", mountedFolder: toStatus(record) });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_mounted_folder_read_failed");
        return fail(reply, error);
      }
    },
  );

  instance.post(
    "/companies/:companyId/projects/:projectId/code/mounted-folder",
    async (request: unknown, reply: FastifyReply) => {
      const { companyId, projectId } = (request as { params?: unknown }).params as ProjectParams;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_MOUNTED_FOLDER_ACTIONS.confirm);
        const body = ((request as { body?: unknown }).body ?? {}) as { path?: unknown; mode?: unknown; expectedRevision?: unknown; confirm?: unknown; reason?: unknown };
        const expectedRevision = Number(body.expectedRevision);
        if (!Number.isFinite(expectedRevision) || expectedRevision < 0) {
          throw new CodeMountedFolderRouteError(
            "invalid_arguments",
            "expectedRevision is required so a confirmation cannot silently replace another decision",
            400,
          );
        }
        if (typeof body.path !== "string") throw new CodeMountedFolderRouteError("invalid_arguments", "path is required", 400);
        if (body.mode !== "ro" && body.mode !== "rw") throw new CodeMountedFolderRouteError("invalid_mount_mode", "mode must be 'ro' or 'rw'", 400);
        const mode: MountedFolderMode = body.mode;
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
        const record = await deps.mountedFolder.confirm(ctx, companyId, projectId, {
          path: body.path,
          mode,
          expectedRevision,
          confirm: body.confirm === true,
          ...(reason === undefined ? {} : { reason }),
        });
        return reply.code(200).send({ ...withApiVersion({}), status: "ok", mountedFolder: toStatus(record) });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_mounted_folder_confirm_failed");
        return fail(reply, error);
      }
    },
  );

  instance.post(
    "/companies/:companyId/projects/:projectId/code/mounted-folder/revoke",
    async (request: unknown, reply: FastifyReply) => {
      const { companyId, projectId } = (request as { params?: unknown }).params as ProjectParams;
      try {
        const ctx = await authorizeAction(request, companyId, CODE_MOUNTED_FOLDER_ACTIONS.revoke);
        const body = ((request as { body?: unknown }).body ?? {}) as { expectedRevision?: unknown; reason?: unknown };
        const expectedRevision = Number(body.expectedRevision);
        if (!Number.isFinite(expectedRevision) || expectedRevision < 0) {
          throw new CodeMountedFolderRouteError("invalid_arguments", "expectedRevision is required so a revocation cannot race another decision", 400);
        }
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
        const record = await deps.mountedFolder.revoke(ctx, companyId, projectId, {
          expectedRevision,
          ...(reason === undefined ? {} : { reason }),
        });
        return reply.code(200).send({ ...withApiVersion({}), status: "ok", mountedFolder: toStatus(record) });
      } catch (error) {
        deps.logger?.warn({ projectId, code: resolveErrorCode(error) }, "code_mounted_folder_revoke_failed");
        return fail(reply, error);
      }
    },
  );
}
