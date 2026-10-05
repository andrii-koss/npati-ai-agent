import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaOperation, SchemaSnapshot } from "./data-provider";
import type { ProjectMigrationEngine } from "./migration-engine";
import { DataStudioError, validateIdentifier } from "./identifier";
import { validateOperation } from "./studio-service";
import { TEMPLATE_CATALOG, validateTemplate, type DataSchemaTemplate } from "@npati/shared";
import type { ProjectWorkspace } from "../project-workspace";

const MAX_SCHEMA_OPS_PER_RUN = 50;
const MAX_AGENT_INSERT_ROWS = 100;

export interface AgentSchemaApplyOptions {
  dryRunOnly?: boolean;
  expectedFingerprint?: string;
  runId?: string;
  agentId?: string;
  approved?: boolean;
}

export interface AgentTemplateApplyOptions {
  dryRunOnly?: boolean;
  runId?: string;
  agentId?: string;
  approved?: boolean;
}

export function formatSchemaForProjectContext(backendName: string, schema: SchemaSnapshot): string {
  const lines = [
    "## Data Schema (Data Studio)",
    `- Backend: ${backendName} (dev)`,
    `- Synchronized: ${new Date().toISOString()}`,
    `- Collections (${schema.tables.length}):`,
    "- Project API: /v1/projects/<projectId> (use the configured PROJECT_API_URL and PROJECT_PUBLISHABLE_KEY).",
    "- Client SDK: createProjectClient({ apiUrl: PROJECT_API_URL, publishableKey: PROJECT_PUBLISHABLE_KEY }).",
    "- Auth: client.auth.signUp(credentials), signIn, signOut, getUser; data: client.from(\"products\").list(), get(id), create(row), update(id, row), delete(id).",
    "- Send the user access token through the SDK. Access policies and row level security apply to every request.",
  ];
  for (const table of schema.tables) {
    const cols = table.columns.map((c) => `${c.name} (${c.type}${c.nullable ? "" : ", required"})`).join(", ");
    lines.push(`  - \`${table.name}\`: ${cols}`);
  }
  return lines.join("\n");
}

export async function syncProjectMdSchema(
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  backendName: string,
  schema: SchemaSnapshot,
  workspace?: ProjectWorkspace,
): Promise<void> {
  if (!workspace) return;
  try {
    const schemaSection = formatSchemaForProjectContext(backendName, schema);
    let content = "";
    let revision = "";
    try {
      const existing = await workspace.readFile(ctx, companyId, projectId, "PROJECT.md");
      content = existing.content;
      revision = existing.revision;
    } catch {
      content = `# Project Workspace\n\n`;
    }

    const regex = /## Data Schema \(Data Studio\)[\s\S]*?(?=\n## |\n# |$)/;
    let nextContent = "";
    if (regex.test(content)) {
      nextContent = content.replace(regex, schemaSection + "\n");
    } else {
      nextContent = content.trimEnd() + "\n\n" + schemaSection + "\n";
    }

    if (revision) {
      await workspace.writeFile(ctx, companyId, projectId, "PROJECT.md", nextContent, revision);
    } else {
      await workspace.createFile(ctx, companyId, projectId, "PROJECT.md", nextContent);
    }
  } catch {
    // Non-fatal if project workspace file sync fails
  }
}

import type { ProjectAuthService } from "./auth-service";
import type { ProjectAccessPolicy, ProjectAuthSettings } from "@npati/shared";

export class AgentDataStudioService {
  constructor(
    private readonly store: Pick<WorkspaceStore, "getProject">,
    private readonly repository: DataBackendRepository,
    private readonly provider: DataProvider,
    private readonly migrations: ProjectMigrationEngine,
    private readonly workspace?: ProjectWorkspace,
    private readonly authService?: ProjectAuthService,
  ) {}

