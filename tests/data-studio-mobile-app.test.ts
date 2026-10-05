import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import {
  MOBILE_APP_FRAMEWORK,
  MOBILE_APP_PREVIEW_PORT,
  createMobileAppScaffold,
  defaultAppScheme,
  isAuthRedirectAllowed,
  isMobileAppRequest,
  isValidAppScheme,
  normalizeAuthRedirectUrl,
  slugifyProjectName,
  classifyProjectIntent,
} from "@npati/shared";
import {
  createProjectClient,
  createSecureStoreStorage,
  buildAuthRedirectUrl,
  parseAuthDeepLink,
} from "../packages/project-client/src/index";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { detectProjectStack } from "../apps/agent-api/src/project-preview-service";
import { ProjectRedirectRepository, MAX_AUTH_REDIRECTS } from "../apps/agent-api/src/data-studio/redirect-repository";
import { ProjectAuthService } from "../apps/agent-api/src/data-studio/auth-service";
import { isForbiddenSandboxVariable, PROJECT_API_SANDBOX_VARIABLES } from "../apps/agent-api/src/project-sandbox-service";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";

const owner: AuthContext = {
  workspaceId: "tenant-d6",
  userId: "user-d6",
  permissions: ["workspace:read", "workspace:write", "business:manage"],
};

async function projectFixture() {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "D6 Co" }, "d6-company");
  const service = new ProjectService(store);
  return { store, company, service };
}

