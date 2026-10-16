import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { NetworkActivityRecorder } from "../apps/agent-api/src/network-activity";
import { PolicyDecisionRecorder } from "../apps/agent-api/src/policy-decision-activity";
import {
  ActivityContentRejectedError,
  ActivitySecretRejectedError,
  activitySinkForKind,
  assertMetadataOnlyActivityPayload,
  assertNoSecretsInActivityPayload,
  createCodeRunActivitySink,
  splitActivityEvent,
} from "../apps/agent-api/src/code-run-activity-sink";

/**
 * C6b — Activity events must carry their `snapshot_id` and must be storable without ever becoming a content
 * or secret store. These tests run the real store (in-memory) and the real recorders, so a regression in the
 * shared sink fails here rather than in production.
 */

const COMPANY = "company-1";
const WORKSPACE = "workspace-1";
const SESSION = "session-1";
const RUN = "run-1";
const SNAPSHOT = "snapshot-1";

function makeSink(now = new Date("2026-01-02T03:04:05.000Z")) {
  const store = new InMemoryWorkspaceStore();
  const log = vi.fn();
  const sink = createCodeRunActivitySink({
    store,
    workspaceId: WORKSPACE,
    classification: { resolve: () => ({ dataClassification: "confidential", retentionClass: "standard" }) },
    log,
    now: () => now,
  });
  return { store, sink, log };
}

describe("security-gate: C6b activity events reference their snapshot", () => {
  it("persists a tool-call event with its snapshot id", async () => {
    const { store, sink } = makeSink();
    const result = await sink.record(
      { kind: "code_tool_activity", companyId: COMPANY, projectId: "project-1", sessionId: SESSION, runId: RUN, snapshotId: SNAPSHOT },
      { tool: "code.fs.read", toolVersion: 1, durationMs: 12, bytes: 40, truncated: false, ok: true },
    );
    expect(result.persisted).toBe(true);
    const events = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId: COMPANY, projectId: "project-1", sessionId: SESSION, runId: RUN,
      snapshotId: SNAPSHOT, kind: "code_tool_activity",
    });
    expect(events[0]!.payload.tool).toBe("code.fs.read");
  });

  it("stores data_classification and retention_class from creation, never undefined", async () => {
    const { store, sink } = makeSink();
    await sink.record({ kind: "run_activity", companyId: COMPANY, sessionId: SESSION }, { status: "completed" });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event!.dataClassification).toBe("confidential");
    expect(event!.retentionClass).toBe("standard");
  });

  it("falls back to conservative defaults when the resolver returns nothing", async () => {
    const store = new InMemoryWorkspaceStore();
    const sink = createCodeRunActivitySink({ store, workspaceId: WORKSPACE });
    await sink.record({ kind: "run_activity", companyId: COMPANY }, { status: "running" });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event!.dataClassification).toBe("confidential");
    expect(event!.retentionClass).toBe("standard");
  });

  it("keeps snapshotId null when no snapshot exists instead of fabricating one", async () => {
    const { store, sink } = makeSink();
    await sink.record({ kind: "run_activity", companyId: COMPANY, runId: RUN }, { status: "running" });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event!.snapshotId).toBeNull();
    expect(event!.runId).toBe(RUN);
  });

  it("filters events by snapshot so 'why did the agent do this' can be answered", async () => {
    const { store, sink } = makeSink();
    await sink.record({ kind: "policy_decision", companyId: COMPANY, snapshotId: SNAPSHOT }, { decision: "allow" });
    await sink.record({ kind: "policy_decision", companyId: COMPANY, snapshotId: "other" }, { decision: "deny" });
    const events = await store.listCodeActivityEvents({ companyId: COMPANY, snapshotId: SNAPSHOT });
    expect(events).toHaveLength(1);
    expect(events[0]!.snapshotId).toBe(SNAPSHOT);
  });

  it("never lets another company read these events", async () => {
    const { store, sink } = makeSink();
    await sink.record({ kind: "run_activity", companyId: COMPANY }, { status: "running" });
    expect(await store.listCodeActivityEvents({ companyId: "company-2" })).toEqual([]);
  });
});