  private async context(ctx: AuthContext, companyId: string, projectId: string, requestedEnv?: string) {
    if (requestedEnv && requestedEnv !== "dev") {
      throw new DataStudioError(403, "environment", "Agent may not address production environment directly", false, "PROD_ENVIRONMENT_FORBIDDEN");
    }
    const project = await this.store.getProject(ctx, companyId, projectId);
    if (!project.dataBackendId) {
      throw new DataStudioError(404, "project_data", "Project has no attached DataBackend", false, "DATA_BACKEND_NOT_ATTACHED");
    }
    const backend = await this.repository.get(ctx, companyId, project.dataBackendId);
    const env = await this.repository.environment(ctx, companyId, backend.id, "dev");
    return { backend, env, project };
  }

  async inspectSchema(ctx: AuthContext, companyId: string, projectId: string) {
    const { backend, env } = await this.context(ctx, companyId, projectId);
    const drift = env.status === "ready" ? await this.migrations.detectDrift(ctx, backend, "dev") : null;
    return {
      backend: { id: backend.id, name: backend.name, status: backend.status },
      environment: { name: "dev", syncStatus: drift?.status ?? env.syncStatus, schemaFingerprint: env.schemaFingerprint },
      schema: drift?.schema ?? null,
      expectedSchema: env.expectedSchema ?? null,
    };
  }

  async applySchema(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    operation: SchemaOperation,
    options: AgentSchemaApplyOptions = {},
  ) {
    validateOperation(operation);
    const { backend, env } = await this.context(ctx, companyId, projectId);

    if (backend.status !== "ready" || env.status !== "ready") {
      throw new DataStudioError(409, "apply", "Backend is not ready", false, "BACKEND_NOT_READY");
    }
    if (env.syncStatus !== "synced") {
      throw new DataStudioError(409, "apply", "Schema drift blocks changes", false, "DRIFT_BLOCKED");
    }

    const preview = await this.migrations.dryRun({
      backend,
      environment: "dev",
      operation,
      authorId: options.agentId || ctx.userId,
    });

    const isHighRisk = preview.destructive || preview.requiresSnapshot || operation.kind === "drop_collection" || operation.kind === "drop_field";

    if (isHighRisk && !options.approved && !options.dryRunOnly) {
      return {
        approvalRequired: true,
        riskLevel: "high" as const,
        reason: "Destructive schema modification requires human approval",
        diff: preview.diff,
        destructive: preview.destructive,
        requiresSnapshot: preview.requiresSnapshot,
        reversible: preview.reversible,
        operation: operation.kind,
      };
    }

    if (options.dryRunOnly) {
      return {
        dryRun: true,
        diff: preview.diff,
        destructive: preview.destructive,
        requiresSnapshot: preview.requiresSnapshot,
        reversible: preview.reversible,
        riskLevel: isHighRisk ? "high" : "medium",
      };
    }

    if (options.expectedFingerprint && env.schemaFingerprint !== options.expectedFingerprint) {
      throw new DataStudioError(409, "apply", "Schema changed concurrently", false, "STALE_SCHEMA");
    }

    const migration = await this.migrations.apply(ctx, {
      backend,
      environment: "dev",
      operation,
      authorId: options.agentId || ctx.userId,
      runId: options.runId,
    });

    // Update PROJECT.md with latest schema
    const updatedSchema = await this.provider.introspectSchema(backend, "dev");
    await syncProjectMdSchema(ctx, companyId, projectId, backend.name, updatedSchema, this.workspace);

    return {
      applied: true,
      migrationId: migration.id,
      version: migration.version,
      fingerprint: migration.fingerprint,
      diff: migration.diff,
    };
  }

  async listRows(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    collection: string,
    query: Parameters<ProjectMigrationEngine["listOwnerRows"]>[4] = {},
  ) {
    const { backend } = await this.context(ctx, companyId, projectId);
    validateIdentifier(collection);
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    return {
      rows: await this.migrations.listOwnerRows(ctx, backend, "dev", collection, { ...query, limit }),
    };
  }

  async readRow(ctx: AuthContext, companyId: string, projectId: string, collection: string, id: string) {
    const { backend } = await this.context(ctx, companyId, projectId);
    validateIdentifier(collection);
    const rows = await this.migrations.listOwnerRows(ctx, backend, "dev", collection, {
      filters: [{ field: "id", operator: "eq", value: id }],
      limit: 1,
    });
    return { row: rows[0] ?? null };
  }

