import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { DataBackendRepository } from "./repository";
import type { DataProvider, SchemaOperation, SchemaSnapshot } from "./data-provider";
import type { ProjectMigrationEngine } from "./migration-engine";
import { DataStudioError, validateIdentifier } from "./identifier";
import type { RowTransferInput } from "./row-transfer";
import { isCodeChatWebsite } from "../code-chat-website";
import { validateOperation } from "./studio-service";
import { PROJECT_SDK_FILE_NAME, PROJECT_SDK_IMPORT_PATH } from "./project-sdk-file";
import { TEMPLATE_CATALOG, validateTemplate, getDataSeed, validateDataSeed, type DataSchemaTemplate } from "@npati/shared";
import type { ProjectWorkspace } from "../project-workspace";

const MAX_SCHEMA_OPS_PER_RUN = 50;
const MAX_AGENT_INSERT_ROWS = 100;

export interface AgentSchemaApplyOptions {
  dryRunOnly?: boolean;
  expectedFingerprint?: string;
  expectedBackendId?: string;
  runId?: string;
  agentId?: string;
  approved?: boolean;
}

export interface AgentTemplateApplyOptions {
  dryRunOnly?: boolean;
  runId?: string;
  agentId?: string;
  approved?: boolean;
  /** D7: also insert optional demo rows (dev only). */
  seedDemoData?: boolean;
}

/**
 * What code running in a visitor's browser must use. The sandbox variable PROJECT_API_URL is a private hostname, and an
 * agent given only that value wrote it into plain sites, whose forms then could not reach the database.
 */
export function projectBrowserAccess(projectId: string, publishableKey: string) {
  return {
    use: "For any code that runs in the visitor's browser (plain HTML/JavaScript). PROJECT_API_URL is private to the sandbox: never write it into browser code.",
    baseUrl: `/v1/projects/${projectId}`,
    headers: { "X-Project-Key": publishableKey, "Authorization": "Bearer <token, once signed in>" },
    accounts: "Built in, so do not create a users table. POST /auth/signup and POST /auth/login take JSON {email, password, name?} and return {user, token}; GET /auth/me.",
    rows: "GET and POST /data/<table>.",
    contactForm: "POST exactly {name, email, message} to /forms/contact_messages/submit; the table must be named contact_messages.",
    policies: "A browser can use a table only after code.data.policies.apply: rule public with action insert for a form, rule owner only when the table has an owner_id column.",
  };
}