describe("D6 — mobile app template", () => {
  it("scaffolds an Expo + TypeScript app with a preview script", () => {
    const scaffold = createMobileAppScaffold({ name: "Shop Mobile", slug: "shop-mobile", scheme: "npati-shop" });
    expect(scaffold.framework).toBe(MOBILE_APP_FRAMEWORK);
    expect(scaffold.port).toBe(MOBILE_APP_PREVIEW_PORT);
    expect(scaffold.devCommand).toContain("expo export --platform web");

    const pkg = JSON.parse(scaffold.files["package.json"]!);
    expect(pkg.dependencies.expo).toBeTruthy();
    expect(pkg.dependencies["expo-secure-store"]).toBeTruthy();
    expect(pkg.dependencies["react-native-web"]).toBeTruthy();

    for (const required of ["App.tsx", "app.config.js", "tsconfig.json", "src/config.ts", "src/api.ts", "src/screens/AuthScreen.tsx", "src/screens/ListScreen.tsx", "src/screens/DetailScreen.tsx", "src/screens/FormScreen.tsx", "src/validation.ts", "src/schema.ts", "README.md"]) {
      expect(Object.keys(scaffold.files), required).toContain(required);
    }
    expect(scaffold.files["app.config.js"]).toContain("process.env.PROJECT_PUBLISHABLE_KEY");
    expect(scaffold.files["src/api.ts"]).toContain("createSecureStoreStorage");
    expect(scaffold.files["src/api.ts"]).toContain("./npati-client");
    expect(scaffold.files["README.md"]).toContain("PROJECT_PUBLISHABLE_KEY");
    expect(scaffold.files["README.md"]).toContain("BuildProvider");
  });

  it("never puts secret keys or database credentials into generated app files", () => {
    const scaffold = createMobileAppScaffold({ name: "Shop Mobile", slug: "shop-mobile", scheme: "npati-shop" });
    for (const [filePath, content] of Object.entries(scaffold.files)) {
      if (filePath === "README.md") continue; // documents the rule, so it names the variables
      expect(content, filePath).not.toContain("PROJECT_SECRET_KEY");
      expect(content, filePath).not.toMatch(/npati_sk_(?:dev|prod)_/);
      expect(content, filePath).not.toContain("DATABASE_URL");
      expect(content, filePath).not.toMatch(/postgres(?:ql)?:\/\//);
    }
    expect(scaffold.files["README.md"]).toContain("PROJECT_SECRET_KEY");
    expect(scaffold.files["README.md"]).toContain("must never appear");
  });

  it("derives a valid deep link scheme and rejects dangerous ones", () => {
    expect(slugifyProjectName("Shop  Mobile!")).toBe("shop-mobile");
    expect(defaultAppScheme("Shop Mobile")).toBe("npati-shop-mobile");
    expect(isValidAppScheme("npati-shop")).toBe(true);
    expect(isValidAppScheme("shop.app+1")).toBe(true);
    for (const invalid of ["http", "https", "javascript", "1shop", "S", "", "a".repeat(60)]) {
      expect(isValidAppScheme(invalid), invalid).toBe(false);
    }
  });
});

describe("D6 — auth redirect allowlist", () => {
  it("normalizes targets and refuses query strings, fragments, credentials and reserved schemes", () => {
    expect(normalizeAuthRedirectUrl("https://shop.example.com/auth/callback")).toBe("https://shop.example.com/auth/callback");
    expect(normalizeAuthRedirectUrl("npati-shop://auth/callback")).toBe("npati-shop://auth/callback");
    for (const invalid of [
      "https://shop.example.com/auth/callback?token=stolen",
      "https://shop.example.com/auth/callback#frag",
      "https://user:pass@shop.example.com/auth",
      "javascript:alert(1)",
      "not-a-url",
      "",
    ]) {
      expect(normalizeAuthRedirectUrl(invalid), invalid).toBeNull();
    }
  });

  it("matches only registered targets exactly", () => {
    const allowed = ["https://shop.example.com/auth/callback", "npati-shop://auth/callback"];
    expect(isAuthRedirectAllowed("https://shop.example.com/auth/callback", allowed)).toBe(true);
    expect(isAuthRedirectAllowed("npati-shop://auth/callback", allowed)).toBe(true);
    expect(isAuthRedirectAllowed("https://evil.example.com/auth/callback", allowed)).toBe(false);
    expect(isAuthRedirectAllowed("https://shop.example.com.evil.test/auth/callback", allowed)).toBe(false);
  });

  it("stores, dedupes and bounds the allowlist per project", async () => {
    const { company } = await projectFixture();
    const repository = new ProjectRedirectRepository({ get: async () => ({ id: "p1" } as never) });
    const stored = await repository.replace(owner, company.id, "p1", "dev", [
      "npati-shop://auth/callback",
      "https://shop.example.com/auth/callback",
      "npati-shop://auth/callback",
    ]);
    expect(stored).toHaveLength(2);
    expect(await repository.list(owner, company.id, "p1", "dev")).toEqual(stored);
    expect(await repository.list(owner, company.id, "p1", "prod")).toEqual([]);

    await expect(repository.replace(owner, company.id, "p1", "dev", ["https://evil.test/x?y=1"]))
      .rejects.toMatchObject({ code: "INVALID_REDIRECT_URL" });
    await expect(repository.replace(owner, company.id, "p1", "dev", Array.from({ length: MAX_AUTH_REDIRECTS + 1 }, (_v, index) => `https://shop.example.com/cb/${index}`)))
      .rejects.toMatchObject({ code: "TOO_MANY_REDIRECT_URLS" });

    await expect(repository.assertAllowed(owner, company.id, "p1", "dev", "https://evil.example.com/auth/callback"))
      .rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED", status: 400 });
    await expect(repository.assertAllowed(owner, company.id, "p1", "dev", "npati-shop://auth/callback"))
      .resolves.toBe("npati-shop://auth/callback");
  });

  it("is enforced by Project Auth before any token is issued", async () => {
    const { store, company } = await projectFixture();
    const { project } = await new ProjectService(store).create(owner, company.id, { name: "Shop", type: "website", dataBackendId: "backend-1" }, "d6-p");
    const repository = new ProjectRedirectRepository({ get: (ctx, companyId, projectId) => store.getProject(ctx, companyId, projectId) });
    await repository.replace(owner, company.id, project.id, "dev", ["npati-shop://auth/callback"]);

    const backend = {
      id: "backend-1", workspaceId: owner.workspaceId, companyId: company.id, name: "Store DB",
      provider: "shared_postgres", status: "ready", createdBy: owner.userId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const dataRepository = {
      get: async () => backend,
      environment: async () => ({ status: "ready", providerConfig: {} }),
    } as unknown as DataBackendRepository;
    const service = new ProjectAuthService({
      store, repository: dataRepository, provisioner: {} as never, redirects: repository,
    });

    await expect(service.forgotPassword(owner, company.id, project.id, "dev", "user@example.com", undefined, "https://evil.example.com/auth/callback"))
      .rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });

    const listed = await service.getRedirectUrls(owner, company.id, project.id, "dev");
    expect(listed.redirectUrls).toEqual(["npati-shop://auth/callback"]);
    const updated = await service.updateRedirectUrls(owner, company.id, project.id, "dev", ["npati-shop://auth/callback", "https://shop.example.com/auth/callback"]);
    expect(updated.redirectUrls).toHaveLength(2);
  });
});

describe("D6 — SDK in a React Native runtime", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stores the session in the platform secure store", async () => {
    const calls: string[] = [];
    const secureStore = {
      async getItemAsync(key: string) { calls.push(`get:${key}`); return null; },
      async setItemAsync(key: string, value: string) { calls.push(`set:${key}:${value}`); },
      async deleteItemAsync(key: string) { calls.push(`del:${key}`); },
    };
    const storage = createSecureStoreStorage(secureStore);
    expect(await storage.getItem("npati_session_p1")).toBeNull();
    await storage.setItem("npati_session_p1", "{}");
    await storage.removeItem("npati_session_p1");
    expect(calls).toEqual([
      "get:npati_session_p1",
      "set:npati_session_p1:{}",
      "del:npati_session_p1",
    ]);
  });

  it("parses verification and reset deep links and ignores malformed ones", () => {
    expect(parseAuthDeepLink("npati-shop://auth/callback?kind=verify_email&token=abc")).toEqual({ kind: "verify_email", token: "abc" });
    expect(parseAuthDeepLink("npati-shop://auth/verify?token=abc")).toEqual({ kind: "verify_email", token: "abc" });
    expect(parseAuthDeepLink("npati-shop://auth/reset?token=xyz")).toEqual({ kind: "reset_password", token: "xyz" });
    expect(parseAuthDeepLink("npati-shop://auth/callback?kind=reset_password&token=xyz")).toEqual({ kind: "reset_password", token: "xyz" });
    expect(parseAuthDeepLink("npati-shop://auth/callback")).toBeNull();
    expect(parseAuthDeepLink("not a url")).toBeNull();
    expect(buildAuthRedirectUrl("npati-shop")).toBe("npati-shop://auth/callback");
  });

  it("refuses a secret key inside a mobile runtime", () => {
    vi.stubGlobal("navigator", { product: "ReactNative" });
    expect(() => createProjectClient({ apiUrl: "https://api.example.test", secretKey: "npati_sk_dev_deadbeef" }))
      .toThrow(/PROJECT_SECRET_KEY cannot be used in a browser or mobile app/);
  });
});

