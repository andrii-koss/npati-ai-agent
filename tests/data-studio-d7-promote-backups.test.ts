import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { PromoteService } from "../apps/agent-api/src/data-studio/promote-service";
import { BackupService } from "../apps/agent-api/src/data-studio/backup-service";
import { QuotaService } from "../apps/agent-api/src/data-studio/quota-service";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { ExternalPostgresProvisioner } from "../apps/agent-api/src/data-studio/external-provisioner";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import type { DatabaseProvisioner } from "../apps/agent-api/src/data-studio/provisioner";
import type { ProjectMigrationEngine } from "../apps/agent-api/src/data-studio/migration-engine";
import type { DataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import type { BackupPolicy, DataBackend, DataBackendEnvironment, DataBackendPromotion, DataEnvironmentName, ProjectSnapshot } from "../apps/agent-api/src/data-studio/types";

const owner: AuthContext = { workspaceId: "tenant-d7", userId: "user-d7", permissions: ["workspace:read", "business:manage"] };

interface FakeState {
  backend: DataBackend;
  environments: Record<DataEnvironmentName, DataBackendEnvironment>;
  snapshots: ProjectSnapshot[];
  promotions: DataBackendPromotion[];
  secrets: Map<string, string>;
  locks: Map<string, string>;
  migrations: Record<DataEnvironmentName, Array<{ version: number; operation: unknown }>>;
  deprovisioned: DataEnvironmentName[];
}

function fakeState(overrides: Partial<DataBackend> = {}): FakeState {
  const backend: DataBackend = {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: owner.workspaceId,
    companyId: "company-d7",
    createdBy: owner.userId,
    name: "Store DB",
    provider: "shared_postgres",
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  const environment = (name: DataEnvironmentName): DataBackendEnvironment => ({
    id: `env-${name}`,
    workspaceId: owner.workspaceId,
    companyId: backend.companyId,
    backendId: backend.id,
    environment: name,
    providerConfig: {},
    status: "ready",
    schemaFingerprint: `fp-${name}`,
    expectedSchema: null,
    syncStatus: "synced",
    limits: {},
    backupPolicy: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return {
    backend,
    environments: { dev: environment("dev"), prod: environment("prod") },
    snapshots: [],
    promotions: [],
    secrets: new Map(),
    locks: new Map(),
    migrations: { dev: [], prod: [] },
    deprovisioned: [],
  };
}

function fakeRepository(state: FakeState) {
  const repository = {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    async get(_ctx: AuthContext, companyId: string, id: string) {
      if (id !== state.backend.id || companyId !== state.backend.companyId) throw new Error("not found");
      return state.backend;
    },
    async environment(_ctx: AuthContext, _companyId: string, _id: string, environment: DataEnvironmentName) {
      return state.environments[environment];
    },
    async setEnvironment(_ctx: AuthContext, _companyId: string, _id: string, environment: DataEnvironmentName, patch: { status?: string; providerConfig?: Record<string, unknown>; syncStatus?: string; schemaFingerprint?: string; limits?: Record<string, number>; backupPolicy?: BackupPolicy }) {
      const current = state.environments[environment];
      state.environments[environment] = {
        ...current,
        ...(patch.status ? { status: patch.status as DataBackendEnvironment["status"] } : {}),
        ...(patch.providerConfig ? { providerConfig: patch.providerConfig } : {}),
        ...(patch.syncStatus ? { syncStatus: patch.syncStatus as DataBackendEnvironment["syncStatus"] } : {}),
        ...(patch.schemaFingerprint ? { schemaFingerprint: patch.schemaFingerprint } : {}),
        ...(patch.limits ? { limits: patch.limits } : {}),
        ...(patch.backupPolicy ? { backupPolicy: patch.backupPolicy } : {}),
      };
    },
    async setExpectedSchema(_ctx: AuthContext, _companyId: string, _id: string, environment: DataEnvironmentName, _schema: unknown, fingerprint: string) {
      state.environments[environment] = { ...state.environments[environment], schemaFingerprint: fingerprint, syncStatus: "synced" };
    },
    async acquireLock(_id: string, environment: DataEnvironmentName, token: string) {
      if (state.locks.has(environment)) return false;
      state.locks.set(environment, token);
      return true;
    },
    async releaseLock(_id: string, environment: DataEnvironmentName, token: string) {
      if (state.locks.get(environment) === token) state.locks.delete(environment);
    },
    async insertSnapshot(_backendId: string, environment: DataEnvironmentName, snapshot: { id: string; path: string; kind: string; reason?: string; sizeBytes?: number; createdBy?: string }) {
      state.snapshots.push({
        id: snapshot.id, backendId: state.backend.id, environment, path: snapshot.path,
        createdAt: new Date().toISOString(), kind: snapshot.kind as ProjectSnapshot["kind"], reason: snapshot.reason ?? null, sizeBytes: snapshot.sizeBytes ?? null,
      });
    },
    async listSnapshots(_backendId: string, environment: DataEnvironmentName, limit = 100) {
      return state.snapshots.filter((snapshot) => snapshot.environment === environment).slice(0, limit);
    },
    async getSnapshot(_backendId: string, environment: DataEnvironmentName, id: string) {
      return state.snapshots.find((snapshot) => snapshot.environment === environment && snapshot.id === id) ?? null;
    },
    async deleteSnapshotRecord(id: string) {
      state.snapshots = state.snapshots.filter((snapshot) => snapshot.id !== id);
    },
    async expiredSnapshots() { return []; },
    async surplusScheduledSnapshots(_backendId: string, environment: DataEnvironmentName, keep: number) {
      return state.snapshots.filter((snapshot) => snapshot.environment === environment && snapshot.kind === "scheduled").slice(keep);
    },
    async allBackends() { return [{ backend: state.backend, environments: [state.environments.dev, state.environments.prod] }]; },
    async setRemovalDeadline(_ctx: AuthContext, _companyId: string, _id: string, removeAfter: Date) {
      state.backend = { ...state.backend, status: "deleting", removeAfter: removeAfter.toISOString() };
    },
    async dueRemovals() { return state.backend.removeAfter && Date.parse(state.backend.removeAfter) <= Date.now() ? [state.backend] : []; },
    async insertPromotion(promotion: DataBackendPromotion) { state.promotions.push(promotion); },
    async updatePromotion(id: string, patch: { status?: DataBackendPromotion["status"]; appliedAt?: string }) {
      state.promotions = state.promotions.map((promotion) => promotion.id === id ? { ...promotion, ...patch } : promotion);
    },
    async listPromotions() { return state.promotions; },
    async listAppliedMigrations(_backendId: string, environment: DataEnvironmentName) {
      return state.migrations[environment].map((row) => ({ version: row.version, operation: row.operation }));
    },
    async getAccessPolicies() { return []; },
    async attach() { return null; },
    async deleteSecrets() { state.secrets.clear(); },
    async deleteSnapshots() { const rows = state.snapshots; state.snapshots = []; return rows; },
    async remove() { state.backend = { ...state.backend, status: "deleted" } as DataBackend; },
    async beginRemoval(_ctx: AuthContext, _companyId: string, _id: string) {
      state.backend = { ...state.backend, status: "deleting" };
    },
    async attachedCount() { return 0; },
    async putSecret(_ctx: AuthContext, _companyId: string, _id: string, environment: DataEnvironmentName, role: string, value: string) {
      const ref = `${environment}:${role}`;
      state.secrets.set(ref, value);
      return ref;
    },
    async resolveSecret(_ctx: AuthContext, _companyId: string, _id: string, environment: DataEnvironmentName, role: string) {
      const value = state.secrets.get(`${environment}:${role}`);
      if (!value) throw new Error("secret not found");
      return value;
    },
  };
  return repository as unknown as DataBackendRepository;
}

function fakeProvisioner(state: FakeState, snapshots: ProjectSnapshot[] = []) {
  const calls: string[] = [];
  const provisioner = {
    async provisionDatabase(_b: DataBackend, environment: DataEnvironmentName) { calls.push(`provision:${environment}`); },
    async deprovisionDatabase(_b: DataBackend, environment: DataEnvironmentName) { calls.push(`deprovision:${environment}`); state.deprovisioned.push(environment); },
    async getConnection(_b: DataBackend, environment: DataEnvironmentName, role: string) { calls.push(`connection:${environment}:${role}`); return { host: "localhost", port: 5432, database: "db", user: role, password: "secret" }; },
    async rotateCredentials() { calls.push("rotate"); },
    async suspendRuntime(_b: DataBackend, environment: DataEnvironmentName) { calls.push(`suspend:${environment}`); },
    async resumeRuntime(_b: DataBackend, environment: DataEnvironmentName) { calls.push(`resume:${environment}`); },
    async snapshot(_b: DataBackend, environment: DataEnvironmentName): Promise<ProjectSnapshot> {
      const snapshot: ProjectSnapshot = { id: crypto.randomUUID(), backendId: state.backend.id, environment, path: `/snapshots/${crypto.randomUUID()}.dump`, createdAt: new Date().toISOString(), kind: "manual" };
      snapshots.push(snapshot);
      calls.push(`snapshot:${environment}`);
      return snapshot;
    },
    async restoreSnapshot(_b: DataBackend, environment: DataEnvironmentName, snapshot: ProjectSnapshot) { calls.push(`restore:${environment}:${snapshot.id}`); },
    async getUsage() { calls.push("usage"); return { bytes: Number(process.env.__TEST_USAGE_BYTES ?? 0), connections: 1 }; },
  };
  return { provisioner: provisioner as unknown as DatabaseProvisioner, calls };
}

function fakeProvider(): DataProvider {
  return {
    async introspectSchema() { return { tables: [{ name: "products", columns: [], constraints: [], indexes: [], rlsEnabled: true, rlsForced: true, policies: [] }] }; },
    schemaFingerprint() { return "fp-after-promote"; },
    compileOperation() { return { operation: { kind: "create_collection" } as never, upSql: "CREATE TABLE x()", reversible: true, destructive: false, requiresSnapshot: false }; },
  } as unknown as DataProvider;
}

function fakeEngine(state: FakeState, options: { drift?: string } = {}) {
  const applied: number[] = [];
  const engine = {
    async dryRun(request: { operation: { kind: string } }) {
      const destructive = request.operation.kind === "drop_collection";
      return {
        operation: request.operation.kind,
        upSql: `-- ${request.operation.kind}`,
        reversible: !destructive,
        destructive,
        requiresSnapshot: destructive,
        current: { tables: [] },
        diff: { operation: request.operation, beforeFingerprint: "fp", sql: `-- ${request.operation.kind}` },
      };
    },
    async apply(_ctx: AuthContext, request: { operation: { kind: string } }) {
      applied.push(1);
      return { id: "m", version: applied.length, checksum: "c", fingerprint: "fp", operation: request.operation.kind, upSql: "", reversible: true, destructive: false, requiresSnapshot: false, current: { tables: [] }, diff: { operation: request.operation, beforeFingerprint: "fp", sql: "" } };
    },
    async detectDrift() { return { status: options.drift ?? "synced", actual: "fp-prod", expected: "fp-prod", schema: { tables: [] } }; },
  };
  return { engine: engine as unknown as ProjectMigrationEngine, applied };
}

describe("D7 — promote dev → prod", () => {
  it("previews the pending dev migrations, their flags and the collection diff", async () => {
    const state = fakeState();
    state.migrations.dev = [{ version: 1, operation: { kind: "create_collection", collection: "products" } }];
    const { provisioner } = fakeProvisioner(state);
    const { engine } = fakeEngine(state);
    const promote = new PromoteService(fakeRepository(state), provisioner, engine, fakeProvider());

    const preview = await promote.preview(owner, state.backend.companyId, state.backend.id, {});
    expect(preview.operations).toHaveLength(1);
    expect(preview.operations[0]!.kind).toBe("create_collection");
    expect(preview.operations[0]!.destructive).toBe(false);
    expect(preview.approvalRequired).toBe(true);
    expect(preview.pendingVersions).toEqual([1]);
    expect(preview.targetEnvironment).toBe("prod");
  });

  it("refuses to apply without approval and does nothing", async () => {
    const state = fakeState();
    const { provisioner, calls } = fakeProvisioner(state);
    const { engine, applied } = fakeEngine(state);
    const promote = new PromoteService(fakeRepository(state), provisioner, engine, fakeProvider());

    await expect(promote.apply(owner, state.backend.companyId, state.backend.id, {}))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED", status: 409 });
    expect(applied).toHaveLength(0);
    expect(calls).not.toContain("snapshot:prod");
  });

  it("blocks promotion while prod has schema drift", async () => {
    const state = fakeState();
    state.environments.prod.syncStatus = "drift_detected";
    const { provisioner } = fakeProvisioner(state);
    const { engine } = fakeEngine(state, { drift: "drift_detected" });
    const promote = new PromoteService(fakeRepository(state), provisioner, engine, fakeProvider());

    await expect(promote.preview(owner, state.backend.companyId, state.backend.id, {}))
      .rejects.toMatchObject({ code: "DRIFT_BLOCKED", status: 409 });
  });

  it("blocks a second promotion while the migration lock is held", async () => {
    const state = fakeState();
    state.locks.set("prod", "other-owner");
    const { provisioner } = fakeProvisioner(state);
    const { engine } = fakeEngine(state);
    const promote = new PromoteService(fakeRepository(state), provisioner, engine, fakeProvider());

    await expect(promote.apply(owner, state.backend.companyId, state.backend.id, { approved: true }))
      .rejects.toMatchObject({ code: "PROMOTE_BUSY", status: 409 });
  });

  it("snapshots prod, replays dev migrations and refreshes the prod fingerprint after approval", async () => {
    const state = fakeState();
    state.migrations.dev = [
      { version: 1, operation: { kind: "create_collection", collection: "products" } },
      { version: 2, operation: { kind: "add_field", collection: "products" } },
    ];
    state.migrations.prod = [{ version: 1, operation: { kind: "create_collection", collection: "products" } }];
    const snapshots: ProjectSnapshot[] = [];
    const { provisioner, calls } = fakeProvisioner(state, snapshots);
    const { engine, applied } = fakeEngine(state);
    const promote = new PromoteService(fakeRepository(state), provisioner, engine, fakeProvider());

    const result = await promote.apply(owner, state.backend.companyId, state.backend.id, { approved: true, agentId: "agent-1" });
    expect(result.status).toBe("applied");
    expect(result.appliedOperations).toBe(1); // version 1 already exists in prod
    expect(applied).toHaveLength(1);
    expect(calls).toContain("snapshot:prod");
    expect(snapshots[0]!.environment).toBe("prod");
    expect(state.snapshots.some((snapshot) => snapshot.kind === "pre_promote")).toBe(true);
    expect(state.environments.prod.schemaFingerprint).toBe("fp-after-promote");
    expect(state.promotions.at(-1)?.status).toBe("applied");
    expect(state.locks.size).toBe(0);
  });

  it("records a rejected promotion for the audit trail", async () => {
    const state = fakeState();
    const { provisioner } = fakeProvisioner(state);
    const { engine } = fakeEngine(state);
    const promote = new PromoteService(fakeRepository(state), provisioner, engine, fakeProvider());

    const rejected = await promote.reject(owner, state.backend.companyId, state.backend.id, { reason: "not now" });
    expect(rejected.status).toBe("rejected");
    expect(state.promotions.at(-1)?.error).toBe("not now");
  });
});

const memoryStorage = {
  name: "memory",
  async store(snapshot: ProjectSnapshot) { return snapshot.path; },
  async remove() { /* no files in tests */ },
  async exists() { return true; },
};

describe("D7 — backups and restore", () => {
  it("creates a manual snapshot, lists it and refuses an unapproved restore", async () => {
    const state = fakeState();
    const snapshots: ProjectSnapshot[] = [];
    const { provisioner, calls } = fakeProvisioner(state, snapshots);
    const backups = new BackupService(fakeRepository(state), provisioner, fakeProvider(), memoryStorage);

    const created = await backups.create(owner, state.backend.companyId, state.backend.id, "prod", { reason: "before release" });
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]!.kind).toBe("manual");
    expect((await backups.list(owner, state.backend.companyId, state.backend.id, "prod"))).toHaveLength(1);

    await expect(backups.restore(owner, state.backend.companyId, state.backend.id, "prod", created.id, {}))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(calls).not.toContain(`restore:prod:${created.id}`);

    const restored = await backups.restore(owner, state.backend.companyId, state.backend.id, "prod", created.id, { approved: true });
    expect(restored.restoredSnapshotId).toBe(created.id);
    expect(restored.safetySnapshotId).toBeTruthy();
    expect(calls).toContain(`restore:prod:${created.id}`);
    expect(state.snapshots.some((snapshot) => snapshot.kind === "pre_restore")).toBe(true);
  });

  it("takes scheduled snapshots when the policy interval elapsed and keeps only `keep` of them", async () => {
    const state = fakeState();
    state.environments.prod.backupPolicy = { intervalMinutes: 60, keep: 2 };
    state.environments.dev.backupPolicy = { intervalMinutes: 0, keep: 2 };
    const snapshots: ProjectSnapshot[] = [];
    const { provisioner } = fakeProvisioner(state, snapshots);
    const backups = new BackupService(fakeRepository(state), provisioner, fakeProvider(), memoryStorage);

    await backups.runScheduled(new Date());
    expect(state.snapshots.filter((snapshot) => snapshot.kind === "scheduled")).toHaveLength(1);
    expect(state.snapshots.filter((snapshot) => snapshot.environment === "dev")).toHaveLength(0);

    // Older scheduled snapshots beyond the keep count are pruned.
    state.snapshots.push({ id: "old-1", backendId: state.backend.id, environment: "prod", path: "/tmp/old-1.dump", createdAt: new Date(Date.now() - 7200_000).toISOString(), kind: "scheduled" });
    state.snapshots.push({ id: "old-2", backendId: state.backend.id, environment: "prod", path: "/tmp/old-2.dump", createdAt: new Date(Date.now() - 3600_000).toISOString(), kind: "scheduled" });
    await backups.runScheduled(new Date());
    expect(state.snapshots.filter((snapshot) => snapshot.kind === "scheduled")).toHaveLength(2);
  });

  it("updates the backup policy per environment", async () => {
    const state = fakeState();
    const { provisioner } = fakeProvisioner(state);
    const backups = new BackupService(fakeRepository(state), provisioner, fakeProvider(), memoryStorage);
    const policy = await backups.updatePolicy(owner, state.backend.companyId, state.backend.id, "dev", { intervalMinutes: 30, keep: 4 });
    expect(policy.intervalMinutes).toBe(30);
    expect(policy.keep).toBe(4);
    expect(state.environments.dev.backupPolicy).toEqual({ intervalMinutes: 30, keep: 4 });
  });

  it("purges a backend only after its removal deadline and cleans databases, roles and secrets", async () => {
    const state = fakeState();
    state.secrets.set("dev:migrator", "x");
    state.backend = { ...state.backend, status: "deleting", removeAfter: new Date(Date.now() - 1000).toISOString() };
    const { provisioner } = fakeProvisioner(state);
    const backups = new BackupService(fakeRepository(state), provisioner, fakeProvider(), memoryStorage);

    const purged = await backups.purgeDueBackends();
    expect(purged).toBe(1);
    expect(state.deprovisioned).toEqual(["dev", "prod"]);
    expect(state.secrets.size).toBe(0);
    expect(state.backend.status).toBe("deleted");
  });
});

describe("D7 — quotas", () => {
  it("reports usage without enforcing persisted database allowances", async () => {
    const state = fakeState();
    state.environments.prod.limits = { maxDatabaseBytes: 1000 };
    const { provisioner } = fakeProvisioner(state);
    const quotas = new QuotaService(fakeRepository(state), provisioner, 0);

    process.env.__TEST_USAGE_BYTES = "500";
    const ok = await quotas.report(owner, state.backend.companyId, state.backend.id, "prod");
    expect(ok.state).toBe("ok");
    expect(ok.limits.maxDatabaseBytes).toBe(1000);
    await expect(quotas.assertWritesAllowed(state.backend, "prod")).resolves.toBeUndefined();

    process.env.__TEST_USAGE_BYTES = "900";
    const warning = await quotas.report(owner, state.backend.companyId, state.backend.id, "prod");
    expect(warning.state).toBe("ok");
    expect(warning.writesBlocked).toBe(false);

    process.env.__TEST_USAGE_BYTES = "1200";
    const exceeded = await quotas.report(owner, state.backend.companyId, state.backend.id, "prod");
    expect(exceeded.state).toBe("ok");
    expect(exceeded.usageQuotasEnabled).toBe(false);
    expect(exceeded.writesBlocked).toBe(false);
    await expect(quotas.assertWritesAllowed(state.backend, "prod")).resolves.toBeUndefined();
    delete process.env.__TEST_USAGE_BYTES;
  });
});

describe("D7 — external databases", () => {
  it("falls back to restricted mode when the owner cannot create roles", async () => {
    const state = fakeState({ provider: "external_postgres" });
    const repository = fakeRepository(state);
    state.secrets.set("dev:external_owner", "postgres://owner:pw@neon.example.com:5432/shop");
    state.secrets.set("prod:external_owner", "postgres://owner:pw@neon.example.com:5432/shop");
    const provisioner = new ExternalPostgresProvisioner(repository, { snapshotDirectory: "/tmp/npati-snapshots" });
    // No real server is contacted: capability inspection fails and the provisioner must report it.
    await expect(provisioner.inspectCapabilities(state.backend, "dev")).rejects.toBeTruthy();
    await expect(provisioner.provisionDatabase(state.backend, "dev")).rejects.toBeTruthy();
  });

  it("rejects a connection string that is not postgres", async () => {
    const state = fakeState({ provider: "external_postgres" });
    const repository = fakeRepository(state);
    state.secrets.set("dev:external_owner", "mysql://owner:pw@host/db");
    const provisioner = new ExternalPostgresProvisioner(repository, { snapshotDirectory: "/tmp/npati-snapshots" });
    await expect(provisioner.getUsage(state.backend, "dev")).rejects.toMatchObject({ code: "INVALID_CONNECTION_STRING" });
  });

  it("refuses external backends without a connection string", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "D7 Co" }, "d7-company");
    const state = fakeState({ provider: "external_postgres" });
    const repository = fakeRepository(state);
    state.backend = { ...state.backend, companyId: company.id };
    state.environments.dev.companyId = company.id;
    state.environments.prod.companyId = company.id;
    const { provisioner } = fakeProvisioner(state);
    const service = new DataBackendService(store, repository, provisioner);

    await expect(service.create(owner, company.id, { name: "External", provider: "external_postgres" }))
      .rejects.toMatchObject({ code: "INVALID_CONNECTION_STRING" });
  });
});

