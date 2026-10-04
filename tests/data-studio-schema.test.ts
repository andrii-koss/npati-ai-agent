import { describe, expect, it } from "vitest";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";

const provider = new PostgresDataProvider({ maxCollections: 20, maxFields: 30, maxRows: 100 });

describe("Data Studio schema compiler", () => {
  it("marks data loss as destructive even if structure can be recreated", () => {
    const change = provider.dropField("orders", "note");
    expect(change.destructive).toBe(true);
    expect(change.requiresSnapshot).toBe(true);
    expect(change.reversible).toBe(false);
  });

  it("enables and forces RLS on new collections", () => {
    const change = provider.createCollection("orders", [{ name: "title", type: "string" }]);
    expect(change.upSql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(change.upSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(change.upSql).not.toContain("CREATE POLICY");
  });

  it("enforces collection and field limits", () => {
    expect(() => provider.createCollection("orders", Array.from({ length: 31 }, (_, i) => ({ name: "f" + i, type: "text" as const })))).toThrow();
    expect(() => provider.createCollection("orders", [{ name: "title", type: "text" }, { name: "title", type: "text" }])).toThrow();
  });
});
