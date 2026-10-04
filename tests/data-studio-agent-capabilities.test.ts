import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import {
  defaultCapabilityRegistry,
  CAPABILITY_MATRIX,
  DATA_CAPABILITY_GROUPS,
  isDataCapabilityPermitted,
  validateTemplate,
  BUILTIN_DATA_TEMPLATES,
  classifyProjectIntent,
  type DataSchemaTemplate,
} from "@npati/shared";
import { AgentDataStudioService } from "../apps/agent-api/src/data-studio/agent-data-service";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import type { DataProvider, SchemaSnapshot, SchemaOperation } from "../apps/agent-api/src/data-studio/data-provider";
import type { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import type { DataBackend, DataBackendEnvironment, DataEnvironmentName } from "../apps/agent-api/src/data-studio/types";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";

describe("Data Studio Agent Capabilities & Templates (D3)", () => {
  function createHarness() {
    const store = new InMemoryWorkspaceStore();
    const context: AuthContext = {
      workspaceId: "tenant-1",
      userId: "user-1",
      permissions: ["workspace:read", "business:manage"],
    };

    const mockBackend: DataBackend = {
      id: "backend-1",
      workspaceId: "tenant-1",
      companyId: "company-1",
      name: "Main DB",
      provider: "shared_postgres",
      status: "ready",
      createdBy: "user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockEnv: DataBackendEnvironment = {
      id: "env-1",
      workspaceId: "tenant-1",
      companyId: "company-1",
      backendId: "backend-1",
      environment: "dev" as DataEnvironmentName,
      status: "ready" as const,
      schemaFingerprint: "fingerprint-init",
      expectedSchema: null as any,
      syncStatus: "synced" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const currentSchema: SchemaSnapshot = {
      tables: [
        {
          name: "articles",
          columns: [
            { name: "id", type: "uuid", nullable: false },
            { name: "title", type: "text", nullable: false },
            { name: "content", type: "text", nullable: true },
          ],
          constraints: ["pk_articles:PRIMARY KEY (id)"],
          indexes: [],
          rlsEnabled: true,
          rlsForced: true,
          policies: [],
        },
      ],
    };

    const rowsDatabase: Record<string, Array<Record<string, unknown>>> = {
      articles: [
        { id: "art-1", title: "Hello World", content: "First post content" },
      ],
    };

    const mockRepo: Partial<DataBackendRepository> = {
      async get(ctx, companyId, id) {
        if (id === "backend-1") return mockBackend;
        throw new Error("Backend not found");
      },
      async environment(ctx, companyId, id, env) {
        if (id === "backend-1" && env === "dev") return mockEnv;
        throw new Error("Environment not found");
      },
      async environments(ctx, companyId, id) {
        return [mockEnv];
      },
      async setEnvironment(ctx, companyId, id, env, patch) {
        Object.assign(mockEnv, patch);
      },
    };

    const mockProvider: Partial<DataProvider> = {
      async introspectSchema(backend, env) {
        return JSON.parse(JSON.stringify(currentSchema));
      },
      schemaFingerprint(snapshot) {
        return currentSchema.tables.map((t) => t.name).sort().join(":");
      },
    };

    const mockMigrationEngine: Partial<ProjectMigrationEngine> = {
      async detectDrift(ctx, backend, env) {
        return {
          status: "synced",
          actual: "fingerprint-init",
          expected: "fingerprint-init",
          schema: currentSchema,
        };
      },
      async dryRun(request) {
        const op = request.operation;
        const isDestructive = op.kind === "drop_collection" || op.kind === "drop_field";
        return {
          operation: op.kind,
          upSql: `-- apply ${op.kind}`,
          reversible: !isDestructive,
          destructive: isDestructive,
          requiresSnapshot: isDestructive,
          current: currentSchema,
          diff: {
            operation: op,
            beforeFingerprint: "fingerprint-init",
            sql: `-- apply ${op.kind}`,
          },
        };
      },
      async apply(ctx, request) {
        const op = request.operation;
        if (op.kind === "create_collection") {
          currentSchema.tables.push({
            name: op.collection,
            columns: (op.fields || []).map((f) => ({
              name: f.name,
              type: f.type,
              nullable: !f.required,
            })),
            constraints: [],
            indexes: [],
            rlsEnabled: true,
            rlsForced: true,
            policies: [],
          });
          rowsDatabase[op.collection] = [];
        } else if (op.kind === "drop_collection") {
          currentSchema.tables = currentSchema.tables.filter((t) => t.name !== op.collection);
          delete rowsDatabase[op.collection];
        }
        return {
          id: `mig-${Date.now()}`,
          version: Date.now(),
          name: op.kind,
          appliedOperations: 1,
          durationMs: 15,
          fingerprint: currentSchema.tables.map((t) => t.name).sort().join(":"),
          diff: { operation: op, beforeFingerprint: "fingerprint-init", sql: `-- applied ${op.kind}` },
        };
      },
      async rollback(ctx, backend, env, migrationId) {
        return { success: true };
      },
      async listOwnerRows(ctx, backend, env, collection, input) {
        const rows = rowsDatabase[collection] || [];
        return rows;
      },
      async createOwnerRow(ctx, backend, env, collection, row) {
        if (!rowsDatabase[collection]) rowsDatabase[collection] = [];
        const newRow = { id: `gen-${Date.now()}`, ...row };
        rowsDatabase[collection].push(newRow);
        return newRow;
      },
      async updateOwnerRow(ctx, backend, env, collection, id, row) {
        const list = rowsDatabase[collection] || [];
        const item = list.find((r) => r.id === id);
        if (!item) return null;
        Object.assign(item, row);
        return item;
      },
      async deleteOwnerRows(ctx, backend, env, collection, ids) {
        const list = rowsDatabase[collection] || [];
        const filtered = list.filter((r) => !ids.includes(String(r.id)));
        const deleted = list.length - filtered.length;
        rowsDatabase[collection] = filtered;
        return { deleted };
      },
    };

    const filesInProject = new Map<string, string>();
    const mockProjectWorkspace: any = {
      async readFile(ctx: any, companyId: string, projectId: string, path: string) {
        const content = filesInProject.get(path);
        if (content === undefined) throw new Error(`File not found: ${path}`);
        return { path, content, revision: "rev-1" };
      },
      async createFile(ctx: any, companyId: string, projectId: string, path: string, content: string) {
        filesInProject.set(path, content);
        return { path, size: content.length, revision: `rev-${Date.now()}` };
      },
      async writeFile(ctx: any, companyId: string, projectId: string, path: string, content: string) {
        filesInProject.set(path, content);
        return { path, size: content.length, revision: `rev-${Date.now()}` };
      },
    };

    const service = new AgentDataStudioService(
      store,
      mockRepo as DataBackendRepository,
      mockProvider as DataProvider,
      mockMigrationEngine as ProjectMigrationEngine,
      mockProjectWorkspace
    );

    return {
      store,
      context,
      service,
      currentSchema,
      rowsDatabase,
      filesInProject,
      mockRepo,
      mockProvider,
      mockMigrationEngine,
      mockProjectWorkspace,
    };
  }

  it("registers all 10 canonical data capabilities in catalog and matrix", () => {
    const requiredTools = [
      "project.data.schema.inspect",
      "project.data.schema.apply",
      "project.data.rows.list",
      "project.data.rows.read",
      "project.data.rows.create",
      "project.data.rows.update",
      "project.data.rows.delete",
      "project.data.migrations.list",
      "project.data.templates.list",
      "project.data.templates.apply",
    ];

    for (const toolId of requiredTools) {
      const found = defaultCapabilityRegistry.get(toolId);
      expect(found, `Tool ${toolId} should exist in registry`).toBeDefined();
      expect(found?.domain).toBe("storage");

      const inMatrix = CAPABILITY_MATRIX.find((entry) => entry.capabilityId === toolId);
      expect(inMatrix, `Tool ${toolId} should exist in CAPABILITY_MATRIX`).toBeDefined();
    }
  });

  it("correctly evaluates agent capability groups via isDataCapabilityPermitted", () => {
    // Agent with only data.read
    const readOnlyAgentTools = ["data.read"];
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.schema.inspect")).toBe(true);
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.rows.list")).toBe(true);
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.rows.read")).toBe(true);
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.migrations.list")).toBe(true);
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.templates.list")).toBe(true);
    // Write/Schema tools denied
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.rows.create")).toBe(false);
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.schema.apply")).toBe(false);
    expect(isDataCapabilityPermitted(readOnlyAgentTools, "project.data.templates.apply")).toBe(false);

    // Agent with data.write
    const writeAgentTools = ["data.write"];
    expect(isDataCapabilityPermitted(writeAgentTools, "project.data.rows.create")).toBe(true);
    expect(isDataCapabilityPermitted(writeAgentTools, "project.data.rows.update")).toBe(true);
    expect(isDataCapabilityPermitted(writeAgentTools, "project.data.rows.delete")).toBe(true);
    expect(isDataCapabilityPermitted(writeAgentTools, "project.data.schema.apply")).toBe(false);

    // Agent with data.schema
    const schemaAgentTools = ["data.schema"];
    expect(isDataCapabilityPermitted(schemaAgentTools, "project.data.schema.apply")).toBe(true);
    expect(isDataCapabilityPermitted(schemaAgentTools, "project.data.templates.apply")).toBe(true);

    // Agent with direct tool name
    expect(isDataCapabilityPermitted(["project.data.schema.inspect"], "project.data.schema.inspect")).toBe(true);
    // Agent with no matching tools
    expect(isDataCapabilityPermitted(["project.files.read"], "project.data.schema.inspect")).toBe(false);
  });

  it("validates templates and strictly rejects private collections without owner-based policies", () => {
    const invalidTemplate: DataSchemaTemplate = {
      id: "invalid-shop",
      name: "Invalid Shop",
      description: "Missing access policies for private orders",
      category: "commerce",
      collections: [
        {
          name: "orders",
          fields: [
            { name: "id", type: "uuid" },
            { name: "total", type: "decimal" },
          ],
        },
      ],
      relations: [],
      accessPolicies: [],
      gdprStrategies: { orders: "retain" },
    };

    expect(() => validateTemplate(invalidTemplate)).toThrowError(
      /Private collection "orders" must declare owner-based access policies/
    );
  });

  it("validates that all built-in templates (ecommerce, blog, crm, saas-basic) pass policy checks", () => {
    expect(BUILTIN_DATA_TEMPLATES.length).toBe(4);
    for (const template of BUILTIN_DATA_TEMPLATES) {
      expect(() => validateTemplate(template)).not.toThrow();
      expect(template.collections.length).toBeGreaterThan(0);
    }
  });

  it("rejects malicious or invalid operations with clear errors", async () => {
    const { service, context, store } = createHarness();
    const company = await store.createCompany(context, { name: "Test Corp", industry: "Tech" }, "comp-1");
    const { project } = await store.createProject(context, company.id, {
      name: "Online Store",
      type: "website",
      dataBackendId: "backend-1",
    }, "idem-1");

    // SQL Injection in collection name
    const maliciousOp: SchemaOperation = {
      kind: "create_collection",
      collection: "products; DROP TABLE users; --",
      fields: [{ name: "id", type: "uuid" }],
    };

    await expect(
      service.applySchema(context, company.id, project.id, maliciousOp)
    ).rejects.toThrowError(/Invalid database identifier/);

    // Unsupported column type
    const badTypeOp: SchemaOperation = {
      kind: "create_collection",
      collection: "valid_name",
      fields: [{ name: "id", type: "magic_type" as any }],
    };

    await expect(
      service.applySchema(context, company.id, project.id, badTypeOp)
    ).rejects.toThrowError(/Invalid field type/);
  });

  it("requires approval for destructive schema changes and executes after approval", async () => {
    const { service, context, store, currentSchema } = createHarness();
    const company = await store.createCompany(context, { name: "Test Corp", industry: "Tech" }, "comp-2");
    const { project } = await store.createProject(context, company.id, {
      name: "Online Store",
      type: "website",
      dataBackendId: "backend-1",
    }, "idem-2");

    const dropOp: SchemaOperation = {
      kind: "drop_collection",
      collection: "articles",
    };

    // 1. Without approval -> returns approvalRequired
    const unapprovedResult = await service.applySchema(context, company.id, project.id, dropOp, {
      approved: false,
    });
    expect(unapprovedResult.approvalRequired).toBe(true);
    expect(unapprovedResult.riskLevel).toBe("high");
    expect(unapprovedResult.destructive).toBe(true);

    // Table should still exist
    expect(currentSchema.tables.some((t) => t.name === "articles")).toBe(true);

    // 2. With approval -> executes successfully
    const approvedResult = await service.applySchema(context, company.id, project.id, dropOp, {
      approved: true,
    });
    expect(approvedResult.applied).toBe(true);
    expect(currentSchema.tables.some((t) => t.name === "articles")).toBe(false);
  });

  it("applies ecommerce template atomically and updates PROJECT.md context", async () => {
    const { service, context, store, filesInProject, currentSchema } = createHarness();
    const company = await store.createCompany(context, { name: "Test Corp", industry: "Tech" }, "comp-3");
    const { project } = await store.createProject(context, company.id, {
      name: "E-Commerce Project",
      type: "website",
      dataBackendId: "backend-1",
    }, "idem-3");

    // 1. Dry run returns plan + diff
    const dryRun = await service.applyTemplate(context, company.id, project.id, "ecommerce", {
      dryRunOnly: true,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.collections.length).toBe(8); // categories, products, product_variants, carts, cart_items, orders, order_items, addresses

    // 2. Apply with approval
    const applied = await service.applyTemplate(context, company.id, project.id, "ecommerce", {
      approved: true,
    });
    expect(applied.applied).toBe(true);
    expect(applied.collections.length).toBe(8);

    // Verify all collections now exist in schema
    const tableNames = currentSchema.tables.map((t) => t.name);
    expect(tableNames).toContain("products");
    expect(tableNames).toContain("orders");
    expect(tableNames).toContain("carts");
    expect(tableNames).toContain("addresses");

    // 3. Verify PROJECT.md has been automatically synced with schema summary
    const projectMd = filesInProject.get("PROJECT.md");
    expect(projectMd).toBeDefined();
    expect(projectMd).toContain("## Data Schema (Data Studio)");
    expect(projectMd).toContain("`products`:");
    expect(projectMd).toContain("`orders`:");
    expect(projectMd).toContain("`carts`:");
    // Ensure no secrets or row data leaked into PROJECT.md
    expect(projectMd).not.toContain("password");
    expect(projectMd).not.toContain("postgres://");
    expect(projectMd).not.toContain("First post content");
  });

  it("strictly enforces tenant isolation and prevents cross-company access", async () => {
    const { service, context, store } = createHarness();
    const companyA = await store.createCompany(context, { name: "Company A", industry: "Tech" }, "comp-a");
    const companyB = await store.createCompany(context, { name: "Company B", industry: "Retail" }, "comp-b");

    const { project: projectB } = await store.createProject(context, companyB.id, {
      name: "Project B",
      type: "website",
      dataBackendId: "backend-1",
    }, "idem-4");

    // Trying to access projectB with companyA ID must fail
    await expect(
      service.inspectSchema(context, companyA.id, projectB.id)
    ).rejects.toThrowError(/Project not found/);
  });

  it("blocks project without attached DataBackend with descriptive error", async () => {
    const { service, context, store } = createHarness();
    const company = await store.createCompany(context, { name: "Test Corp", industry: "Tech" }, "comp-no-backend");
    const { project: projectWithoutBackend } = await store.createProject(context, company.id, {
      name: "Empty Project",
      type: "website",
    }, "idem-5");

    await expect(
      service.inspectSchema(context, company.id, projectWithoutBackend.id)
    ).rejects.toThrowError(/Project has no attached DataBackend/);
  });

  it("enforces agent capability authorization through CompanyToolRuntime", async () => {
    const { service, context, store } = createHarness();
    const company = await store.createCompany(context, { name: "Test Corp", industry: "Tech" }, "comp-runtime");
    const { project } = await store.createProject(context, company.id, {
      name: "Store Project",
      type: "website",
      dataBackendId: "backend-1",
    }, "idem-6");

    // Create an agent with only data.read
    const readAgent = await store.createCompanyAgent(context, company.id, {
      name: "Inspector Agent",
      role: "specialist",
      tools: ["data.read"],
    }, "read-agent-key");

    // Create an agent with no data capabilities
    const restrictedAgent = await store.createCompanyAgent(context, company.id, {
      name: "Frontend Designer",
      role: "specialist",
      tools: ["project.files.read", "project.files.write"],
    }, "restricted-agent-key");

    const mockAiEngine: any = {
      async executeTool() { return {}; },
    };

    const runtime = new CompanyToolRuntime(
      mockAiEngine,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service
    );

    const abortSignal = new AbortController().signal;

    // 1. Read agent can inspect schema
    const inspectResult = await runtime.execute(
      context,
      company,
      "project.data.schema.inspect",
      { projectId: project.id, __npatiAgentId: readAgent.id },
      abortSignal
    );
    expect(inspectResult).toBeDefined();

    // 2. Read agent fails when attempting to mutate schema
    await expect(
      runtime.execute(
        context,
        company,
        "project.data.schema.apply",
        {
          projectId: project.id,
          operation: { kind: "create_collection", collection: "test_coll", fields: [{ name: "id", type: "uuid" }] },
          __npatiAgentId: readAgent.id,
        },
        abortSignal
      )
    ).rejects.toThrowError(/Agent lacks required capability group for project.data.schema.apply/);

    // 3. Restricted agent fails even on inspection
    await expect(
      runtime.execute(
        context,
        company,
        "project.data.schema.inspect",
        { projectId: project.id, __npatiAgentId: restrictedAgent.id },
        abortSignal
      )
    ).rejects.toThrowError(/Agent lacks required capability group for project.data.schema.inspect/);
  });

  it("classifies user requests for schema and templates into ADD_DATA_MODEL / EDIT_DATA_MODEL", () => {
    // User phrases in Ukrainian
    expect(classifyProjectIntent("додай у проєкт таблиці для інтернет-магазину").intent).toBe("ADD_DATA_MODEL");
    expect(classifyProjectIntent("додай таблицю для замовлень").intent).toBe("ADD_DATA_MODEL");
    expect(classifyProjectIntent("створи схему бази даних").intent).toBe("ADD_DATA_MODEL");
    expect(classifyProjectIntent("зміни структуру таблиці products").intent).toBe("EDIT_DATA_MODEL");
    expect(classifyProjectIntent("видали колонку з таблиці").intent).toBe("EDIT_DATA_MODEL");

    // English phrases
    expect(classifyProjectIntent("add table for ecommerce orders").intent).toBe("ADD_DATA_MODEL");
    expect(classifyProjectIntent("create ecommerce schema").intent).toBe("ADD_DATA_MODEL");
    expect(classifyProjectIntent("add collection for reviews").intent).toBe("ADD_DATA_MODEL");
    expect(classifyProjectIntent("modify column type in products").intent).toBe("EDIT_DATA_MODEL");
  });
});
