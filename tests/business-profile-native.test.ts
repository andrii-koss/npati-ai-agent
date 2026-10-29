import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { executeBusinessProfileTool } from "../apps/agent-api/src/business-profile-native";

const auth: AuthContext = { workspaceId: "profile-workspace", userId: "profile-user", permissions: ["business:manage", "workspace:read", "workspace:write"] };

async function fixture() {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const create = (key: string, description: string) => executeBusinessProfileTool({
    store, auth, createRequestKey: key,
    args: { action: "create", profile: { name: "Same model name", description },
      goals: [{ title: "Launch", description }],
      memories: [{ type: "business_fact", title: "Idea", content: description }] },
  });
  return { store, create };
}

describe("Native Business Profile creation identity", () => {
  it("keeps independent same-name requests and their dependent records separate", async () => {
    const { store, create } = await fixture();
    const first = await create("request-one", "First independent idea");
    const second = await create("request-two", "Second independent idea");
    const third = await create("request-three", "Third independent idea");
    expect(new Set([first.businessId, second.businessId, third.businessId]).size).toBe(3);
    for (const [outcome, description] of [[first, "First independent idea"], [second, "Second independent idea"], [third, "Third independent idea"]] as const) {
      expect(outcome).toMatchObject({ complete: true, alreadyExisted: false });
      expect((await store.getUserBusiness(auth, outcome.businessId)).description).toBe(description);
      expect(await store.listGoals(auth, outcome.businessId)).toEqual([expect.objectContaining({ title: "Launch", description })]);
      expect(await store.listMemory(auth, outcome.businessId)).toEqual([expect.objectContaining({ title: "Idea", content: description })]);
    }
  });

  it("refuses an update that changes nothing instead of reporting a verified change", async () => {
    const { store, create } = await fixture();
    const first = await create("only", "Kept idea");
    const before = await store.getUserBusiness(auth, first.businessId);
    await expect(executeBusinessProfileTool({ store, auth, args: { action: "update", businessId: first.businessId, profile: {} } })).rejects.toThrow(/nothing was updated/);
    // Re-sending the stored name (seen live for a deletion request) is not a change either.
    await expect(executeBusinessProfileTool({ store, auth, args: { action: "update", businessId: first.businessId, profile: { name: "Same model name" } } })).rejects.toThrow(/nothing was updated/);
    expect(await store.getUserBusiness(auth, first.businessId)).toEqual(before);
    await expect(executeBusinessProfileTool({ store, auth, args: { action: "update", businessId: first.businessId, profile: { market: "Lviv" } } })).resolves.toMatchObject({ complete: true });
  });

  it("reuses the same durable request key without duplicating business, goals or memory", async () => {
    const { store, create } = await fixture();
    const first = await create("same-request", "One idea");
    const replay = await create("same-request", "One idea");
    expect(replay).toMatchObject({ complete: true, alreadyExisted: true, businessId: first.businessId });
    expect(await store.listUserBusinesses(auth)).toHaveLength(1);
    expect(await store.listGoals(auth, first.businessId)).toHaveLength(1);
    expect(await store.listMemory(auth, first.businessId)).toHaveLength(1);
  });
});
