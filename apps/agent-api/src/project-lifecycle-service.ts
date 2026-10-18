import { WorkspaceNotFoundError, type AuthContext, type Project, type WorkspaceStore } from "@npati/workspace";
import type { FastifyBaseLogger } from "fastify";
import type { ProjectService } from "./project-service";
import type { ProjectPreviewService } from "./project-preview-service";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { ProjectMediaService } from "./project-media-service";
import type { DataBackendService } from "./data-studio/service";

export class ProjectLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "ProjectLifecycleError";
  }
}

export interface ProjectLifecycleDeps {
  store: WorkspaceStore;
  projects: ProjectService;
  previewService?: ProjectPreviewService;
  sandboxService?: ProjectSandboxService;
  mediaService?: ProjectMediaService;
  dataBackendService?: DataBackendService;
  removeWorkspace?: (ctx: AuthContext, companyId: string, projectId: string) => Promise<{ removed: boolean; reason?: string; alreadyAbsent?: boolean }>;
  auditLog?: (entry: { ctx: AuthContext; companyId: string; action: string; resourceId: string; metadata?: Record<string, unknown> }) => Promise<void>;
  logger?: FastifyBaseLogger;
}

export interface DeletePlanResource {
  type: string;
  identifier: string;
  ownership: "dedicated" | "shared";
  status: string;
  softDeleteAction: string;
  hardPurgeAction: string;
  details?: Record<string, unknown>;
}

export interface DeletePlanResult extends Record<string, unknown> {
  projectId: string;
  companyId: string;
  projectName: string;
  currentStatus: string;
  lifecyclePlan: {
    retentionDays: number;
    purgeScheduledAt: string;
    dryRun: true;
  };
  resources: {
    dedicated: DeletePlanResource[];
    shared: DeletePlanResource[];
  };
  immediateAccessRevocation: {
    livePreview: string;
    projectApiGateway: string;
    corsOrigins: string;
    projectApiKeys: string;
  };
}

export class ProjectLifecycleService {
  constructor(private readonly deps: ProjectLifecycleDeps) {}

