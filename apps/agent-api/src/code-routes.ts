import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { CodeError, type CodeService } from "./code-service";
import { hasAdminPermission } from "./code-rbac";
import { CODE_AGENT_MASTER_FLAG, FeatureDisabledError, FeatureFlagError, isValidCodeFlagKey, type FeatureFlagService } from "./feature-flags";
import { API_VERSION, resolveApiVersion } from "./api-versioning";
import { CodeProjectRouteError, resolveCreateKind } from "./code-project-lifecycle-routes";

type CompanyParams = { companyId: string };
type ProjectParams = { companyId: string; projectId: string };
type SessionParams = { companyId: string; sessionId: string };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, retryable: false } });
  if (error instanceof FeatureDisabledError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, flagKey: error.flagKey, retryable: false } });
  if (error instanceof FeatureFlagError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, retryable: false } });
  if (error instanceof CodeError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  // Revision conflicts from the store surface as a stable code so clients can reload and retry.
  if (error instanceof WorkspaceAccessError && /changed by another request/i.test(error.message)) {
    return reply.code(409).send({ error: { code: "flag_revision_conflict", message: error.message, retryable: true } });
  }
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: "code_access_denied", message: error.message, retryable: false } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: "code_not_found", message: error.message, retryable: false } });
  if (error instanceof CodeProjectRouteError) return reply.code(error.httpStatus).send({ error: { code: error.code, message: error.message, retryable: error.retryable, ...(Object.keys(error.details).length ? { details: error.details } : {}) } });
  const message = error instanceof Error ? error.message : "Coding Agent request failed";
  return reply.code(500).send({ error: { code: "code_error", message, retryable: true } });
}

/**
 * C1/C1a: code project and code session API.
 *
 * Reads stay available at all times (History is read-only when the feature is off); every mutation
 * additionally requires the master flag and its own sub-flag, checked here *and* in the service, so a
 * direct service call or a forgotten route cannot bypass the gate. The feature is dark by default.
 */
