import { describe, it, expect } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { defaultHybridRouter } from "@npati/shared";

const message = "Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview.";
const auth: AuthContext = { workspaceId: "context-ws", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage"] };

describe("Chat Project context recovery", () => {
  it("recognizes the Ukrainian create request without ASCII word boundaries", () => {
    expect(defaultHybridRouter.classifyProject({ message }).intent).toBe("CREATE_WEBSITE");
  });
  it("ignores a stale Project only for a new creation request, retaining company authorization", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(auth, { name: "Shop" }, "context-shop-company");
    const resolver = new ActiveContextResolver(store);
    const requested = { contextType: "project", companyId: company.id, projectId: "deleted-project" };
    const resolved = await resolver.resolveChat(auth, requested, message);
    expect(resolved.context).toMatchObject({ contextType: "company", companyId: company.id });
    expect(resolved.project).toBeUndefined();
    await expect(resolver.resolveChat(auth, requested, "Зроби header темнішим")).rejects.toThrow("Project not found");
    await expect(resolver.resolveChat({ ...auth, workspaceId: "other-workspace" }, requested, message)).rejects.toThrow();
  });
});
