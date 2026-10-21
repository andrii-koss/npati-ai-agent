import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { defaultCapabilityRegistry, CODE_TOOL_SCHEMA_MIRROR } from "@npati/shared";
import { CodeToolRuntime, type CodeReadPort } from "../apps/agent-api/src/code-tool-runtime";
import { codeDataExecutors } from "../apps/agent-api/src/code-data-tools";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { PolicyEngine, isReviewSafeTool } from "../apps/agent-api/src/code-policy-engine";
import { DataStudioError } from "../apps/agent-api/src/data-studio/identifier";
import { CODE_TOOL_SCHEMAS, resolveManifestForSession } from "../apps/agent-api/src/code-tool-registry";
import { isReadOnlyRunTool } from "../apps/agent-api/src/coding-agent-runner-contracts";
import type { CodeApprovalPort } from "../apps/agent-api/src/code-workspace-checkpoint";

const ctx: AuthContext = { userId: "owner", workspaceId: "data-code", permissions: ["admin:all", "workspace:read", "workspace:write"] };
const port: CodeReadPort = { listDir: vi.fn(), readFile: vi.fn(), runSearch: vi.fn() };
const operation = { kind: "create_collection", collection: "products", fields: [{ name: "title", type: "text" }] };
async function fixture(mode = "auto", approvals?: CodeApprovalPort) {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(ctx, { name: "Data coding" }, "data-code-company");
  const flags = new FeatureFlagService(store, undefined, { enabledByDefault: true });
  const projectData = {
    inspectSchema: vi.fn(async () => ({ backend: { id: "db", name: "Site DB", status: "ready" as const }, environment: { name: "dev", syncStatus: "synced" as const, schemaFingerprint: "before" }, schema: { tables: [] }, expectedSchema: null })),
    applySchema: vi.fn(),
    createBackend: vi.fn(async()=>({created:true,backend:{id:"db",name:"Orders",status:"ready"},environment:{PROJECT_API_URL:"https://api.test/v1/projects/selected-site",PROJECT_PUBLISHABLE_KEY:"public"}})),
    assertBackend: vi.fn(),
    listRows: vi.fn(async () => ({ rows: [] })),
    transferRows: vi.fn(async () => ({ applied: true, rows: 1, transferId: crypto.randomUUID(), source: "products", target: "archive", mode: "move" as const, snapshotId: null })),
    attachToProject: vi.fn(async () => ({ attached: true, backendId: "db", targetProjectId: "second-site", previousBackendId: null })),
  };
  projectData.applySchema.mockResolvedValue({ applied: true, fingerprint: "after" });
  const policy = new PolicyEngine({ flags, capabilities: defaultCapabilityRegistry, sessionMode: async () => mode as "auto", });
  const runtime = new CodeToolRuntime({ store, flags, approvals, toPort: () => port, wrap: (_tool, value) => value,
    reviewScope: { allows: isReviewSafeTool }, executors: codeDataExecutors({ projectData, dataPolicy: policy }) });
  const invoke = (tool: string, args = {}, extra = {}) => runtime.invoke(ctx, { companyId: company.id, projectId: "selected-site", sessionId: "session", tool, args, toolCallId: crypto.randomUUID(), ...extra });
  return { runtime, projectData, invoke, company };
}
describe("Coding Agent project database tools", () => {
  it("publishes new tools without changing the previous session manifest", () => {
    expect(resolveManifestForSession(11).tools).toHaveLength(43);
    expect(resolveManifestForSession(12).tools).toHaveLength(45);
    expect(resolveManifestForSession(12).checksum).toBe("caf264774bbf481acb49317361fd79495045380bc46516708b0571863e017a9a");
    expect(resolveManifestForSession(13).tools).toHaveLength(49);
    for (const name of ["code.data.schema.inspect", "code.data.schema.apply"]) {
      const tool = CODE_TOOL_SCHEMAS.find(t => t.name === name)!;
      expect(CODE_TOOL_SCHEMA_MIRROR[name]).toEqual({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema });
      expect(defaultCapabilityRegistry.get(name)).toBeDefined();
    }
  });
  it("inspects and applies a schema using server-selected context and revision", async () => {
    const f = await fixture();
    expect((await f.invoke("code.data.schema.inspect")).ok).toBe(true);
    expect(f.projectData.inspectSchema).toHaveBeenCalledWith(ctx, f.company.id, "selected-site");
    const args = { operation, expectedFingerprint: "before" };
    expect((await f.invoke("code.data.schema.apply", args)).ok).toBe(true);
    expect(f.projectData.applySchema).toHaveBeenCalledWith(ctx, f.company.id, "selected-site", operation, expect.objectContaining({ expectedFingerprint: "before", approved: false }));
  });
  it.each([{ operation }, { operation, expectedFingerprint: "before", projectId: "other" }, { operation, expectedFingerprint: "before", environment: "prod" }, { operation, expectedFingerprint: "before", approved: true }, { operation: { kind: "drop_collection", collection: "products" }, expectedFingerprint: "before" }])("rejects missing revision, target substitution, self-approval or destructive arguments: %j", async args => {
    const f = await fixture(); expect((await f.invoke("code.data.schema.apply", args)).ok).toBe(false);
    expect(f.projectData.applySchema).not.toHaveBeenCalled();
  });
  it("allows inspection in plan mode and refuses database changes", async () => {
    expect(isReadOnlyRunTool("code.data.schema.inspect")).toBe(true);
    expect(isReadOnlyRunTool("code.data.schema.apply")).toBe(false);
    const f = await fixture("plan"); expect((await f.invoke("code.data.schema.inspect")).ok).toBe(true);
    expect((await f.invoke("code.data.schema.apply", { operation, expectedFingerprint: "before" })).ok).toBe(false);
    expect(f.projectData.applySchema).not.toHaveBeenCalled();
  });
  it("refuses schema changes in a read-only review", async () => {
    const f = await fixture(); expect((await f.invoke("code.data.schema.apply", { operation, expectedFingerprint: "before" }, { readOnlyIntent: true })).ok).toBe(false);
    expect(f.projectData.applySchema).not.toHaveBeenCalled();
  });
  it("returns missing backend and stale-schema errors without claiming success", async () => {
    const f = await fixture();
    f.projectData.applySchema.mockRejectedValue(new DataStudioError(409, "apply", "Schema changed concurrently", false, "STALE_SCHEMA"));
    expect(await f.invoke("code.data.schema.apply", { operation, expectedFingerprint: "before" })).toMatchObject({ ok: false, error: { code: "project_data_error", details: { dataCode: "STALE_SCHEMA" } } });
  });
  it("never turns a Data Studio approval request into a successful migration", async () => {
    const f = await fixture(); f.projectData.applySchema.mockResolvedValue({ approvalRequired: true });
    expect(await f.invoke("code.data.schema.apply", { operation, expectedFingerprint: "before" })).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });
});