describe("security-gate: C6b activity payloads are metadata only", () => {
  it("rejects a command line instead of stripping it silently", async () => {
    const { store, sink } = makeSink();
    await expect(
      sink.record({ kind: "code_tool_activity", companyId: COMPANY }, { tool: "code.shell.exec", command: "rm -rf /" }),
    ).rejects.toBeInstanceOf(ActivityContentRejectedError);
    expect(await store.listCodeActivityEvents({ companyId: COMPANY })).toEqual([]);
  });

  // Plain loop rather than `it.each`: the same assertions under vitest, and the shared verification harness
  // does not implement `it.each`. A suite that cannot load is a suite that proves nothing.
  const contentKeyCases: Array<[string, Record<string, unknown>]> = [
    ["content", { content: "file body" }],
    ["diff", { diff: "--- a\n+++ b" }],
    ["prompt", { prompt: "system" }],
    ["stdout", { stdout: "log line" }],
    ["url", { url: "https://example.com/x" }],
    ["nested", { outer: { inner: { command: "ls" } } }],
    ["in an array", { items: [{ command: "ls" }] }],
  ];
  for (const [label, payload] of contentKeyCases) {
    it(`rejects content key ${label}`, () => {
      expect(() => assertMetadataOnlyActivityPayload(payload)).toThrow(ActivityContentRejectedError);
    });
  }

  it("rejects content beyond the former array and nesting inspection limits before storage or logging", async () => {
    const { store, sink, log } = makeSink();
    const items: Record<string, unknown>[] = Array.from({ length: 101 }, () => ({ ok: true }));
    items.push({ prompt: "Private user instruction" });
    let nested: Record<string, unknown> = { stdout: "Private terminal output" };
    for (let index = 0; index < 10; index++) nested = { nested };
    for (const payload of [{ items }, nested]) {
      await expect(sink.record({ kind: "run_activity", companyId: COMPANY }, payload)).rejects.toBeInstanceOf(ActivityContentRejectedError);
    }
    expect(await store.listCodeActivityEvents({ companyId: COMPANY })).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(() => assertMetadataOnlyActivityPayload({ paths: Array.from({ length: 150 }, (_, index) => `src/file-${index}.ts`) })).not.toThrow();
  });

  it("fails closed on excessive complexity and cycles instead of accepting uninspected fields", () => {
    let nested: Record<string, unknown> = { ok: true };
    for (let index = 0; index < 40; index++) nested = { nested };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertMetadataOnlyActivityPayload(nested)).toThrow(ActivityContentRejectedError);
    expect(() => assertMetadataOnlyActivityPayload(cyclic)).toThrow(ActivityContentRejectedError);
    expect(() => assertMetadataOnlyActivityPayload({ items: Array(10_001).fill(null) })).toThrow(ActivityContentRejectedError);
  });
  it("rejects a secret hidden in an innocuous key", async () => {
    const { store, sink } = makeSink();
    await expect(
      sink.record({ kind: "run_activity", companyId: COMPANY }, { note: "token ghp_012345678901234567890123456789012345" }),
    ).rejects.toBeInstanceOf(ActivitySecretRejectedError);
    expect(await store.listCodeActivityEvents({ companyId: COMPANY })).toEqual([]);
    expect(() => assertNoSecretsInActivityPayload({ note: "no secrets here" })).not.toThrow();
  });

  it("allows metadata, including file paths, which this project treats as metadata", async () => {
    const { sink } = makeSink();
    const result = await sink.record(
      { kind: "policy_decision", companyId: COMPANY, snapshotId: SNAPSHOT },
      { action: "code.fs.edit", decision: "allow", phase: "risk", paths: ["src/index.ts"], filesChanged: 1 },
    );
    expect(result.persisted).toBe(true);
  });

  it("splits an event into identity and payload so a caller cannot forget the snapshot", () => {
    const { identity, payload } = splitActivityEvent({
      kind: "policy_decision", companyId: COMPANY, snapshotId: SNAPSHOT, sessionId: SESSION,
      decision: "deny", code: "hard_deny",
    });
    expect(identity).toMatchObject({ kind: "policy_decision", companyId: COMPANY, snapshotId: SNAPSHOT, sessionId: SESSION });
    expect(payload).toEqual({ decision: "deny", code: "hard_deny" });
  });

  it("refuses an unknown event kind and a missing company", async () => {
    const { sink } = makeSink();
    await expect(sink.record({ kind: "not_a_kind" as never, companyId: COMPANY }, {})).rejects.toBeInstanceOf(ActivityContentRejectedError);
    await expect(sink.record({ kind: "run_activity", companyId: "" }, {})).rejects.toBeInstanceOf(ActivityContentRejectedError);
  });
});

