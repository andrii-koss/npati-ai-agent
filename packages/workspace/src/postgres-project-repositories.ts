import { Pool } from "pg";
import { assertCompany, getProject } from "./postgres-store-support";
import { randomUUID } from "node:crypto";
import type { ApplyCodeRunStateEventInput, AuthContext, CodeActivityEventRecord, CodeContextSummaryRecord, CodeRunRequestRecord, CodeRunScanPage, CodeRunStateRecord, CodeRunStateScanInput, CodeRunTurnRecord, CodeRunTurnScanInput, CreateCheckpointInput, CreateCodeActivityEventInput, CreateCodeContextSummaryInput, CreateCodeRunStateInput, CreateDeploymentInput, CreateProjectQaReportInput, DataClassification, ListCodeActivityEventsInput, ListCodeContextSummariesInput, ListCodeRunStatesInput, Project, ProjectCheckpoint, ProjectCodeSettings, ProjectCodeTrust, ProjectDeployment, ProjectInput, ProjectMountedFolder, ProjectQaReport, RetentionClass } from "./types";
import { CodeRunStateStoreError, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, WorkspaceNotFoundError, clampScanLimit, codeRunRequestStatus, decodeCodeActivityCursor, decodeCodeRunScanCursor, encodeCodeRunScanCursor } from "./types";
import { codeActivityEventColumns, codeContextSummaryColumns, codeRunStateColumns, codeRunTurnColumns, projectCheckpointColumns, projectCodeTrustColumns, projectColumns, projectDeploymentColumns, projectMountedFolderColumns, projectQaReportColumns } from "./postgres-store-schema";
import { mapCodeActivityEventRow, mapCodeContextSummaryRow } from "./postgres-store-support";
import { assertProjectAgent } from "./postgres-company-repositories";
import { codeChildSessionId } from "./code-child-session-id";
import type { CodeProjectRefScanInput, CodeProjectRefScanPage, CodeSession, CodeSessionInput, CodeSessionMode, CodeSessionStatus } from "./types";
import { WorkspaceAccessError, isClassificationAtLeast } from "./types";
import { codeSessionColumns } from "./postgres-store-schema";

export async function createProject(pool: Pool, context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    await assertCompany(pool, context, companyId);
    const created = await pool.query<Project>(`INSERT INTO projects
      (id,workspace_id,company_id,created_by,name,description,type,create_request_key,data_backend_id,app_scheme,
       data_classification,retention_class,default_branch,toolchain)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (workspace_id,company_id,created_by,create_request_key) DO NOTHING
      RETURNING ${projectColumns}`,
      [randomUUID(), context.workspaceId, companyId, context.userId, input.name, input.description ?? null, input.type, idempotencyKey,
        input.dataBackendId ?? null, input.appScheme ?? null,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION, input.retentionClass ?? DEFAULT_RETENTION_CLASS,
        input.defaultBranch ?? null, input.toolchain ? JSON.stringify(input.toolchain) : null]);
    if (created.rows[0]) return { project: created.rows[0], created: true };
    const existing = await pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 AND create_request_key=$4`,
      [context.workspaceId,companyId,context.userId,idempotencyKey]);
    if (!existing.rows[0]) throw new WorkspaceNotFoundError("Project not found");
    return { project: existing.rows[0], created: false };
  }

export async function listProjects(pool: Pool, context: AuthContext, companyId: string, includeArchived = false) {
    await assertCompany(pool, context, companyId);
    const result = await pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 AND ($4 OR status<>'archived')
      ORDER BY updated_at DESC,id`, [context.workspaceId,companyId,context.userId,includeArchived]);
    return result.rows;
  }

export async function updateProject(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    const current = await getProject(pool, context, companyId, projectId);
    const name = input.name === undefined ? current.name : input.name;
    const code = input.code ?? {};
    const result = await pool.query<Project>(`UPDATE projects
      SET name=$5,
          toolchain=COALESCE($7, toolchain),
          default_branch=COALESCE($8, default_branch),
          data_classification=COALESCE($9, data_classification),
          retention_class=COALESCE($10, retention_class),
          revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId, context.workspaceId, companyId, context.userId, name, input.expectedRevision,
        code.toolchain ? JSON.stringify(code.toolchain) : null, code.defaultBranch ?? null,
        code.dataClassification ?? null, code.retentionClass ?? null]);
    if (!result.rows[0]) throw new Error("Project changed by another request or is archived");
    return result.rows[0];
  }

export async function setProjectSandbox(pool: Pool, context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<Project>(`UPDATE projects
      SET sandbox_id=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND sandbox_id IS NOT DISTINCT FROM $6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,sandboxId,expectedSandboxId]);
    if (!result.rows[0]) throw new Error("Project sandbox changed by another request or is archived");
    return result.rows[0];
  }