const modify = { expectedBackendId: "db", expectedFingerprint: "before", operation: { kind: "drop_collection", collection: "products" } };
function approvalFixture() {
  const records = new Map<string, string>();
  const approvals: CodeApprovalPort = {
    request: vi.fn(async input => { const id = crypto.randomUUID(); records.set(id, JSON.stringify(input.inputPayload)); return { approvalId: id }; }),
    consume: vi.fn(async input => { if (records.get(input.approvalId) !== JSON.stringify(input.inputPayload)) throw Object.assign(Error("Payload changed"), { code: "approval_invalid" }); records.delete(input.approvalId); }),
  };
  return { approvals };
}
describe("Coding Agent extended database operations", () => {
  it("previews destructive DDL without approving or applying it", async () => {
    const f = await fixture();
    expect((await f.invoke("code.data.schema.modify", { ...modify, dryRun: true })).ok).toBe(true);
    expect(f.projectData.applySchema).toHaveBeenCalledWith(ctx, f.company.id, "selected-site", modify.operation, expect.objectContaining({ approved: false, dryRunOnly: true, expectedBackendId: "db" }));
  });
  it("requires a human decision and binds it to exact schema arguments", async () => {
    const { approvals } = approvalFixture(); const f = await fixture("auto", approvals);
    const denied = await f.invoke("code.data.schema.modify", modify);
    expect(denied).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(f.projectData.applySchema).not.toHaveBeenCalled();
    const approvalId = denied.ok ? "" : denied.error.details?.approvalId;
    expect((await f.invoke("code.data.schema.modify", { ...modify, operation: { ...modify.operation, collection: "other" } }, { approvalId })).ok).toBe(false);
    expect(f.projectData.applySchema).not.toHaveBeenCalled();
    expect((await f.invoke("code.data.schema.modify", modify, { approvalId })).ok).toBe(true);
    expect(f.projectData.applySchema).toHaveBeenCalledWith(ctx, f.company.id, "selected-site", modify.operation, expect.objectContaining({ approved: true }));
    expect((await f.invoke("code.data.schema.modify", modify, { approvalId })).ok).toBe(false);
  });
  it.each(["code.data.schema.modify", "code.data.rows.transfer", "code.data.backend.attach"])("never offers %s as read-only", tool => expect(isReadOnlyRunTool(tool)).toBe(false));
  it("allows listing rows in planning mode", async () => {
    const f = await fixture("plan"); expect(isReadOnlyRunTool("code.data.rows.list")).toBe(true);
    expect((await f.invoke("code.data.rows.list", { expectedBackendId: "db", collection: "products", limit: 25 })).ok).toBe(true);
  });
  const transfer = { expectedBackendId: "db", expectedFingerprint: "before", source: "products", target: "archive", mode: "move", ids: ["11111111-1111-4111-8111-111111111111"], fields: [{ source: "title", target: "title" }] };
  const attach = { expectedBackendId: "db", targetProjectId: "second-site", expectedTargetBackendId: null };
  it.each([["code.data.rows.transfer", transfer], ["code.data.backend.attach", attach]] as const)("requires exact approval for %s", async (tool, args) => {
    const { approvals } = approvalFixture(); const f = await fixture("auto", approvals);
    const pending = await f.invoke(tool, args); expect(pending).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = pending.ok ? "" : pending.error.details?.approvalId;
    expect((await f.invoke(tool, args, { approvalId })).ok).toBe(true);
    expect((await f.invoke(tool, { ...args, approved: true })).ok).toBe(false);
  });
  it("blocks database access when the selected backend changed", async () => {
    const f = await fixture(); f.projectData.assertBackend.mockRejectedValue(new DataStudioError(409, "attachment", "Changed", false, "BACKEND_CHANGED"));
    expect(await f.invoke("code.data.schema.modify", { ...modify, dryRun: true })).toMatchObject({ ok: false, error: { details: { dataCode: "BACKEND_CHANGED" } } });
    expect(f.projectData.applySchema).not.toHaveBeenCalled();
  });
});

