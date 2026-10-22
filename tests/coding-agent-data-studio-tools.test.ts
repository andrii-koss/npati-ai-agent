import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import type { CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { CODE_WRITE_TOOLS } from "../apps/agent-api/src/code-edit-approval";
import { READ_TOOLS, WRITE_TOOLS } from "../apps/agent-api/src/code-policy-tools";
import { codeDataStudioExecutors } from "../apps/agent-api/src/code-data-studio-tools";
import { DataStudioError } from "../apps/agent-api/src/data-studio/identifier";

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function execution(tool: string, args: Record<string, unknown>, approved = false): CodeToolExecutionContext {
  const schema = CODE_TOOL_SCHEMAS.find((entry) => entry.name === tool)!;
  return { ctx, companyId: "company-1", projectId: "project-1", sessionId: "session-1", runId: "run-1", tool: schema, args, toolCallId: "call-1", approved } as unknown as CodeToolExecutionContext;
}

function service() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return method === "createRow" ? { row: { id: "r" + calls.length } } : { ok: true }; };
  return {
    calls,
    projectData: {
      assertBackend: record("assertBackend"),
      listRows: record("listRows"),
      createRow: record("createRow"),
      listMigrations: record("listMigrations"),
      inspectAuth: record("inspectAuth"),
      configureAuth: record("configureAuth"),
    } as never,
  };
}
const allow = { evaluate: async () => ({ decision: "allow" as const }) } as never;
const deny = { evaluate: async () => ({ decision: "deny" as const, status: 403, code: "mode_denied" }) } as never;

describe("Data Studio tools for the Coding Agent (manifest v15)", () => {
  it("classifies reads and writes through the existing sets: both writes are approval-gated writes", () => {
    for (const read of ["code.data.query.read", "code.data.migrations.list", "code.data.policies.inspect"]) {
      expect(READ_TOOLS.has(read)).toBe(true);
      expect(CODE_WRITE_TOOLS.has(read)).toBe(false);
    }
    for (const write of ["code.data.rows.seed", "code.data.policies.apply"]) {
      expect(WRITE_TOOLS.has(write)).toBe(true);
      expect(CODE_WRITE_TOOLS.has(write)).toBe(true);
    }
    for (const name of ["code.data.query.read", "code.data.rows.seed", "code.data.policies.apply"]) {
      const schema = CODE_TOOL_SCHEMAS.find((entry) => entry.name === name)!;
      expect(JSON.stringify(schema.inputSchema)).not.toMatch(/"sql"|"query"\s*:\s*\{\s*"type"\s*:\s*"string"/i);
    }
  });

  it("query.read passes structured filters to the service and refuses anything else", async () => {
    const s = service();
    const tools = codeDataStudioExecutors({ projectData: s.projectData, dataPolicy: allow });
    await tools["code.data.query.read"]!(execution("code.data.query.read", {
      expectedBackendId: "b1", collection: "orders", filters: [{ field: "status", operator: "eq", value: "paid" }], sort: { field: "created_at", direction: "desc" }, limit: 20,
    }));
    expect(s.calls.map((call) => call.method)).toEqual(["assertBackend", "listRows"]);
    expect(s.calls[1]!.args.slice(3)).toEqual(["orders", { filters: [{ field: "status", operator: "eq", value: "paid" }], sort: { field: "created_at", direction: "desc" }, limit: 20 }]);
    await expect(tools["code.data.query.read"]!(execution("code.data.query.read", { expectedBackendId: "b1", collection: "orders", filters: [{ field: "x", operator: "OR 1=1", value: 1 }] })))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(tools["code.data.query.read"]!(execution("code.data.query.read", { expectedBackendId: "b1", collection: "orders; drop table x" })))
      .rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("rows.seed never writes without approval, previews on dryRun and validates every row", async () => {
    const s = service();
    const tools = codeDataStudioExecutors({ projectData: s.projectData, dataPolicy: allow });
    const args = { expectedBackendId: "b1", collection: "products", rows: [{ name: "Mug", price: 12 }, { name: "Bowl", price: 20 }] };
    await expect(tools["code.data.rows.seed"]!(execution("code.data.rows.seed", { ...args, dryRun: false }))).rejects.toMatchObject({ code: "approval_required" });
    expect(s.calls).toEqual([]);
    await expect(tools["code.data.rows.seed"]!(execution("code.data.rows.seed", { ...args, dryRun: true }))).resolves.toMatchObject({ dryRun: true, rowCount: 2, environment: "dev" });
    expect(s.calls.some((call) => call.method === "createRow")).toBe(false);
    await expect(tools["code.data.rows.seed"]!(execution("code.data.rows.seed", { ...args, dryRun: false }, true))).resolves.toMatchObject({ applied: true, rowCount: 2, environment: "dev" });
    expect(s.calls.filter((call) => call.method === "createRow")).toHaveLength(2);
    await expect(tools["code.data.rows.seed"]!(execution("code.data.rows.seed", { ...args, rows: [{ id: "x" }] }, true))).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(tools["code.data.rows.seed"]!(execution("code.data.rows.seed", { ...args, rows: Array.from({ length: 51 }, () => ({ name: "n" })) }, true))).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("policies.apply goes through the Data Studio RLS compiler only with approval", async () => {
    const s = service();
    const tools = codeDataStudioExecutors({ projectData: s.projectData, dataPolicy: allow });
    const policies = [{ collection: "orders", rule: "owner", ownerField: "user_id", actions: ["select", "update"] }];
    await expect(tools["code.data.policies.apply"]!(execution("code.data.policies.apply", { expectedBackendId: "b1", policies, dryRun: false }))).rejects.toMatchObject({ code: "approval_required" });
    await expect(tools["code.data.policies.apply"]!(execution("code.data.policies.apply", { expectedBackendId: "b1", policies, dryRun: true }))).resolves.toMatchObject({ dryRun: true, policies });
    await tools["code.data.policies.apply"]!(execution("code.data.policies.apply", { expectedBackendId: "b1", policies, dryRun: false }, true));
    expect(s.calls.at(-1)).toEqual({ method: "configureAuth", args: [ctx, "company-1", "project-1", { policies }, { approved: true }] });
    await expect(tools["code.data.policies.apply"]!(execution("code.data.policies.apply", { expectedBackendId: "b1", policies: [{ collection: "orders", rule: "owner", actions: ["select"] }], dryRun: true })))
      .rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("is refused by the coding policy before touching the service, and maps Data Studio errors", async () => {
    const s = service();
    await expect(codeDataStudioExecutors({ projectData: s.projectData, dataPolicy: deny })["code.data.migrations.list"]!(execution("code.data.migrations.list", { expectedBackendId: "b1" })))
      .rejects.toMatchObject({ code: "policy_denied" });
    expect(s.calls).toEqual([]);
    const failing = { ...service().projectData as object, assertBackend: async () => { throw new DataStudioError(409, "project_data", "Project database attachment changed", false, "BACKEND_CHANGED"); } } as never;
    await expect(codeDataStudioExecutors({ projectData: failing, dataPolicy: allow })["code.data.policies.inspect"]!(execution("code.data.policies.inspect", { expectedBackendId: "stale" })))
      .rejects.toMatchObject({ code: "project_data_error" });
  });
});
