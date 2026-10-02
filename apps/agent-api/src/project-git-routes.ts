import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import {
  ProjectGitService,
  GitError,
  GitConflictError,
  GitConflictEscalationError,
  GitApprovalRequiredError,
} from "./project-git-service";

interface ProjectParams {
  companyId: string;
  projectId: string;
}

interface CheckpointParams extends ProjectParams {
  checkpointId: string;
}

export function registerProjectGitRoutes(
  app: FastifyInstance,
  gitService: ProjectGitService,
  auth: AuthProvider,
) {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> => {
    try {
      return await auth.authenticate(request);
    } catch (error) {
      const known = error instanceof AuthenticationError ? error : new AuthenticationError("Unauthorized", 401, "UNAUTHORIZED");
      reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      return null;
    }
  };

  const handleError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof GitConflictError || error instanceof GitConflictEscalationError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          conflictingFiles: error.conflictingFiles,
          details: error.details,
        },
      });
    }
    if (error instanceof GitApprovalRequiredError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          approvalRequired: true,
        },
      });
    }
    if (error instanceof GitError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }
    const message = error instanceof Error ? error.message : "Internal git operation error";
    return reply.code(500).send({
      error: {
        code: "GIT_INTERNAL_ERROR",
        message,
      },
    });
  };

  // 1. Git Status
  app.get<{ Params: ProjectParams }>(
    "/companies/:companyId/projects/:projectId/git/status",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      try {
        const result = await gitService.status(ctx, companyId, projectId);
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 2. Git Diff
  app.get<{ Params: ProjectParams; Querystring: { file?: string; staged?: string } }>(
    "/companies/:companyId/projects/:projectId/git/diff",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const staged = request.query.staged === "true" || request.query.staged === "1";
      try {
        const result = await gitService.diff(ctx, companyId, projectId, {
          file: request.query.file,
          staged,
        });
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 3. Git Log
  app.get<{ Params: ProjectParams; Querystring: { limit?: string } }>(
    "/companies/:companyId/projects/:projectId/git/log",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const limit = Number(request.query.limit) || 20;
      try {
        const commits = await gitService.log(ctx, companyId, projectId, limit);
        return reply.code(200).send({ commits });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 4. Git Branch (list, create, switch)
  app.post<{ Params: ProjectParams; Body: { action: "list" | "create" | "switch"; branch?: string } }>(
    "/companies/:companyId/projects/:projectId/git/branch",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const { action = "list", branch } = request.body ?? {};
      try {
        const result = await gitService.branch(ctx, companyId, projectId, { action, branch });
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 5. Git Stage
  app.post<{ Params: ProjectParams; Body: { files?: string[] } }>(
    "/companies/:companyId/projects/:projectId/git/stage",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const { files } = request.body ?? {};
      try {
        const result = await gitService.stage(ctx, companyId, projectId, files);
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 6. Git Commit
  app.post<{ Params: ProjectParams; Body: { message: string; files?: string[]; stageAll?: boolean } }>(
    "/companies/:companyId/projects/:projectId/git/commit",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const { message, files, stageAll } = request.body ?? {};
      try {
        const result = await gitService.commit(ctx, companyId, projectId, { message, files, stageAll });
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 7. Git Restore File(s)
  app.post<{ Params: ProjectParams; Body: { files: string[] } }>(
    "/companies/:companyId/projects/:projectId/git/restore",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const { files } = request.body ?? {};
      try {
        const result = await gitService.restore(ctx, companyId, projectId, { files });
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 8. List Checkpoints
  app.get<{ Params: ProjectParams; Querystring: { limit?: string } }>(
    "/companies/:companyId/projects/:projectId/checkpoints",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const limit = Number(request.query.limit) || 50;
      try {
        const checkpoints = await gitService.listCheckpoints(ctx, companyId, projectId, limit);
        return reply.code(200).send({ checkpoints });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 9. Create Checkpoint
  app.post<{ Params: ProjectParams; Body: { name: string; description?: string; trigger?: any } }>(
    "/companies/:companyId/projects/:projectId/checkpoints",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId } = request.params;
      const { name, description, trigger } = request.body ?? {};
      try {
        const checkpoint = await gitService.createCheckpoint(ctx, companyId, projectId, {
          name,
          description,
          trigger: trigger ?? "manual",
        });
        return reply.code(201).send(checkpoint);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // 10. Restore Checkpoint (Automatic pre-restore safety checkpoint included)
  app.post<{ Params: CheckpointParams; Body: { approved?: boolean } }>(
    "/companies/:companyId/projects/:projectId/checkpoints/:checkpointId/restore",
    async (request, reply) => {
      const ctx = await authenticate(request, reply);
      if (!ctx) return;
      const { companyId, projectId, checkpointId } = request.params;
      const { approved } = request.body ?? {};
      try {
        const result = await gitService.restoreCheckpoint(ctx, companyId, projectId, checkpointId, { approved });
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // External writes are executed only through the Company tool runtime, which consumes a durable approval.
  app.post<{ Params: ProjectParams }>("/companies/:companyId/projects/:projectId/git/push", async (_request, reply) =>
    reply.code(403).send({ error: { code: "GIT_APPROVAL_REQUIRED", message: "Use an approved Company run to push.", approvalRequired: true } }));
  app.post<{ Params: ProjectParams }>("/companies/:companyId/projects/:projectId/git/pr", async (_request, reply) =>
    reply.code(403).send({ error: { code: "GIT_APPROVAL_REQUIRED", message: "Use an approved Company run to create a pull request.", approvalRequired: true } }));
}