describe("on-demand project databases",()=>{
 it("does not provision when inspecting, and provisions only on an explicit tool call",async()=>{
  const f=await fixture();await f.invoke("code.data.schema.inspect");expect(f.projectData.createBackend).not.toHaveBeenCalled();
  const result=await f.invoke("code.data.backend.create",{name:"Orders",reason:"Persist customer orders shared across devices"});
  expect(result.ok).toBe(true);expect(f.projectData.createBackend).toHaveBeenCalledWith(ctx,f.company.id,"selected-site",{name:"Orders",reason:"Persist customer orders shared across devices"});
 });
 it.each(["plan"])("denies database creation in %s mode",async mode=>{
  const f=await fixture(mode);expect((await f.invoke("code.data.backend.create",{name:"Orders",reason:"Store orders"})).ok).toBe(false);
  expect(f.projectData.createBackend).not.toHaveBeenCalled();
 });
 it("denies read-only intent and target substitution",async()=>{
  const f=await fixture();
  expect((await f.invoke("code.data.backend.create",{name:"Orders",reason:"Store orders"},{readOnlyIntent:true})).ok).toBe(false);
  expect((await f.invoke("code.data.backend.create",{name:"Orders",reason:"Store orders",projectId:"foreign"})).ok).toBe(false);
  expect(f.projectData.createBackend).not.toHaveBeenCalled();
 });
 it("keeps previous manifests immutable and publishes creation only to new sessions",()=>{
  expect(resolveManifestForSession(13).tools.some(t=>t.name==="code.data.backend.create")).toBe(false);
  expect(resolveManifestForSession(14).tools.some(t=>t.name==="code.data.backend.create")).toBe(true);
 });
});