describe("security-gate: C6b a failing sink never changes a decision", () => {
  it("reports a store failure instead of throwing", async () => {
    const failing = {
      createCodeActivityEvent: vi.fn(async () => { throw new Error("store down"); }),
    };
    const sink = createCodeRunActivitySink({ store: failing as never, workspaceId: WORKSPACE });
    const result = await sink.record({ kind: "run_activity", companyId: COMPANY }, { status: "running" });
    expect(result).toEqual({ persisted: false, errorCode: "activity_persist_failed", errorMessage: "store down" });
  });

  it("still logs the event in parallel so diagnostics survive", async () => {
    const { sink, log } = makeSink();
    await sink.record({ kind: "run_activity", companyId: COMPANY, snapshotId: SNAPSHOT }, { status: "completed" });
    expect(log).toHaveBeenCalled();
    const [logged] = log.mock.calls[0]!;
    expect(logged).toMatchObject({ kind: "run_activity", snapshotId: SNAPSHOT, dataClassification: "confidential" });
  });
});

describe("security-gate: C6b the existing recorders persist through the shared sink", () => {
  it("persists policy decisions with the snapshot id from the request", async () => {
    const { store, sink } = makeSink();
    const recorder = new PolicyDecisionRecorder({ sink: activitySinkForKind(sink, "policy_decision") });
    await recorder.record({
      companyId: COMPANY, sessionId: SESSION, runId: RUN, snapshotId: SNAPSHOT,
      tool: "code.shell.exec", action: "code.shell.exec", phase: "approval", decision: "require_approval",
      actor: "user-1", actorKind: "user",
    });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event).toMatchObject({ kind: "policy_decision", snapshotId: SNAPSHOT, runId: RUN });
    expect(event!.payload.decision).toBe("require_approval");
    expect(JSON.stringify(event)).not.toMatch(/command|stdout|content/i);
  });

  it("persists network decisions with run and snapshot when known", async () => {
    const { store, sink } = makeSink();
    const recorder = new NetworkActivityRecorder({ sink: activitySinkForKind(sink, "network_decision") });
    await recorder.record({
      companyId: COMPANY, sessionId: SESSION, runId: RUN, snapshotId: SNAPSHOT,
      phase: "run", host: "registry.npmjs.org", port: 443, protocol: "https", action: "allow",
    });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event).toMatchObject({ kind: "network_decision", snapshotId: SNAPSHOT, runId: RUN });
    expect(event!.payload).toMatchObject({ host: "registry.npmjs.org", action: "allow" });
    expect(event!.payload).not.toHaveProperty("url");
  });

  it("keeps network events without a snapshot storable", async () => {
    const { store, sink } = makeSink();
    const recorder = new NetworkActivityRecorder({ sink: activitySinkForKind(sink, "network_decision") });
    await recorder.record({ companyId: COMPANY, phase: "run", host: "example.com", protocol: "https", action: "deny", code: "denied" });
    const [event] = await store.listCodeActivityEvents({ companyId: COMPANY });
    expect(event!.snapshotId).toBeNull();
  });
});