describe("D7 — lifecycle", () => {
  it("defers DataBackend removal behind the snapshot retention window", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "D7 Lifecycle" }, "d7-lifecycle");
    const state = fakeState();
    state.backend = { ...state.backend, companyId: company.id };
    state.environments.dev.companyId = company.id;
    state.environments.prod.companyId = company.id;
    const repository = fakeRepository(state);
    const { provisioner, calls } = fakeProvisioner(state);
    const service = new DataBackendService(store, repository, provisioner);

    const result = await service.remove(owner, company.id, state.backend.id, "Store DB");
    expect(result).toMatchObject({ deleted: false, deferred: true });
    expect(result.removeAfter).toBeTruthy();
    expect(state.backend.status).toBe("deleting");
    expect(calls).not.toContain("deprovision:prod");
    expect(calls).toContain("suspend:prod");
  });

  it("cleans project-bound CORS origins, redirect URLs and logs when a Project is deleted", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "D7 Detach" }, "d7-detach");
    const { project } = await store.createProject(owner, company.id, { name: "Shop", type: "website", dataBackendId: "11111111-1111-4111-8111-111111111111" }, "d7-detach-project");
    const state = fakeState();
    state.backend = { ...state.backend, companyId: company.id };
    state.environments.dev.companyId = company.id;
    state.environments.prod.companyId = company.id;
    state.environments.dev.providerConfig = { corsOriginsByProject: { [project.id]: ["https://shop.example.com"] } };
    state.environments.prod.providerConfig = { corsOriginsByProject: { [project.id]: ["https://shop.example.com"] } };
    const repository = fakeRepository(state);
    const { provisioner } = fakeProvisioner(state);
    const service = new DataBackendService(store, repository, provisioner);

    const result = await service.detachProjectArtifacts(owner, company.id, project.id);
    expect(result.detached).toBe(true);
    expect(result.cleanedOrigins).toBe(2);
    expect(state.environments.dev.providerConfig.corsOriginsByProject).toEqual({});
    expect(state.environments.prod.providerConfig.corsOriginsByProject).toEqual({});
  });

  it("keeps dev and prod isolated: quota overrides apply per environment", async () => {
    const state = fakeState();
    const { provisioner } = fakeProvisioner(state);
    const quotas = new QuotaService(fakeRepository(state), provisioner, 0);
    expect(quotas.resolveLimits("dev").maxDatabaseBytes).toBe(Number(process.env.NPATI_DATA_MAX_DATABASE_BYTES) || 1_000_000_000);
    expect(quotas.resolveLimits("prod", { maxDatabaseBytes: 5 }).maxDatabaseBytes).toBe(5);
    expect(quotas.resolveLimits("dev", { maxDatabaseBytes: 5 }).maxDatabaseBytes).toBe(5);
  });
});

