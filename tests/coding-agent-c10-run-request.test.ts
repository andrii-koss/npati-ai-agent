import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, WorkspaceNotFoundError } from "@npati/workspace";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { ChatResult } from "@npati/omniroute-adapter";
import {
  CODE_RUN_REQUEST_MAX_CHARS,
  CodeRunStateLog,
  decideRunRequest,
  requestTruncationMarker,
  type CodeRunStateStorePort,
} from "../apps/agent-api/src/code-run-state";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  isReadOnlyRunTool,
  type CodeRunToolDescriptor,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";
import { CodeSessionResumeService, type CodeSessionResumeDeps } from "../apps/agent-api/src/code-session-resume";
import { toResumeRequestView } from "../apps/agent-api/src/code-session-durability";
import { readFileSync } from "node:fs";

/**
 * C10 security-gate suite: **the run's original request survives a restart**.
 *
 * The defect this suite exists to prevent: the request the user typed lived only in the live request body. The
 * replay bundle records what the *model* produced and is written once, on the terminal path, so a run that
 * crashed mid-flight left no copy of the request at all — and `code_run_turns.messages`, declared for the
 * transcript, was never written by anything. A resume could therefore reconstruct an objective from a plan or a
 * summary, but never the user's own words.
 *
 * What is pinned here, in order of how badly it breaks if lost:
 *
 *  1. **The request is written before the first model step**, by the same statement that creates the run, so a
 *     process that dies immediately after start still leaves it behind. The test drives the **real runner** and
 *     then checks the durable row.
 *  2. **A restart recovers exactly X.** A brand-new run-state log and a brand-new resume service (what a new
 *     process has) recover the verbatim text as the prompt's original-request section — not a paraphrase, and
 *     not "empty".
 *  3. **A resume can never overwrite it.** `startRun` is idempotent by run id, so re-entering the loop with the
 *     reconstructed continuation prompt leaves the original text intact.
 *  4. **A request that is not there is reported honestly.** No record → `request_not_recorded`; a request whose
 *     record was refused because it looked like a credential → `request_refused_credential`, with the value
 *     never stored; an unreadable store → `request_record_unavailable`. The prompt says which, instead of
 *     implying the objective is a quotation.
 *  5. **Tenant scoping and classification.** A run of another company is not readable, and the record states the
 *     class it was created under.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PROJECT = "project-1";
const SESSION = "session-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const REQUEST = "Fix the failing parser test in src/parser.ts and run the suite.";

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: SESSION,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    userId: "user-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read a file", write: false },
];
const SCHEMAS = TOOLS.map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}));

/**
 * A runner wired to the real C6a log and the real store, with an engine that answers a tool call and then — by
 * refusing the lease renewal while the first model call is in flight — makes the run stop as `interrupted`,
 * which is exactly the durable state a crashed process leaves and the only state a resume continues.
 */
async function startRunAndInterrupt(input: {
  prompt: string;
  store: InMemoryWorkspaceStore;
  clock: { t: number };
  imageReference?: string;
  runId?: string;
}): Promise<{ runId: string; status: string }> {
  const log = new CodeRunStateLog({
    store: input.store as unknown as CodeRunStateStorePort,
    now: () => input.clock.t,
  });
  let firstCall = true;
  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => TOOLS.map((tool) => ({ ...tool })),
      invoke: async (_ctx, call) => ({
        ok: true,
        tool: call.tool,
        toolVersion: 1,
        schemaVersion: 1,
        result: { ok: true },
        truncated: false,
        durationMs: 1,
      }),
    },
    engine: {
      chat: async (): Promise<ChatResult> => {
        if (firstCall) {
          firstCall = false;
          // The lease is renewed on a timer (1 s here). Waiting past it lets the refused renewal mark the run
          // as one nobody is driving any more — the same condition a killed process produces.
          await new Promise((resolve) => setTimeout(resolve, 1_400));
          return {
            content: "",
            toolCalls: [{ id: "call-read", type: "function", function: { name: "code.fs.read", arguments: '{"path":"src/parser.ts"}' } }],
          };
        }
        return { content: "done" };
      },
    },
    schemas: SCHEMAS,
    ...(input.imageReference
      ? {
        imageAdmission: {
          admit: async () => ({
            reference: input.imageReference!,
            dev: false,
            digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            sbomRef: "sbom/sandbox-node-1.json",
          }),
        },
      }
      : {}),
    runState: {
      startRun: (start) => log.startRun(start),
      // The process is "gone": its renewal is refused, which is how the loop learns it no longer owns the run.
      renewLease: async () => ({ held: false }),
      appendTurn: (turn) => log.appendTurn(turn),
      appendToolCall: (call) => log.appendToolCall(call),
      markFinished: (finished) => log.markFinished(finished),
      releaseLease: (release) => log.releaseLease(release),
    } as unknown as CodingAgentRunnerPorts["runState"],
    limits: { runHeartbeatMs: 1_000, maxStepsPerRun: 5, maxRunMinutes: 5 },
    environment: createCodeRunEnvironmentHolder(),
    activity: { record: async () => undefined },
    logger: { warn: () => undefined },
  };
  const runner = new CodingAgentRunner(ports);
  const result = await runner.run({
    ctx,
    session: session(),
    prompt: input.prompt,
    ...(input.imageReference ? { imageReference: input.imageReference } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    runStateOwner: "runner-a",
  });
  return { runId: result.runId ?? "", status: result.status };
}

