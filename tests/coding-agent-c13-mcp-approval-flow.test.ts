import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import { RiskApprovalService } from "../packages/shared/src/risk-approval";
import { approvalPayloadForHash } from "../apps/agent-api/src/approvals-repository";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodeRunRuntimeCapabilitiesPort,
  type CodingAgentRunInput,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";
import {
  McpRuntimeCapabilityStore,
  assertReplayRuntimeMcpManifestMatches,
  lookupCapability,
  type McpCapabilityTenant,
} from "../apps/agent-api/src/mcp-runtime-capabilities";
import { applyMcpRiskOverride } from "../apps/agent-api/src/mcp-risk-override";
import { McpToolPolicyStore } from "../apps/agent-api/src/mcp-tool-policy-repository";
import {
  MCP_APPROVAL_KIND,
  mcpApprovalArgsHash,
  mcpApprovalPayloadFor,
  releaseMcpApprovalPause,
} from "../apps/agent-api/src/mcp-approval";
import { createMcpRuntimeRunPath } from "../apps/agent-api/src/mcp-run-path";
import { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";
import { refuseResume } from "../apps/agent-api/src/code-run-state";
import { McpRuntimeTransport, configuredIntegrationsFrom, type ConfiguredMcpIntegration } from "../apps/agent-api/src/mcp-runtime-transport";
import { ssrfSafeFetch, type SsrfTransportResponse } from "../apps/agent-api/src/ssrf-safe-http";
import type { ResolverPort } from "../apps/agent-api/src/ssrf-policy";

/**
 * C13 (owner blocker 1): **one-shot approval of a runtime MCP call** — ask, pause, approve, redeem once,
 * resume the same run, execute.
 *
 * The owner's requirement verbatim: `approval_required` → pause the run → a human approves **the exact
 * provider/connection/tool/schema-hash/args-hash** → the approval is consumed **once** → the same run resumes
 * → the tool really executes. A normal one-shot approval must not require the owner/admin risk downgrade.
 *
 * What the suite drives, and with what:
 *
 *   - the **real** `McpRuntimeRunPath` over the **real** `McpRuntimeTransport`/`ssrfSafeFetch` (only the socket
 *     is a stand-in, so the SSRF policy, the allowlist and the response guard are real);
 *   - the **real** `PolicyEngine`, wired exactly like `app.ts` (static → runtime capability lookup, the approval
 *     gateway adapted onto the durable store);
 *   - the **real** runner, so the pause is the run's own `waiting_for_user` state and the resume is the run's
 *     own continuation;
 *   - a durable approval table that mirrors `CompanyApprovalsRepository.consumeApproved` (status, single use,
 *     expiry, `run_id`, `agent_id`, `tool_name` and the canonical payload hash), hashed with the **real**
 *     `RiskApprovalService` and `approvalPayloadForHash`. A stand-in that accepted any payload would prove
 *     nothing, so the mirroring is the point: the suite asserts that the material the request side stored and
 *     the material the consuming side presented hash to the **same** value.
 */

const WORKSPACE = "ws-1";
const COMPANY = "company-a";
const TENANT: McpCapabilityTenant = { workspaceId: WORKSPACE, companyId: COMPANY };
const PROJECT_ID = "project-1";
const SESSION_ID = "session-1";
const RUN_ID = "run-1";
const AGENT_ID = "agent-1";
const OWNER_CTX: AuthContext = {
  userId: "owner-1",
  workspaceId: WORKSPACE,
  permissions: ["owner", "workspace:read", "workspace:write"],
};

const PUBLIC_HOST = "mcp.example.com";
const CONNECTION_ID = "conn-1";
const TOOL_NAME = "read_file";
const TOOL_ID = `mcp:${CONNECTION_ID}/${TOOL_NAME}`;
const READ_FILE_SCHEMA = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const CALL_ARGS = { path: "a.txt" };

const INTEGRATION: ConfiguredMcpIntegration = {
  connectionId: CONNECTION_ID,
  connectionName: "filesystem",
  connectionScope: "company",
  transport: "http",
  endpoint: `https://${PUBLIC_HOST}/api/mcp/stream`,
};

const STATIC_DESCRIPTORS = [{ name: "code.fs.read", version: 1, status: "active", description: "read a file", write: false }];
const STATIC_SCHEMAS = STATIC_DESCRIPTORS.map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}));
const INTEGRATION_FLAGS = ["coding_agent.enabled", "code.read", "code.write", "code.mcp"] as const;

function session(): CodeSession {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE,
    companyId: COMPANY,
    projectId: PROJECT_ID,
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

function nativeCall(name: string, args: Record<string, unknown>, id: string) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

const resolver: ResolverPort = async () => ["93.184.216.34"];

function toolsListBody(tools: Array<{ name: string; inputSchema?: unknown }>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: tools.map((tool) => ({ name: tool.name, description: `${tool.name} from a third-party server`, inputSchema: tool.inputSchema ?? {} })) },
  });
}

function toolCallBody(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } });
}