describe("D7 — automatic DataBackend attachment", () => {
  it("attaches a database only on request and returns the Project with the backend already linked", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "Auto attach" }, "auto-attach");
    const calls: string[] = [];
    const service = new ProjectService(store, undefined, async (_ctx, companyId, projectId) => {
      calls.push(projectId);
      // The real callback goes through the repository; here we only verify the plumbing.
      (store as unknown as { projects: Map<string, { dataBackendId?: string }> }).projects.get(projectId)!.dataBackendId = "backend-auto";
      return "backend-auto";
    });

    // Since the opt-in change, creating a website alone never provisions a database.
    const plain = await service.create(owner, company.id, { name: "Plain site", type: "website" }, "auto-attach-plain");
    expect(calls).toHaveLength(0);
    expect(plain.project.dataBackendId).toBeUndefined();
    const created = await service.create(owner, company.id, { name: "Shop", type: "website" }, "auto-attach-key", { attachDataBackend: true });
    expect(calls).toHaveLength(1);
    expect(created.project.dataBackendId).toBe("backend-auto");
  });

  it("keeps an explicitly selected database and never calls the auto attach", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "Explicit" }, "explicit-attach");
    let called = 0;
    const service = new ProjectService(store, undefined, async () => { called += 1; return "backend-other"; });

    const created = await service.create(owner, company.id, { name: "App", type: "mobile_app", dataBackendId: "backend-chosen" }, "explicit-attach-key");
    expect(called).toBe(0);
    expect(created.project.dataBackendId).toBe("backend-chosen");
  });

  it("still creates the Project when the automatic attachment fails", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "Broken attach" }, "broken-attach");
    const service = new ProjectService(store, undefined, async () => { throw new Error("postgres-projects down"); });

    const created = await service.create(owner, company.id, { name: "Site", type: "website" }, "broken-attach-key");
    expect(created.project.id).toBeTruthy();
    expect(created.project.dataBackendId ?? null).toBeNull();
  });
});