  async createRow(ctx: AuthContext, companyId: string, projectId: string, collection: string, row: Record<string, unknown>) {
    const { backend } = await this.context(ctx, companyId, projectId);
    validateIdentifier(collection);
    const created = await this.migrations.createOwnerRow(ctx, backend, "dev", collection, row);
    return { row: created };
  }

  async updateRow(ctx: AuthContext, companyId: string, projectId: string, collection: string, id: string, row: Record<string, unknown>) {
    const { backend } = await this.context(ctx, companyId, projectId);
    validateIdentifier(collection);
    const updated = await this.migrations.updateOwnerRow(ctx, backend, "dev", collection, id, row);
    return { row: updated };
  }

  async deleteRows(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    collection: string,
    ids: string[],
    approved: boolean,
  ) {
    if (!approved) {
      return {
        approvalRequired: true,
        riskLevel: "high" as const,
        reason: `Deleting ${ids.length} rows from collection "${collection}" requires human confirmation`,
        affectedCount: ids.length,
      };
    }
    const { backend } = await this.context(ctx, companyId, projectId);
    validateIdentifier(collection);
    return this.migrations.deleteOwnerRows(ctx, backend, "dev", collection, ids);
  }

  async listMigrations(ctx: AuthContext, companyId: string, projectId: string) {
    const { backend } = await this.context(ctx, companyId, projectId);
    const history = await this.repository.pool.query(
      `SELECT id, version, operation, reversible, destructive, requires_snapshot AS "requiresSnapshot",
              author_id AS "authorId", run_id AS "runId", status, created_at AS "createdAt", applied_at AS "appliedAt"
       FROM data_backend_migrations
       WHERE backend_id=$1 AND environment='dev'
       ORDER BY version DESC, created_at DESC LIMIT 100`,
      [backend.id],
    );
    return { migrations: history.rows };
  }

  listTemplates(): { templates: DataSchemaTemplate[] } {
    return { templates: TEMPLATE_CATALOG };
  }