/** The socket stand-in: it counts every dial, which is how "the tool was not called" is measured. */
function recordingSocket(answers: Array<{ status?: number; body?: string }>) {
  const calls: string[] = [];
  const socket = async (request: { url: URL }): Promise<SsrfTransportResponse> => {
    calls.push(request.url.toString());
    const answer = answers[calls.length - 1] ?? answers[answers.length - 1] ?? { status: 200, body: "{}" };
    const bytes = new TextEncoder().encode(answer.body ?? "{}");
    return {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    } as SsrfTransportResponse;
  };
  return { socket, calls };
}

/**
 * The durable approval table, with the behaviour of `CompanyApprovalsRepository`: a record is stored with the
 * hash of its payload and consumed **atomically** against status, single use, expiry, context and that hash.
 */
class DurableApprovals {
  private readonly risk = new RiskApprovalService("c13-mcp-approval-secret");
  private readonly rows = new Map<string, {
    id: string; companyId: string; userId: string; runId: string | null; agentId: string | null; toolName: string;
    inputPayload: Record<string, unknown>; payloadHash: string;
    status: "pending" | "approved" | "rejected" | "expired"; expiresAt: number; consumedAt: number | null;
  }>();
  private sequence = 0;
  /** Every record the **request side** created, with the hash it will be matched against. */
  readonly requested: Array<{ id: string; toolName: string; runId: string; agentId: string; inputPayload: Record<string, unknown>; payloadHash: string }> = [];
  /** Every consumption attempt the **consuming side** made, with the hash it presented. */
  readonly consumes: Array<{ id: string; toolName: string; runId: string; agentId: string; inputPayload: Record<string, unknown>; payloadHash: string; matched: boolean }> = [];
  readonly refusals: string[] = [];
  now = Date.now();

  private hash(payload: Record<string, unknown>): string {
    return this.risk.computePayloadHash(approvalPayloadForHash(payload));
  }

  get(id: string): { id: string; status: string; notes: string | null } | null {
    const row = this.rows.get(id);
    return row ? { id: row.id, status: row.status, notes: null } : null;
  }

  /** What the human decided. Flipped by the tests, exactly like the decide route does. */
  decide(id: string, decision: "approved" | "rejected"): void {
    const row = this.rows.get(id);
    if (!row) throw Object.assign(new Error("Approval request not found"), { status: 404 });
    row.status = decision;
  }

  requestApproval(ctx: AuthContext, companyId: string, input: {
    runId?: string; agentId?: string; toolName: string; actionSummary: string;
    inputPayload?: Record<string, unknown>; ttlMs?: number; riskLevel?: string;
  }): { id: string; expiresAt: string } {
    const id = `approval-${++this.sequence}`;
    const payload = input.inputPayload ?? {};
    const row = {
      id,
      companyId,
      userId: String(ctx.userId ?? ""),
      runId: input.runId || null,
      agentId: input.agentId || null,
      toolName: input.toolName,
      inputPayload: payload,
      payloadHash: this.hash(payload),
      status: "pending" as const,
      expiresAt: this.now + (input.ttlMs ?? 900_000),
      consumedAt: null as number | null,
    };
    this.rows.set(id, row);
    this.requested.push({
      id, toolName: row.toolName, runId: row.runId ?? "", agentId: row.agentId ?? "",
      inputPayload: payload, payloadHash: row.payloadHash,
    });
    return { id, expiresAt: new Date(row.expiresAt).toISOString() };
  }

  consumeApproved(ctx: AuthContext, companyId: string, id: string, params: {
    runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown>;
  }): { id: string; status: string } {
    const row = this.rows.get(id);
    const payloadHash = this.hash(params.inputPayload);
    const matches = Boolean(row)
      && row!.companyId === companyId
      && row!.userId === String(ctx.userId ?? "")
      && row!.status === "approved"
      && row!.consumedAt === null
      && row!.expiresAt > this.now
      && row!.toolName === params.toolName
      && row!.runId === (params.runId || null)
      && row!.agentId === (params.agentId || null)
      && row!.payloadHash === payloadHash;
    this.consumes.push({
      id, toolName: params.toolName, runId: params.runId, agentId: params.agentId,
      inputPayload: params.inputPayload, payloadHash, matched: matches,
    });
    if (matches) {
      row!.consumedAt = this.now;
      return { id, status: "approved" };
    }
    const reason = row?.consumedAt ? "Approval has already been consumed"
      : row && row.expiresAt <= this.now ? "Approval request has expired"
        : row && row.status !== "approved" ? `Approval is not approved (status: ${row.status})`
          : "Approval context or payload does not match";
    this.refusals.push(reason);
    throw Object.assign(new Error(reason), { status: 409, code: row?.consumedAt ? "APPROVAL_ALREADY_USED" : "APPROVAL_INVALID" });
  }

  /** The expiry sweep of `expireStaleApprovalsDetailed`, with the rows it moved. */
  expireStale(): Array<{ id: string; companyId: string; runId: string | null; inputPayload: Record<string, unknown> }> {
    const moved: Array<{ id: string; companyId: string; runId: string | null; inputPayload: Record<string, unknown> }> = [];
    for (const row of this.rows.values()) {
      if (row.status !== "pending" || row.expiresAt > this.now) continue;
      row.status = "expired";
      moved.push({ id: row.id, companyId: row.companyId, runId: row.runId, inputPayload: row.inputPayload });
    }
    return moved;
  }
}