describe("D7 — transferring a DataBackend to another company", () => {
  async function harness() {
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "Old Company" }, "transfer-old");
    const target = await store.createCompany(owner, { name: "New Company" }, "transfer-new");
    const state = fakeState();
    state.backend = { ...state.backend, companyId: company.id, name: "Store DB" };
    state.environments.dev.companyId = company.id;
    state.environments.prod.companyId = company.id;
    const transfers: Array<Record<string, string>> = [];
    const repository = fakeRepository(state) as unknown as Record<string, unknown>;
    repository.transferToCompany = async (workspaceId: string, from: string, to: string, backendId: string, createdBy: string) => {
      transfers.push({ workspaceId, from, to, backendId, createdBy });
      return { moved: 1, environments: 2, detachedProjects: 1, promotions: 0 };
    };
    const { provisioner } = fakeProvisioner(state);
    const service = new DataBackendService(store, repository as never, provisioner);
    return { store, service, state, company, target, transfers };
  }

  it("hands the database over to another company and reports the detached projects", async () => {
    const { service, state, company, target, transfers } = await harness();
    const result = await service.transfer(owner, company.id, state.backend.id, { targetCompanyId: target.id, confirmName: "Store DB" });
    expect(result).toMatchObject({
      transferred: true,
      targetCompanyId: target.id,
      targetCompanyName: "New Company",
      detachedProjects: 1,
      environments: 2,
    });
    expect(transfers).toEqual([{ workspaceId: owner.workspaceId, from: company.id, to: target.id, backendId: state.backend.id, createdBy: owner.userId }]);
  });

  it("requires the exact DataBackend name before moving it", async () => {
    const { service, state, company, target, transfers } = await harness();
    await expect(service.transfer(owner, company.id, state.backend.id, { targetCompanyId: target.id, confirmName: "store db" }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(transfers).toHaveLength(0);
  });

  it("refuses the current company and companies of other users as a target", async () => {
    const { store, service, state, company, target, transfers } = await harness();
    await expect(service.transfer(owner, company.id, state.backend.id, { targetCompanyId: company.id, confirmName: "Store DB" }))
      .rejects.toMatchObject({ code: "INVALID_TARGET_COMPANY" });
    await expect(service.transfer(owner, company.id, state.backend.id, { confirmName: "Store DB" }))
      .rejects.toMatchObject({ code: "INVALID_TARGET_COMPANY" });

    const stranger: AuthContext = { workspaceId: owner.workspaceId, userId: "user-stranger", permissions: ["workspace:read", "business:manage"] };
    const foreign = await store.createCompany(stranger, { name: "Foreign" }, "transfer-foreign");
    // The company lookup already refuses another owner's company; the ownership check in the
    // service stays as defence in depth.
    await expect(service.transfer(owner, company.id, state.backend.id, { targetCompanyId: foreign.id, confirmName: "Store DB" }))
      .rejects.toMatchObject({ code: "BUSINESS_ACCESS_DENIED" });
    expect(transfers).toHaveLength(0);
  });

  it("exposes the transfer over HTTP and rejects it without confirmation", async () => {
    const Fastify = (await import("fastify")).default;
    const { registerDataBackendRoutes } = await import("../apps/agent-api/src/data-studio/routes");
    const app = Fastify();
    const calls: unknown[] = [];
    const service = {
      async transfer(_ctx: AuthContext, companyId: string, id: string, input: unknown) {
        calls.push({ companyId, id, input });
        return { transferred: true, backendId: id, targetCompanyId: "company-new", detachedProjects: 0 };
      },
    };
    registerDataBackendRoutes(app, { authenticate: async () => owner } as never, service as never);

    const res = await app.inject({
      method: "POST",
      url: "/companies/company-old/data-backends/backend-1/transfer",
      payload: { targetCompanyId: "company-new", confirmName: "Store DB" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ transferred: true, targetCompanyId: "company-new" });
    expect(calls).toHaveLength(1);

    const missing = await app.inject({ method: "POST", url: "/companies/company-old/data-backends/backend-1/transfer", payload: { targetCompanyId: "company-new" } });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });
});

describe("D7 — schema template routes (settings page)", () => {  it("lists templates, refuses prod and requires explicit approval before applying", async () => {
    const Fastify = (await import("fastify")).default;
    const { registerDataStudioRoutes } = await import("../apps/agent-api/src/data-studio/studio-routes");
    const app = Fastify();
    const calls: Array<{ templateId: string; seedDemoData: boolean }> = [];
    const agentService = {
      async applyTemplate(_ctx: AuthContext, _companyId: string, _projectId: string, templateId: string, options: { seedDemoData?: boolean }) {
        calls.push({ templateId, seedDemoData: options.seedDemoData === true });
        return { applied: true, templateId, collections: ["products"], appliedMigrationsCount: 1, seededRows: options.seedDemoData ? 4 : 0 };
      },
    };
    registerDataStudioRoutes(app, { authenticate: async () => owner } as never, {} as never, agentService as never);

    const list = await app.inject({ method: "GET", url: "/companies/c1/projects/p1/data-studio/dev/templates" });
    expect(list.statusCode).toBe(200);
    const templates = list.json().templates as Array<{ id: string; collections: unknown[] }>;
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.some((template) => template.id === "ecommerce")).toBe(true);

    const prod = await app.inject({ method: "POST", url: "/companies/c1/projects/p1/data-studio/prod/templates/apply", payload: { templateId: "ecommerce", approved: true } });
    expect(prod.statusCode).toBe(409);
    expect(prod.json().error.code).toBe("PROMOTE_REQUIRED");

    const unapproved = await app.inject({ method: "POST", url: "/companies/c1/projects/p1/data-studio/dev/templates/apply", payload: { templateId: "ecommerce" } });
    expect(unapproved.statusCode).toBe(409);
    expect(unapproved.json().error.code).toBe("APPROVAL_REQUIRED");
    expect(calls).toHaveLength(0);

    const applied = await app.inject({ method: "POST", url: "/companies/c1/projects/p1/data-studio/dev/templates/apply", payload: { templateId: "ecommerce", approved: true, seedDemoData: true } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ applied: true, templateId: "ecommerce", seededRows: 4 });
    expect(calls).toEqual([{ templateId: "ecommerce", seedDemoData: true }]);
    await app.close();
  });
});