export function registerCodeRoutes(app: FastifyInstance, auth: AuthProvider, service?: CodeService, flags?: FeatureFlagService) {
  // C1a: every code API response advertises the API version it was served with.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.includes("/code/") || request.url.includes("/code?")) reply.header("x-npati-api-version", API_VERSION);
    return payload;
  });

  const authorize = async (request: FastifyRequest, permission: "workspace:read" | "business:manage") => {
    // C1a: the client states the API version it supports; an unsupported one is rejected with
    // `unsupported_api_version` and every response carries the version it was served with.
    resolveApiVersion(request.headers);
    const ctx = await auth.authenticate(request);
    if (!ctx.permissions.includes(permission) && !hasAdminPermission(ctx.permissions)) {
      throw new WorkspaceAccessError("Missing permission: " + permission);
    }
    if (!service) throw new CodeError("code_unavailable", "Coding Agent is unavailable", 503, true);
    return { ctx, service };
  };

  /** Mutation gate: master + sub-flag, evaluated on the server for the company in the path. */
  const authorizeWrite = async (request: FastifyRequest, companyId: string, subFlag: string) => {
    const { ctx, service } = await authorize(request, "business:manage");
    if (!flags) throw new FeatureDisabledError(CODE_AGENT_MASTER_FLAG, "Coding Agent is unavailable: feature flags are not configured");
    await flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId });
    await flags.assertEnabled(ctx, subFlag, { companyId });
    return { ctx, service };
  };

  app.get<{ Params: CompanyParams; Querystring: { includeArchived?: string } }>("/companies/:companyId/code/projects", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      const projects = await service.listProjects(ctx, request.params.companyId, request.query.includeArchived === "true");
      // C7: additively enriched with the newest session per project, so the UI can offer "continue where you
      // left off" without a second list endpoint. Every pre-existing field is passed through untouched.
      const sessions = await service.listSessions(ctx, request.params.companyId, undefined, { includeArchived: false, limit: 200 });
      const newest = new Map<string, { sessionId: string; mode: string; status: string; updatedAt: string }>();
      for (const session of sessions) {
        const current = newest.get(session.projectId);
        if (!current || session.updatedAt > current.updatedAt) {
          newest.set(session.projectId, { sessionId: session.id, mode: session.mode, status: session.status, updatedAt: session.updatedAt });
        }
      }
      return { projects: projects.map((project) => ({ ...project, lastSession: newest.get(project.id) ?? null })) };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: CompanyParams; Body: { name: string; description?: string; repositoryUrl?: string; branch?: string; credentialId?: string; dataClassification?: string; retentionClass?: string; kind?: string } }>(
    "/companies/:companyId/code/projects",
    { schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 5000 },
      repositoryUrl: { type: "string", maxLength: 2000 },
      branch: { type: "string", maxLength: 200 },
      credentialId: { type: "string", maxLength: 200 },
      dataClassification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
      retentionClass: { type: "string", enum: ["ephemeral", "short", "standard", "extended", "until_deleted"] },
      // C7: the UI states which creation flow it is showing. `import_repository` requires a repository URL and
      // `empty`/`upload` forbid one, so the declared kind can never disagree with what is actually created.
      // The creation itself stays on the existing `CodeService.createProject` path (which imports the repository
      // and detects the toolchain), so no second creation path exists.
      kind: { type: "string", enum: ["import_repository", "upload", "empty"] },
    } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorizeWrite(request, request.params.companyId, "code.write");
        const kind = request.body.kind === undefined ? undefined : resolveCreateKind(request.body.kind);
        const repositoryUrl = typeof request.body.repositoryUrl === "string" ? request.body.repositoryUrl.trim() : "";
        if (kind === "import_repository" && !repositoryUrl) {
          throw new CodeProjectRouteError("invalid_arguments", "repositoryUrl is required when kind is import_repository", 400, { field: "repositoryUrl" });
        }
        if (kind !== undefined && kind !== "import_repository" && repositoryUrl) {
          throw new CodeProjectRouteError("invalid_arguments", "repositoryUrl is only accepted when kind is import_repository", 400, { field: "repositoryUrl" });
        }
        const project = await service.createProject(ctx, request.params.companyId, request.body as never);
        return reply.code(201).send(project);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: ProjectParams }>("/companies/:companyId/projects/:projectId/code/detect-toolchain", async (request, reply) => {
    try {
      const { ctx, service } = await authorizeWrite(request, request.params.companyId, "code.write");
      return await service.detectAndPersist(ctx, request.params.companyId, request.params.projectId);
    } catch (error) { return fail(reply, error); }
  });

  app.patch<{ Params: ProjectParams; Body: { expectedRevision: number; toolchain?: unknown; verifyCommands?: Record<string, string>; defaultBranch?: string; dataClassification?: string; retentionClass?: string } }>(
    "/companies/:companyId/projects/:projectId/code",
    { schema: { body: { type: "object", additionalProperties: false, required: ["expectedRevision"], properties: {
      expectedRevision: { type: "integer", minimum: 1 },
      toolchain: { type: "object", additionalProperties: true },
      verifyCommands: { type: "object", additionalProperties: { type: "string", maxLength: 300 } },
      defaultBranch: { type: "string", maxLength: 200 },
      dataClassification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
      retentionClass: { type: "string", enum: ["ephemeral", "short", "standard", "extended", "until_deleted"] },
    } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorizeWrite(request, request.params.companyId, "code.write");
        return await service.updateProject(ctx, request.params.companyId, request.params.projectId, request.body as never);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: CompanyParams; Querystring: { projectId?: string } }>("/companies/:companyId/code/sessions", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      return { sessions: await service.listSessionsWithProjects(ctx, request.params.companyId, request.query.projectId) };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: ProjectParams; Body: { mode?: string; agentId?: string; modelProfile?: string; parentSessionId?: string; dataClassification?: string; retentionClass?: string; summary?: string } }>(
    "/companies/:companyId/projects/:projectId/code/sessions",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      mode: { type: "string", enum: ["plan", "edit", "auto", "full_auto"] },
      agentId: { type: "string", maxLength: 200 },
      modelProfile: { type: "string", maxLength: 200 },
      parentSessionId: { type: "string", maxLength: 200 },
      dataClassification: { type: "string", enum: ["public", "internal", "confidential", "restricted"] },
      retentionClass: { type: "string", enum: ["ephemeral", "short", "standard", "extended", "until_deleted"] },
      summary: { type: "string", maxLength: 4000 },
    } } } },
    async (request, reply) => {
      try {
        const { ctx, service } = await authorizeWrite(request, request.params.companyId, "code.write");
        if ("childKey" in (request.body ?? {})) throw new CodeError("invalid_arguments", "Internal child identity is not a public session argument", 400);
        const session = await service.createSession(ctx, request.params.companyId, request.params.projectId, request.body as never);
        return reply.code(201).send(session);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.get<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      return await service.getSession(ctx, request.params.companyId, request.params.sessionId);
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: SessionParams }>("/companies/:companyId/code/sessions/:sessionId/archive", async (request, reply) => {
    try {
      // Archiving is part of History management, so it stays available even when the feature is off
      // (the user must always be able to tidy up and later delete their data).
      const { ctx, service } = await authorize(request, "business:manage");
      return await service.archiveSession(ctx, request.params.companyId, request.params.sessionId);
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: CompanyParams }>("/companies/:companyId/code/limits", async (request, reply) => {
    try {
      const { service } = await authorize(request, "workspace:read");
      return { limits: service.getLimits() };
    } catch (error) { return fail(reply, error); }
  });

  // --- C1a: feature flags ---------------------------------------------------------------

  /** Read-only flag view: works while the feature is off, which is how the UI knows it is dark. */
  app.get<{ Params: CompanyParams }>("/companies/:companyId/code/flags", async (request, reply) => {
    try {
      const { ctx, service } = await authorize(request, "workspace:read");
      if (!flags) return reply.code(503).send({ error: { code: "feature_disabled", message: "Feature flags are not configured", retryable: false } });
      // Ownership probe: flag configuration is never readable for a company the caller cannot access.
      await service.listProjects(ctx, request.params.companyId, true);
      const described = await flags.describe(ctx, { companyId: request.params.companyId });
      return {
        flags: described.flags.map((flag) => ({ key: flag.key, enabled: flag.enabled, scope: flag.scope, stage: flag.stage, source: flag.source })),
        master: { key: described.master.key, enabled: described.master.enabled, scope: described.master.scope, stage: described.master.stage, source: described.master.source },
        darkLaunch: described.darkLaunch,
        execution: await flags.executionModes.get(ctx, request.params.companyId),
        defaultsEnabled: flags.usesCompanyDefaults,
        management: {
          company: await flags.canManage(ctx, request.params.companyId),
          global: await flags.canManage(ctx),
        },
        configured: (await flags.list(ctx)).filter((flag) => flag.scope === "global" || flag.scopeId === request.params.companyId),
      };
    } catch (error) { return fail(reply, error); }
  });

  app.put<{ Params: CompanyParams; Body: { scope: "global" | "company" | "user"; scopeId?: string; flagKey: string; stage?: "off" | "internal" | "allowlist" | "percent" | "ga"; enabled?: boolean; rolloutPercent?: number; allowlist?: string[]; expectedRevision?: number } }>(
    "/companies/:companyId/code/flags",
    { schema: { body: { type: "object", additionalProperties: false, required: ["scope", "flagKey"], properties: {
      scope: { type: "string", enum: ["global", "company", "user"] },
      scopeId: { type: "string", maxLength: 200 },
      flagKey: { type: "string", maxLength: 120 },
      stage: { type: "string", enum: ["off", "internal", "allowlist", "percent", "ga"] },
      enabled: { type: "boolean" },
      rolloutPercent: { type: "integer", minimum: 0, maximum: 100 },
      allowlist: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 500 },
      expectedRevision: { type: "integer", minimum: 1 },
    } } } },
    async (request, reply) => {
      try {
        const ctx = await auth.authenticate(request);
        if (!flags) return reply.code(503).send({ error: { code: "feature_disabled", message: "Feature flags are not configured", retryable: false } });
        // Changing a flag is an administrative act: `business:manage` alone must not be enough, so the
        // A stored company owner/admin may change company flags; global changes require account administration.
        if (!(await flags.canManage(ctx, request.body.scope === "company" ? request.params.companyId : undefined))) {
          return reply.code(403).send({ error: { code: "flag_admin_required", message: "Changing a feature flag requires the owner/admin role for the selected scope", retryable: false } });
        }
        if (request.body.scope === "company" && request.body.scopeId !== request.params.companyId) {
          return reply.code(400).send({ error: { code: "invalid_flag_key", message: "scopeId must match the company in the route", retryable: false } });
        }
        if (!isValidCodeFlagKey(request.body.flagKey)) {
          return reply.code(400).send({ error: { code: "invalid_flag_key", message: `Invalid coding flag key "${request.body.flagKey}"`, retryable: false } });
        }
        // A flag change is only ever made from a company the caller can access.
        if (!service) return reply.code(503).send({ error: { code: "code_unavailable", message: "Coding Agent is unavailable", retryable: true } });
        await service.listProjects(ctx, request.params.companyId, true);
        const saved = await flags.setFlag(ctx, request.body, { auditCompanyId: request.params.companyId });
        return reply.send(saved);
      } catch (error) { return fail(reply, error); }
    },
  );

  app.post<{ Params: CompanyParams; Body: { reason?: string; scope?: "global" | "company" } }>(
    "/companies/:companyId/code/flags/kill-switch",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      reason: { type: "string", maxLength: 500 },
      scope: { type: "string", enum: ["global", "company"] },
    } } } },
    async (request, reply) => {
      try {
        const ctx = await auth.authenticate(request);
        if (!flags) return reply.code(503).send({ error: { code: "feature_disabled", message: "Feature flags are not configured", retryable: false } });
        // Same administrative role requirement as a flag change; a plain member cannot stop the feature.
        if (!(await flags.canManage(ctx, request.body?.scope === "global" ? undefined : request.params.companyId))) {
          return reply.code(403).send({ error: { code: "flag_admin_required", message: "Using the kill switch requires the owner/admin role for the selected scope", retryable: false } });
        }
        if (!service) return reply.code(503).send({ error: { code: "code_unavailable", message: "Coding Agent is unavailable", retryable: true } });
        await service.listProjects(ctx, request.params.companyId, true);
        const result = await flags.killSwitch(ctx, {
          companyId: request.body?.scope === "global" ? undefined : request.params.companyId,
          reason: request.body?.reason,
        });
        return reply.send({ flag: result.flag, suspendedSessions: result.suspendedSessions, stoppedSandboxes: result.stoppedSandboxes });
      } catch (error) { return fail(reply, error); }
    },
  );
}
