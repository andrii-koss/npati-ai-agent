/** Bundle locally and run inside agent-api against temporary, scoped databases. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { PostgresWorkspaceStore, type AuthContext, type Project } from "@npati/workspace";
import { defaultCapabilityRegistry } from "@npati/shared";
import { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import { SharedPostgresProvisioner } from "../apps/agent-api/src/data-studio/provisioner";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import { ProjectAuthService } from "../apps/agent-api/src/data-studio/auth-service";
import { ProjectApiGatewayService } from "../apps/agent-api/src/data-studio/gateway-service";
import { AgentDataStudioService } from "../apps/agent-api/src/data-studio/agent-data-service";
import { codeDataExecutors } from "../apps/agent-api/src/code-data-tools";
import { CodeToolRuntime, type CodeReadPort } from "../apps/agent-api/src/code-tool-runtime";
import { PolicyEngine, isReviewSafeTool } from "../apps/agent-api/src/code-policy-engine";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { AuditLogService } from "../apps/agent-api/src/audit-log";
import { CompanyApprovalsRepository } from "../apps/agent-api/src/approvals-repository";
import type { CodeApprovalPort } from "../apps/agent-api/src/code-workspace-checkpoint";
import { ensureIdentity } from "../packages/workspace/src/postgres-store-support";

const ctx: AuthContext = { workspaceId: "coding-data-check-" + randomUUID(), userId: randomUUID(), permissions: ["admin:all", "workspace:read", "workspace:write", "business:manage"] };
assert(process.env.DATABASE_URL && process.env.NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD);
const store = new PostgresWorkspaceStore(process.env.DATABASE_URL);
const identities = new Pool({ connectionString: process.env.DATABASE_URL });
await store.initialize();
const approvalsRepo = new CompanyApprovalsRepository(process.env.DATABASE_URL);
const extraProjects: string[] = [];
const repository = new DataBackendRepository(process.env.DATABASE_URL);
const provisioner = new SharedPostgresProvisioner({ host: process.env.NPATI_PROJECTS_POSTGRES_HOST ?? "postgres-projects", port: 5432,
  adminUser: process.env.NPATI_PROJECTS_POSTGRES_ADMIN_USER ?? "npati_projects_admin", adminPassword: process.env.NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD,
  maintenanceDatabase: "postgres", snapshotDirectory: "/tmp/coding-data-check" }, repository);
const provider = new PostgresDataProvider({}, provisioner);
const migrations = new ProjectMigrationEngine(provisioner, provider, repository);
const backends = new DataBackendService(store, repository, provisioner, provider);
const authService = new ProjectAuthService({ store, repository, provisioner });
// The local diagnostic supplies a public base without changing container configuration.
process.env.NPATI_PROJECT_API_PUBLIC_URL ||= "http://127.0.0.1:3001";
const gateway = new ProjectApiGatewayService(store, repository, provisioner, authService, provider);
const projectData = new AgentDataStudioService(store, repository, provider, migrations);
let companyId: string | undefined, projectId: string | undefined, backend: Awaited<ReturnType<typeof backends.create>> | undefined;
let foreignCompanyId: string | undefined, foreignProjectId: string | undefined;
const other = { ...ctx, workspaceId: ctx.workspaceId + "-other", userId: randomUUID() };
try {
  await ensureIdentity(identities, ctx); await ensureIdentity(identities, other);
  companyId = (await store.createCompany(ctx, { name: "Coding data verification" }, randomUUID())).id;
  projectId = (await store.createProject(ctx, companyId, { name: "Temporary site", type: "code_project" }, randomUUID())).project.id;
  backend = await backends.create(ctx, companyId, { name: "Temporary coding database" });
  await backends.attach(ctx, companyId, projectId, backend.id);
  const untouchedProduction = await provider.introspectSchema(backend, "prod");
  const flags = new FeatureFlagService(store, undefined, { enabledByDefault: true });
  const policy = new PolicyEngine({ flags, capabilities: defaultCapabilityRegistry, sessionMode: async () => "auto" });
  const port: CodeReadPort = { listDir: async () => ({ entries: [] }), readFile: async () => { throw Error("No file read expected"); }, runSearch: async () => ({ matches: [], truncated: false }) };
  const approvals: CodeApprovalPort = {
    request: async input => { const row = await approvalsRepo.requestApproval(input.ctx, input.companyId, input); return { approvalId: row.id, expiresAt: row.expiresAt }; },
    consume: async input => { await approvalsRepo.consumeApproved(input.ctx, input.companyId, input.approvalId, input); },
  };
  const runtime = new CodeToolRuntime({ store, flags, approvals, audit: new AuditLogService(store), toPort: () => port,
    reviewScope: { allows: isReviewSafeTool }, wrap: (_tool, value) => value, executors: codeDataExecutors({ projectData, dataPolicy: policy }) });
  const invoke = (tool: string, args: Record<string, unknown> = {}, selectedProject = projectId!, approvalId?: string) => runtime.invoke(ctx, {
    companyId: companyId!, projectId: selectedProject, tool, args, toolCallId: randomUUID(), sessionId: "diagnostic-session", runId: "diagnostic-run", agentId: "diagnostic-agent", approvalId,
  });
  const inspected = await invoke("code.data.schema.inspect"); assert(inspected.ok, JSON.stringify(inspected));
  const before = await projectData.inspectSchema(ctx, companyId, projectId);
  const operation = { kind: "create_collection", collection: "products", fields: [{ name: "title", type: "text" }] };
  const preview = await invoke("code.data.schema.apply", { operation, expectedFingerprint: before.environment.schemaFingerprint, dryRun: true });
  assert(preview.ok, JSON.stringify(preview));
  assert(!(await provider.introspectSchema(backend, "dev")).tables.some(t => t.name === "products"));
  const applied = await invoke("code.data.schema.apply", { operation, expectedFingerprint: before.environment.schemaFingerprint });
  assert(applied.ok, JSON.stringify(applied));
  assert((await provider.introspectSchema(backend, "dev")).tables.some(t => t.name === "products"));
  const stale = await invoke("code.data.schema.apply", { operation: { kind: "add_field", collection: "products", field: { name: "note", type: "text" } }, expectedFingerprint: before.environment.schemaFingerprint });
  assert.equal(stale.ok, false, "Old schema fingerprint must fail");
  const after = await projectData.inspectSchema(ctx, companyId, projectId);
  assert((await invoke("code.data.schema.apply", { operation: { kind: "add_field", collection: "products", field: { name: "price", type: "decimal" } }, expectedFingerprint: after.environment.schemaFingerprint })).ok);
  const live = await projectData.inspectSchema(ctx, companyId, projectId);
  assert((await invoke("code.data.schema.apply", { operation: { kind: "create_index", collection: "products", fields: ["title"] }, expectedFingerprint: live.environment.schemaFingerprint })).ok);
  assert.deepEqual(await provider.introspectSchema(backend, "prod"), untouchedProduction);
  foreignCompanyId = (await store.createCompany(other, { name: "Foreign fixture" }, randomUUID())).id;
  foreignProjectId = (await store.createProject(other, foreignCompanyId, { name: "Foreign site", type: "code_project" }, randomUUID())).project.id;
  assert.equal((await invoke("code.data.schema.inspect", {}, foreignProjectId)).ok, false);
  assert.equal((await invoke("code.data.schema.apply", { operation, expectedFingerprint: live.environment.schemaFingerprint }, foreignProjectId)).ok, false);
  const confirmed = async (tool: string, args: Record<string, unknown>) => {
    const pending = await invoke(tool, args);
    assert(!pending.ok && pending.error.code === "approval_required", JSON.stringify(pending));
    const approvalId = pending.error.details?.approvalId as string;
    await approvalsRepo.decide(ctx, companyId!, approvalId, "approved", "Explicit consent for temporary diagnostic fixture");
    const result = await invoke(tool, args, projectId, approvalId);
    assert(result.ok, JSON.stringify(result)); return result;
  };
  const modify = async (operation: Record<string, unknown>) => {
    const current = await projectData.inspectSchema(ctx, companyId!, projectId!);
    return confirmed("code.data.schema.modify", { expectedBackendId: backend!.id, expectedFingerprint: current.environment.schemaFingerprint, operation });
  };
  const converted = (await projectData.createRow(ctx, companyId, projectId, "products", { title: "Numeric conversion", price: 123 })).row!;
  const elapsed: Record<string, number> = {};
  let start = performance.now(); await projectData.inspectSchema(ctx, companyId, projectId); elapsed.inspectMs = Math.round(performance.now() - start);
  await modify({ kind: "alter_field", collection: "products", field: { name: "price", type: "text" } });
  assert((await provider.introspectSchema(backend, "dev")).tables.find(t => t.name === "products")!.columns.some(c => c.name === "price" && c.type === "text"));
  await projectData.updateRow(ctx, companyId, projectId, "products", converted.id as string, { price: "not-a-number" });
  const badCastArgs = { expectedBackendId: backend.id, expectedFingerprint: (await projectData.inspectSchema(ctx, companyId, projectId)).environment.schemaFingerprint, operation: { kind: "alter_field", collection: "products", field: { name: "price", type: "integer" } } };
  const badCastPending = await invoke("code.data.schema.modify", badCastArgs); assert(!badCastPending.ok);
  const badCastApproval = badCastPending.error.details?.approvalId as string; await approvalsRepo.decide(ctx, companyId, badCastApproval, "approved");
  assert.equal((await invoke("code.data.schema.modify", badCastArgs, projectId, badCastApproval)).ok, false);
  assert.equal((await projectData.readRow(ctx, companyId, projectId, "products", converted.id as string)).row!.price, "not-a-number");
  await projectData.updateRow(ctx, companyId, projectId, "products", converted.id as string, { price: "123" });
  await modify({ kind: "alter_field", collection: "products", field: { name: "price", type: "integer" } });
  assert.equal(String((await projectData.readRow(ctx, companyId, projectId, "products", converted.id as string)).row!.price), "123");
  await modify({ kind: "drop_field", collection: "products", field: "price" });
  assert(!(await provider.introspectSchema(backend, "dev")).tables.find(t => t.name === "products")!.columns.some(c => c.name === "price"));
  const publicRead = async (collection: string) => {
    await authService.applyAccessPolicies(ctx, companyId!, projectId!, "dev", [{ collection, actions: ["select"], rule: "public" }]);
    const schema = await provider.introspectSchema(backend!, "dev");
    await repository.setExpectedSchema(ctx, companyId!, backend!.id, "dev", schema, provider.schemaFingerprint(schema));
  };
  await publicRead("products");
  await modify({ kind: "rename_collection", collection: "products", next: "catalog" });
  assert((await repository.getAccessPolicies(ctx, companyId, backend.id, "dev")).some(p => p.collection === "catalog"));
  const schema = await projectData.inspectSchema(ctx, companyId, projectId);
  assert((await invoke("code.data.schema.apply", { operation: { kind: "create_collection", collection: "archive", fields: [{ name: "title", type: "text" }] }, expectedFingerprint: schema.environment.schemaFingerprint })).ok);
  const rowA = (await projectData.createRow(ctx, companyId, projectId, "catalog", { title: "A" })).row!;
  const rowB = (await projectData.createRow(ctx, companyId, projectId, "catalog", { title: "B" })).row!;
  const fingerprint = (await projectData.inspectSchema(ctx, companyId, projectId)).environment.schemaFingerprint;
  const transfer = { expectedBackendId: backend.id, expectedFingerprint: fingerprint, source: "catalog", target: "archive", mode: "copy", ids: [rowA.id], fields: [{ source: "title", target: "title" }] };
  assert((await invoke("code.data.rows.transfer", { ...transfer, dryRun: true })).ok);
  assert.equal((await projectData.listRows(ctx, companyId, projectId, "archive")).rows.length, 0);
  start = performance.now(); await confirmed("code.data.rows.transfer", transfer); elapsed.copyWithApprovalMs = Math.round(performance.now()-start);
  assert((await projectData.readRow(ctx, companyId, projectId, "catalog", rowA.id as string)).row);
  assert((await projectData.readRow(ctx, companyId, projectId, "archive", rowA.id as string)).row);
  // Duplicate target ID must fail atomically without deleting the source.
  const conflictArgs = { ...transfer, mode: "move" };
  const conflictPending = await invoke("code.data.rows.transfer", conflictArgs); assert(!conflictPending.ok);
  const conflictApproval = conflictPending.error.details?.approvalId as string;
  await approvalsRepo.decide(ctx, companyId, conflictApproval, "approved");
  assert.equal((await invoke("code.data.rows.transfer", conflictArgs, projectId, conflictApproval)).ok, false);
  assert((await projectData.readRow(ctx, companyId, projectId, "catalog", rowA.id as string)).row);
  await confirmed("code.data.rows.transfer", { ...transfer, mode: "move", ids: [rowB.id] });
  assert.equal((await projectData.readRow(ctx, companyId, projectId, "catalog", rowB.id as string)).row, null);
  assert((await projectData.readRow(ctx, companyId, projectId, "archive", rowB.id as string)).row);
  assert((await invoke("code.data.rows.list", { expectedBackendId: backend.id, collection: "archive" })).ok);
  for (const name of ["Second website", "Mobile application"]) {
    const target: Project = (await store.createProject(ctx, companyId, { name, type: "code_project" }, randomUUID())).project;
    extraProjects.push(target.id);
    const targets = await invoke("code.data.backend.attach", { expectedBackendId: backend.id, dryRun: true });
    assert(targets.ok);
    assert((targets.result as { targets: Array<{ projectId: string }> }).targets.some(t => t.projectId === target.id));
    const args = { expectedBackendId: backend.id, targetProjectId: target.id, expectedTargetBackendId: null };
    assert((await invoke("code.data.backend.attach", { ...args, dryRun: true })).ok);
    await confirmed("code.data.backend.attach", args);
    assert.equal((await store.getProject(ctx, companyId, target.id)).dataBackendId, backend.id);
    assert.equal((await projectData.listRows(ctx, companyId, target.id, "archive")).rows.length, 2);
  }
  await publicRead("archive");
  for (const id of [projectId, ...extraProjects]) {
    const environment = await gateway.getSandboxEnvironment(ctx, companyId, id);
    assert(environment.PROJECT_API_URL?.endsWith("/"+id));
    const response = await fetch("http://127.0.0.1:3001/v1/projects/"+id+"/data/archive", { headers: { "x-project-key": environment.PROJECT_PUBLISHABLE_KEY! } });
    const result = await response.json() as { data?: unknown[]; rows?: unknown[] };
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal((result.data ?? result.rows)?.length, 2, JSON.stringify(result));
  }
  // A stale expected attachment cannot silently replace the target database.
  const staleAttach = { expectedBackendId: backend.id, targetProjectId: extraProjects[0], expectedTargetBackendId: null };
  const attachPending = await invoke("code.data.backend.attach", staleAttach); assert(!attachPending.ok);
  const attachApproval = attachPending.error.details?.approvalId as string; await approvalsRepo.decide(ctx, companyId, attachApproval, "approved");
  assert.equal((await invoke("code.data.backend.attach", staleAttach, projectId, attachApproval)).ok, false);
  assert.equal((await invoke("code.data.backend.attach", { expectedBackendId: backend.id, targetProjectId: foreignProjectId, expectedTargetBackendId: null, dryRun: true })).ok, false);
  await modify({ kind: "drop_collection", collection: "catalog" });
  assert(!(await provider.introspectSchema(backend, "dev")).tables.some(t => t.name === "catalog"));
  assert(!(await repository.getAccessPolicies(ctx, companyId, backend.id, "dev")).some(p => p.collection === "catalog"));
  assert.deepEqual(await provider.introspectSchema(backend, "prod"), untouchedProduction);
  const snapshots = await repository.pool.query("SELECT count(*)::integer AS count FROM data_backend_snapshots WHERE backend_id=$1", [backend.id]); assert(snapshots.rows[0].count >= 4);
  const connection = await provisioner.getConnection(backend, "dev", "runtime");
  const database = new Pool(connection);
  try {
    const roles = await database.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(roles.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    await assert.rejects(database.query("CREATE TABLE forbidden(id integer)"));
  } finally { await database.end(); }
  console.log(JSON.stringify({ passed: true, createTable: true, addField: true, createIndex: true, dryRun: true, staleSchemaDenied: true, foreignProjectDenied: true, productionUnchanged: true, runtimeDdlDenied: true, renameTable: true, changeType: true, invalidCastRollback: true, deleteField: true, deleteTable: true, copyRows: true, moveRows: true, conflictRollback: true, sharedDatabaseAcrossThreeProjects: true, sharedProjectApiHttp: true, staleAttachmentDenied: true, snapshots: true, timings: elapsed }));
} finally {
  // Release cached runtime connections before removing the temporary databases.
  await gateway.close(); await authService.close(); await provider.close();
  if (foreignCompanyId && foreignProjectId) await store.deleteProject(other, foreignCompanyId, foreignProjectId);
  if (companyId) for (const id of extraProjects) await store.deleteProject(ctx, companyId, id);
  if (companyId && projectId) await store.deleteProject(ctx, companyId, projectId);
  if (companyId && backend) {
    const snapshots = await repository.pool.query<{ filePath: string }>('SELECT file_path AS "filePath" FROM data_backend_snapshots WHERE backend_id=$1', [backend.id]);
    await backends.remove(ctx, companyId, backend.id, backend.name, { immediate: true });
    for (const snapshot of snapshots.rows) {
      assert.equal(path.dirname(path.resolve(snapshot.filePath)), "/tmp/coding-data-check");
      assert(/^[0-9a-f-]{36}\.dump$/.test(path.basename(snapshot.filePath)));
      await unlink(snapshot.filePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  }
  if (companyId) await store.deleteCompany(ctx, companyId);
  if (foreignCompanyId) await store.deleteCompany(other, foreignCompanyId);
  await provisioner.close(); await repository.close(); await store.close(); await identities.end(); await approvalsRepo.close();
}
