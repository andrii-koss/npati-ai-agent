import { describe, expect, it } from "vitest";
import { runMigration060 } from "../packages/workspace/src/migration-060";

describe("Data Studio Core migration", () => {
  it("keeps backend ownership and Project attachment within one Company", async () => {
    const statements: string[] = [];
    await runMigration060({ query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; } } as never);
    const sql = statements.join("\n");
    expect(sql).toContain("FOREIGN KEY(workspace_id,company_id,data_backend_id)");
    expect(sql).toContain("REFERENCES data_backends(workspace_id,company_id,id)");
    expect(sql).toContain("data_backend_environments");
    expect(sql).toContain("data_backend_migration_locks");
    expect(sql).toContain("data_backend_access_policies");
  });
});