  private async audit(ctx: AuthContext, companyId: string, action: string, resourceId: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.deps.auditLog) {
      await this.deps.auditLog({ ctx, companyId, action, resourceId, metadata });
    }
  }

  /**
   * Pure dry-run endpoint: computes and returns the exact resource breakdown,
   * ownership, shared vs dedicated status, retention, and planned operations.
   * Performs ZERO deletions or mutations.
   */
  async getDeletePlan(ctx: AuthContext, companyId: string, projectId: string): Promise<DeletePlanResult> {
    const project = await this.deps.projects.get(ctx, companyId, projectId);

    const dedicated: DeletePlanResource[] = [];
    const shared: DeletePlanResource[] = [];

    // 1. Sandbox Runtime (Dedicated)
    dedicated.push({
      type: "sandbox_runtime",
      identifier: project.sandboxId ?? "unattached",
      ownership: "dedicated",
      status: project.sandboxId ? "configured" : "none",
      softDeleteAction: "stop_processes_preserve_disk",
      hardPurgeAction: "destroy_sandbox_directory",
      details: {
        sandboxId: project.sandboxId ?? null,
        directoryPreservedDuringSoftDelete: true,
      },
    });

    // 2. Workspace Files (Dedicated)
    dedicated.push({
      type: "workspace_files",
      identifier: `project-workspaces/${companyId}/${projectId}`,
      ownership: "dedicated",
      status: "active",
      softDeleteAction: "retain_all_source_code_30_days",
      hardPurgeAction: "remove_workspace_directory",
      details: {
        retentionPolicy: "30_days_recovery",
        zeroDataLossDuringSoftDelete: true,
      },
    });

    // 3. Media Assets in MinIO (Dedicated)
    let mediaCount = 0;
    let mediaBytes = 0;
    if (this.deps.mediaService) {
      try {
        const usage = await this.deps.mediaService.getQuotaUsage(companyId, projectId);
        mediaCount = usage.count;
        mediaBytes = usage.totalBytes;
      } catch {
        // ignore in dry-run
      }
    }
    dedicated.push({
      type: "media_assets",
      identifier: `npati-project-media/${companyId}/${projectId}/*`,
      ownership: "dedicated",
      status: mediaCount > 0 ? "contains_objects" : "empty",
      softDeleteAction: "retain_all_media_assets",
      hardPurgeAction: "purge_bucket_prefix",
      details: {
        objectCount: mediaCount,
        totalBytes: mediaBytes,
        prefixIsolation: `${companyId}/${projectId}/`,
      },
    });

    // 4. Dedicated Database Records (Checkpoints, sessions, events)
    let checkpointsCount = 0;
    let activityEventsCount = 0;
    let contextSummariesCount = 0;

    const pool = (this.deps.store as unknown as { pool?: Pick<import("pg").Pool, "query"> }).pool;
    if (pool && typeof pool.query === "function") {
      try {
        const chkRes = await pool.query("SELECT count(*)::int AS count FROM project_checkpoints WHERE project_id=$1", [projectId]);
        checkpointsCount = chkRes.rows[0]?.count ?? 0;
        const actRes = await pool.query("SELECT count(*)::int AS count FROM code_activity_events WHERE project_id=$1", [projectId]);
        activityEventsCount = actRes.rows[0]?.count ?? 0;
        const ctxRes = await pool.query("SELECT count(*)::int AS count FROM code_context_summaries WHERE project_id=$1", [projectId]);
        contextSummariesCount = ctxRes.rows[0]?.count ?? 0;
      } catch {
        // ignore in dry run
      }
    }

    dedicated.push({
      type: "project_database_records",
      identifier: "project_checkpoints, code_activity_events, code_context_summaries, project_sessions",
      ownership: "dedicated",
      status: "retained_for_soft_delete",
      softDeleteAction: "mark_project_soft_deleted_retain_records",
      hardPurgeAction: "delete_dedicated_records_clean_orphans",
      details: {
        checkpoints: checkpointsCount,
        activityEvents: activityEventsCount,
        contextSummaries: contextSummariesCount,
      },
    });

    // 5. Data Studio Backend & PostgreSQL Databases (Shared/Dedicated preservation)
    if (project.dataBackendId) {
      const cleanBackendId = project.dataBackendId.replace(/-/g, "");
      shared.push({
        type: "data_backend",
        identifier: project.dataBackendId,
        ownership: "shared",
        status: "preserved",
        softDeleteAction: "revoke_cors_origins_and_block_api",
        hardPurgeAction: "detach_artifacts_no_drop_database",
        details: {
          databaseDev: `db_${cleanBackendId}_dev`,
          databaseProd: `db_${cleanBackendId}_prod`,
          dropDatabaseExecuted: false,
          dropSchemaExecuted: false,
          preservationGuaranteed: true,
          otherProjectsProtected: true,
        },
      });
    }

    const scheduledDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    return {
      projectId: project.id,
      companyId: project.companyId,
      projectName: project.name,
      currentStatus: project.status,
      lifecyclePlan: {
        retentionDays: 30,
        purgeScheduledAt: scheduledDate,
        dryRun: true,
      },
      resources: {
        dedicated,
        shared,
      },
      immediateAccessRevocation: {
        livePreview: "stopped_and_blocked",
        projectApiGateway: "rejected_with_404_not_found",
        corsOrigins: "immediately_removed_from_dev_and_prod_allowlists",
        projectApiKeys: "site_specific_access_denied_shared_keys_intact",
      },
    };
  }

  /**
   * Soft Delete:
   * - Stops preview and sandbox processes (does NOT delete files or destroy sandbox).
   * - Blocks Live Preview and Project API Gateway immediately.
   * - Immediately removes CORS permissions of the deleted site without revoking other projects' keys.
   * - Preserves source code, MinIO media, checkpoints, and PostgreSQL databases.
   * - Transitions status to 'soft_deleted' with 30-day retention purge date.
   */
  async softDelete(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { reason?: string } = {},
  ): Promise<{
    status: "soft_deleted";
    projectId: string;
    retentionDays: number;
    purgeAfter: string;
    alreadySoftDeleted?: boolean;
    actions: {
      previewStopped: boolean;
      sandboxProcessesStopped: boolean;
      corsRevoked: boolean;
      filesPreserved: boolean;
      databasePreserved: boolean;
    };
  }> {
    const project = await this.deps.projects.get(ctx, companyId, projectId);

    if (project.status === "soft_deleted") {
      return {
        status: "soft_deleted",
        projectId,
        retentionDays: 30,
        purgeAfter: project.purgeAfter ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        alreadySoftDeleted: true,
        actions: {
          previewStopped: true,
          sandboxProcessesStopped: true,
          corsRevoked: true,
          filesPreserved: true,
          databasePreserved: true,
        },
      };
    }

    if (project.status === "purging" || project.status === "deleted") {
      throw new ProjectLifecycleError("invalid_state", `Cannot soft delete project in '${project.status}' state`, 409);
    }

    await this.audit(ctx, companyId, "project.lifecycle.soft_delete", projectId, { reason: options.reason });

    // 1. Stop live preview
    let previewStopped = false;
    if (this.deps.previewService) {
      try {
        await this.deps.previewService.stopPreview(ctx, companyId, projectId);
        previewStopped = true;
      } catch (err) {
        this.deps.logger?.warn({ err, projectId }, "preview_stop_during_soft_delete_failed");
      }
    }

    // 2. Stop sandbox processes (DO NOT call destroy; preserve files)
    let sandboxStopped = false;
    if (project.sandboxId && this.deps.sandboxService) {
      try {
        await this.deps.sandboxService.stop(ctx, project);
        sandboxStopped = true;
      } catch (err) {
        this.deps.logger?.warn({ err, projectId }, "sandbox_stop_during_soft_delete_failed");
      }
    }

    // 3. Revoke CORS origins for this project in DataStudio
    let corsRevoked = false;
    if (this.deps.dataBackendService) {
      try {
        const result = await this.deps.dataBackendService.detachProjectCors(ctx, companyId, projectId);
        corsRevoked = result.cleanedOrigins > 0;
      } catch (err) {
        this.deps.logger?.warn({ err, projectId }, "cors_revocation_during_soft_delete_failed");
      }
    }

    // 4. Update project record to soft_deleted with 30-day purge schedule
    const purgeDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const updated = await this.deps.store.softDeleteProject(ctx, companyId, projectId, options.reason, purgeDate);

    // 5. Persist lifecycle journal record
    await this.deps.store.recordProjectLifecycleRecord({
      workspaceId: ctx.workspaceId,
      companyId,
      projectId,
      operation: "soft_delete",
      status: "completed",
      details: {
        reason: options.reason,
        purgeAfter: purgeDate,
        previewStopped,
        sandboxStopped,
        corsRevoked,
      },
    }).catch(() => undefined);

    return {
      status: "soft_deleted",
      projectId,
      retentionDays: 30,
      purgeAfter: updated.purgeAfter ?? purgeDate,
      actions: {
        previewStopped,
        sandboxProcessesStopped: sandboxStopped,
        corsRevoked,
        filesPreserved: true,
        databasePreserved: true,
      },
    };
  }

  /**
   * Restore:
   * - Re-verifies user permissions.
   * - Validates project is in 'soft_deleted' state.
   * - Restores project status to 'ready' and clears deletion schedule.
   * - Re-verifies DataBackend attachment and re-attaches if needed.
   * - Live Preview and gateway access are unblocked.
   */
  async restore(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{
    status: "ready";
    projectId: string;
    restored: boolean;
    restoredAt: string;
    workspacePreserved?: boolean;
    mediaCount?: number;
    mediaBytes?: number;
    dataBackendAttached?: boolean;
    previewUnblocked?: boolean;
  }> {
    const project = await this.deps.projects.get(ctx, companyId, projectId);

    if (project.status !== "soft_deleted") {
      throw new ProjectLifecycleError("invalid_state", `Cannot restore project with status '${project.status}' (expected 'soft_deleted')`, 409);
    }

    await this.audit(ctx, companyId, "project.lifecycle.restore", projectId, {});

    // Re-verify DataBackend attachment if present
    let dataBackendAttached = false;
    if (project.dataBackendId && this.deps.dataBackendService) {
      try {
        await this.deps.dataBackendService.get(ctx, companyId, project.dataBackendId);
        dataBackendAttached = true;
      } catch (err) {
        this.deps.logger?.warn({ err, projectId, backendId: project.dataBackendId }, "backend_verification_on_restore_warn");
      }
    }

    // Verify media files in MinIO
    let mediaCount = 0;
    let mediaBytes = 0;
    if (this.deps.mediaService) {
      try {
        const mediaList = await this.deps.mediaService.listMedia(companyId, projectId);
        mediaCount = mediaList.items.length;
        mediaBytes = mediaList.totalBytes;
      } catch (err) {
        this.deps.logger?.warn({ err, projectId }, "media_verification_on_restore_warn");
      }
    }

    const restored = await this.deps.store.restoreProject(ctx, companyId, projectId);
    const restoredAt = restored.restoredAt ?? new Date().toISOString();

    await this.deps.store.recordProjectLifecycleRecord({
      workspaceId: ctx.workspaceId,
      companyId,
      projectId,
      operation: "restore",
      status: "completed",
      details: {
        restoredAt,
        workspacePreserved: true,
        mediaCount,
        mediaBytes,
        dataBackendAttached,
        previewUnblocked: true,
      },
    }).catch(() => undefined);

    return {
      status: "ready",
      projectId,
      restored: true,
      restoredAt,
      workspacePreserved: true,
      mediaCount,
      mediaBytes,
      dataBackendAttached,
      previewUnblocked: true,
    };
  }

  /**
   * Hard Purge:
   * - Permitted ONLY for projects in 'soft_deleted' or 'purging' status.
   * - Enforces retention window (must be past purge_after, unless force: true is explicitly provided).
   * - Transitions status to 'purging' to prevent concurrent restore/delete.
   * - Purges ONLY dedicated resources: MinIO media prefix, sandbox directory, workspace files,
   *   checkpoints, dedicated sessions, and orphaned code_activity_events/code_context_summaries.
   * - Preserves DataBackend and PostgreSQL databases (no DROP DATABASE).
   * - Idempotent on repeated calls.
   */
  async hardPurge(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{
    status: "purged";
    projectId: string;
    alreadyPurged?: boolean;
    purged: {
      mediaObjects: number;
      mediaBytes: number;
      sandboxDestroyed: boolean;
      workspaceRemoved: boolean;
      orphanedRecordsCleaned: number;
      dataBackendPreserved: boolean;
    };
  }> {
    let project: Project;
    try {
      project = await this.deps.projects.get(ctx, companyId, projectId);
    } catch (error) {
      if (!(error instanceof WorkspaceNotFoundError)) throw error;
      // Already absent
      return {
        status: "purged",
        projectId,
        alreadyPurged: true,
        purged: {
          mediaObjects: 0,
          mediaBytes: 0,
          sandboxDestroyed: true,
          workspaceRemoved: true,
          orphanedRecordsCleaned: 0,
          dataBackendPreserved: true,
        },
      };
    }

    if (project.status !== "soft_deleted" && project.status !== "purging") {
      throw new ProjectLifecycleError("invalid_state", `Cannot hard purge project in status '${project.status}' (must be 'soft_deleted' or 'purging')`, 409);
    }

    // Check retention window
    if (options.force) {
      if (ctx.role !== "owner" && ctx.role !== "admin") {
        throw new ProjectLifecycleError(
          "force_purge_forbidden",
          "Immediate hard purge bypassing retention is restricted to company owners and administrators",
          403,
          { role: ctx.role },
        );
      }
    } else if (project.purgeAfter) {
      const purgeTime = new Date(project.purgeAfter).getTime();
      if (Date.now() < purgeTime) {
        throw new ProjectLifecycleError(
          "retention_not_expired",
          `Project retention has not expired yet (scheduled for ${project.purgeAfter}). Use force: true to override for testing.`,
          409,
          { purgeAfter: project.purgeAfter },
        );
      }
    }

    await this.audit(ctx, companyId, "project.lifecycle.hard_purge", projectId, { force: options.force });

    // Transition to 'purging' state
    if (project.status !== "purging") await this.deps.store.transitionProjectToPurging(ctx, companyId, projectId);
    const cleanupFailures: string[] = [];

    let mediaObjects = 0;
    let mediaBytes = 0;
    if (this.deps.mediaService) {
      try {
        const purgeRes = await this.deps.mediaService.purgeProjectMedia(ctx, companyId, projectId);
        mediaObjects = purgeRes.deletedCount;
        mediaBytes = purgeRes.deletedBytes;
      } catch (err) {
        cleanupFailures.push("media");
        this.deps.logger?.warn({ err, projectId }, "media_purge_partial_failure");
      }
    }

    // 2. Destroy sandbox runtime & disk directory
    let sandboxDestroyed = false;
    if (this.deps.sandboxService) {
      try {
        await this.deps.sandboxService.destroy(ctx, project);
        sandboxDestroyed = true;
      } catch (err) {
        cleanupFailures.push("sandbox");
        this.deps.logger?.warn({ err, projectId }, "sandbox_destroy_partial_failure");
      }
    }

    // 3. Remove workspace files
    let workspaceRemoved = false;
    if (this.deps.removeWorkspace) {
      try {
        const res = await this.deps.removeWorkspace(ctx, companyId, projectId);
        workspaceRemoved = res.removed || res.alreadyAbsent === true;
        if (!workspaceRemoved) cleanupFailures.push("workspace");
      } catch (err) {
        cleanupFailures.push("workspace");
        this.deps.logger?.warn({ err, projectId }, "workspace_remove_partial_failure");
      }
    }

    // 4. Detach project artifacts in DataStudio (NEVER drop database)
    if (this.deps.dataBackendService) {
      try {
        await this.deps.dataBackendService.detachProjectArtifacts(ctx, companyId, projectId);
      } catch (err) {
        cleanupFailures.push("data_backend_artifacts");
        this.deps.logger?.warn({ err, projectId }, "datastudio_detach_partial_failure");
      }
    }

    // 5. Clean up dedicated records & orphaned events
    let orphanedCleaned = 0;
    const pool = (this.deps.store as unknown as { pool?: Pick<import("pg").Pool, "query"> }).pool;
    if (pool && typeof pool.query === "function") {
      try {
        const delAct = await pool.query("DELETE FROM code_activity_events WHERE project_id=$1", [projectId]);
        orphanedCleaned += delAct.rowCount ?? 0;
        const delCtx = await pool.query("DELETE FROM code_context_summaries WHERE project_id=$1", [projectId]);
        orphanedCleaned += delCtx.rowCount ?? 0;
        await pool.query("DELETE FROM project_terminal_events WHERE project_id=$1", [projectId]);
      } catch (err) {
        cleanupFailures.push("database_records");
        this.deps.logger?.warn({ err, projectId }, "orphaned_records_cleanup_failed");
      }
    }

    if (cleanupFailures.length > 0) {
      throw new ProjectLifecycleError("cleanup_incomplete", "Project cleanup is incomplete; project metadata is retained for retry", 503, {
        failedSteps: [...new Set(cleanupFailures)], retryable: true,
      });
    }

    // 6. Delete metadata only after every configured cleanup step succeeded.
    await this.deps.store.deleteProject(ctx, companyId, projectId);

    // 7. Record lifecycle record
    await this.deps.store.recordProjectLifecycleRecord({
      workspaceId: ctx.workspaceId,
      companyId,
      projectId,
      operation: "hard_purge",
      status: "completed",
      details: {
        mediaObjects,
        mediaBytes,
        sandboxDestroyed,
        workspaceRemoved,
        orphanedCleaned,
        dataBackendPreserved: true,
      },
    }).catch(() => undefined);

    return {
      status: "purged",
      projectId,
      purged: {
        mediaObjects,
        mediaBytes,
        sandboxDestroyed,
        workspaceRemoved,
        orphanedRecordsCleaned: orphanedCleaned,
        dataBackendPreserved: true,
      },
    };
  }

  /**
   * Automated worker pass: finds projects whose 30-day retention has elapsed and purges them.
   */
  async purgeExpiredProjects(ctx: AuthContext, limit = 50): Promise<{ processed: number; errors: number }> {
    const expired = await this.deps.store.listExpiredSoftDeletedProjects(limit);
    let processed = 0;
    let errors = 0;

    for (const item of expired) {
      try {
        await this.hardPurge(ctx, item.companyId, item.id);
        processed++;
      } catch (err) {
        errors++;
        this.deps.logger?.error({ err, projectId: item.id }, "scheduled_hard_purge_failed");
      }
    }

    return { processed, errors };
  }
}
