import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { CompanyApprovalsRepository } from "../apps/agent-api/src/approvals-repository";

// Explicit opt-in; the adapter executes the repository's actual SQL on the isolated stand's PostgreSQL.
const fixturePath = process.env.NPATI_V5_DB_PROOF;
describe.skipIf(!fixturePath)("durable approval without run/agent (isolated PostgreSQL)", () => {
  it("consumes an exact approved action once, while rejecting a substituted context or payload", async () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath!, "utf8")) as { companyId: string; ctx: AuthContext };
    const query = async (sql: string, params: unknown[] = []) => {
      const literal = (v: unknown) => v === null || v === undefined ? "NULL" : `'${String(v instanceof Date ? v.toISOString() : v).replace(/'/g, "''")}'`;
      const rendered = sql.replace(/\$(\d+)/g, (_s, n: string) => literal(params[Number(n) - 1]));
      const wrapped = `WITH proof AS (${rendered}) SELECT coalesce(json_agg(proof), '[]'::json) FROM proof;`;
      const output = execFileSync("docker", ["exec", "-i", "npati-isolated-source-20261011-postgres-1", "sh", "-c",
        'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -tA -v ON_ERROR_STOP=1'],
      { input: wrapped, encoding: "utf8", timeout: 10000 });
      return { rows: JSON.parse(output.trim()) as Array<Record<string, unknown>> };
    };
    const repo = new CompanyApprovalsRepository("postgres://unused");
    Object.assign(repo, { pool: { query } });
    const payload = { proof: "Stage05-null-context", commandHash: "synthetic-proof" };
    const row = await repo.requestApproval(fixture.ctx, fixture.companyId, { toolName: "code.shell.exec", actionSummary: "Stage05 synthetic proof", inputPayload: payload });
    try {
      await repo.decide(fixture.ctx, fixture.companyId, row.id, "approved");
      const input = { runId: "", agentId: "", toolName: "code.shell.exec", inputPayload: payload };
      await expect(repo.consumeApproved(fixture.ctx, fixture.companyId, row.id, { ...input, runId: "different" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
      await expect(repo.consumeApproved(fixture.ctx, fixture.companyId, row.id, { ...input, inputPayload: { proof: "substituted" } })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
      await expect(repo.consumeApproved(fixture.ctx, fixture.companyId, row.id, input)).resolves.toMatchObject({ id: row.id });
      await expect(repo.consumeApproved(fixture.ctx, fixture.companyId, row.id, input)).rejects.toMatchObject({ code: "APPROVAL_ALREADY_USED" });
    } finally {
      await query("DELETE FROM company_approvals WHERE id=$1 AND company_id=$2 RETURNING id", [row.id, fixture.companyId]);
    }
  });
});
