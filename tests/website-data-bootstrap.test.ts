import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import ts from "typescript";
import { TEMPLATE_CATALOG, createDefaultWebsiteDocument } from "@npati/shared";
import { classifyProjectIntent } from "../packages/shared/src/project-intent";
import { NextJsAdapter } from "../packages/shared/src/website-renderer";
import { createWebsiteDataFiles } from "../apps/agent-api/src/website-data-scaffold";
import { bootstrapWebsiteData } from "../apps/agent-api/src/data-studio/website-bootstrap";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import { RlsPolicyCompiler } from "../apps/agent-api/src/data-studio/rls-compiler";
import { loadProjectClientSdkSource } from "../apps/agent-api/src/data-studio/project-sdk-file";
import { ProjectApiGatewayService } from "../apps/agent-api/src/data-studio/gateway-service";
import { createProjectClient } from "../packages/project-client/src/index";
import { extractCleanProjectName } from "../apps/agent-api/src/project-orchestrator";

const prompt = "Створи тестовий сайт інтернет магазин на Next.js, запусти build і Live Preview.";
const ctx = { workspaceId: "ws", userId: "user", permissions: ["business:manage"] };
const backend = { id: "backend", companyId: "company", workspaceId: "ws", createdBy: "user", status: "ready", name: "Shop data" };
const provider = new PostgresDataProvider();