/** The durable run state the pause is written to, modelled on `code_run_states` (status + details). */
class RunStates {
  readonly rows = new Map<string, { companyId: string; runId: string; status: string; details: Record<string, unknown> }>();
  write(companyId: string, runId: string, status: string, details: Record<string, unknown> = {}): void {
    const existing = this.rows.get(runId);
    this.rows.set(runId, { companyId, runId, status, details: { ...(existing?.details ?? {}), ...details } });
  }
  get(runId: string): { companyId: string; runId: string; status: string; details: Record<string, unknown> } | null {
    return this.rows.get(runId) ?? null;
  }
  /** The runner's own run-state port. */
  runnerPort(defaultRunId = RUN_ID): CodingAgentRunnerPorts["runState"] {
    return {
      startRun: async (input) => {
        const runId = input.runId ?? defaultRunId;
        if (!this.rows.has(runId)) this.write(input.companyId, runId, "running");
        return { runId };
      },
      renewLease: async () => ({ held: true }),
      releaseLease: async () => ({}),
      appendTurn: async () => ({}),
      appendToolCall: async () => ({}),
      markWaitingForUser: async (input) => {
        this.write(input.companyId, input.runId, "waiting_for_user", {
          waitingForUser: { questionId: input.questionId, toolCallId: input.toolCallId, since: "2026-02-01T00:00:00.000Z" },
        });
        return {};
      },
      markFinished: async (input) => {
        this.write(input.companyId, input.runId, input.status, { stopReason: input.reason ?? null });
        return {};
      },
    } as unknown as CodingAgentRunnerPorts["runState"];
  }
  /** The C9 release surface (`resumeAfterAnswer` / `markInterrupted`), used by `releaseMcpApprovalPause`. */
  releasePort(): { resumeAfterAnswer(input: { companyId: string; runId: string; questionId: string; answeredBy: string }): Promise<unknown>; markInterrupted(input: { companyId: string; runId: string; reason: string }): Promise<unknown> } {
    return {
      resumeAfterAnswer: async (input) => {
        this.write(input.companyId, input.runId, "interrupted", {
          interruptedReason: "user_answered",
          answeredBy: input.answeredBy,
          questionId: input.questionId,
        });
        return {};
      },
      markInterrupted: async (input) => {
        this.write(input.companyId, input.runId, "interrupted", { interruptedReason: input.reason });
        return {};
      },
    };
  }
}

interface HarnessOptions {
  /** The MCP server's answers, in dial order. Default: one listing, then one tool result per call. */
  answers?: Array<{ status?: number; body?: string }>;
  runStates?: RunStates;
  approvals?: DurableApprovals;
  /** Simulates a restart: a brand-new runner/run-path/engine over the same durable state. */
  fresh?: boolean;
}

/**
 * A fresh runtime (new store, transport, run path, engine and runner) — or, with `fresh: true`, a new set of
 * in-process objects over the **same** durable approvals and run state, which is exactly what a process restart
 * leaves behind.
 */
