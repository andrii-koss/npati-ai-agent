import { describe, expect, it, vi } from "vitest";

import { InMemoryWorkspaceStore } from "../packages/workspace/src/in-memory-store";
import { ExecutionSnapshotImmutableError } from "../packages/workspace/src/types";
import {
  collectExecutionSnapshotPayload,
  assertNoSecretsInSnapshot,
  createExecutionSnapshotProvider,
  readSnapshotForRun,
  SnapshotSecretDetectedError,
  type ExecutionSnapshotSources,
} from "../apps/agent-api/src/execution-snapshot";
import {
  ensureModelProfilesVersion,
  ensureSystemPromptVersion,
  snapshotConfigContentHash,
} from "../apps/agent-api/src/code-snapshot-versioning";

const COMPANY = "company-1";
const WORKSPACE = "workspace-1";
const PROJECT = "project-1";
const SESSION = "session-1";
/** A GitHub-shaped token the C4a scanner recognises; used only to prove the refusal path. */
const CANARY_SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function source(overrides: Partial<ExecutionSnapshotSources> = {}): ExecutionSnapshotSources {
  return {
    toolManifestVersion: async () => 5,
    policyVersion: async () => "policy-3",
    modelProfileVersion: async () => 2,
    modelSelection: async () => ({ provider: "local", model: "self-hosted-1", parameters: { topP: 0.9 } }),
    systemPrompt: async () => ({ version: 1, contentHash: "sha256:prompt" }),
    runnerVersion: async () => "1.2.3+fingerprint",
    sandboxImage: async () => ({ digest: "sha256:image", sbomRef: "sbom.json" }),
    featureFlags: async () => ({ "code.write": true }),
    providerDataPolicy: async () => ({ version: 4, classification: "confidential" }),
    baseCommit: async () => ({ branch: "main", commit: "abc123", dirty: false }),
    projectInstructions: async () => ({ contentHash: null, trustStatus: "untrusted" }),
    toolchain: async () => ({ node: "22.13.0" }),
    ...overrides,
  };
}

async function createSnapshot(store: InMemoryWorkspaceStore, runId?: string, turn = 0) {
  return store.createExecutionSnapshot({
    companyId: COMPANY,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: runId ?? null,
    payload: { snapshotSchemaVersion: 1, note: `turn-${turn}` },
    trigger: runId ? "run_start" : "session_start",
    createdBy: "user-1",
    now: new Date(2026, 0, 1, 0, 0, turn),
    id: `snap-${turn}`,
  });
}