/** A brand-new resume service over the same durable store: what a restarted process has. */
function restartedResumeService(input: {
  store: InMemoryWorkspaceStore;
  clock: { t: number };
  requestRead?: (companyId: string, runId: string) => Promise<never>;
}): { service: CodeSessionResumeService; deps: CodeSessionResumeDeps } {
  const freshLog = new CodeRunStateLog({
    store: input.store as unknown as CodeRunStateStorePort,
    now: () => input.clock.t,
  });
  const deps: CodeSessionResumeDeps = {
    flags: { assertEnabled: async () => true },
    sessions: {
      get: async (_ctx, companyId, sessionId) => {
        if (companyId !== COMPANY || sessionId !== SESSION) throw new WorkspaceNotFoundError("Code session not found");
        return session();
      },
    },
    runState: freshLog,
    store: {
      getCodeSessionHead: (companyId, sessionId) => input.store.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (value) => input.store.setCodeSessionHead(value),
      getLatestCodeRunRecoveryNotice: (companyId, runId) => input.store.getLatestCodeRunRecoveryNotice(companyId, runId),
      listCodeContextSummaries: (value) => input.store.listCodeContextSummaries(value),
      listCodeGoals: (value) => input.store.listCodeGoals(value),
      getLatestCodeSessionPlan: (companyId, sessionId) => input.store.getLatestCodeSessionPlan(companyId, sessionId),
      listCodeSessionTodos: (value) => input.store.listCodeSessionTodos(value),
      listCodeRunTurns: (companyId, runId) => input.store.listCodeRunTurns(companyId, runId),
      getCodeRunRequest: input.requestRead
        ? (companyId: string, runId: string) => input.requestRead!(companyId, runId)
        : (companyId, runId) => input.store.getCodeRunRequest(companyId, runId),
    },
    linkRun: async () => ({ linked: true }),
    activity: { record: async () => undefined },
    owner: "resume-worker",
    now: () => input.clock.t,
  };
  return { service: new CodeSessionResumeService(deps), deps };
}