  async applyTemplate(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    templateId: string,
    options: AgentTemplateApplyOptions = {},
  ) {
    const template = TEMPLATE_CATALOG.find((t) => t.id === templateId);
    if (!template) {
      throw new DataStudioError(404, "template", `Template "${templateId}" not found in catalog`, false, "TEMPLATE_NOT_FOUND");
    }

    // Validate access policies and structure
    validateTemplate(template);

    const { backend, env } = await this.context(ctx, companyId, projectId);
    if (backend.status !== "ready" || env.status !== "ready") {
      throw new DataStudioError(409, "template", "Backend is not ready", false, "BACKEND_NOT_READY");
    }

    // Convert template to ordered SchemaOperation sequence
    const operations: SchemaOperation[] = [];

    // 1. Create collections with fields
    for (const col of template.collections) {
      operations.push({
        kind: "create_collection",
        collection: col.name,
        fields: col.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          default: f.default,
          options: f.options,
        })),
      });
    }

    // 2. Create relations
    for (const rel of template.relations) {
      operations.push({
        kind: "create_relation",
        collection: rel.collection,
        target: rel.target,
        name: rel.name,
        cardinality: rel.cardinality,
      });
    }

    if (operations.length > MAX_SCHEMA_OPS_PER_RUN) {
      throw new DataStudioError(400, "template", `Template exceeds limit of ${MAX_SCHEMA_OPS_PER_RUN} operations`, false, "LIMIT_EXCEEDED");
    }

    // Dry run preview of all operations
    const previews = [];
    for (const op of operations) {
      const p = await this.migrations.dryRun({
        backend,
        environment: "dev",
        operation: op,
        authorId: options.agentId || ctx.userId,
      });
      previews.push({ operation: op.kind, diff: p.diff, reversible: p.reversible });
    }

    // Template application requires single human approval
    if (!options.approved && !options.dryRunOnly) {
      return {
        approvalRequired: true,
        riskLevel: "high" as const,
        templateId: template.id,
        templateName: template.name,
        collections: template.collections.map((c) => c.name),
        relationsCount: template.relations.length,
        diffs: previews.map((p) => p.diff),
        reason: `Applying template "${template.name}" will create ${template.collections.length} collections and ${template.relations.length} relations. User confirmation required.`,
      };
    }

    if (options.dryRunOnly) {
      return {
        dryRun: true,
        templateId: template.id,
        templateName: template.name,
        collections: template.collections.map((c) => c.name),
        operationsCount: operations.length,
        diffs: previews.map((p) => p.diff),
      };
    }

    // Execute operations atomically in a transaction
    const appliedMigrations = [];
    try {
      for (const op of operations) {
        const mig = await this.migrations.apply(ctx, {
          backend,
          environment: "dev",
          operation: op,
          authorId: options.agentId || ctx.userId,
          runId: options.runId,
        });
        appliedMigrations.push(mig);
      }
      if (!this.authService) throw new DataStudioError(503, "template", "Project Auth service is required to apply template policies", true, "AUTH_UNAVAILABLE");
      await this.authService.applyAccessPolicies(ctx, companyId, projectId, "dev", template.accessPolicies);
    } catch (error) {
      // Rollback applied migrations in reverse order if any operation fails
      for (let i = appliedMigrations.length - 1; i >= 0; i--) {
        const mig = appliedMigrations[i]!;
        await this.migrations.rollback(ctx, backend, "dev", mig.id).catch(() => {});
      }
      throw error;
    }

    // Update PROJECT.md
    const updatedSchema = await this.provider.introspectSchema(backend, "dev");
    await syncProjectMdSchema(ctx, companyId, projectId, backend.name, updatedSchema, this.workspace);

    return {
      applied: true,
      templateId: template.id,
      collections: template.collections.map((c) => c.name),
      appliedMigrationsCount: appliedMigrations.length,
    };
  }

  async inspectAuth(ctx: AuthContext, companyId: string, projectId: string) {
    if (!this.authService) {
      throw new DataStudioError(503, "auth", "Project Auth service not configured", true, "AUTH_UNAVAILABLE");
    }
    const settings = await this.authService.getAuthSettings(ctx, companyId, projectId, "dev");
    const policies = await this.authService.getAccessPolicies(ctx, companyId, projectId, "dev");
    return {
      settings,
      policiesCount: policies.length,
      policies: policies.map((p) => ({
        collection: p.collection,
        rule: p.rule,
        ownerField: p.ownerField,
        role: p.role,
        actions: p.actions,
      })),
      roles: ["admin", "member", "user"],
    };
  }

  async configureAuth(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { settings?: Partial<ProjectAuthSettings>; policies?: ProjectAccessPolicy[] },
    options: { approved?: boolean } = {},
  ) {
    if (!this.authService) {
      throw new DataStudioError(503, "auth", "Project Auth service not configured", true, "AUTH_UNAVAILABLE");
    }

    const isSensitive =
      (input.settings?.requireEmailVerification === false) ||
      (input.settings?.allowRegistration !== undefined) ||
      Boolean(input.policies?.some((p) => p.rule === "public" && p.actions?.includes("delete")));

    if (isSensitive && !options.approved) {
      return {
        approvalRequired: true,
        risk: "high",
        reason: "Modifying security-sensitive authentication settings requires human approval.",
        proposedSettings: input.settings,
        proposedPolicies: input.policies,
      };
    }

    let updatedSettings;
    if (input.settings) {
      updatedSettings = await this.authService.updateAuthSettings(ctx, companyId, projectId, "dev", input.settings);
    }
    let compiledPolicies;
    if (input.policies) {
      compiledPolicies = await this.authService.applyAccessPolicies(ctx, companyId, projectId, "dev", input.policies);
    }

    return {
      success: true,
      configured: true,
      settings: updatedSettings,
      policies: compiledPolicies,
    };
  }
}
