import { describe, expect, it, vi } from "vitest";
import { withAuthPolicySchemaSnapshot } from "../apps/agent-api/src/data-studio/auth-policy-schema-snapshot";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
const provider = new PostgresDataProvider();
const before = { tables: [{ name: "products", columns: [{ name: "title", type: "text", nullable: false }], policies: ["management"], indexes: [], constraints: [], rlsEnabled: true, rlsForced: true }] };
const after = structuredClone(before); after.tables[0]!.policies.push("public_select");
function fixture() {
  const schemaProvider = { schemaFingerprint: (schema: typeof before) => provider.schemaFingerprint(schema), introspectSchema: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after) };
  const repository = { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}), setExpectedSchema: vi.fn(async () => {}),
    environment: vi.fn(async () => ({ syncStatus: "synced", schemaFingerprint: provider.schemaFingerprint(before) })) };
  const work = vi.fn(async () => ({ compiled: 1 }));
  const invoke = (environment = "dev") => withAuthPolicySchemaSnapshot({ schemaProvider, repository } as never, { workspaceId: "w", userId: "u", permissions: [] },
    { id: "b", companyId: "c" } as never, environment as "dev", [{ collection: "products", rule: "public", actions: ["select"] }], work);
  return { schemaProvider, repository, work, invoke };
}
describe("managed dev auth-policy schema snapshot", () => {
  it("records exactly the managed policy change under the existing migration lock", async () => {
    const f = fixture(); expect(await f.invoke()).toEqual({ compiled: 1 });
    expect(f.repository.acquireLock).toHaveBeenCalledOnce();
    expect(f.repository.setExpectedSchema).toHaveBeenCalledWith(expect.anything(), "c", "b", "dev", after, provider.schemaFingerprint(after));
    expect(f.repository.releaseLock).toHaveBeenCalledOnce();
  });
  it("refuses existing drift without applying policies or accepting a new snapshot", async () => {
    const f = fixture(); f.repository.environment.mockResolvedValueOnce({ syncStatus: "synced", schemaFingerprint: "unexpected" });
    await expect(f.invoke()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(f.work).not.toHaveBeenCalled(); expect(f.repository.setExpectedSchema).not.toHaveBeenCalled();
    expect(f.repository.releaseLock).toHaveBeenCalledOnce();
  });
  it("does not bless concurrent column changes as an authorized policy change", async () => {
    const f = fixture(), changed = structuredClone(after); changed.tables[0]!.columns.push({ name: "unexpected", type: "text", nullable: false });
    f.schemaProvider.introspectSchema.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(changed);
    await expect(f.invoke()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    expect(f.repository.setExpectedSchema).not.toHaveBeenCalled();
  });
  it("preserves production behavior and releases the lock on a failed managed operation", async () => {
    const f = fixture(); await f.invoke("prod"); expect(f.repository.acquireLock).not.toHaveBeenCalled();
    const g = fixture(); g.work.mockRejectedValueOnce(new Error("failed"));
    await expect(g.invoke()).rejects.toThrow("failed"); expect(g.repository.releaseLock).toHaveBeenCalledOnce();
    expect(g.repository.setExpectedSchema).not.toHaveBeenCalled();
  });
});