describe("security-gate: C10 run request — the user's own words survive the process", () => {
  it("records the request before the first model step, in the run's own row", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const started = await startRunAndInterrupt({ prompt: REQUEST, store, clock });
    expect(started.runId).not.toBe("");
    // The run really was interrupted by the lost lease — this is the resumable state, not a completed run.
    expect(started.status).toBe("interrupted");

    const record = await store.getCodeRunRequest(COMPANY, started.runId);
    expect(record).not.toBeNull();
    expect(record?.status).toBe("recorded");
    expect(record?.text).toBe(REQUEST);
    expect(record?.truncated).toBe(false);
    // The hash covers the stored bytes, so a reader can prove the quotation is the record and not a paraphrase.
    expect(record?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.dataClassification).toBe("confidential");
    expect(record?.retentionClass).toBe("standard");
    // Written at creation: the row's own timestamp is the run's start, and it is not empty afterwards.
    expect(record?.recordedAt?.getTime()).toBe(T0);
  });

  it("recovers exactly the recorded request after a restart, and quotes it in the prompt", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const started = await startRunAndInterrupt({ prompt: REQUEST, store, clock });

    // The restart: the crashed worker's lease (60 s) is long gone, and nothing in process memory survives.
    clock.t = T0 + 10 * 60_000;
    const { service } = restartedResumeService({ store, clock });
    const outcome = await service.resume({ ctx, companyId: COMPANY, sessionId: SESSION, runId: started.runId });

    expect(outcome.requestUnavailable).toBeNull();
    expect(outcome.request.available).toBe(true);
    expect(outcome.request.text).toBe(REQUEST);
    expect(outcome.request.reason).toBeNull();
    expect(outcome.history.request).toBe(true);
    expect(outcome.resumePromptSections).toContain("request");
    // Verbatim, and labelled as the user's own text rather than as a derived objective.
    expect(outcome.resumePrompt).toContain(REQUEST);
    expect(outcome.resumePrompt).toContain("=== Original request (verbatim, recorded when the run was created) ===");
    expect(outcome.resumePrompt).toContain("it is the user's own text");
    // The mode in force travels too: the continuation runs under the same session, and says so.
    expect(outcome.resumePromptSections).toContain("mode");
    expect(outcome.resumePrompt).toContain("Session mode: auto.");
  });

  it("cannot be overwritten by a resume re-entering the loop with the continuation prompt", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const started = await startRunAndInterrupt({ prompt: REQUEST, store, clock });

    // A resume re-runs `startRun` with the same run id — and, in this deployment, with the reconstructed
    // continuation prompt as the next prompt. The store's create is idempotent by run id, so the original wins.
    const log = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => clock.t });
    await log.startRun({
      ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "resume-worker",
      runId: started.runId, request: "Resume: continue from the last completed turn.",
    });
    const record = await store.getCodeRunRequest(COMPANY, started.runId);
    expect(record?.text).toBe(REQUEST);
    // The second start neither created a run nor rewrote the request: one row, still `interrupted`.
    const runs = await store.listStaleCodeRunStates({ now: new Date(clock.t), limit: 10 });
    expect(runs.map((run) => run.runId)).toEqual([]);
    expect((await store.getCodeRunState(COMPANY, started.runId))?.status).toBe("interrupted");
  });

  it("says the request was not recorded instead of pretending the objective is a quotation", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    // A run started by a caller that supplies no prompt — the honest reason `not_recorded` exists for.
    const log = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => clock.t });
    await log.startRun({ ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "runner-a", runId: "run-nr" });
    await log.appendTurn({ companyId: COMPANY, runId: "run-nr", turnIndex: 1, status: "running" });
    clock.t = T0 + 10 * 60_000;

    const { service } = restartedResumeService({ store, clock });
    const outcome = await service.resume({ ctx, companyId: COMPANY, sessionId: SESSION, runId: "run-nr" });
    expect(outcome.request.available).toBe(false);
    expect(outcome.requestUnavailable).toBe("request_not_recorded");
    expect(outcome.request.text).toBeNull();
    expect(outcome.history.request).toBe(false);
    expect(outcome.resumePrompt).toContain("The original request text was not recorded for this run.");
    expect(outcome.resumePrompt).not.toContain("=== Original request");
  });

  it("refuses to store a credential-shaped request and reports the refusal, never the value", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const secretPrompt = "rotate the key export API_TOKEN=sk_live_0123456789abcdefghijkl on the server";
    const started = await startRunAndInterrupt({ prompt: secretPrompt, store, clock });

    const record = await store.getCodeRunRequest(COMPANY, started.runId);
    expect(record?.status).toBe("refused_credential");
    expect(record?.text).toBeNull();
    expect(record?.sha256).toBeNull();
    // Nothing anywhere in the durable record carries the value.
    expect(JSON.stringify(record)).not.toContain("sk_live");

    clock.t = T0 + 10 * 60_000;
    const { service } = restartedResumeService({ store, clock });
    const outcome = await service.resume({ ctx, companyId: COMPANY, sessionId: SESSION, runId: started.runId });
    expect(outcome.requestUnavailable).toBe("request_refused_credential");
    expect(outcome.request.available).toBe(false);
    // The prompt states the refusal and never carries the value it refused.
    expect(outcome.resumePrompt).toContain("the record of it was refused");
    expect(outcome.resumePrompt).not.toContain("sk_live");
  });

  it("separates an unreadable store from a run that never had a request", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const log = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => clock.t });
    await log.startRun({ ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "runner-a", runId: "run-x", request: REQUEST });
    clock.t = T0 + 10 * 60_000;

    const { service } = restartedResumeService({
      store,
      clock,
      requestRead: async () => {
        throw new Error("run state store is down");
      },
    });
    const outcome = await service.resume({ ctx, companyId: COMPANY, sessionId: SESSION, runId: "run-x" });
    // An outage is not evidence about the request, so it is never reported as "there was none".
    expect(outcome.requestUnavailable).toBe("request_record_unavailable");
    expect(outcome.request.text).toBeNull();
    expect(outcome.resumePrompt).toContain("the record could not be read");
  });

  it("scopes the read to the tenant", async () => {
    const store = new InMemoryWorkspaceStore();
    const clock = { t: T0 };
    const log = new CodeRunStateLog({ store: store as unknown as CodeRunStateStorePort, now: () => clock.t });
    await log.startRun({ ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "runner-a", runId: "run-t", request: REQUEST });
    expect((await store.getCodeRunRequest(COMPANY, "run-t"))?.text).toBe(REQUEST);
    // Another company cannot read it, and cannot tell it apart from a run that does not exist.
    expect(await store.getCodeRunRequest(OTHER_COMPANY, "run-t")).toBeNull();
    expect(await store.getCodeRunRequest(COMPANY, "run-missing")).toBeNull();
  });
});

