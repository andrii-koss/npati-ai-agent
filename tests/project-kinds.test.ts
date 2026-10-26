import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, OmniRouteMarketplace } from "@npati/agent";
import { classifyProjectIntent, createGameScaffold, developmentTargetKind, planChatDevelopment, projectKindOf } from "@npati/shared";

describe("project kinds", () => {
  it("recognises a game request without mistaking words that only contain the stem", () => {
    const game = classifyProjectIntent({ message: "Створи гру змійка з рахунком" });
    expect(game.intent).toBe("CREATE_PROJECT");
    expect(game.targetDetails).toMatchObject({ projectType: "game", framework: "HTML/CSS" });
    expect(classifyProjectIntent({ message: "Create a platformer game in React + Vite" }).targetDetails)
      .toMatchObject({ projectType: "game", framework: "React + Vite" });
    expect(classifyProjectIntent({ message: "Створи групу для відділу продажів" }).targetDetails?.projectType).not.toBe("game");
    expect(classifyProjectIntent({ message: "Створи сайт для програми лояльності" }).targetDetails?.projectType).toBe("website");
    // A game for phones is a native mobile app.
    expect(classifyProjectIntent({ message: "Створи мобільний застосунок гру для Android" }).targetDetails?.projectType).toBe("mobile_app");
  });

  it("plans a game as its own project and maps chat targets to project kinds", () => {
    expect(planChatDevelopment("Створи гру тетріс")).toEqual([{ kind: "game", name: "Game", framework: "HTML/CSS" }]);
    expect(planChatDevelopment("Створи сайт і гру")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "website" }), expect.objectContaining({ kind: "game" })]));
    expect(["website", "blog", "store", "crm", "mobile_app", "game", "api"].map((kind) => developmentTargetKind(kind as never)))
      .toEqual(["website", "website", "website", "web_app", "mobile_app", "game", "api"]);
  });

  it("derives the kind of projects created before kinds existed", () => {
    expect(projectKindOf({ type: "code_project", framework: "Next.js" })).toBe("website");
    expect(projectKindOf({ type: "mobile_app", framework: "Expo" })).toBe("mobile_app");
    expect(projectKindOf({ type: "code_project", framework: "FastAPI" })).toBe("api");
    expect(projectKindOf({ type: "web_app" })).toBe("web_app");
    expect(projectKindOf({ type: "code_project", framework: "HTML/CSS", kind: "game" })).toBe("game");
  });

  it("ships a playable, dependency-free game starter with an escaped title", () => {
    const { files } = createGameScaffold({ name: "Зірки <&> гра" });
    expect(Object.keys(files).sort()).toEqual(["game.js", "index.html", "style.css"]);
    expect(files["index.html"]).toContain("<title>Зірки &lt;&amp;&gt; гра</title>");
    expect(files["index.html"]).toContain('<script src="game.js"></script>');
    expect(files["game.js"]).toContain("requestAnimationFrame");
    expect(files["game.js"]).not.toMatch(/\bimport\b|require\(/);
  });

  describe("projects API", () => {
    const apps: Array<ReturnType<typeof buildApp>> = [];
    afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
    const context: AuthContext = { workspaceId: "workspace-kinds", userId: "user-kinds", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const engine = { chat: async () => ({ content: "" }), stream: async function* () {}, getCapabilities: async () => [], healthCheck: async () => ({ status: "ok" }) } as unknown as AIEngine;

    async function setup() {
      const store = new InMemoryWorkspaceStore();
      const authProvider: AuthProvider = { authenticate: async () => context };
      const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
      const app = buildApp({ workspaceStore: store, authProvider, marketplace, aiEngine: engine });
      apps.push(app);
      const company = await store.createCompany(context, { name: "Kinds" });
      return { app, companyId: company.id };
    }

    it("stores the kind a project is created with and defaults it from the type", async () => {
      const { app, companyId } = await setup();
      const game = await app.inject({ method: "POST", url: `/companies/${companyId}/projects`, headers: { "idempotency-key": "kind-game" }, payload: { name: "Arcade", type: "website", kind: "game" } });
      expect(game.statusCode).toBe(201);
      expect(game.json()).toMatchObject({ type: "website", kind: "game" });
      const mobile = await app.inject({ method: "POST", url: `/companies/${companyId}/projects`, headers: { "idempotency-key": "kind-mobile" }, payload: { name: "App", type: "mobile_app" } });
      expect(mobile.json().kind).toBe("mobile_app");
      const listed = await app.inject({ method: "GET", url: `/companies/${companyId}/projects` });
      expect(listed.json().projects.map((p: { kind: string }) => p.kind).sort()).toEqual(["game", "mobile_app"]);
      const invalid = await app.inject({ method: "POST", url: `/companies/${companyId}/projects`, headers: { "idempotency-key": "kind-bad" }, payload: { name: "X", type: "website", kind: "spaceship" } });
      expect(invalid.statusCode).toBe(400);
    });
  });
});