describe("Website data creation regressions", () => {
  it("uses the site topic as its name instead of the creation and build instructions", () => {
    expect(extractCleanProjectName(prompt)).toBe("Інтернет магазин");
    expect(extractCleanProjectName("Create a test website for online store on Next.js, run build and Live Preview.")).toBe("Online store");
    expect(extractCleanProjectName(prompt,"My Shop")).toBe("My Shop");
  });
  it.each([prompt, "Створи інтернет магазин на Next.js", "Створи інтернет-магазин на Next.js"])("creates a Next store for %s", message => {
    expect(classifyProjectIntent({ message, activeProjectId: "old" })).toMatchObject({ intent: "CREATE_WEBSITE", targetDetails: { framework: "Next.js", projectType: "website" } });
  });
  it("routes new columns to schema edits and preserves mobile type with preview", () => {
    expect(classifyProjectIntent({ message: "Додай колонку phone у customers", activeProjectId: "p" }).intent).toBe("EDIT_DATA_MODEL");
    expect(classifyProjectIntent({ message: "Створи мобільний додаток для магазину і запусти Live Preview" }).targetDetails).toMatchObject({ projectType: "mobile_app", framework: "Expo" });
  });
  it("compiles every ecommerce field default and restricts public catalog writes", () => {
    const template = TEMPLATE_CATALOG.find(template => template.id === "ecommerce")!;
    for (const collection of template.collections) expect(() => provider.createCollection(collection.name, collection.fields)).not.toThrow();
    const policy = template.accessPolicies.find(policy => policy.collection === "products")!;
    const compiled = RlsPolicyCompiler.compile("products", [policy]).sql.join("\n");
    expect(compiled).toContain("FOR SELECT USING (true)");
    expect(compiled).not.toContain("FOR INSERT WITH CHECK (true)");
    expect(provider.compileOperation({ kind: "create_relation", collection: "products", target: "categories", name: "category", field: "category_id", cardinality: "many-to-one" }).upSql).toContain('FOREIGN KEY ("category_id")');
  });
  it("typechecks generated account, forms, store and SDK together", async () => {
    const root = path.resolve(".data/virtual-website-typecheck");
    const files = createWebsiteDataFiles("https://api.example.test/v1/projects/p1", "npati_pk_dev_public", "p1", true);
    files["npati-client.ts"] = await loadProjectClientSdkSource();
    const virtual = new Map(Object.entries(files).map(([name, content]) => [path.join(root, name), content]));
    const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, types: ["react", "node"] };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host), getSourceFile = host.getSourceFile.bind(host);
    host.readFile = file => virtual.get(path.normalize(file)) ?? readFile(file);
    host.fileExists = file => virtual.has(path.normalize(file)) || fileExists(file);
    const directoryExists = host.directoryExists!.bind(host);
    host.directoryExists = directory => path.normalize(directory).startsWith(root) || directoryExists(directory);
    host.realpath = file => virtual.has(path.normalize(file)) ? path.normalize(file) : ts.sys.realpath?.(file) ?? file;
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNew) => virtual.has(path.normalize(file)) ? ts.createSourceFile(file, virtual.get(path.normalize(file))!, languageVersion, true) : getSourceFile(file, languageVersion, onError, shouldCreateNew);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...virtual.keys()], options, host));
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  }, 30000);
  it("prepares schema/auth/API before frontend and is idempotent on retry", async () => {
    vi.stubEnv("NPATI_PROJECT_API_PUBLIC_URL", "https://api.example.test");
    vi.stubEnv("NPATI_WEB_ORIGIN", "https://web.example.test");
    try {
      const files = new Map(Object.entries(new NextJsAdapter().scaffoldProject(createDefaultWebsiteDocument("Shop", "nextjs"))));
      const events: string[] = [];
      const schema: any = { tables: [] };
      const environment: any = { providerConfig: {} };
      const project: any = { id: "p1", companyId: "company", name: "Shop", dataBackendId: "backend" };
      const workspace: any = {
        readFile: async (_ctx: unknown, _company: string, _project: string, file: string) => { if (!files.has(file)) throw new Error("missing"); return { content: files.get(file), revision: "r" }; },
        createFile: async (_ctx: unknown, _company: string, _project: string, file: string, content: string) => { events.push("file:" + file); files.set(file, content); },
        writeFile: async (_ctx: unknown, _company: string, _project: string, file: string, content: string) => files.set(file, content),
      };
      const services: any = {
        backends: { get: async () => ({ backend }) },
        repository: { environment: async () => environment, setEnvironment: async (_ctx: unknown, _company: string, _backend: string, _env: string, patch: unknown) => Object.assign(environment, patch), setExpectedSchema: async () => {} },
        provider: { introspectSchema: async () => schema, schemaFingerprint: () => "fp" },
        agentData: { applyTemplate: vi.fn(async () => { events.push("schema"); schema.tables = TEMPLATE_CATALOG[0]!.collections.map(collection => ({ name: collection.name, columns: [] })); }) },
        migrations: { applyBatch: async (_ctx: unknown, request: any) => { for (const operation of request.operations) schema.tables.push({ name: operation.collection, columns: [] }); }, listOwnerRows: async () => [{ id: "product" }] },
        auth: { ensureInitialized: async () => { events.push("auth"); } },
        studio: { updateCorsOrigins: vi.fn(async () => { events.push("cors"); }) },
        gateway: { getSandboxEnvironment: async () => { events.push("sdk"); files.set("npati-client.ts", "export {}"); return { PROJECT_API_URL: "https://api.example.test/v1/projects/p1", PROJECT_PUBLISHABLE_KEY: "public" }; }, inspectApi: async () => ({ sdk: { available: true } }) },
        workspace,
      };
      await bootstrapWebsiteData(ctx, project, prompt, services);
      expect(events.indexOf("schema")).toBeLessThan(events.indexOf("auth"));
      expect(events.indexOf("sdk")).toBeLessThan(events.indexOf("file:lib/project-client.ts"));
      expect(files.get("components/BlockRenderer.tsx")).not.toContain('alert("Thank you! Message sent.")');
      expect(files.get("components/BlockRenderer.tsx")).toContain('case "forms"');
      expect(files.get("app/page.tsx")).toContain("ProjectStore");
      expect(environment.providerConfig.websiteBootstrap.status).toBe("ready");
      await bootstrapWebsiteData(ctx, project, prompt, services);
      expect(services.agentData.applyTemplate).toHaveBeenCalledTimes(1);
      expect(files.get("components/BlockRenderer.tsx")!.match(/import \{ ProjectForm \}/g)).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("Real migration batch transaction boundary", () => {
  function harness(fail: boolean) {
    const queries: string[] = [];
    const client = { release: vi.fn(), query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("pg_try_advisory")) return { rows: [{ locked: true }] };
      if (sql.includes("coalesce(max")) return { rows: [{ version: "0" }] };
      if (fail && sql.startsWith('CREATE TABLE "second"')) throw new Error("injected DDL failure");
      return { rows: [], rowCount: 1 };
    }) };
    const repository: any = { get: async () => backend, environment: async () => ({ status: "ready", syncStatus: "synced" }), acquireLock: async () => true, releaseLock: vi.fn(), setExpectedSchema: vi.fn(), pool: { query: vi.fn(async () => ({})) }, setCollectionAccessPolicies: vi.fn() };
    const schemaProvider: any = { ...provider, compileOperation: provider.compileOperation.bind(provider), assertLimits: provider.assertLimits.bind(provider), introspectSchema: async () => ({ tables: [] }), schemaFingerprint: () => "fp" };
    const engine = new ProjectMigrationEngine({ getUsage: async () => ({ bytes: 0 }), getConnection: async () => ({ user: "runtime" }) } as any, schemaProvider, repository);
    (engine as any).pool = async () => ({ query: async () => ({}), connect: async () => client, end: async () => {} });
    return { engine, queries, repository };
  }
  it("rolls back all DDL and does not publish Core history on failure", async () => {
    const { engine, queries, repository } = harness(true);
    await expect(engine.applyBatch(ctx, { backend: backend as any, environment: "dev", authorId: "user", operations: [{ kind: "create_collection", collection: "first", fields: [] }, { kind: "create_collection", collection: "second", fields: [] }] })).rejects.toThrow("injected DDL failure");
    expect(queries.filter(sql => sql === "BEGIN")).toHaveLength(1);
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(repository.pool.query).not.toHaveBeenCalled();
    expect(repository.releaseLock).toHaveBeenCalled();
  });
  it("commits collections and runtime policies once", async () => {
    const { engine, queries } = harness(false);
    await engine.applyBatch(ctx, { backend: backend as any, environment: "dev", authorId: "user", operations: [{ kind: "create_collection", collection: "products", fields: [] }], policies: [{ collection: "products", rule: "public", actions: ["select"] }] });
    expect(queries.filter(sql => sql === "COMMIT")).toHaveLength(1);
    expect(queries.indexOf("COMMIT")).toBeGreaterThan(queries.findIndex(sql => sql.includes("CREATE POLICY")));
  });
  it("reuses a verified Promote lock without acquiring or releasing it", async () => {
    const { engine, repository } = harness(false);
    repository.ownsLock = vi.fn(async () => true);
    repository.acquireLock = vi.fn(async () => { throw new Error("nested lock"); });
    await engine.apply(ctx, { backend: backend as any, environment: "prod", authorId: "user", lockToken: "promotion-lock", operation: { kind: "create_collection", collection: "products", fields: [] } });
    expect(repository.ownsLock).toHaveBeenCalledWith("backend", "prod", "promotion-lock");
    expect(repository.acquireLock).not.toHaveBeenCalled();
    expect(repository.releaseLock).not.toHaveBeenCalled();
  });
});