export async function archiveProject(pool: Pool, context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<Project>(`UPDATE projects
      SET status='archived',revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$5 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,expectedRevision]);
    if (!result.rows[0]) throw new Error("Project changed by another request or is archived");
    return result.rows[0];
  }

export async function deleteProject(pool: Pool, context: AuthContext, companyId: string, projectId: string) {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query(`DELETE FROM projects
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`,
      [projectId,context.workspaceId,companyId,context.userId]);
    return Boolean(result.rowCount);
  }

export async function getProjectCodeTrust(pool: Pool, context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    const result = await pool.query<ProjectCodeTrust>(`SELECT ${projectCodeTrustColumns} FROM project_code_trust
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3`,
      [context.workspaceId, companyId, projectId]);
    return result.rows[0] ?? null;
  }

export async function getProjectMountedFolder(pool: Pool, context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    const result = await pool.query<ProjectMountedFolder>(`SELECT ${projectMountedFolderColumns} FROM project_mounted_folders
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3`,
      [context.workspaceId, companyId, projectId]);
    return result.rows[0] ?? null;
  }

export async function getProjectMountedFolderForSystem(pool: Pool, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    const result = await pool.query<ProjectMountedFolder>(`SELECT ${projectMountedFolderColumns} FROM project_mounted_folders
      WHERE company_id=$1 AND project_id=$2`,
      [companyId, projectId]);
    return result.rows[0] ?? null;
  }

export async function createProjectCheckpoint(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    await getProject(pool, context, companyId, projectId);
    const id = `chk_${randomUUID()}`;
    const result = await pool.query<ProjectCheckpoint>(`INSERT INTO project_checkpoints
      (id, workspace_id, company_id, project_id, user_id, name, description, commit_hash, trigger, run_id, file_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING ${projectCheckpointColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.name.trim(), input.description ?? null, input.commitHash ?? null, input.trigger, input.runId ?? null, input.fileCount ?? 0]);
    return result.rows[0]!;
  }

export async function listProjectCheckpoints(pool: Pool, context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> {
    await getProject(pool, context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await pool.query<ProjectCheckpoint>(`SELECT ${projectCheckpointColumns} FROM project_checkpoints
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

export async function getProjectCheckpoint(pool: Pool, context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<ProjectCheckpoint>(`SELECT ${projectCheckpointColumns} FROM project_checkpoints
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [checkpointId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) throw new WorkspaceNotFoundError("Project checkpoint not found");
    return result.rows[0]!;
  }

export async function deleteProjectCheckpoint(pool: Pool, context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query(`DELETE FROM project_checkpoints
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [checkpointId, context.workspaceId, companyId, projectId]);
    return Boolean(result.rowCount);
  }

export async function createProjectDeployment(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    await getProject(pool, context, companyId, projectId);
    const id = `dep_${randomUUID()}`;
    const result = await pool.query<ProjectDeployment>(`INSERT INTO project_deployments
      (id, workspace_id, company_id, project_id, user_id, provider, environment, branch, commit_hash, status, target_url, external_deployment_id, preflight_summary, error_message, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING ${projectDeploymentColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.provider, input.environment ?? "production", input.branch ?? "project/main", input.commitHash ?? null, input.status ?? "queued", input.targetUrl ?? null, input.externalDeploymentId ?? null, input.preflightSummary ? JSON.stringify(input.preflightSummary) : null, input.errorMessage ?? null, input.runId ?? null]);
    return result.rows[0]!;
  }

export async function listProjectDeployments(pool: Pool, context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> {
    await getProject(pool, context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await pool.query<ProjectDeployment>(`SELECT ${projectDeploymentColumns} FROM project_deployments
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

export async function getProjectDeployment(pool: Pool, context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<ProjectDeployment>(`SELECT ${projectDeploymentColumns} FROM project_deployments
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [deploymentId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) return null;
    return result.rows[0]!;
  }

export async function updateProjectDeployment(pool: Pool, context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    await getProject(pool, context, companyId, projectId);
    const current = await getProjectDeployment(pool, context, companyId, projectId, deploymentId);
    if (!current) throw new WorkspaceNotFoundError("Project deployment not found");
    const status = patch.status ?? current.status;
    const targetUrl = patch.targetUrl !== undefined ? patch.targetUrl : (current.targetUrl ?? null);
    const externalDeploymentId = patch.externalDeploymentId !== undefined ? patch.externalDeploymentId : (current.externalDeploymentId ?? null);
    const preflightSummary = patch.preflightSummary !== undefined ? JSON.stringify(patch.preflightSummary) : (current.preflightSummary ? JSON.stringify(current.preflightSummary) : null);
    const errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : (current.errorMessage ?? null);
    const result = await pool.query<ProjectDeployment>(`UPDATE project_deployments
      SET status=$5, target_url=$6, external_deployment_id=$7, preflight_summary=$8, error_message=$9, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4
      RETURNING ${projectDeploymentColumns}`,
      [deploymentId, context.workspaceId, companyId, projectId, status, targetUrl, externalDeploymentId, preflightSummary, errorMessage]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Project deployment not found");
    return result.rows[0];
  }

export async function createProjectQaReport(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    await getProject(pool, context, companyId, projectId);
    const id = `qa_${randomUUID()}`;
    const result = await pool.query<ProjectQaReport>(`INSERT INTO project_qa_reports
      (id, workspace_id, company_id, project_id, user_id, status, target_url, summary, issues, metrics, screenshots, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING ${projectQaReportColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.status, input.targetUrl, input.summary, JSON.stringify(input.issues ?? []), JSON.stringify(input.metrics ?? {}), JSON.stringify(input.screenshots ?? []), input.runId ?? null]);
    return result.rows[0]!;
  }

export async function listProjectQaReports(pool: Pool, context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectQaReport[]> {
    await getProject(pool, context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await pool.query<ProjectQaReport>(`SELECT ${projectQaReportColumns} FROM project_qa_reports
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

export async function getProjectQaReport(pool: Pool, context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> {
    await getProject(pool, context, companyId, projectId);
    const result = await pool.query<ProjectQaReport>(`SELECT ${projectQaReportColumns} FROM project_qa_reports
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [reportId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) return null;
    return result.rows[0]!;
  }

export async function getProjectForSystem(pool: Pool, companyId: string, projectId: string): Promise<Project | null> {
    const result = await pool.query<Project>(
      `SELECT ${projectColumns} FROM projects WHERE id=$1 AND company_id=$2 LIMIT 1`,
      [projectId, companyId],
    );
    return result.rows[0] ?? null;
  }
export async function createCodeRunState(pool: Pool, input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const request = input.request ?? { status: "not_recorded" as const, text: null, sha256: null, truncated: false, recordedAt: null };
    await pool.query(
      `INSERT INTO code_run_states(
         run_id, workspace_id, company_id, project_id, session_id, status, turn_index, last_event_seq,
         lease_owner, lease_expires_at, heartbeat_at, started_at, updated_at, details,
         request_status, request_text, request_sha256, request_truncated, request_recorded_at,
         data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,'running',0,1,$6,$7,$8,$8,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        input.runId, input.workspaceId, input.companyId, input.projectId, input.sessionId,
        input.owner, expiresAt, input.now, JSON.stringify(input.details ?? {}),
        request.status, request.text, request.sha256, request.truncated, request.recordedAt,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      ],
    );
    const stored = await getCodeRunState(pool, input.companyId, input.runId);
    if (!stored) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "The run state could not be created", {
        httpStatus: 404, details: { runId: input.runId },
      });
    }
    return stored;
  }

export async function getCodeRunRequest(pool: Pool, companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    const result = await pool.query<{
      request_status: string; request_text: string | null; request_sha256: string | null;
      request_truncated: boolean; request_recorded_at: Date | null;
      data_classification: string; retention_class: string;
    }>(
      `SELECT request_status, request_text, request_sha256, request_truncated, request_recorded_at,
              data_classification, retention_class
         FROM code_run_states WHERE company_id=$1 AND run_id=$2`,
      [companyId, runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      runId,
      companyId,
      status: codeRunRequestStatus(row.request_status),
      text: row.request_text,
      sha256: row.request_sha256,
      truncated: row.request_truncated === true,
      recordedAt: row.request_recorded_at ? new Date(row.request_recorded_at) : null,
      dataClassification: row.data_classification as DataClassification,
      retentionClass: row.retention_class as RetentionClass,
    };
  }

export async function applyCodeRunStateEvent(pool: Pool, input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    const leasePredicate = (() => {
      if (!input.lease) return "TRUE";
      if (input.lease.mode === "acquire") {
        return "(lease_owner IS NULL OR lease_owner=$7 OR lease_expires_at IS NULL OR lease_expires_at < $6)";
      }
      if (input.lease.mode === "renew") return "lease_owner=$7";
      return "lease_owner=$7";
    })();
    const leaseExpiresAt = input.lease
      ? (input.lease.mode === "release" ? null : new Date(input.lease.now.getTime() + (input.lease.leaseMs ?? 0)))
      : undefined;
    const result = await pool.query<CodeRunStateRecord>(
      `UPDATE code_run_states SET
         status = COALESCE($4, status),
         turn_index = COALESCE($5, turn_index),
         heartbeat_at = COALESCE($8, heartbeat_at),
         finished_at = CASE WHEN $9::boolean THEN $10 ELSE finished_at END,
         details = COALESCE($11::jsonb, details),
         last_event_seq = $3,
         lease_owner = CASE WHEN $12::boolean AND ${leasePredicate} THEN $7 ELSE lease_owner END,
         lease_expires_at = CASE WHEN $12::boolean AND ${leasePredicate} THEN $13 ELSE lease_expires_at END,
         revision = revision + 1,
         updated_at = $6
       WHERE company_id=$1 AND run_id=$2 AND last_event_seq < $3
       RETURNING ${codeRunStateColumns}`,
      [
        input.companyId, input.runId, input.seq,
        input.status ?? null, input.turnIndex ?? null, input.lease?.now ?? new Date(),
        input.lease?.owner ?? null, input.heartbeatAt ?? null,
        input.finishedAt !== undefined, input.finishedAt ?? null,
        input.details === undefined ? null : JSON.stringify(input.details),
        Boolean(input.lease), leaseExpiresAt ?? null,
      ],
    );
    if (result.rows[0]) return result.rows[0];

    const current = await getCodeRunState(pool, input.companyId, input.runId);
    if (!current) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "No such run state", {
        httpStatus: 404, details: { runId: input.runId },
      });
    }
    return current;
  }

export async function getCodeRunState(pool: Pool, companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states WHERE company_id=$1 AND run_id=$2`,
      [companyId, runId],
    );
    return result.rows[0] ?? null;
  }

export async function listStaleCodeRunStates(pool: Pool, input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> {
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states
       WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at < $1)
       ORDER BY started_at ASC
       LIMIT $2`,
      [input.now, Math.max(1, input.limit)],
    );
    return result.rows;
  }

export async function listCodeRunStates(pool: Pool, input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const statuses = input.statuses && input.statuses.length > 0 ? [...input.statuses] : null;
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states
        WHERE company_id=$1
          AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          AND ($3::timestamptz IS NULL OR started_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR started_at < $4::timestamptz)
        ORDER BY started_at DESC, run_id ASC
        LIMIT $5`,
      [input.companyId, statuses, input.startedAfter ?? null, input.startedBefore ?? null, limit],
    );
    return result.rows;
  }

export async function getCodeRunTurn(pool: Pool, companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    const result = await pool.query<CodeRunTurnRecord>(
      `SELECT ${codeRunTurnColumns} FROM code_run_turns
       WHERE company_id=$1 AND run_id=$2 AND turn_index=$3`,
      [companyId, runId, turnIndex],
    );
    return result.rows[0] ?? null;
  }

export async function listCodeRunTurns(pool: Pool, companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    const result = await pool.query<CodeRunTurnRecord>(
      `SELECT ${codeRunTurnColumns} FROM code_run_turns
       WHERE company_id=$1 AND run_id=$2 ORDER BY turn_index ASC`,
      [companyId, runId],
    );
    return result.rows;
  }

export async function listCodeRunStatesForScan(pool: Pool, input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const result = await pool.query<CodeRunStateRecord>(
      `SELECT ${codeRunStateColumns} FROM code_run_states
       WHERE ($1::text IS NULL OR company_id=$1)
         AND started_at < $2
         AND status='running'
         AND ($3::timestamptz IS NULL OR (started_at, run_id, 0::integer) > ($3::timestamptz, $4, 0))
       ORDER BY started_at ASC, run_id ASC
       LIMIT $5`,
      [input.companyId, input.startedBefore, cursor?.startedAt ?? null, cursor?.runId ?? "", limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: result.rows.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: 0 })
        : null,
    };
  }

export async function listCodeRunTurnsForScan(pool: Pool, input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const statuses = [...(input.statuses ?? ["running"])];
    const result = await pool.query<CodeRunTurnRecord>(
      `SELECT ${codeRunTurnColumns} FROM code_run_turns
       WHERE ($1::text IS NULL OR company_id=$1)
         AND started_at < $2
         AND status = ANY($3::text[])
         AND ($4::timestamptz IS NULL OR (started_at, run_id, turn_index) > ($4::timestamptz, $5, $6))
       ORDER BY started_at ASC, run_id ASC, turn_index ASC
       LIMIT $7`,
      [
        input.companyId, input.startedBefore, statuses,
        cursor?.startedAt ?? null, cursor?.runId ?? "", cursor?.turnIndex ?? 0, limit + 1,
      ],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: result.rows.length > limit && last
        ? encodeCodeRunScanCursor({
          startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: last.turnIndex,
        })
        : null,
    };
  }

export async function createCodeActivityEvent(pool: Pool, input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    const result = await pool.query(
      `INSERT INTO code_activity_events
        (id, workspace_id, company_id, project_id, session_id, run_id, snapshot_id,
         parent_run_id, parent_tool_call_id, parent_event_id, kind, payload,
         data_classification, retention_class, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${codeActivityEventColumns}`,
      [input.id ?? randomUUID(), input.workspaceId, input.companyId, input.projectId ?? null,
        input.sessionId ?? null, input.runId ?? null, input.snapshotId ?? null,
        input.parentRunId ?? null, input.parentToolCallId ?? null, input.parentEventId ?? null,
        input.kind,
        JSON.stringify(input.payload),
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? DEFAULT_RETENTION_CLASS,
        input.now ?? new Date()],
    );
    return mapCodeActivityEventRow(result.rows[0]!);
  }

export async function listCodeActivityEvents(pool: Pool, input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const result = await pool.query(
      `SELECT ${codeActivityEventColumns} FROM code_activity_events
        WHERE company_id=$1
          AND ($2::text IS NULL OR session_id=$2)
          AND ($3::text IS NULL OR run_id=$3)
          AND ($4::text IS NULL OR snapshot_id=$4)
          AND ($5::text IS NULL OR parent_run_id=$5)
          AND ($6::timestamptz IS NULL OR (created_at, id) < ($6::timestamptz, $7::text))
        ORDER BY created_at DESC, id DESC LIMIT $8`,
      [input.companyId, input.sessionId ?? null, input.runId ?? null, input.snapshotId ?? null,
        input.parentRunId ?? null,
        input.cursor ? new Date(decodeCodeActivityCursor(input.cursor).createdAt) : null,
        input.cursor ? decodeCodeActivityCursor(input.cursor).id : null, limit],
    );
    return result.rows.map((row) => mapCodeActivityEventRow(row));
  }

export async function createCodeContextSummary(pool: Pool, input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> {
    const result = await pool.query(
      `INSERT INTO code_context_summaries
        (id, company_id, project_id, session_id, run_id, snapshot_id, turn_index, schema_version, summary,
         summary_text, content_hash, data_classification, retention_class, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${codeContextSummaryColumns}`,
      [input.id ?? randomUUID(), input.companyId, input.projectId, input.sessionId ?? null,
        input.runId ?? null, input.snapshotId ?? null, input.turnIndex ?? 0, input.schemaVersion,
        JSON.stringify(input.summary), input.summaryText, input.contentHash,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
        input.retentionClass ?? "short",
        input.now ?? new Date()],
    );
    return mapCodeContextSummaryRow(result.rows[0]!);
  }

export async function listCodeContextSummaries(pool: Pool, input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const result = await pool.query(
      `SELECT ${codeContextSummaryColumns} FROM code_context_summaries
        WHERE company_id=$1
          AND ($2::text IS NULL OR session_id=$2)
          AND ($3::text IS NULL OR run_id=$3)
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [input.companyId, input.sessionId ?? null, input.runId ?? null, limit],
    );
    return result.rows.map((row) => mapCodeContextSummaryRow(row));
  }

export async function createCodeSession(pool: Pool, context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession> {
    const project = await getProject(pool, context, companyId, projectId);
    await assertProjectAgent(pool, context, companyId, input.agentId);
    if (input.parentSessionId) {
      const parent = await getCodeSession(pool, context, companyId, input.parentSessionId);
      if (parent.projectId !== projectId) throw new WorkspaceAccessError("Parent session belongs to another project");
    }

    const requested = input.dataClassification ?? project.dataClassification;
    if (!isClassificationAtLeast(requested, project.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lower than the project classification");
    }
    const id = input.childKey && input.parentSessionId
      ? codeChildSessionId(context, companyId, projectId, input.parentSessionId, input.childKey) : randomUUID();
    const session = await pool.query<CodeSession>(`INSERT INTO code_sessions
      (id, workspace_id, company_id, project_id, user_id, agent_id, mode, model_profile, status, parent_session_id,
       summary, data_classification, retention_class)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12)
      ON CONFLICT (id) DO NOTHING
      RETURNING ${codeSessionColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.agentId ?? null,
        input.mode ?? "edit", input.modelProfile ?? null, input.parentSessionId ?? null, input.summary ?? null,
        requested, input.retentionClass ?? project.retentionClass]);
    return session.rows[0] ?? getCodeSession(pool, context, companyId, id);
  }
export async function getCodeSession(pool: Pool, context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> {
    const result = await pool.query<CodeSession>(`SELECT ${codeSessionColumns} FROM code_sessions
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`,
      [sessionId, context.workspaceId, companyId, context.userId]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Code session not found");
    return result.rows[0];
  }
export async function listCodeSessions(pool: Pool, context: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> {
    await assertCompany(pool, context, companyId);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const result = await pool.query<CodeSession>(`SELECT ${codeSessionColumns} FROM code_sessions
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3
        AND ($4::text IS NULL OR project_id=$4)
        AND ($5::boolean OR status<>'archived')
      ORDER BY updated_at DESC, id LIMIT $6`,
      [context.workspaceId, companyId, context.userId, projectId ?? null, options.includeArchived === true, limit]);
    return result.rows;
  }
export async function updateCodeSession(pool: Pool, context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession> {
    const current = await getCodeSession(pool, context, companyId, sessionId);
    if (patch.dataClassification && !isClassificationAtLeast(patch.dataClassification, current.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lowered through this endpoint");
    }
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw new WorkspaceAccessError("Code session changed by another request. Reload and try again.");
    }
    const result = await pool.query<CodeSession>(`UPDATE code_sessions
      SET status=COALESCE($5,status),
          summary=COALESCE($6,summary),
          run_id=COALESCE($7,run_id),
          model_profile=COALESCE($8,model_profile),
          data_classification=COALESCE($9,data_classification),
          retention_class=COALESCE($10,retention_class),
          tool_manifest_version=COALESCE($11,tool_manifest_version),
          mode=COALESCE($12,mode),
          revision=revision+1,
          updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4
      RETURNING ${codeSessionColumns}`,
      [sessionId, context.workspaceId, companyId, context.userId, patch.status ?? null, patch.summary ?? null,
        patch.runId === undefined ? null : patch.runId, patch.modelProfile ?? null,
        patch.dataClassification ?? null, patch.retentionClass ?? null,
        patch.toolManifestVersion === undefined ? null : patch.toolManifestVersion, patch.mode ?? null]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Code session not found");
    return result.rows[0];
  }
export async function listCodeProjectRefs(pool: Pool, input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const result = await pool.query<{ companyId: string; projectId: string; lastSessionAt: Date }>(
      `SELECT company_id AS "companyId", project_id AS "projectId", max(created_at) AS "lastSessionAt"
         FROM code_sessions
        WHERE ($1::text IS NULL OR company_id=$1)
        GROUP BY company_id, project_id
       HAVING ($2::timestamptz IS NULL OR (max(created_at), project_id) < ($2::timestamptz, $3))
        ORDER BY max(created_at) DESC, project_id ASC
        LIMIT $4`,
      [input.companyId, cursor?.startedAt ?? null, cursor?.runId ?? "", limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((row) => ({
        companyId: row.companyId,
        projectId: row.projectId,
        lastSessionAt: new Date(row.lastSessionAt).toISOString(),
      })),
      nextCursor: result.rows.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: new Date(last.lastSessionAt).toISOString(), runId: last.projectId, turnIndex: 0 })
        : null,
    };
  }