describe("D6 — mobile_app projects share the website DataBackend", () => {
  it("creates a mobile project with a default deep link scheme and an attached backend", async () => {
    const { store, company, service } = await projectFixture();
    const { project } = await service.create(owner, company.id, {
      name: "Shop Mobile", type: "mobile_app", dataBackendId: "backend-shared",
    }, "d6-mobile");
    expect(project.type).toBe("mobile_app");
    expect(project.appScheme).toBe("npati-shop-mobile");
    expect(project.dataBackendId).toBe("backend-shared");

    const { project: website } = await service.create(owner, company.id, {
      name: "Shop", type: "website", dataBackendId: "backend-shared",
    }, "d6-web");
    expect(website.type).toBe("website");
    expect(website.appScheme).toBeUndefined();
    expect(website.dataBackendId).toBe("backend-shared");

    const listed = await store.listProjects(owner, company.id);
    expect(listed.filter((item) => item.dataBackendId === "backend-shared")).toHaveLength(2);
  });

  it("validates the app scheme and the project type", async () => {
    const { company, service } = await projectFixture();
    const explicit = await service.create(owner, company.id, { name: "App", type: "mobile_app", appScheme: "npati-custom" }, "d6-scheme");
    expect(explicit.project.appScheme).toBe("npati-custom");
    await expect(service.create(owner, company.id, { name: "App", type: "mobile_app", appScheme: "javascript" }, "d6-bad-scheme"))
      .rejects.toThrow(/Invalid app scheme/);
    await expect(service.create(owner, company.id, { name: "Site", type: "website", appScheme: "npati-site" }, "d6-scheme-web"))
      .rejects.toThrow(/only supported for mobile_app/);
    await expect(service.create(owner, company.id, { name: "Other", type: "desktop_app" as never }, "d6-bad-type"))
      .rejects.toThrow(/Invalid project type/);
  });

  it("recognizes mobile intents and keeps them as project creation", () => {
    for (const message of [
      "створи мобільний додаток для цього магазину",
      "зроби Android застосунок на Expo",
      "build a react native mobile app for my shop",
    ]) {
      expect(isMobileAppRequest(message), message).toBe(true);
      const decision = classifyProjectIntent({ message });
      expect(decision.targetDetails?.projectType, message).toBe("mobile_app");
      expect(decision.targetDetails?.framework, message).toBe("Expo");
    }
    const website = classifyProjectIntent({ message: "створи сайт для кав'ярні" });
    expect(website.targetDetails?.projectType).toBe("website");
    expect(isMobileAppRequest("зроби сайт адаптивним для мобільних")).toBe(false);
  });
});

describe("D6 — Expo stack detection and sandbox contract", () => {
  it("detects Expo projects and previews the web export", async () => {
    const packageJson = JSON.stringify({
      name: "shop-mobile",
      scripts: { start: "expo start", export: "expo export --platform web --output-dir dist" },
      dependencies: { expo: "~51.0.39", "react-native": "0.74.5" },
    });
    const files = [{ path: "package.json" }, { path: "app.config.js" }];
    const stack = await detectProjectStack(files, async (filePath) => (filePath === "package.json" ? packageJson : ""));
    expect(stack.framework).toBe("expo");
    expect(stack.port).toBe(MOBILE_APP_PREVIEW_PORT);
    expect(stack.command).toContain("serve -s dist");

    const staticStack = await detectProjectStack([{ path: "index.html" }], async () => "");
    expect(staticStack.framework).toBe("static");
  });

  it("keeps the sandbox environment at the two public Project API variables", () => {
    expect([...PROJECT_API_SANDBOX_VARIABLES]).toEqual(["PROJECT_API_URL", "PROJECT_PUBLISHABLE_KEY"]);
    for (const name of ["PROJECT_SECRET_KEY", "DATABASE_URL", "EXPO_TOKEN", "PGPASSWORD"]) {
      expect(isForbiddenSandboxVariable(name), name).toBe(true);
    }
    expect(isForbiddenSandboxVariable("PROJECT_PUBLISHABLE_KEY")).toBe(false);
  });
});