describe("Generated site gateway requests", () => {
  it("submits forms without RETURNING or SELECT access", async () => {
    const gateway = new ProjectApiGatewayService({} as any, {} as any, {} as any);
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1 }));
    const authorize = vi.fn(async () => {});
    (gateway as any).authorizeCollection = authorize;
    (gateway as any).validateColumns = async () => {};
    (gateway as any).executeRuntime = async (_auth: unknown, handler: any) => handler({ query });
    await expect(gateway.submitForm({} as any, "contact_messages", { name: "Test", email: "test@example.test", message: "Hello" })).resolves.toEqual({ success: true });
    expect(authorize).toHaveBeenCalledWith({}, "contact_messages", "insert");
    expect(query.mock.calls[0]![0]).not.toContain("RETURNING");
    await expect(gateway.submitForm({} as any, "orders", {})).rejects.toThrow("Unsupported form collection");
  });
  it("includes session and project key in checkout without leaking them to external URLs", async () => {
    const calls: Array<{url:string;headers:Headers}> = [];
    const client = createProjectClient({ apiUrl: "https://api.example.test/v1/projects/p1", publishableKey: "public", projectId: "p1", storage: { getItem: () => JSON.stringify({ accessToken: "user-token", refreshToken: "refresh", expiresAt: Date.now()+60000 }), setItem: () => {}, removeItem: () => {} }, fetch: async (url, init) => { calls.push({url:String(url),headers:new Headers(init?.headers)}); return new Response("{}"); } });
    await client.fetchRaw("/commerce/checkout", {method:"POST",body:'{"cartId":"cart"}'});
    expect(calls[0]!.headers.get("X-Project-Key")).toBe("public");
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer user-token");
    await client.fetchRaw("https://external.example.test");
    expect(calls[1]!.headers.has("X-Project-Key")).toBe(false);
    expect(calls[1]!.headers.has("Authorization")).toBe(false);
  });
});