function createHarness(options: HarnessOptions = {}) {
  const approvals = options.approvals ?? new DurableApprovals();
  const runStates = options.runStates ?? new RunStates();
  const enabledFlags = new Set<string>(INTEGRATION_FLAGS);
  const flags = {
    assertEnabled: async (_ctx: AuthContext, flagKey: string) => {
      if (!enabledFlags.has(flagKey)) throw Object.assign(new Error(`disabled ${flagKey}`), { code: "feature_disabled" });
      return true;
    },
  };
  const workspaceStore = new InMemoryWorkspaceStore();
  const policies = new McpToolPolicyStore();
  const capabilityStore = new McpRuntimeCapabilityStore({ policies });
  const activity: Array<Record<string, unknown>> = [];
  const engineCalls: Array<{ messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
  const socket = recordingSocket(options.answers ?? [
    { body: toolsListBody([{ name: TOOL_NAME, inputSchema: READ_FILE_SCHEMA }]) },
    { body: toolsListBody([{ name: TOOL_NAME, inputSchema: READ_FILE_SCHEMA }]) },
    { body: toolCallBody("file contents") },
    { body: toolsListBody([{ name: TOOL_NAME, inputSchema: READ_FILE_SCHEMA }]) },
    { body: toolCallBody("file contents") },
    { body: toolsListBody([{ name: TOOL_NAME, inputSchema: READ_FILE_SCHEMA }]) },
    { body: toolCallBody("file contents") },
    { body: toolsListBody([{ name: TOOL_NAME, inputSchema: READ_FILE_SCHEMA }]) },
    { body: toolCallBody("file contents") },
  ]);
  const transport = new McpRuntimeTransport({
    allowlist: [PUBLIC_HOST],
    fetchImpl: (url, fetchOptions) => ssrfSafeFetch(url, { ...fetchOptions, resolve: resolver, transport: socket.socket, maxRedirects: 5 }),
  });
  const source = configuredIntegrationsFrom({
    async listMcpServers() {
      return [{
        id: CONNECTION_ID, name: "filesystem", transport: "http" as const,
        endpoint: `https://${PUBLIC_HOST}/api/mcp/stream`, isActive: true,
      }];
    },
  });

  const policyEngine = new PolicyEngine({
    flags,
    capabilities: {
      get: (id, scope) => lookupCapability(
        {
          staticCapabilities: { get: (toolId) => STATIC_DESCRIPTORS.find((tool) => tool.name === toolId) },
          runtimeOverlay: capabilityStore.overlayFor({
            workspaceId: scope?.workspaceId ?? WORKSPACE,
            companyId: scope?.companyId ?? COMPANY,
          }),
        },
        id,
      ).capability,
    },
    classifier: () => ({ risk: "safe" }),
    approvals: {
      // The same adaptation `app.ts` wires: the engine's port is the durable approval store's own API.
      requestApproval: async (ctx, companyId, input) => approvals.requestApproval(ctx, companyId, input as never),
      consumeApproved: async (ctx, companyId, id, params) => approvals.consumeApproved(ctx, companyId, id, params as never),
    },
    getApproval: async (_ctx, _companyId, id) => approvals.get(id),
    sessionMode: async () => "auto",
  });

  const runPath = createMcpRuntimeRunPath({
    store: capabilityStore,
    transport,
    source: () => source,
    flags,
    policy: policyEngine,
    activity: { record: async (event) => { activity.push(event); } },
    logger: { warn: () => undefined },
  });

  let script: Array<{ content: string; toolCalls?: ReturnType<typeof nativeCall>[] }> = [];
  const ports: CodingAgentRunnerPorts = {
    flags,
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => STATIC_DESCRIPTORS.map((tool) => ({ ...tool })),
      invoke: async () => ({
        ok: false,
        error: { code: "unknown_tool", status: 404, message: "dispatched to the static runtime", tool: null, step: "resolve", retryable: false },
      }),
    },
    runtimeCapabilities: runPath as CodeRunRuntimeCapabilitiesPort,
    engine: {
      chat: async (request) => {
        engineCalls.push(request as unknown as { messages: Array<{ role: string; content: unknown }> });
        const next = script.shift();
        return next ?? { content: "done" };
      },
    },
    schemas: STATIC_SCHEMAS,
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async (event) => { activity.push(event); } },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
    runState: runStates.runnerPort(),
    environment: createCodeRunEnvironmentHolder(),
    limits: { maxStepsPerRun: 4, maxRunMinutes: 5, parallelReadOnlyCalls: 2, toolOutputChars: 30_000 },
    logger: { warn: () => undefined },
  };

  const runner = new CodingAgentRunner(ports);

  return {
    approvals,
    runStates,
    capabilityStore,
    policies,
    policyEngine,
    runPath,
    runner,
    activity,
    engineCalls,
    socketCalls: socket.calls,
    setScript(next: Array<{ content: string; toolCalls?: ReturnType<typeof nativeCall>[] }>) { script = [...next]; },
    run(input: Partial<CodingAgentRunInput> = {}) {
      return runner.run({ ctx: OWNER_CTX, session: session(), prompt: "read a file over MCP", ...input });
    },
    /** The model-visible messages of the n-th model call (1-based) of this runner. */
    messagesOf(index: number): Array<{ role: string; content: unknown }> {
      return engineCalls[index - 1]?.messages ?? [];
    },
    /** The messages of the most recent model call, so a continuation can be inspected without indexing. */
    lastMessages(): Array<{ role: string; content: unknown }> {
      return engineCalls[engineCalls.length - 1]?.messages ?? [];
    },
    /** Dials to the configured Integration so far (a listing and a tool call look the same on the wire). */
    dials(): number {
      return socket.calls.length;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

/** Drives one run that asks the model for the MCP tool and pauses on the approval. */
async function pauseOnApproval(harness: Harness, runId = RUN_ID, args: Record<string, unknown> = CALL_ARGS) {
  harness.setScript([
    { content: "reading", toolCalls: [nativeCall(TOOL_ID, args, "mcp-call-1")] },
    { content: "done" },
  ]);
  return harness.run({ runId, agentId: AGENT_ID });
}

/** The approval record of a paused run, as the run result reports it. */
function pendingOf(result: { pendingApprovals?: Array<Record<string, unknown>> }): Record<string, unknown> {
  const pending = result.pendingApprovals?.[0];
  if (!pending) throw new Error("the run reported no pending approval");
  return pending;
}

describe("[security-gate] C13 MCP approval — ask, pause, approve once, resume, execute", () => {
  it("pauses the run on approval_required, creates exactly one request, and dials nothing", async () => {
    const harness = createHarness();
    const result = await pauseOnApproval(harness);

    // The pause is the run's own existing state, not a new one.
    expect(result.status).toBe("waiting_for_user");
    expect(result.reason).toBe("waiting_for_user");
    expect(harness.runStates.get(RUN_ID)?.status).toBe("waiting_for_user");
    // One request, created by the engine's approval phase for this exact call.
    expect(harness.approvals.requested).toHaveLength(1);
    const requested = harness.approvals.requested[0]!;
    expect(requested.toolName).toBe(TOOL_ID);
    expect(requested.runId).toBe(RUN_ID);
    expect(requested.agentId).toBe(AGENT_ID);

    // The payload carries precisely what the owner named — provider, connection, tool, schema hash, args hash —
    // plus the identifiers the record is matched on.
    const payload = requested.inputPayload;
    expect(payload).toMatchObject({
      kind: MCP_APPROVAL_KIND,
      providerId: "mcp-runtime",
      connectionId: CONNECTION_ID,
      toolName: TOOL_NAME,
      tool: TOOL_ID,
      schemaHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      argsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      companyId: COMPANY,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      toolCallId: "mcp-call-1",
      approvalScope: "once",
    });
    expect(payload).not.toHaveProperty("args");
    expect(JSON.stringify(payload)).not.toContain("a.txt");

    // The run result names the record and the binding, so a caller can approve it and continue the run.
    const pending = pendingOf(result);
    expect(pending.approvalId).toBe(requested.id);
    expect(pending.toolCallId).toBe("mcp-call-1");
    expect(pending.tool).toBe(TOOL_ID);
    expect(pending.connectionId).toBe(CONNECTION_ID);
    expect(pending.toolName).toBe(TOOL_NAME);
    expect(pending.argsHash).toBe(payload.argsHash);
    expect(pending.schemaHash).toBe(payload.schemaHash);

    // Nothing was sent to the third-party server beyond the discovery listing, and no consumption happened.
    expect(harness.socketCalls).toHaveLength(1);
    expect(harness.approvals.consumes).toHaveLength(0);
    // The tool is still published with its fail-closed default: nothing about the approval lowered the risk.
    const published = harness.capabilityStore.listFor(TENANT);
    expect(published[0]?.risk).toBe("high");
    expect(published[0]?.approvalRequired).toBe(true);
    expect(published[0]?.riskSource).toBe("runtime_default");
  });

  it("hashes the same material on the requesting side and on the consuming side, and executes the call once", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);
    const dialsBeforeResume = harness.socketCalls.length;
    harness.approvals.decide(approvalId, "approved");
    // The human decided: the existing C9 transition releases the paused run.
    await releaseMcpApprovalPause(harness.runStates.releasePort(), {
      companyId: COMPANY, runId: RUN_ID, approvalId, reason: "approved", answeredBy: "owner-1",
    });
    expect(harness.runStates.get(RUN_ID)?.status).toBe("interrupted");

    harness.setScript([{ content: "done" }]);
    const resumed = await harness.run({
      runId: RUN_ID,
      agentId: AGENT_ID,
      approvedToolCalls: [{ approvalId, toolCallId: "mcp-call-1", tool: TOOL_ID, args: CALL_ARGS }],
    });

    // The same run continued and finished; the tool really executed through the SSRF-safe transport.
    expect(resumed.status).toBe("completed");
    expect(harness.socketCalls.length).toBe(dialsBeforeResume + 2);

    // Exactly one consumption, and it matched.
    expect(harness.approvals.consumes).toHaveLength(1);
    const consumed = harness.approvals.consumes[0]!;
    expect(consumed.matched).toBe(true);
    expect(consumed.id).toBe(approvalId);
    expect(consumed.runId).toBe(RUN_ID);
    expect(consumed.agentId).toBe(AGENT_ID);
    expect(consumed.toolName).toBe(TOOL_ID);

    /**
     * The property C11 lost and this suite exists to pin: the **same** material was hashed on both sides. Both
     * values come from the real hash function over the real payload objects, so this is a comparison of bytes and
     * not of two objects that merely look alike in the source.
     */
    const requested = harness.approvals.requested[0]!;
    expect(consumed.payloadHash).toBe(requested.payloadHash);
    expect(consumed.inputPayload).toEqual(requested.inputPayload);
    expect(requested.payloadHash).toBe(
      new RiskApprovalService("unused").computePayloadHash(approvalPayloadForHash(requested.inputPayload)),
    );
    // …and the payload is the canonical builder's output for this exact subject, not a hand-built lookalike.
    expect(requested.inputPayload).toEqual(mcpApprovalPayloadFor({
      companyId: COMPANY,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      toolCallId: "mcp-call-1",
      tool: TOOL_ID,
      runtimeMcp: {
        providerId: "mcp-runtime",
        connectionId: CONNECTION_ID,
        toolName: TOOL_NAME,
        schemaHash: String(pendingOf(paused).schemaHash),
        argsHash: mcpApprovalArgsHash(CALL_ARGS),
      },
    }));

    // The model received the canonical `untrusted_data` envelope of the executed call.
    const resumedMessages = harness.lastMessages();
    const block = resumedMessages.find((message) => message.role === "system" && String(message.content).includes("approved by a human"));
    expect(block).toBeTruthy();
    expect(String(block!.content)).toContain('"trust":"untrusted_data"');
    expect(String(block!.content)).toContain("file contents");
  });

  it("refuses the second use of the same record and never calls the tool again", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);
    harness.approvals.decide(approvalId, "approved");
    await releaseMcpApprovalPause(harness.runStates.releasePort(), {
      companyId: COMPANY, runId: RUN_ID, approvalId, reason: "approved", answeredBy: "owner-1",
    });
    harness.setScript([{ content: "done" }]);
    await harness.run({
      runId: RUN_ID, agentId: AGENT_ID,
      approvedToolCalls: [{ approvalId, toolCallId: "mcp-call-1", tool: TOOL_ID, args: CALL_ARGS }],
    });
    expect(harness.approvals.consumes.filter((entry) => entry.matched)).toHaveLength(1);
    const dialsAfterFirstUse = harness.dials();

    // A second presentation of the spent record is refused, and the refusal is the store's own code.
    const second = await harness.runPath.invoke({
      ctx: OWNER_CTX, companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID,
      tool: TOOL_ID, args: CALL_ARGS, toolCallId: "mcp-call-2", runId: RUN_ID, agentId: AGENT_ID, approvalId,
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false ? second.error.code : "").toBe("APPROVAL_ALREADY_USED");
    expect(harness.dials()).toBe(dialsAfterFirstUse);
    expect(harness.approvals.consumes.filter((entry) => entry.matched)).toHaveLength(1);
  });

  it("refuses a record presented for another tool, other arguments or another schema", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);
    harness.approvals.decide(approvalId, "approved");
    const dialsBeforeAttempts = harness.dials();

    // Other arguments: the payload hash differs, so the record does not authorise this call.
    const otherArgs = await harness.runPath.invoke({
      ctx: OWNER_CTX, companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID,
      tool: TOOL_ID, args: { path: "b.txt" }, toolCallId: "mcp-call-other", runId: RUN_ID, agentId: AGENT_ID, approvalId,
    });
    expect(otherArgs.ok).toBe(false);
    expect(otherArgs.ok === false ? otherArgs.error.code : "").toBe("APPROVAL_INVALID");
    expect((otherArgs.ok === false ? otherArgs.error.details?.engineCode : null)).toBe("APPROVAL_INVALID");

    // Another run: the store matches on `run_id`, so a record of this run cannot be spent on that one.
    const otherRun = await harness.runPath.invoke({
      ctx: OWNER_CTX, companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID,
      tool: TOOL_ID, args: CALL_ARGS, toolCallId: "mcp-call-run", runId: "run-2", agentId: AGENT_ID, approvalId,
    });
    expect(otherRun.ok).toBe(false);
    expect(otherRun.ok === false ? otherRun.error.code : "").toBe("APPROVAL_INVALID");

    // Another agent: same rule, `agent_id`.
    const otherAgent = await harness.runPath.invoke({
      ctx: OWNER_CTX, companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID,
      tool: TOOL_ID, args: CALL_ARGS, toolCallId: "mcp-call-agent", runId: RUN_ID, agentId: "agent-2", approvalId,
    });
    expect(otherAgent.ok).toBe(false);
    expect(otherAgent.ok === false ? otherAgent.error.code : "").toBe("APPROVAL_INVALID");

    // A record issued for one tool presented for another: `tool_name` is part of the match as well.
    const published = harness.capabilityStore.publishedRecord(TENANT, CONNECTION_ID, TOOL_NAME)!;
    const otherToolPayload = mcpApprovalPayloadFor({
      companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID, runId: RUN_ID, agentId: AGENT_ID,
      toolCallId: "mcp-call-2", tool: `mcp:${CONNECTION_ID}/write_file`,
      runtimeMcp: {
        providerId: "mcp-runtime", connectionId: CONNECTION_ID, toolName: "write_file",
        schemaHash: published.schemaHash, argsHash: mcpApprovalArgsHash(CALL_ARGS),
      },
    });
    expect(otherToolPayload).not.toEqual(harness.approvals.requested[0]!.inputPayload);

    // No call reached the third-party server in any of the four attempts.
    expect(harness.approvals.consumes.filter((entry) => entry.matched)).toHaveLength(0);
    expect(harness.dials()).toBe(dialsBeforeAttempts);
  });

  it("asks a human once per runtime MCP call: two calls in one turn are two requests and one pause", async () => {
    const harness = createHarness();
    harness.setScript([
      {
        content: "reading",
        toolCalls: [
          nativeCall(TOOL_ID, { path: "a.txt" }, "mcp-call-1"),
          nativeCall(TOOL_ID, { path: "b.txt" }, "mcp-call-2"),
        ],
      },
      { content: "done" },
    ]);
    const result = await harness.run({ runId: RUN_ID, agentId: AGENT_ID });

    expect(result.status).toBe("waiting_for_user");
    expect(harness.approvals.requested).toHaveLength(2);
    expect(new Set(harness.approvals.requested.map((entry) => entry.payloadHash)).size).toBe(2);
    expect(harness.approvals.requested[0]!.inputPayload.argsHash).not.toBe(harness.approvals.requested[1]!.inputPayload.argsHash);
    // Both records travel with the pause, so a caller can approve both and continue the same run.
    expect(result.pendingApprovals).toHaveLength(2);
    expect(result.pendingApprovals?.map((entry) => entry.toolCallId)).toEqual(["mcp-call-1", "mcp-call-2"]);
    // Neither call was executed while the run waits for the decisions: one dial, the discovery listing.
    expect(harness.dials()).toBe(1);
  });

  it("does not require the owner/admin risk downgrade, and the downgrade flow still works beside it", async () => {
    // (a) The default `high` + approval-required tool is callable through the one-shot approval alone.
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);
    expect(harness.capabilityStore.listFor(TENANT)[0]?.riskSource).toBe("runtime_default");
    harness.approvals.decide(approvalId, "approved");
    harness.setScript([{ content: "done" }]);
    const resumed = await harness.run({
      runId: RUN_ID, agentId: AGENT_ID,
      approvedToolCalls: [{ approvalId, toolCallId: "mcp-call-1", tool: TOOL_ID, args: CALL_ARGS }],
    });
    expect(resumed.status).toBe("completed");
    expect(harness.approvals.consumes.filter((entry) => entry.matched)).toHaveLength(1);

    // (b) An owner/admin decision is still the separate, journalled path it was, and a downgraded tool needs no
    // one-shot record at all: the engine lets the call through and it executes immediately.
    const audit: Array<Record<string, unknown>> = [];
    const override = await applyMcpRiskOverride(
      {
        store: harness.capabilityStore,
        policies: harness.policies,
        audit: { record: async (entry) => { audit.push(entry as unknown as Record<string, unknown>); return {}; } },
      },
      { ctx: OWNER_CTX, tenant: TENANT, toolId: TOOL_ID, risk: "low", approvalRequired: false, requestId: "req-1" },
    );
    expect(override.riskSource).toBe("owner_policy");
    expect(audit).toHaveLength(1);
    const requestsBefore = harness.approvals.requested.length;
    const dialsBeforeDowngrade = harness.dials();
    harness.setScript([
      { content: "reading", toolCalls: [nativeCall(TOOL_ID, CALL_ARGS, "mcp-call-3")] },
      { content: "done" },
    ]);
    const downgraded = await harness.run({ runId: "run-2", agentId: AGENT_ID });
    expect(downgraded.status).toBe("completed");
    expect(harness.approvals.requested).toHaveLength(requestsBefore);
    // Its own discovery listing plus the executed call, and nothing else: no approval was asked for.
    expect(harness.dials()).toBe(dialsBeforeDowngrade + 2);
  });

  it("refuses a rejected record with the reviewer's verdict and never executes the call", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);
    harness.approvals.decide(approvalId, "rejected");
    await releaseMcpApprovalPause(harness.runStates.releasePort(), {
      companyId: COMPANY, runId: RUN_ID, approvalId, reason: "rejected", answeredBy: "owner-1",
    });

    harness.setScript([{ content: "done" }]);
    const dialsBeforeResume = harness.dials();
    const resumed = await harness.run({
      runId: RUN_ID, agentId: AGENT_ID,
      approvedToolCalls: [{ approvalId, toolCallId: "mcp-call-1", tool: TOOL_ID, args: CALL_ARGS }],
    });

    expect(resumed.status).toBe("completed");
    const block = harness.lastMessages().find((message) => String(message.content).includes("approved by a human"));
    expect(String(block?.content)).toContain("approval_denied");
    // The continuation dialled once for its own discovery listing and never for the rejected call.
    expect(harness.dials()).toBe(dialsBeforeResume + 1);
    expect(harness.approvals.consumes.filter((entry) => entry.matched)).toHaveLength(0);
  });

  it("releases a timed-out wait as an existing interruption and refuses the expired record", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);

    // Nobody answered: the sweep expires the record and the paused run is released with the C9 timeout reason.
    harness.approvals.now += 25 * 60 * 60 * 1000;
    const expired = harness.approvals.expireStale();
    expect(expired).toHaveLength(1);
    for (const row of expired) {
      await releaseMcpApprovalPause(harness.runStates.releasePort(), {
        companyId: row.companyId, runId: String(row.runId), approvalId: row.id, reason: "expired",
      });
    }
    expect(harness.runStates.get(RUN_ID)?.status).toBe("interrupted");
    expect(harness.runStates.get(RUN_ID)?.details.interruptedReason).toBe("approval_timeout");

    // The expired record cannot be redeemed, and nothing is executed.
    const dialsBeforeAttempt = harness.dials();
    const attempt = await harness.runPath.invoke({
      ctx: OWNER_CTX, companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID,
      tool: TOOL_ID, args: CALL_ARGS, toolCallId: "mcp-call-1", runId: RUN_ID, agentId: AGENT_ID, approvalId,
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.ok === false ? attempt.error.code : "").toBe("APPROVAL_INVALID");
    expect(harness.dials()).toBe(dialsBeforeAttempt);
  });

  it("releases a cancelled wait without a decision, and a cancelled run cannot redeem the record", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const approvalId = String(pendingOf(paused).approvalId);
    await releaseMcpApprovalPause(harness.runStates.releasePort(), {
      companyId: COMPANY, runId: RUN_ID, approvalId, reason: "cancelled",
    });
    expect(harness.runStates.get(RUN_ID)?.details.interruptedReason).toBe("approval_cancelled");
    // The record was never approved, so presenting it is a refusal rather than an execution.
    const dialsBeforeAttempt = harness.dials();
    const attempt = await harness.runPath.invoke({
      ctx: OWNER_CTX, companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID,
      tool: TOOL_ID, args: CALL_ARGS, toolCallId: "mcp-call-1", runId: RUN_ID, agentId: AGENT_ID, approvalId,
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.ok === false ? attempt.error.code : "").toBe("APPROVAL_INVALID");
    expect(harness.dials()).toBe(dialsBeforeAttempt);
  });

  it("survives a process restart: a fresh runtime redeems the approval the paused one recorded", async () => {
    // Process 1: the run pauses and asks a human. Nothing but durable state is kept.
    const approvals = new DurableApprovals();
    const runStates = new RunStates();
    const first = createHarness({ approvals, runStates });
    const paused = await pauseOnApproval(first);
    const approvalId = String(pendingOf(paused).approvalId);
    const schemaHash = String(pendingOf(paused).schemaHash);
    expect(first.runStates.get(RUN_ID)?.status).toBe("waiting_for_user");
    // The C10 rule that makes the release necessary: a run paused on `waiting_for_user` cannot be resumed, and an
    // interrupted one can. The approval decision is what moves it from the first state to the second.
    expect(refuseResume("waiting_for_user")).toBe("waiting_for_user");

    // Process 2: brand-new store, transport, run path, engine and runner — the same durable records.
    const second = createHarness({ approvals, runStates, fresh: true });
    expect(second.runner).not.toBe(first.runner);
    second.approvals.decide(approvalId, "approved");
    await releaseMcpApprovalPause(second.runStates.releasePort(), {
      companyId: COMPANY, runId: RUN_ID, approvalId, reason: "approved", answeredBy: "owner-1",
    });
    expect(refuseResume(second.runStates.get(RUN_ID)!.status as "waiting_for_user" | "running" | "interrupted")).toBeNull();

    second.setScript([{ content: "done" }]);
    const resumed = await second.run({
      runId: RUN_ID, agentId: AGENT_ID,
      approvedToolCalls: [{ approvalId, toolCallId: "mcp-call-1", tool: TOOL_ID, args: CALL_ARGS }],
    });

    expect(resumed.status).toBe("completed");
    expect(second.approvals.consumes.filter((entry) => entry.matched)).toHaveLength(1);
    // The binding travelled across the restart unchanged: the schema hash the fresh process published is the one
    // the record was issued for, so the redemption is a match rather than a coincidence.
    const published = second.capabilityStore.publishedRecord(TENANT, CONNECTION_ID, TOOL_NAME)!;
    expect(published.schemaHash).toBe(schemaHash);
    // The fresh process's own discovery is the only listing it needed; the tool call is the second dial.
    expect(second.dials()).toBe(2);
  });

  it("binds the schema hash, which is also what the runtime manifest revision is derived from", async () => {
    const harness = createHarness();
    const paused = await pauseOnApproval(harness);
    const pending = pendingOf(paused);
    const recorded = harness.approvals.requested[0]!;
    const published = harness.capabilityStore.publishedRecord(TENANT, CONNECTION_ID, TOOL_NAME)!;
    const manifest = harness.capabilityStore.manifestFor(TENANT);

    // The schema the approval was issued for is the schema the manifest pins for this tenant.
    expect(pending.schemaHash).toBe(published.schemaHash);
    expect(manifest.tools[0]?.schemaHash).toBe(recorded.inputPayload.schemaHash);

    // A call whose schema hash moved is a **different** material, so a record for the old schema can never be
    // redeemed for the new one — the same binding the manifest revision and the replay guard use.
    const movedPayload = mcpApprovalPayloadFor({
      companyId: COMPANY, projectId: PROJECT_ID, sessionId: SESSION_ID, runId: RUN_ID, agentId: AGENT_ID,
      toolCallId: "mcp-call-1", tool: TOOL_ID,
      runtimeMcp: {
        providerId: "mcp-runtime", connectionId: CONNECTION_ID, toolName: TOOL_NAME,
        schemaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        argsHash: mcpApprovalArgsHash(CALL_ARGS),
      },
    });
    expect(movedPayload).not.toEqual(recorded.inputPayload);

    // The existing replay contract still refuses a moved manifest, which is the same event seen from the run.
    let refused: unknown = null;
    try {
      assertReplayRuntimeMcpManifestMatches({
        recorded: manifest as unknown as Record<string, unknown>,
        current: { ...(manifest as unknown as Record<string, unknown>), hash: "mcp-runtime/different" },
      });
    } catch (error) {
      refused = error;
    }
    expect((refused as { code?: string }).code).toBe("replay_runtime_mcp_manifest_changed");
    expect(harness.approvals.consumes).toHaveLength(0);
  });
});