export function formatSchemaForProjectContext(backendName: string, schema: SchemaSnapshot, projectId = "<projectId>"): string {
  const lines = [
    "## Data Schema (Data Studio)",
    `- Backend: ${backendName} (dev)`,
    `- Synchronized: ${new Date().toISOString()}`,
    `- Collections (${schema.tables.length}):`,
    "- Project API: /v1/projects/<projectId> (use the configured PROJECT_API_URL and PROJECT_PUBLISHABLE_KEY).",
    `- Client SDK: import { createProjectClient } from "${PROJECT_SDK_IMPORT_PATH}" — generated file ${PROJECT_SDK_FILE_NAME} sits in the project root, no package install is required.`,
    "- Usage: createProjectClient({ apiUrl: PROJECT_API_URL, publishableKey: PROJECT_PUBLISHABLE_KEY }).",
    "- Auth: client.auth.signUp(credentials), signIn, signOut, getUser; Data queries: client.from(\"table\").list() returns Promise<{ data: Row[], meta: { total: number } }> (access rows via res.data), get(id) returns Promise<Row>, create(row), update(id, row), delete(id).",
    `- For a plain HTML/JavaScript site do not import the TypeScript SDK and do not use PROJECT_API_URL (a private hostname the browser cannot reach). Call the relative path /v1/projects/${projectId} with fetch, never with a host name in front of it, and send the header X-Project-Key: <PROJECT_PUBLISHABLE_KEY>; once signed in also send Authorization: Bearer <token>. Keep the signed-in session across page reloads: save the token in localStorage, restore it on page load with GET /auth/me, and clear it only on sign-out or a 401.`,
    "- Plain site endpoints under that base path: POST /auth/signup and POST /auth/login take JSON {email, password, name?} and return {user, token}; GET /auth/me; rows are GET and POST /data/<table>. A contact form POSTs exactly {name, email, message} to /forms/contact_messages/submit and needs an insert policy with rule public on contact_messages.",
    "- A policy with rule owner needs an owner column in that table (owner_id uuid by default): add it with code.data.schema.apply before applying the policy.",
    "- In Sandbox, PROJECT_API_URL can be a private service hostname. Use it server-side (Next.js Route Handler or Server Component); browser components call same-origin routes. Verify real rows in Preview and show an explicit API error instead of static fallback products.",
    "- Never put PROJECT_SECRET_KEY, DATABASE_URL or any database credential into generated client code.",
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
    const schemaSection = formatSchemaForProjectContext(backendName, schema, projectId);
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
import type { PromoteService } from "./promote-service";
import type { ProjectAccessPolicy, ProjectAuthSettings } from "@npati/shared";

export class AgentDataStudioService {
  constructor(
    private readonly store: Pick<WorkspaceStore, "getProject"> & Partial<Pick<WorkspaceStore, "listProjects">>,
    private readonly repository: DataBackendRepository,
    private readonly provider: DataProvider,
    private readonly migrations: ProjectMigrationEngine,
    private readonly workspace?: ProjectWorkspace,
    private readonly authService?: ProjectAuthService,
    /** D7: dev → prod promote (approval-gated). */
    private readonly promote?: PromoteService,
    private readonly backendCreator?: (ctx: AuthContext, companyId: string, projectId: string, name: string) => Promise<{ created: boolean; backend: { id: string; name: string; status: string }; environment: Record<string,string> }>,
  ) {}


  async createBackend(ctx: AuthContext, companyId: string, projectId: string, input: { name: string; reason: string; separate?: boolean }) {
    const project = await this.store.getProject(ctx, companyId, projectId);
    // Creating reuses the attached database, so a project that shares one first leaves it; the other project keeps it.
    if (input.separate && project.dataBackendId && this.store.listProjects) {
      const shared = (await this.store.listProjects(ctx, companyId)).some((other) => other.id !== projectId && other.dataBackendId === project.dataBackendId);
      if (shared) await this.repository.attach(ctx, companyId, projectId, null, project.dataBackendId);
    }
    if (!this.backendCreator) throw new DataStudioError(503,"create_backend","Database provisioning is unavailable",true,"PROJECT_DATABASE_UNAVAILABLE");
    const result = await this.backendCreator(ctx, companyId, projectId, input.name);
    const { backend } = await this.context(ctx, companyId, projectId);
    await syncProjectMdSchema(ctx, companyId, projectId, backend.name, await this.provider.introspectSchema(backend,"dev"), this.workspace);
    return { ...result, ...(result.environment?.PROJECT_PUBLISHABLE_KEY ? { browserAccess: projectBrowserAccess(projectId, result.environment.PROJECT_PUBLISHABLE_KEY) } : {}), reason: input.reason, userMessage: result.created ? "Created database: " + result.backend.name : "Using existing database: " + result.backend.name };
  }

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

  async assertBackend(ctx: AuthContext, companyId: string, projectId: string, expectedBackendId: string) {
    const { backend } = await this.context(ctx, companyId, projectId);
    if (backend.id !== expectedBackendId) throw new DataStudioError(409, "project_data", `Project database attachment changed; this project's database id is ${backend.id}`, false, "BACKEND_CHANGED");
    return backend;
  }

  async transferRows(ctx: AuthContext, companyId: string, projectId: string, expectedBackendId: string, input: RowTransferInput) {
    const backend = await this.assertBackend(ctx, companyId, projectId, expectedBackendId);
    return this.migrations.transferRows(ctx, backend, input);
  }

  async attachToProject(ctx: AuthContext, companyId: string, projectId: string, input: { expectedBackendId: string; targetProjectId?: string; expectedTargetBackendId?: string | null; dryRun?: boolean }) {
    const current = await this.store.getProject(ctx, companyId, projectId);
    if (!current.dataBackendId) return this.attachFromProject(ctx, companyId, projectId, input);
    const backend = await this.assertBackend(ctx, companyId, projectId, input.expectedBackendId);
    if (!input.targetProjectId && input.dryRun) {
      if (!this.store.listProjects) throw new DataStudioError(503, "attach", "Project listing is unavailable", false, "PROJECT_LIST_UNAVAILABLE");
      const projects = await this.store.listProjects(ctx, companyId);
      return { dryRun: true, backendId: backend.id, targets: projects.filter(p => p.id !== projectId && p.createdBy === ctx.userId && p.workspaceId === ctx.workspaceId && p.companyId === companyId && (p.type === "code_project" || isCodeChatWebsite(p))).map(p => ({ projectId: p.id, name: p.name, currentBackendId: p.dataBackendId ?? null })) };
    }
    if (!input.targetProjectId || (!input.dryRun && input.expectedTargetBackendId === undefined)) throw new DataStudioError(400, "attach", "Select a target and its current attachment before confirming", false, "INVALID_ATTACHMENT");
    const target = await this.store.getProject(ctx, companyId, input.targetProjectId);
    if (target.createdBy !== ctx.userId || target.workspaceId !== ctx.workspaceId || target.companyId !== companyId) throw new DataStudioError(404, "attach", "Target project not found", false, "ATTACH_NOT_FOUND");
    if (target.type !== "code_project" && !isCodeChatWebsite(target)) throw new DataStudioError(400, "attach", "Target must be a website/code project", false, "INVALID_PROJECT");
    if (input.dryRun) return { dryRun: true, backendId: backend.id, targetProjectId: target.id, currentBackendId: target.dataBackendId ?? null };
    if ((target.dataBackendId ?? null) !== input.expectedTargetBackendId) throw new DataStudioError(409, "attach", "Target database attachment changed", false, "BACKEND_CHANGED");
    await this.repository.attach(ctx, companyId, target.id, backend.id, input.expectedTargetBackendId);
    await syncProjectMdSchema(ctx, companyId, target.id, backend.name, await this.provider.introspectSchema(backend, "dev"), this.workspace);
    return { attached: true, backendId: backend.id, targetProjectId: target.id, previousBackendId: input.expectedTargetBackendId };
  }

  /**
   * The other direction: this project has no database yet (a mobile app created after its site), so it takes the
   * database of the named project ("connect the app to the site's database").
   */
  private async attachFromProject(ctx: AuthContext, companyId: string, projectId: string, input: { expectedBackendId: string; targetProjectId?: string; dryRun?: boolean }) {
    const owned = (p: { createdBy: string; workspaceId: string; companyId: string }) => p.createdBy === ctx.userId && p.workspaceId === ctx.workspaceId && p.companyId === companyId;
    if (!input.targetProjectId) {
      if (!this.store.listProjects) throw new DataStudioError(503, "attach", "Project listing is unavailable", false, "PROJECT_LIST_UNAVAILABLE");
      const projects = await this.store.listProjects(ctx, companyId);
      const sources = projects.filter(p => p.id !== projectId && owned(p) && p.dataBackendId).map(p => ({ id: p.id, name: p.name, backendId: p.dataBackendId }));
      if (input.dryRun) return { dryRun: true, direction: "use_database_of_target", note: "This project has no database. Pass the project whose database it should use as targetProjectId, and that project's backendId as expectedBackendId.", sources };
      throw new DataStudioError(400, "attach", "This project has no database: name the project whose database it should use (targetProjectId)", false, "INVALID_ATTACHMENT");
    }
    const source = await this.store.getProject(ctx, companyId, input.targetProjectId);
    if (!owned(source)) throw new DataStudioError(404, "attach", "Target project not found", false, "ATTACH_NOT_FOUND");
    if (!source.dataBackendId) throw new DataStudioError(404, "attach", "Neither project has a database yet; create one first", false, "ATTACH_NOT_FOUND");
    if (input.dryRun) return { dryRun: true, direction: "use_database_of_target", backendId: source.dataBackendId, targetProjectId: source.id, currentBackendId: null };
    if (input.expectedBackendId !== source.dataBackendId) throw new DataStudioError(409, "attach", `That project's database id is ${source.dataBackendId}; pass it as expectedBackendId`, false, "BACKEND_CHANGED");
    const backend = await this.repository.get(ctx, companyId, source.dataBackendId);
    await this.repository.attach(ctx, companyId, projectId, backend.id, null);
    await syncProjectMdSchema(ctx, companyId, projectId, backend.name, await this.provider.introspectSchema(backend, "dev"), this.workspace);
    return { attached: true, backendId: backend.id, projectId, sourceProjectId: source.id, previousBackendId: null };
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

    if (options.expectedBackendId && backend.id !== options.expectedBackendId) throw new DataStudioError(409, "apply", "Project database attachment changed", false, "BACKEND_CHANGED");
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
      ...(options.expectedFingerprint ? { expectedFingerprint: options.expectedFingerprint } : {}),
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

  /**
   * D7: agents may preview a dev → prod promote; applying it always requires human approval
   * (the caller passes `approved` only after the existing approval flow).
   */
  async promoteDevToProd(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { withData?: boolean; dryRun?: boolean; approved?: boolean; runId?: string; agentId?: string } = {},
  ) {
    if (!this.promote) {
      throw new DataStudioError(503, "promote", "Promote is unavailable on this installation", true, "PROMOTE_UNAVAILABLE");
    }
    const { project } = await this.context(ctx, companyId, projectId);
    const backendId = project.dataBackendId;
    if (!backendId) throw new DataStudioError(404, "promote", "Project has no attached DataBackend", false, "DATA_BACKEND_NOT_ATTACHED");
    const preview = await this.promote.preview(ctx, companyId, backendId, { withData: options.withData, targetEnvironment: "prod" });
    if (options.dryRun || !options.approved) {
      return {
        approvalRequired: true,
        riskLevel: "high" as const,
        reason: "Promoting dev to prod changes the production schema and requires human approval.",
        preview,
      };
    }
    const result = await this.promote.apply(ctx, companyId, backendId, {
      approved: true,
      withData: options.withData,
      targetEnvironment: "prod",
      runId: options.runId,
      agentId: options.agentId,
    });
    return { applied: true, ...result, preview };
  }

  async listMigrations(ctx: AuthContext, companyId: string, projectId: string) {    const { backend } = await this.context(ctx, companyId, projectId);
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
      const source = template.collections.find(collection => collection.name === (rel.cardinality === "one-to-many" ? rel.target : rel.collection));
      const field = source?.fields.find(field => field.name === `${rel.name}_id` || field.name === rel.name)?.name;
      operations.push({
        kind: "create_relation",
        collection: rel.collection,
        target: rel.target,
        name: rel.name,
        cardinality: rel.cardinality,
        ...(field && rel.cardinality !== "many-to-many" ? { field } : {}),
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

    const appliedMigrations = await this.migrations.applyBatch(ctx, {
      backend, environment: "dev", operations, policies: template.accessPolicies,
      authorId: options.agentId || ctx.userId, runId: options.runId,
    });
    const currentEnv = await this.repository.environment(ctx, companyId, backend.id, "dev");
    await this.repository.setEnvironment(ctx, companyId, backend.id, "dev", {
      providerConfig: { ...currentEnv.providerConfig, gdprStrategies: { ...(currentEnv.providerConfig?.gdprStrategies as Record<string, string> ?? {}), ...template.gdprStrategies } },
    });

    // Update PROJECT.md
    const updatedSchema = await this.provider.introspectSchema(backend, "dev");
    await syncProjectMdSchema(ctx, companyId, projectId, backend.name, updatedSchema, this.workspace);

    // D7: optional demo data, dev only (production never receives seeds implicitly).
    let seededRows = 0;
    if (options.seedDemoData) {
      const seed = getDataSeed(templateId);
      if (seed) {
        const problems = validateDataSeed(seed, template.collections.map((collection) => collection.name));
        if (problems.length) throw new DataStudioError(400, "template", `Seed data is invalid: ${problems.join("; ")}`, false, "INVALID_SEED");
        for (const set of seed.sets) {
          for (const row of set.rows) {
            await this.migrations.createOwnerRow(ctx, backend, "dev", set.collection, row);
            seededRows += 1;
          }
        }
      }
    }

    return {
      applied: true,
      templateId: template.id,
      collections: template.collections.map((c) => c.name),
      appliedMigrationsCount: appliedMigrations.length,
      seededRows,
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
