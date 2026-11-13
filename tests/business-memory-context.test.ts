import { expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { businessMemoryNote } from "../apps/agent-api/src/business-memory-context";

const auth: AuthContext = { workspaceId: "w", userId: "owner", permissions: ["*", "workspace:read", "workspace:write", "business:manage"] };
// V6 step 11: a recall question routed to Goals only ("нагадай код рецепту і скільки продали по цілі") got no Memory.
it("lists the saved Memory of the turn's businesses only", async () => {
  const store = new InMemoryWorkspaceStore();
  const bakery = await store.createBusiness(auth, { name: "V6TEST_Bakery2" }), flowers = await store.createBusiness(auth, { name: "V6TEST_Flowers" });
  await store.createMemory(auth, bakery.id, { type: "business_fact", title: "Код рецепту круасанів", content: "KRUASAN-78", confidence: 1, source: "user" });
  await store.createMemory(auth, flowers.id, { type: "business_fact", title: "Секрет", content: "FOREIGN", confidence: 1, source: "user" });
  const note = await businessMemoryNote(store, auth, [bakery]);
  expect(note).toContain("KRUASAN-78"); expect(note).not.toContain("FOREIGN");
  expect(await businessMemoryNote(store, auth, [])).toBe("");
});

// V6 step 11: after compaction a turn routed without Business records answered 0/500 and KRUASAN-77 from old messages.
it("gives the selected business's current goal values and memory as authoritative", async () => {
  const { currentBusinessRecordsNote } = await import("../apps/agent-api/src/business-memory-context");
  const store = new InMemoryWorkspaceStore();
  const bakery = await store.createBusiness(auth, { name: "V6TEST_Bakery2" });
  const goal = await store.createGoal(auth, bakery.id, { title: "V6TEST продати 500 круасанів", targetValue: 500, currentValue: 0, targetUnit: "круасанів", priority: 1 });
  await store.updateGoal(auth, bakery.id, goal.id, { currentValue: 120 });
  await store.createMemory(auth, bakery.id, { type: "business_fact", title: "Код рецепту", content: "KRUASAN-78", confidence: 1, source: "user" });
  const note = await currentBusinessRecordsNote(store, auth, [bakery]);
  expect(note).toContain("\"current\":120"); expect(note).toContain("KRUASAN-78"); expect(note).toContain("may be outdated");
});