describe("security-gate: C6b execution snapshot store is append-only", () => {
  it("creates a snapshot per run, chains it to the session head and hashes the payload", async () => {
    const store = new InMemoryWorkspaceStore();
    const first = await createSnapshot(store);
    const second = await createSnapshot(store, "run-1", 1);

    expect(first.snapshotVersion).toBe(1);
    expect(first.prevSnapshotId).toBeNull();
    expect(second.snapshotVersion).toBe(2);
    expect(second.prevSnapshotId).toBe(first.id);
    expect(second.prevPayloadHash).toBe(first.payloadHash);
    expect(second.payloadHash.startsWith("sha256:")).toBe(true);
  });

  it("refuses a create that would reuse an existing snapshot id (no upsert path)", async () => {
    const store = new InMemoryWorkspaceStore();
    await createSnapshot(store);
    await expect(createSnapshot(store)).rejects.toBeInstanceOf(ExecutionSnapshotImmutableError);
  });

  it("has no update or delete surface at all", () => {
    const store = new InMemoryWorkspaceStore() as unknown as Record<string, unknown>;
    expect(store["updateExecutionSnapshot"]).toBeUndefined();
    expect(store["deleteExecutionSnapshot"]).toBeUndefined();
  });

  it("keeps the payload hash sensitive to payload content", async () => {
    const store = new InMemoryWorkspaceStore();
    const a = await store.createExecutionSnapshot({
      companyId: COMPANY, workspaceId: WORKSPACE, projectId: PROJECT, sessionId: "s-a",
      payload: { policyVersion: "1" }, trigger: "run_start", createdBy: "user-1",
    });
    const b = await store.createExecutionSnapshot({
      companyId: COMPANY, workspaceId: WORKSPACE, projectId: PROJECT, sessionId: "s-b",
      payload: { policyVersion: "2" }, trigger: "run_start", createdBy: "user-1",
    });
    expect(a.payloadHash).not.toBe(b.payloadHash);
  });

  it("isolates snapshots by company", async () => {
    const store = new InMemoryWorkspaceStore();
    const created = await createSnapshot(store);
    expect(await store.getExecutionSnapshot("other-company", created.id)).toBeNull();
    expect(await store.getLatestSnapshotForSession("other-company", SESSION)).toBeNull();
  });

  it("reports the changed field, not the whole object, and never the values verbatim", async () => {
    const store = new InMemoryWorkspaceStore();
    const before = await store.createExecutionSnapshot({
      companyId: COMPANY, workspaceId: WORKSPACE, projectId: PROJECT, sessionId: "s",
      payload: { featureFlags: { "code.write": true }, policyVersion: "1" },
      trigger: "run_start", createdBy: "user-1",
    });
    const after = await store.createExecutionSnapshot({
      companyId: COMPANY, workspaceId: WORKSPACE, projectId: PROJECT, sessionId: "s",
      payload: { featureFlags: { "code.write": false }, policyVersion: "1" },
      trigger: "run_start", createdBy: "user-1",
    });
    const diff = store.diffExecutionSnapshots(before, after);
    expect(diff.changes.map((change) => change.field)).toEqual(["featureFlags.code.write"]);
    expect(diff.changes[0]?.from).toBe("true");
    expect(diff.changes[0]?.to).toBe("false");
    expect(diff.unchanged).toContain("policyVersion");
    expect(JSON.stringify(diff)).not.toContain(CANARY_SECRET);
  });

  it("reads the snapshot of a run and answers legacy_no_snapshot when there is none", async () => {
    const store = new InMemoryWorkspaceStore();
    await createSnapshot(store, "run-1");
    const found = await readSnapshotForRun(store, COMPANY, "run-1");
    expect(found.kind).toBe("snapshot");

    const missing = await readSnapshotForRun(store, COMPANY, "run-before-c6b");
    expect(missing).toEqual({ kind: "legacy_no_snapshot", runId: "run-before-c6b" });
  });
});

describe("security-gate: C6b config versions are immutable and deduplicated by content", () => {
  it("reuses the version for identical content and creates a new one for a change", async () => {
    const store = new InMemoryWorkspaceStore();
    const first = await ensureSystemPromptVersion({
      store, companyId: COMPANY, workspaceId: WORKSPACE, content: { role: "coder" },
      promptText: "You are a coding agent.", createdBy: "user-1",
    });
    const again = await ensureSystemPromptVersion({
      store, companyId: COMPANY, workspaceId: WORKSPACE, content: { role: "coder" },
      promptText: "You are a coding agent.", createdBy: "user-1",
    });
    const changed = await ensureSystemPromptVersion({
      store, companyId: COMPANY, workspaceId: WORKSPACE, content: { role: "coder" },
      promptText: "You are a coding agent. Be terse.", createdBy: "user-1",
    });

    expect(first.created).toBe(true);
    expect(first.version).toBe(1);
    expect(again.created).toBe(false);
    expect(again.version).toBe(first.version);
    expect(again.contentHash).toBe(first.contentHash);
    expect(changed.created).toBe(true);
    expect(changed.version).toBe(2);
  });

  it("hashes content order-independently and tracks model profiles separately from prompts", async () => {
    expect(snapshotConfigContentHash({ a: 1, b: 2 })).toBe(snapshotConfigContentHash({ b: 2, a: 1 }));
    const store = new InMemoryWorkspaceStore();
    const profiles = await ensureModelProfilesVersion({
      store, companyId: COMPANY, workspaceId: WORKSPACE, content: { profiles: [{ id: "p1" }] },
      createdBy: "user-1",
    });
    expect(profiles.version).toBe(1);
    expect(await store.getSnapshotConfigVersion(COMPANY, "system_prompt", 1)).toBeNull();
    expect((await store.listSnapshotConfigVersions(COMPANY, "model_profiles")).length).toBe(1);
  });
});

