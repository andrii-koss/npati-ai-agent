import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WorkspaceAccessError, WorkspaceNotFoundError, type AuthContext, type ProjectCheckpoint, type WorkspaceStore } from "@npati/workspace";
import { AuthenticationError, type AuthProvider } from "./auth";
import { ProjectFileError, type ProjectWorkspace } from "./project-workspace";
import { ProjectMediaError, type ProjectMediaService } from "./project-media-service";
import type { ProjectService } from "./project-service";

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
  if (error instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: { code: error.code, message: error.message } });
  if (error instanceof ProjectFileError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, currentRevision: error.currentRevision } });
  if (error instanceof ProjectMediaError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  return reply.code(500).send({ error: { code: "project_files_error", message: error instanceof Error ? error.message : "Project file request failed" } });
}

async function authorize(
  auth: AuthProvider,
  request: FastifyRequest,
  requiredCompanyId?: string,
  requiredProjectId?: string,
  projectService?: ProjectService,
) {
  const context = await auth.authenticate(request);
  if (!context.permissions.some((permission) => ["workspace:read", "business:manage", "owner", "*"].includes(permission))) {
    throw new WorkspaceAccessError("Missing workspace read permission");
  }
  if (requiredCompanyId && context.companyId && context.companyId !== requiredCompanyId && !context.permissions.includes("*")) {
    throw new WorkspaceAccessError("Cross-tenant access forbidden: company mismatch");
  }
  if (requiredProjectId && "projectId" in context && typeof context.projectId === "string" && context.projectId && context.projectId !== requiredProjectId && !context.permissions.includes("*")) {
    throw new WorkspaceAccessError("Cross-project access forbidden: project mismatch");
  }
  if (projectService && requiredCompanyId && requiredProjectId) {
    await projectService.get(context, requiredCompanyId, requiredProjectId);
  }
  return context;
}

export { authorize as authorizeProjectFileRead };

interface Params { companyId: string; projectId: string }
interface Query { path?: string; query?: string; workspaceId?: string; prefix?: string }

