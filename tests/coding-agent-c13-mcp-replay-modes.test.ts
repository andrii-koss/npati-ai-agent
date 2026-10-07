import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  ReplayBundleRecorder,
  bundleHash,
  readReplayBundle,
  replayInputHash,
  type ReplayBundleReadResult,
  type ReplayBundleStepPayload,
} from "../apps/agent-api/src/code-replay-bundle";
import {
  CODE_REPLAY_CODES,
  compareRuntimeMcpManifestForReplay,
  replayRecorded,
} from "../apps/agent-api/src/code-replay-engine";
import { CodeReplayService } from "../apps/agent-api/src/code-replay-routes";
import {
  McpRuntimeCapabilityStore,
  buildMcpRuntimeToolRecord,
  mcpRuntimeManifestSnapshot,
  type McpCapabilityTenant,
} from "../apps/agent-api/src/mcp-runtime-capabilities";

/**
 * C13 (owner requirement, corrected): **deterministic replay never discovers, live replay does**.
 *
 * The defect this suite pins shut, in the owner's words: a deterministic replay of an MCP-using run compared
 * the recorded runtime manifest against the manifest of the **current process**, which is read from the
 * in-process runtime overlay. In a fresh process that overlay is empty, so the comparison answered
 * "I cannot say" and the replay was refused with `runtime_mcp_manifest_unavailable` — although the bundle
 * itself carried the manifest and every settled MCP tool result. Reproducing a recorded run therefore required
 * a live discovery it must not perform, and the two modes were indistinguishable.
 *
 * The suite drives the **real** recorder, the **real** reader and the **real** replay engine/service over an
 * `InMemoryWorkspaceStore`, and pins the split:
 *   - `recorded` (the default): the run verifies against the manifest its own bundle recorded, with **zero**
 *     dials — the discovery port is a spy that would throw, and a transport/socket stand-in counts every call;
 *   - `live`: the deployment really discovers, and a manifest that moved — or one that cannot be stated at all —
 *     is refused with the existing 409 contract **before** any run is started.
 */

const WORKSPACE = "ws-c13-replay";
const COMPANY = "company-c13-replay";
const PROJECT = "project-c13-replay";
const SESSION = "session-c13-replay";
const RUN = "run-c13-replay";
const TENANT: McpCapabilityTenant = { workspaceId: WORKSPACE, companyId: COMPANY };

const CTX: AuthContext = {
  userId: "owner-1",
  workspaceId: WORKSPACE,
  permissions: ["owner", "workspace:read", "workspace:write"],
};

const CONNECTION = { connectionId: "conn-1", connectionName: "filesystem", connectionScope: "company" };
const TOOL_SCHEMA = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const CHANGED_TOOL_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, encoding: { type: "string" } },
  required: ["path"],
};
const TOOL_ID = "mcp:conn-1/read_file";

function session(): CodeSession {
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    companyId: COMPANY,
    projectId: PROJECT,
    userId: "owner-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
}

/** The tenant's runtime manifest, built by the real store from a real discovered listing. */
function manifestFor(schema: unknown): Record<string, unknown> {
  const store = new McpRuntimeCapabilityStore();
  store.publish(TENANT, {
    connection: CONNECTION,
    discoveredAt: "2026-02-01T00:00:00.000Z",
    tools: [
      buildMcpRuntimeToolRecord({
        connection: CONNECTION,
        tool: { name: "read_file", description: "read a file", inputSchema: schema },
        discoveredAt: "2026-02-01T00:00:00.000Z",
      }),
    ],
    schemas: { read_file: schema as Record<string, unknown> },
  });
  return mcpRuntimeManifestSnapshot(store.manifestFor(TENANT));
}

/**
 * A recorded MCP-using run: one model step that asked for the runtime tool, and the settled result the model
 * received. The bundle pins the runtime manifest the run was admitted under.
 */