describe("security-gate: C6b snapshot provider reads real sources and refuses secrets", () => {
  it("collects every field and marks an unreadable source instead of dropping it", async () => {
    const { payload, unavailable } = await collectExecutionSnapshotPayload({
      sources: source({ toolchain: async () => { throw new Error("detector_offline"); } }),
      actor: "user-1",
      role: "developer",
      now: new Date(2026, 0, 1),
      trigger: "run_start",
    });

    expect(payload["toolManifestVersion"]).toBe(5);
    expect(payload["runnerVersion"]).toBe("1.2.3+fingerprint");
    expect(payload["providerDataPolicy"]).toEqual({ version: 4, classification: "confidential" });
    expect(payload["projectInstructions"]).toEqual({ contentHash: null, trustStatus: "untrusted" });
    // The unreadable source is explicit, so "we could not tell" cannot be read as "nothing configured".
    expect(payload["toolchain"]).toEqual({ unavailable: "detector_offline" });
    expect(unavailable).toEqual(["toolchain"]);
  });

  it("refuses to persist a snapshot whose sources contain a secret", async () => {
    const { payload } = await collectExecutionSnapshotPayload({
      sources: source({ featureFlags: async () => ({ leaked: CANARY_SECRET }) }),
      actor: "user-1",
      role: "developer",
      now: new Date(2026, 0, 1),
      trigger: "run_start",
    });

    // The secret reaches the payload (nothing silently strips it) and the guard then refuses to persist it.
    expect(JSON.stringify(payload)).toContain(CANARY_SECRET);
    expect(() => assertNoSecretsInSnapshot(payload)).toThrow(SnapshotSecretDetectedError);
    expect(() => assertNoSecretsInSnapshot({ note: "clean" })).not.toThrow();
  });

  it("creates a run snapshot that getSnapshotForRun can find (run_id binding)", async () => {
    const store = new InMemoryWorkspaceStore();
    const provider = createExecutionSnapshotProvider({
      store,
      sources: source(),
      workspaceId: WORKSPACE,
      resolveRole: async () => "developer",
      now: () => new Date(2026, 0, 2),
      id: () => "snap-run-1",
    });

    const created = await provider.create({
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: "run-1", actor: "user-1",
    });
    expect(created.snapshotId).toBe("snap-run-1");

    const byRun = await store.getSnapshotForRun(COMPANY, "run-1");
    expect(byRun?.id).toBe("snap-run-1");
    expect(byRun?.trigger).toBe("run_start");
    expect(byRun?.payload["actorRole"]).toBe("developer");
  });

  it("never persists a secret even through the provider path", async () => {
    const store = new InMemoryWorkspaceStore();
    const create = vi.fn(store.createExecutionSnapshot.bind(store));
    const provider = createExecutionSnapshotProvider({
      store: { ...store, createExecutionSnapshot: create } as unknown as InMemoryWorkspaceStore,
      sources: source({ toolchain: async () => ({ token: CANARY_SECRET }) }),
      workspaceId: WORKSPACE,
      now: () => new Date(2026, 0, 3),
    });

    await expect(provider.create({
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: "run-secret", actor: "user-1",
    })).rejects.toBeInstanceOf(SnapshotSecretDetectedError);
    expect(create).not.toHaveBeenCalled();
  });
});
