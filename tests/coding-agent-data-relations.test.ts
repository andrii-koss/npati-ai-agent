import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CodeToolExecutionContext } from "../apps/agent-api/src/code-tool-runtime";
import { codeDataExecutors } from "../apps/agent-api/src/code-data-tools";
import { CODE_TOOL_SCHEMAS, resolveManifestForSession, schemasForToolManifest } from "../apps/agent-api/src/code-tool-registry";
import { CodingAgentToolCatalog } from "../apps/agent-api/src/coding-agent-tool-catalog";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
const operation = { kind: "create_relation", collection: "products", target: "categories", name: "category", field: "category_id", cardinality: "many-to-one" } as const;
function fixture(version = 2) {
  const applySchema = vi.fn(async () => ({ applied: true }));
  const assertBackend = vi.fn(async () => undefined);
  const evaluate = vi.fn(async () => ({ decision: "allow" }));
  const tools = codeDataExecutors({ projectData: { inspectSchema: vi.fn(), applySchema, assertBackend } as never, dataPolicy: { evaluate } as never });
  const input = { ctx: { userId: "owner", workspaceId: "ws", permissions: ["workspace:write"] }, companyId: "company", projectId: "project", runId: "run",
    tool: CODE_TOOL_SCHEMAS.find(t => t.name === "code.data.schema.apply" && t.version === version)!,
    args: { operation, expectedBackendId: "attached", expectedFingerprint: "current", dryRun: true }, approved: false } as unknown as CodeToolExecutionContext;
  return { input, applySchema, assertBackend, evaluate, invoke: () => tools["code.data.schema.apply"](input) };
}
describe("schema.apply@2 foreign keys", () => {
  it("preserves the exact v1 publication and every old manifest", () => {
    const previous = JSON.parse(readFileSync(new URL("./fixtures/code-tool-schema-v15.json", import.meta.url), "utf8"));
    // The same tools at the same versions as published; the data tools' descriptions and optional fields grew in place (v19-v22).
    expect(resolveManifestForSession(15).tools.map(t => t.key)).toEqual(previous.tools.map((t: { key: string }) => t.key));
    for (let version = 1; version <= 15; version++)
      expect(schemasForToolManifest(version).filter(t => t.name === "code.data.schema.apply").every(t => t.version === 1)).toBe(true);
    const v1 = fixture(1);
    return expect(v1.invoke()).rejects.toMatchObject({ code: "invalid_arguments" });
  });
  it("checks the attached backend and forwards dry-run to the existing dev service without granting approval", async () => {
    const f = fixture(); await f.invoke();
    expect(f.assertBackend).toHaveBeenCalledWith(f.input.ctx, "company", "project", "attached");
    expect(f.applySchema).toHaveBeenCalledWith(f.input.ctx, "company", "project", operation,
      expect.objectContaining({ expectedBackendId: "attached", expectedFingerprint: "current", dryRunOnly: true, approved: false }));
    const sql = new PostgresDataProvider().compileOperation(operation).upSql;
    expect(sql).toContain('FOREIGN KEY ("category_id") REFERENCES "categories"(id)');
  });
  it("refuses invalid relation cardinalities and unexpected SQL before service execution", async () => {
    for (const relation of [{ ...operation, cardinality: "execute_sql" }, { ...operation, sql: "DROP TABLE products" }, { ...operation, target: "categories;drop" }]) {
      const f = fixture(); f.input.args.operation = relation;
      await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(f.applySchema).not.toHaveBeenCalled();
    }
  });
  it("does not bypass policy or attachment failures", async () => {
    const f = fixture(); f.evaluate.mockResolvedValueOnce({ decision: "deny" });
    await expect(f.invoke()).rejects.toMatchObject({ code: "policy_denied" });
    expect(f.assertBackend).not.toHaveBeenCalled(); expect(f.applySchema).not.toHaveBeenCalled();
    const g = fixture(); g.assertBackend.mockRejectedValueOnce(new Error("attachment changed"));
    await expect(g.invoke()).rejects.toThrow("attachment changed"); expect(g.applySchema).not.toHaveBeenCalled();
  });
  it("exposes one model function per name with v1 on an old session and v2 on a new one", () => {
    const catalog = new CodingAgentToolCatalog({ toolRuntime: { listTools: () => CODE_TOOL_SCHEMAS.map(t => ({ ...t, write: true })) } } as never, resolveCodeAgentLimits());
    for (const [manifest, version] of [[15, 1], [16, 2]]) {
      const session = { mode: "auto", toolManifestVersion: manifest } as never;
      const tools = catalog.toolDescriptors(session).filter(t => t.name === "code.data.schema.apply");
      expect(tools).toHaveLength(1); expect(tools[0]!.version).toBe(version);
      expect(catalog.toolSchemaByName([], session).get("code.data.schema.apply")!.version).toBe(version);
    }
  });
});

it.skipIf(process.env.NPATI_LIVE_LOCAL_FK !== "1")("enforces the v2 FK SQL on local PostgreSQL temporary tables (no persistent schema changes)", () => {
  const provider = new PostgresDataProvider();
  const change = provider.compileOperation({ ...operation, collection: "qa_fk_products", target: "qa_fk_categories", name: "qa_category" });
  const sql = [
    "BEGIN;",
    "CREATE TEMP TABLE qa_fk_categories(id uuid PRIMARY KEY) ON COMMIT DROP;",
    "CREATE TEMP TABLE qa_fk_products(id uuid PRIMARY KEY,category_id uuid) ON COMMIT DROP;",
    change.upSql,
    "INSERT INTO qa_fk_categories VALUES ('11111111-1111-4111-8111-111111111111');",
    "INSERT INTO qa_fk_products VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');",
    "DO $$ BEGIN",
    "  BEGIN",
    "    INSERT INTO qa_fk_products VALUES ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');",
    "    RAISE EXCEPTION 'FK did not reject the orphan';",
    "  EXCEPTION WHEN foreign_key_violation THEN NULL; END;",
    "END $$;",
    "SELECT 'FK_PASS:' || count(*) FROM qa_fk_products;",
    "ROLLBACK;",
  ].join("\n");
  const output = execFileSync("docker", ["exec", "-i",
    process.env.NPATI_FOLLOWUP_PG_CONTAINER ?? "npati-isolated-source-20261011-postgres-projects-1",
    "sh", "-c", 'psql -X -qAt -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1'],
    { input: sql, encoding: "utf8", timeout: 10000 });
  expect(output).toContain("FK_PASS:1");
});