async function recordRun(
  store: InMemoryWorkspaceStore,
  options: { manifest?: Record<string, unknown> | null; runId?: string } = {},
): Promise<ReplayBundleReadResult> {
  const runId = options.runId ?? RUN;
  const recorder = new ReplayBundleRecorder({
    store,
    context: {
      workspaceId: WORKSPACE,
      companyId: COMPANY,
      projectId: PROJECT,
      sessionId: SESSION,
      runId,
      runnerVersion: "runner-c13-replay",
      replayMode: "recorded",
      ...(options.manifest === undefined || options.manifest === null
        ? {}
        : { runtimeMcpManifest: options.manifest }),
      dataClassification: "confidential",
      retentionClass: "standard",
    },
    toolOutputChars: 30_000,
    now: () => new Date("2026-02-01T00:05:00.000Z"),
  });
  recorder.recordModelStep({
    turnIndex: 1,
    request: { model: "test-model", messageCount: 2, toolNames: [TOOL_ID] },
    response: {
      content: "reading over MCP",
      toolCalls: [{ id: "mcp-call-1", name: TOOL_ID, argumentsHash: bundleHash({ path: "a.txt" }) }],
    },
  });
  recorder.recordToolCall({
    turnIndex: 1,
    toolCallId: "mcp-call-1",
    tool: TOOL_ID,
    toolVersion: 1,
    argumentsHash: bundleHash({ path: "a.txt" }),
    settledResult: JSON.stringify({ ok: true, tool: TOOL_ID, result: { kind: "code_tool_result" }, truncated: false }),
    outcome: "ok",
  });
  recorder.recordModelStep({
    turnIndex: 2,
    request: { model: "test-model", messageCount: 4, toolNames: [TOOL_ID] },
    response: { content: "done", toolCalls: [] },
  });
  const written = await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" });
  expect(written.written).toBe(true);
  return readReplayBundle({ store, companyId: COMPANY, runId });
}

interface ReplayServiceHarness {
  service: CodeReplayService;
  store: InMemoryWorkspaceStore;
  recording: ReplayBundleReadResult;
  /** Every live-discovery attempt. A deterministic replay must leave this empty. */
  discoveryCalls: string[];
  /** Every dial any transport stand-in made. A deterministic replay must leave this at zero. */
  dials: number;
  startedRuns: string[];
}

async function serviceHarness(options: {
  recordManifest?: Record<string, unknown> | null;
  liveManifest?: Record<string, unknown> | null;
  discoveryThrows?: boolean;
} = {}): Promise<ReplayServiceHarness> {
  const store = new InMemoryWorkspaceStore();
  const recording = await recordRun(store, {
    // `null` is the "this run used no runtime MCP tool" case and must stay distinct from "use the default".
    manifest: options.recordManifest === undefined ? manifestFor(TOOL_SCHEMA) : options.recordManifest,
  });
  const discoveryCalls: string[] = [];
  const startedRuns: string[] = [];
  const state = { dials: 0 };
  const service = new CodeReplayService({
    authorize: async () => ({ allowed: true }),
    loadRecording: async () => ({
      recording,
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      terminalStatus: "completed",
    }),
    loadSession: async () => session(),
    toolVersions: () => 1,
    loadRuntimeMcpManifest: async (_ctx, _companyId, _projectId, runId) => {
      discoveryCalls.push(runId);
      if (options.discoveryThrows) throw Object.assign(new Error("runtime overlay unavailable"), { code: "overlay_unavailable" });
      // A live discovery is a dial: the counter is what proves that the recorded mode never performs one.
      state.dials += 1;
      return options.liveManifest ?? null;
    },
    loadReplayById: async () => recording,
    live: {
      loadSourceRun: async () => ({ projectId: PROJECT, sessionId: SESSION, snapshotId: "snap-1" }),
      startRun: async (input) => {
        startedRuns.push(input.sourceRunId);
        return { runId: "run-live-1", snapshotId: "snap-live", status: "completed" };
      },
    },
    now: () => Date.parse("2026-02-01T00:10:00.000Z"),
  });
  return {
    service,
    store,
    recording,
    discoveryCalls,
    startedRuns,
    get dials() {
      return state.dials;
    },
  } as ReplayServiceHarness;
}