describe("security-gate: C10 run request — the decision itself", () => {
  it("bounds a huge request visibly instead of storing it whole or dropping it", () => {
    const decided = decideRunRequest({ request: "x".repeat(CODE_RUN_REQUEST_MAX_CHARS + 500), now: new Date(T0) });
    expect(decided.status).toBe("recorded");
    expect(decided.truncated).toBe(true);
    expect(decided.text).toContain(requestTruncationMarker(500));
    expect(decided.text?.length).toBe(CODE_RUN_REQUEST_MAX_CHARS + requestTruncationMarker(500).length);
    // The hash is of the stored text, so "what was recorded" is verifiable.
    expect(decided.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats a whitespace-only prompt as nothing to record", () => {
    const decided = decideRunRequest({ request: "   \n  ", now: new Date(T0) });
    expect(decided.status).toBe("not_recorded");
    expect(decided.text).toBeNull();
    expect(decided.recordedAt).toBeNull();
    expect(decideRunRequest({ request: null, now: new Date(T0) }).status).toBe("not_recorded");
  });

  it("maps a stored record onto the view without inventing availability", () => {
    expect(toResumeRequestView(null).reason).toBe("request_not_recorded");
    expect(toResumeRequestView(null, { readFailed: true }).reason).toBe("request_record_unavailable");
    expect(toResumeRequestView({
      status: "refused_credential", text: null, sha256: null, truncated: false, recordedAt: null,
    }).reason).toBe("request_refused_credential");
    // A row that claims "recorded" without text is not trusted into availability.
    expect(toResumeRequestView({
      status: "recorded", text: null, sha256: null, truncated: false, recordedAt: null,
    }).available).toBe(false);
    expect(toResumeRequestView({
      status: "recorded", text: "hi", sha256: "a".repeat(64), truncated: false, recordedAt: new Date(T0),
    })).toMatchObject({ available: true, text: "hi", truncated: false });
  });

  it("writes the request in the same migration that adds the columns, additively and with the vocabulary", () => {
    const migration = readFileSync("packages/workspace/src/migration-083.ts", "utf8");
    // Additive only: no drop, no rename, no retype of an existing column.
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS request_text text");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS request_status text");
    expect(migration).not.toMatch(/DROP COLUMN/i);
    expect(migration).not.toMatch(/ALTER COLUMN .* TYPE/i);
    // The vocabulary and the class sets are enforced in the database, not only in TypeScript.
    expect(migration).toContain("CHECK (request_status IN ('not_recorded','recorded','refused_credential'))");
    expect(migration).toContain("CHECK ((request_status = 'recorded') = (request_text IS NOT NULL))");
    expect(migration).toContain("CHECK (data_classification IN ('public','internal','confidential','restricted'))");
    expect(migration).toContain("CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))");
    // The row is created by the same statement that records the request: the write is atomic with the run.
    const store = ["postgres-store.ts", "postgres-code-runs-repository.ts"].map((f) => readFileSync(`packages/workspace/src/${f}`, "utf8")).join("\n");
    expect(store).toContain("ON CONFLICT (run_id) DO NOTHING");
    expect(store).toMatch(/request_status, request_text, request_sha256, request_truncated, request_recorded_at/);
  });
});