export function registerProjectFileRoutes(
  app: FastifyInstance,
  workspace: ProjectWorkspace,
  auth: AuthProvider,
  mediaService?: ProjectMediaService,
  projectService?: ProjectService,
  checkpoints?: {
    listCheckpoints(ctx: AuthContext, companyId: string, projectId: string, limit?: number): Promise<ProjectCheckpoint[]>;
    readCheckpointFile(ctx: AuthContext, companyId: string, projectId: string, checkpointId: string, file: string): Promise<{ content: string | null }>;
  },
) {
  app.get<{ Params: Params; Querystring: Query }>("/companies/:companyId/projects/:projectId/files/tree", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      return { workspace: await workspace.info(context, companyId, projectId, request.query.workspaceId), files: await workspace.getFileTree(context, companyId, projectId, request.query.workspaceId) };
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: Params; Querystring: Query }>("/companies/:companyId/projects/:projectId/files/read", async (request, reply) => {
    try { return await workspace.readFile(await authorize(auth, request), request.params.companyId, request.params.projectId, request.query.path ?? "", request.query.workspaceId); }
    catch (error) { return fail(reply, error); }
  });

  /**
   * The file as it was before an agent run, so the chat viewer can mark the lines the run changed. Only a file the
   * user may read now is served (the same read as files/read), from the run's first automatic checkpoint.
   */
  app.get<{ Params: Params; Querystring: Query & { runId?: string } }>("/companies/:companyId/projects/:projectId/files/before-run", async (request, reply) => {
    try {
      if (!checkpoints) return reply.code(404).send({ error: { code: "checkpoints_unavailable", message: "Checkpoints are not available" } });
      const runId = request.query.runId ?? "";
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(runId)) return reply.code(400).send({ error: { code: "invalid_run_id", message: "A run id is required" } });
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const filePath = request.query.path ?? "";
      await workspace.readFile(context, companyId, projectId, filePath, request.query.workspaceId);
      const runCheckpoints = (await checkpoints.listCheckpoints(context, companyId, projectId, 200))
        .filter(checkpoint => checkpoint.runId === runId && checkpoint.trigger === "pre_run" && checkpoint.commitHash);
      // The store returns createdAt as a Date; the type says string.
      const first = runCheckpoints.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
      if (!first) return reply.code(404).send({ error: { code: "checkpoint_not_found", message: "No checkpoint for this run" } });
      const before = await checkpoints.readCheckpointFile(context, companyId, projectId, first.id, filePath);
      return { content: before.content, checkpointId: first.id };
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: Params; Querystring: Query }>("/companies/:companyId/projects/:projectId/files/search", async (request, reply) => {
    try { return { files: await workspace.searchFiles(await authorize(auth, request), request.params.companyId, request.params.projectId, request.query.query ?? "", request.query.workspaceId) }; }
    catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: Params; Body: { path: string; content: string; expectedRevision?: string } }>("/companies/:companyId/projects/:projectId/files/write", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const { path: filePath, content, expectedRevision } = request.body || {};
      if (!filePath || typeof filePath !== "string") {
        return reply.code(400).send({ error: { code: "invalid_path", message: "File path is required" } });
      }
      try {
        await workspace.readFile(context, companyId, projectId, filePath);
        if (!expectedRevision) return reply.code(409).send({ error: { code: "revision_required", message: "Read the file and provide its expected revision before replacing it." } });
        const res = await workspace.writeFile(context, companyId, projectId, filePath, content ?? "", expectedRevision);
        return reply.code(200).send(res);
      } catch (err: any) {
        if (!expectedRevision && (err?.code === "file_not_found" || err?.status === 404)) {
          const res = await workspace.createFile(context, companyId, projectId, filePath, content ?? "");
          return reply.code(201).send(res);
        }
        throw err;
      }
    } catch (error) { return fail(reply, error); }
  });

  app.delete<{ Params: Params; Querystring: { path?: string }; Body?: { path?: string } }>("/companies/:companyId/projects/:projectId/files", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const filePath = request.query?.path || (request.body as any)?.path;
      if (!filePath || typeof filePath !== "string") {
        return reply.code(400).send({ error: { code: "invalid_path", message: "File path is required" } });
      }
      await workspace.deleteFile(context, companyId, projectId, filePath);
      return reply.code(204).send();
    } catch (error) { return fail(reply, error); }
  });

  // Website Builder asset upload (backward-compatible and MinIO-backed)
  app.post<{ Params: Params; Body: { name: string; base64Data: string; targetDir?: string; mimeType?: string } }>("/companies/:companyId/projects/:projectId/files/upload", async (request, reply) => {
    try {
      const context = await authorize(auth, request);
      const { companyId, projectId } = request.params;
      const { name, base64Data, targetDir = "assets", mimeType } = request.body || {};
      if (!name || !base64Data) {
        return reply.code(400).send({ error: { code: "invalid_upload", message: "Name and base64Data are required" } });
      }

      const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const data = Buffer.from(rawBase64, "base64");
      const cleanTargetDir = targetDir.replace(/^public\//, "").replace(/^\/+/, "");

      if (mediaService) {
        const item = await mediaService.uploadMedia(context, companyId, projectId, {
          name,
          data,
          mimeType,
          targetDir: cleanTargetDir,
          workspaceSync: true,
        });
        const workspacePath = `public/${item.path}`;
        return reply.code(201).send({ path: workspacePath, url: item.url, name: item.name, size: item.size, mimeType: item.mimeType });
      }

      // Fallback if media service is not wired
      const cleanName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `public/${cleanTargetDir}/${cleanName}`;
      const content = data.toString("binary");
      try {
        const existing = await workspace.readFile(context, companyId, projectId, filePath);
        await workspace.writeFile(context, companyId, projectId, filePath, content, existing.revision);
      } catch {
        await workspace.createFile(context, companyId, projectId, filePath, content);
      }
      const publicUrl = `/${cleanTargetDir}/${cleanName}`;
      return reply.code(201).send({ path: filePath, url: publicUrl, name: cleanName });
    } catch (error) { return fail(reply, error); }
  });

  // Dedicated Project Media Endpoints (Stage 4)
  if (mediaService) {
    app.post<{ Params: Params; Body: { name: string; base64Data: string; mimeType?: string; targetDir?: string } }>("/companies/:companyId/projects/:projectId/media/upload", async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const context = await authorize(auth, request, companyId, projectId, projectService);
        const { name, base64Data, mimeType, targetDir } = request.body || {};
        if (!name || !base64Data) {
          return reply.code(400).send({ error: { code: "invalid_upload", message: "Name and base64Data are required" } });
        }
        const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
        const data = Buffer.from(rawBase64, "base64");
        const item = await mediaService.uploadMedia(context, companyId, projectId, {
          name,
          data,
          mimeType,
          targetDir,
          workspaceSync: true,
        });
        return reply.code(201).send({ item });
      } catch (error) { return fail(reply, error); }
    });

    app.get<{ Params: Params; Querystring: { prefix?: string } }>("/companies/:companyId/projects/:projectId/media", async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const context = await authorize(auth, request, companyId, projectId, projectService);
        const list = await mediaService.listMedia(companyId, projectId, request.query?.prefix);
        return reply.code(200).send(list);
      } catch (error) { return fail(reply, error); }
    });

    app.delete<{ Params: Params; Querystring: { path: string } }>("/companies/:companyId/projects/:projectId/media", async (request, reply) => {
      try {
        const { companyId, projectId } = request.params;
        const context = await authorize(auth, request, companyId, projectId, projectService);
        const mediaPath = request.query?.path;
        if (!mediaPath || typeof mediaPath !== "string") {
          return reply.code(400).send({ error: { code: "invalid_path", message: "Media path query parameter is required" } });
        }
        const result = await mediaService.deleteMedia(context, companyId, projectId, mediaPath);
        return reply.code(200).send(result);
      } catch (error) { return fail(reply, error); }
    });

    /**
     * Project media for the signed-in owner (editor, agent tools). Security audit 2026-11-24, L7: this used to answer
     * anyone who knew a project id, drafts included. Generated sites never depend on it: uploads are mirrored into the
     * project's own `public/` directory, which the Preview and the published site serve themselves. The caller now needs
     * the Authorization header (or a stream ticket for elements that cannot send it) and access to the project.
     */
    const handleMediaStream = async (request: FastifyRequest<{ Params: { projectId: string; "*": string } }>, reply: FastifyReply) => {
      try {
        const { projectId } = request.params;
        const relativePath = request.params["*"];
        try { await auth.authenticate(request); }
        catch (error) {
          const status = Number((error as { status?: number }).status) || 401;
          return reply.code(status).send({ error: { code: (error as { code?: string }).code ?? "UNAUTHORIZED", message: "Sign in to open project media" } });
        }
        if (!relativePath) {
          return reply.code(400).send({ error: { code: "invalid_path", message: "Media path is required" } });
        }
        // The id names a directory below; nothing but an id-shaped value may reach the filesystem lookup.
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
          return reply.code(404).send({ error: { code: "project_not_found", message: "Project not found" } });
        }
        if (!projectService) {
          return reply.code(503).send({ error: { code: "project_state_unavailable", message: "Project access cannot be verified" } });
        }

        let companyId: string | undefined;

        // 1. Try resolving via workspace root directory on disk
        try {
          const workspaceRoot = (workspace as unknown as { root?: unknown }).root;
          if (workspaceRoot && typeof workspaceRoot === "string") {
            const companyDirs = await fs.readdir(workspaceRoot);
            for (const cDir of companyDirs) {
              const projectDir = path.join(workspaceRoot, cDir, projectId);
              try {
                const stat = await fs.stat(projectDir);
                if (stat.isDirectory()) {
                  companyId = cDir;
                  break;
                }
              } catch {
                // not in this company
              }
            }
          }
        } catch {
          // ignore
        }

        let projectStatus: string | undefined;
        // 2. Try resolving via Postgres DB query if available
        if (!companyId) {
          const pool = (projectService as unknown as { store?: { pool?: Pick<import("pg").Pool, "query"> } })?.store?.pool;
          if (pool && typeof pool.query === "function") {
            try {
              const res = await pool.query('SELECT company_id AS "companyId", status FROM projects WHERE id = $1', [projectId]);
              if (res.rows[0]?.companyId) {
                companyId = res.rows[0].companyId;
                projectStatus = res.rows[0].status;
              }
            } catch {
              // ignore
            }
          }
        }

        // 3. Try resolving via in-memory store if available
        if (!companyId) {
          const store = (projectService as unknown as { store?: { projects?: unknown } })?.store;
          if (store?.projects instanceof Map) {
            const proj: unknown = store.projects.get(projectId);
            if (proj && typeof proj === "object" && "companyId" in proj && typeof proj.companyId === "string") {
              companyId = proj.companyId;
              projectStatus = "status" in proj && typeof proj.status === "string" ? proj.status : undefined;
            }
          }
        }

        // 4. Try authenticated context fallback
        if (!companyId) {
          try {
            const ctx = await auth.authenticate(request);
            if (ctx.companyId) {
              companyId = ctx.companyId;
              if (projectService) {
                const p = await projectService.get(ctx, companyId, projectId).catch(() => null);
                if (p) projectStatus = p.status;
              }
            }
          } catch {
            // ignore
          }
        }

        if (!companyId) {
          return reply.code(404).send({ error: { code: "project_not_found", message: "Project not found" } });
        }

        // A retained directory proves file location, never project visibility.
        const stateStore = (projectService as unknown as { store?: Pick<WorkspaceStore, "getProjectForSystem"> } | undefined)?.store;
        if (stateStore?.getProjectForSystem) {
          try {
            const project = await stateStore.getProjectForSystem(companyId, projectId);
            if (!project) return reply.code(404).send({ error: { code: "project_not_found", message: "Project not found" } });
            projectStatus = project.status;
          } catch {
            return reply.code(503).send({ error: { code: "project_state_unavailable", message: "Project visibility cannot be verified" } });
          }
        }
        if (!projectStatus) {
          return reply.code(503).send({ error: { code: "project_state_unavailable", message: "Project visibility cannot be verified" } });
        }

        // Immediate Access Denial if project is soft-deleted, purging or deleted
        if (projectStatus === "soft_deleted" || projectStatus === "purging" || projectStatus === "deleted") {
          return reply.code(404).send({ error: { code: "project_deleted", message: "Project media is unavailable because the project is deleted" } });
        }
        // L7: the caller must be allowed to read this very project (workspace, company and project scope).
        try { await authorize(auth, request, companyId, projectId, projectService); }
        catch { return reply.code(404).send({ error: { code: "project_not_found", message: "Project not found" } }); }

        const { stream, mimeType } = await mediaService.getMedia(companyId, projectId, relativePath);
        const res = reply
          .header("Content-Type", mimeType)
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff");

        if (mimeType === "image/svg+xml") {
          res
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
            .header("Content-Disposition", "inline");
        }

        return res.send(stream);
      } catch (error) { return fail(reply, error); }
    };

    app.get<{ Params: { projectId: string; "*": string } }>("/api/projects/:projectId/media/*", handleMediaStream);
    app.get<{ Params: { projectId: string; "*": string } }>("/projects/:projectId/media/*", handleMediaStream);
  }
}