describe("[security-gate] C13 deterministic replay — the recorded manifest, no discovery", () => {
  it("replays an MCP-using run against the manifest its own bundle recorded, with zero dials", async () => {
    const harness = await serviceHarness();
    const bundle = harness.recording.runtimeMcpManifest as Record<string, unknown>;
    expect(bundle?.providerId).toBe("mcp-runtime");
    expect(typeof bundle?.hash).toBe("string");

    const result = await harness.service.replayRecordedRun(CTX, COMPANY, RUN, { projectId: PROJECT });

    // The replay is clean, and it says exactly what it checked the pin against.
    expect(result.ok).toBe(true);
    expect(result.status).toBe("replayed");
    expect(result.mode).toBe("recorded");
    expect(result.runtimeMcpManifest.mode).toBe("recorded");
    expect(result.runtimeMcpManifest.source).toBe("recording");
    expect(result.runtimeMcpManifest.checked).toBe(true);
    expect(result.runtimeMcpManifest.recordedHash).toBe(bundle.hash);
    expect(result.runtimeMcpManifest.comparedHash).toBe(bundle.hash);
    // Structurally zero: the recorded engine has no transport, no provider and no discovery port at all.
    expect(result.runtimeMcpManifest.dials).toBe(0);
    expect(result.providerCalls).toBe(0);
    expect(result.toolExecutions).toBe(0);

    // …and the recorded **tool results** are the ones the walk verified: two model steps, one settled call.
    expect(result.comparison.modelSteps).toEqual({ matched: 2, expected: 2 });
    expect(result.comparison.toolCalls).toEqual({ matched: 1, expected: 1 });
    expect(result.stepsVerified).toBe(3);

    // The live-discovery port was never consulted, so no process state could have changed the outcome.
    expect(harness.discoveryCalls).toEqual([]);
    expect(harness.dials).toBe(0);
  });

  it("replays with no discovery port wired at all, and after a restart whose overlay is empty", async () => {
    const store = new InMemoryWorkspaceStore();
    // The manifest the run was admitted under, from a tenant whose overlay is now empty (the process restarted).
    const recordedManifest = manifestFor(TOOL_SCHEMA);
    const recording = await recordRun(store, { manifest: recordedManifest });
    expect(new McpRuntimeCapabilityStore().manifestFor(TENANT).toolCount).toBe(0);

    const result = await replayRecorded({
      recording,
      toolVersions: () => 1,
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      recordedTerminalStatus: "completed",
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeMcpManifest).toEqual({
      mode: "recorded",
      checked: true,
      source: "recording",
      recordedHash: recordedManifest.hash,
      comparedHash: recordedManifest.hash,
      dials: 0,
    });
  });

  it("keeps the explicit live comparison: a supplied manifest that moved is still refused (409)", async () => {
    const store = new InMemoryWorkspaceStore();
    const recording = await recordRun(store, { manifest: manifestFor(TOOL_SCHEMA) });
    const moved = manifestFor(CHANGED_TOOL_SCHEMA);
    expect(moved.hash).not.toBe((recording.runtimeMcpManifest as Record<string, unknown>).hash);

    let refused: unknown = null;
    try {
      await replayRecorded({
        recording,
        toolVersions: () => 1,
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        recordedTerminalStatus: "completed",
        // The caller discovered the current tool set itself: this is the live comparison.
        runtimeMcpManifest: moved,
      });
    } catch (error) {
      refused = error;
    }
    expect((refused as { code?: string }).code).toBe(CODE_REPLAY_CODES.runtimeMcpManifestChanged);
    expect((refused as { httpStatus?: number }).httpStatus).toBe(409);
    expect((refused as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "runtime_mcp_manifest_changed",
      mode: "live",
    });

    // The explicit live mode with nothing to compare is still a refusal, never "unchanged".
    let unavailable: unknown = null;
    try {
      await replayRecorded({
        recording,
        toolVersions: () => 1,
        bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
        recordedTerminalStatus: "completed",
        runtimeMcpManifestMode: "live",
      });
    } catch (error) {
      unavailable = error;
    }
    expect((unavailable as { code?: string }).code).toBe(CODE_REPLAY_CODES.runtimeMcpManifestChanged);
    expect((unavailable as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "runtime_mcp_manifest_unavailable",
      mode: "live",
    });
  });

  it("does not depend on external server state: a changed third-party server changes nothing and dials nothing", async () => {
    const store = new InMemoryWorkspaceStore();
    const recording = await recordRun(store, { manifest: manifestFor(TOOL_SCHEMA) });

    // The third-party server now declares a different schema for the same tool. A deterministic replay never
    // asks it anything, so the only way that could matter is through the recording — which is unchanged.
    let dials = 0;
    const externalServer = { dial: () => { dials += 1; return CHANGED_TOOL_SCHEMA; } };
    const first = await replayRecorded({ recording, toolVersions: () => 1, bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION, recordedTerminalStatus: "completed" });
    externalServer.dial();
    const second = await replayRecorded({ recording, toolVersions: () => 1, bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION, recordedTerminalStatus: "completed" });

    expect(dials).toBe(1);
    expect(second.ok).toBe(true);
    expect(second.runtimeMcpManifest).toEqual(first.runtimeMcpManifest);
    expect(second.divergences).toEqual([]);
    expect(second.runtimeMcpManifest.dials).toBe(0);
  });

  it("reads the comparison from the recording only, and never from a live value", () => {
    const recorded = manifestFor(TOOL_SCHEMA);
    const moved = manifestFor(CHANGED_TOOL_SCHEMA);
    // Recorded mode ignores a current value entirely — the two modes cannot be mixed.
    expect(compareRuntimeMcpManifestForReplay({ recorded, current: moved, mode: "recorded", runId: RUN })).toEqual({
      mode: "recorded",
      checked: true,
      source: "recording",
      recordedHash: recorded.hash,
      comparedHash: recorded.hash,
      dials: 0,
    });
    // A run that recorded no manifest has nothing to check, in either mode, and says so rather than "checked".
    expect(compareRuntimeMcpManifestForReplay({ recorded: null, current: moved, mode: "live", runId: RUN })).toEqual({
      mode: "none",
      checked: false,
      source: "none",
      recordedHash: null,
      comparedHash: null,
      dials: 0,
    });
  });
});

describe("[security-gate] C13 live replay — discovery happens here, and a moved manifest is refused first", () => {
  it("refuses a live replay whose discovered manifest differs, before any run is started", async () => {
    const harness = await serviceHarness({ liveManifest: manifestFor(CHANGED_TOOL_SCHEMA) });

    let refused: unknown = null;
    try {
      await harness.service.replayLiveRun(CTX, COMPANY, RUN, { projectId: PROJECT });
    } catch (error) {
      refused = error;
    }
    expect((refused as { code?: string }).code).toBe(CODE_REPLAY_CODES.runtimeMcpManifestChanged);
    expect((refused as { httpStatus?: number }).httpStatus).toBe(409);
    expect((refused as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "runtime_mcp_manifest_changed",
      mode: "live",
      runId: RUN,
    });
    // The live mode really did discover …
    expect(harness.discoveryCalls).toEqual([RUN]);
    // … and the mismatch stopped the replay before it could start a run against a tool set the source run never saw.
    expect(harness.startedRuns).toEqual([]);
  });

  it("refuses a live replay when the current manifest cannot be stated at all", async () => {
    const harness = await serviceHarness({ liveManifest: null });
    let refused: unknown = null;
    try {
      await harness.service.replayLiveRun(CTX, COMPANY, RUN, { projectId: PROJECT });
    } catch (error) {
      refused = error;
    }
    expect((refused as { code?: string }).code).toBe(CODE_REPLAY_CODES.runtimeMcpManifestChanged);
    expect((refused as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "runtime_mcp_manifest_unavailable",
      mode: "live",
    });
    expect(harness.startedRuns).toEqual([]);
  });

  it("starts the live replay when the discovered manifest still matches the recording", async () => {
    const recorded = manifestFor(TOOL_SCHEMA);
    const harness = await serviceHarness({ liveManifest: recorded });
    const result = await harness.service.replayLiveRun(CTX, COMPANY, RUN, { projectId: PROJECT });
    expect(result.mode).toBe("live_best_effort");
    expect(result.notice).toBe("Best-effort reproducibility. External models, registries and services may have changed.");
    expect(harness.discoveryCalls).toEqual([RUN]);
    expect(harness.startedRuns).toEqual([RUN]);
  });

  it("skips the live check for a run that recorded no runtime MCP manifest", async () => {
    const harness = await serviceHarness({ recordManifest: null, liveManifest: null });
    const result = await harness.service.replayLiveRun(CTX, COMPANY, RUN, { projectId: PROJECT });
    expect(result.mode).toBe("live_best_effort");
    // Nothing was recorded, so there is nothing to compare and no discovery is forced.
    expect(harness.discoveryCalls).toEqual([]);
    expect(harness.startedRuns).toEqual([RUN]);
  });
});

describe("[security-gate] C13 replay bundle — the format version and the pre-C13 hash are untouched", () => {
  it("hashes a bundle without runtime MCP fields exactly as before the field existed", async () => {
    const store = new InMemoryWorkspaceStore();
    const recording = await recordRun(store, { manifest: null });
    const steps = recording.replayInput as ReplayBundleStepPayload[];
    // The recorded shape carries no runtime field at all …
    expect(recording.runtimeMcpManifest).toBeNull();
    // … so the derivation is byte-for-byte the pre-C13 one (and the format stays version 3).
    expect(REPLAY_BUNDLE_FORMAT_VERSION).toBe(3);
    expect(replayInputHash(steps)).toBe(bundleHash({ steps }));
    // A replay of such a run reports "nothing to check" rather than a fabricated comparison.
    const result = await replayRecorded({
      recording,
      toolVersions: () => 1,
      bundleVersion: REPLAY_BUNDLE_FORMAT_VERSION,
      recordedTerminalStatus: "completed",
    });
    expect(result.ok).toBe(true);
    expect(result.runtimeMcpManifest).toEqual({
      mode: "none",
      checked: false,
      source: "none",
      recordedHash: null,
      comparedHash: null,
      dials: 0,
    });
  });
});
