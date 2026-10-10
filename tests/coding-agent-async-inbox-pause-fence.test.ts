import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext, type CodeSession } from "@npati/workspace";
import { CodeRunStateLog } from "../apps/agent-api/src/code-run-state";
import { CodingAgentRunner, type CodingAgentRunnerPorts, CODE_ASK_USER_TOOL, type CodeRunToolDescriptor } from "../apps/agent-api/src/coding-agent-runner";
import { CodeSessionInboxService } from "../apps/agent-api/src/code-session-inbox";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";

/**
 * N1 security-gate: the session fence against a continuation after a pause / a resume.
 *
 * The inbox admits **one driver per session**, and that is the property this suite must not weaken. What it
 * pinned too much is the other half: a run that is not driving the session any more. A pause (C9 `code.ask_user`,
 * C11 approval) stops the loop without marking the run terminal — deliberately, so the answer can still be
 * applied — and a C10 resume takes the run's lease while handing the continuation prompt back to its caller
 * instead of driving it. In both cases the old run's C6a lease stays `live` for its TTL while nothing is
 * running, and the fence used to read that lease as "the session is occupied", so the continuation the user had
 * just asked for was refused with `session_run_held` until the lease expired.
 *
 * The two failure modes are therefore tested against each other, in one file:
 *
 *  - a continuation after a pause/resume **must** be able to take the session (this failed before N1);
 *  - two live drivers of one session, neither of which yielded, **must still** conflict (this must keep passing).
 */

const COMPANY = "c";
const PROJECT = "p";
const SESSION = "s";
const RUN = "r";
const QUESTION = "question-1";

const ctx: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write"] };

const session: CodeSession = {
  id: SESSION, companyId: COMPANY, projectId: PROJECT, workspaceId: "w", userId: "u", status: "active",
  mode: "auto", dataClassification: "confidential", retentionClass: "standard", revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * The durable inbox with the flag **on**: the store is wired and `isEnabled` answers true, which is exactly the
 * configuration in which N1 was latent rather than invisible.
 */
function inboxHarness() {
  const store = new InMemoryWorkspaceStore();
  const log = new CodeRunStateLog({ store });
  const inbox = new CodeSessionInboxService({
    store: store.codeInbox,
    flags: { assertEnabled: async () => true, isEnabled: async () => true },
    loadSession: async (_ctx, companyId, sessionId) =>
      companyId === COMPANY && sessionId === SESSION ? session : null,
    loadRunState: (companyId, runId) => log.loadRunState(companyId, runId),
    audit: async () => undefined,
  });
  const start = (runId: string, owner: string) =>
    log.startRun({ ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner, runId });
  const opt = (command: Parameters<typeof inbox.transact>[1]) => inbox.transact(session, command);
  const submit = (requestId: string, mode: "queue" | "steer" = "queue") =>
    inbox.submit(ctx, COMPANY, SESSION, { requestId, mode, text: requestId });
  return { store, log, inbox, start, opt, submit };
}

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
  { name: CODE_ASK_USER_TOOL, version: 1, status: "active", description: "ask", write: false },
];
const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { prompt: { type: "string" } } } }));

function askResult(questionId: string): CodeToolInvokeResult {
  return {
    ok: true, tool: CODE_ASK_USER_TOOL, toolVersion: 1, schemaVersion: 1,
    result: {
      kind: "code_tool_result", tool: CODE_ASK_USER_TOOL, toolVersion: 1, schemaVersion: 1,
      trust: "untrusted_data", note: "data",
      data: { questionId, status: "pending", choices: 1, allowFreeAnswer: false, expiresAt: "2026-01-02T00:00:00.000Z" },
    },
    truncated: false, durationMs: 1,
  };
}

/**
 * Drives the **real** loop through the **real** inbox with the flag on, so the pause transition is produced by
 * the code under test rather than by the test asserting its own stub.
 */
function runnerHarness(inbox: CodeSessionInboxService, log: CodeRunStateLog, script: ChatResult[]) {
  const queue = [...script];
  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => TOOLS.map((tool) => ({ ...tool })),
      invoke: async (_ctx, input) => input.tool === CODE_ASK_USER_TOOL
        ? askResult(QUESTION)
        : { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { ok: true, tool: input.tool }, truncated: false, durationMs: 1 },
    },
    schemas: SCHEMAS,
    engine: { chat: async () => queue.shift() ?? { content: "done" } },
    runState: log,
    inbox,
    sandbox: { release: async () => undefined },
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
    limits: { maxStepsPerRun: 10, maxRunMinutes: 5, parallelReadOnlyCalls: 8 },
  };
  return new CodingAgentRunner(ports);
}

function askCall(id = "call-ask-1") {
  return { id, type: "function" as const, function: { name: CODE_ASK_USER_TOOL, arguments: JSON.stringify({ prompt: "Which database?" }) } };
}

describe("security-gate: N1 — a continuation after a pause is not fenced by the paused run's lease", () => {
  it("lets a new run take the session after the loop paused, and hands it the paused run's pending input", async () => {
    const h = inboxHarness();
    const runner = runnerHarness(h.inbox, h.log, [{ content: "I need a decision", toolCalls: [askCall()] }]);
    const paused = await runner.run({
      ctx, session, prompt: "fix auth", runId: RUN, runStateOwner: "worker", verificationTools: [],
    });
    expect(paused.status).toBe("waiting_for_user");

    // The pause recorded the yield **without** releasing the task: the run is not terminal, and its admitted input
    // has to stay recoverable by a resume of this same run id.
    const afterPause = (await h.opt({ kind: "read" })).state;
    expect(afterPause).toMatchObject({ runId: RUN, phase: "running", yielded: { runId: RUN, owner: "worker" } });
    expect(await h.log.loadRunState(COMPANY, RUN)).toMatchObject({ status: "waiting_for_user" });

    // A user message that arrived while the run was paused is still pending, and the paused run's lease is still
    // live — which is exactly what the old fence read as "the session is occupied".
    await h.submit("next-task");
    const lease = await h.log.loadRunState(COMPANY, RUN);
    expect(lease?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    // The continuation the user actually asks for: the chat path mints a new run id. On the pre-N1 behaviour this
    // line is the failure — `open` answers `session_run_held` — so the assertion below is the non-vacuity proof.
    await h.start("r2", "worker-2");
    const opened = await h.opt({ kind: "open", runId: "r2", owner: "worker-2" });
    expect(opened.state).toMatchObject({ runId: "r2", phase: "running" });
    // The yield does not survive the takeover: the new run is the driver, so the old marker must not linger.
    expect(opened.state.yielded).toBeNull();

    // The paused run's next-turn input is not stranded, and it is not handed to a second driver either: the
    // documented Step-1 rule is that a queued `next-turn` task runs through the existing admission **after** the
    // current task's terminal state and cleanup, so while the continuation it just opened is the live driver the
    // wake path's own transition must refuse to claim it (that is the `session_run_held` fence the next test
    // pins). The message keeps its identity and stays unclaimed for its own run.
    const claimed = await h.opt({ kind: "take-task", authorId: ctx.userId });
    expect(claimed.messages).toEqual([]);
    const queued = (await h.opt({ kind: "read" })).state.messages.find((message) => message.text === "next-task")!;
    expect(queued.status).toBe("pending");
    expect(queued.runId).toBeNull();
  });

  it("lets a continuation take the session after a C10 resume left the task yielded", async () => {
    const h = inboxHarness();
    await h.start(RUN, "worker");
    await h.opt({ kind: "open", runId: RUN, owner: "worker" });
    // What `CodeSessionResumeService` writes: it took the run's lease to rebuild the continuation prompt and is not
    // driving the loop, so the session must not stay fenced against the continuation it just prepared. C10 can only
    // take a lease that is **not** live (`coding-agent-c10-resume.test.ts`: "refuses to steal a lease another live
    // worker holds"), so the crash is modelled the way the reconciler models it: the dead worker's lease is released
    // before the resume, and the resume is then the owner the yield has to name.
    await h.log.markInterrupted({ companyId: COMPANY, runId: RUN, reason: "crash", owner: "worker" });
    const resumed = await h.log.resumeRun({ companyId: COMPANY, runId: RUN, owner: "resume-1234" });
    expect(resumed).toMatchObject({ held: true, refused: null });
    expect(await h.inbox.yieldTask({ ctx, companyId: COMPANY, sessionId: SESSION, runId: RUN, owner: "resume-1234" })).toBe(true);
    expect((await h.opt({ kind: "read" })).state.yielded).toMatchObject({ runId: RUN, owner: "resume-1234" });

    await h.start("r3", "worker-3");
    expect((await h.opt({ kind: "open", runId: "r3", owner: "worker-3" })).state.runId).toBe("r3");
  });

  it("still fences two live drivers of one session, so the fence was not weakened", async () => {
    const h = inboxHarness();
    await h.start("a", "owner-a");
    await h.start("b", "owner-b");
    // Neither run yielded: this is the ordinary "two runs of one session" conflict the inbox exists for.
    const results = await Promise.allSettled([
      h.opt({ kind: "open", runId: "a", owner: "owner-a" }),
      h.opt({ kind: "open", runId: "b", owner: "owner-b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe("session_run_held");

    // And the loser stays fenced after the winner settles its task, exactly as before N1.
    const winner = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ state: { runId: string | null } }>).value.state.runId!;
    const winnerOwner = winner === "a" ? "owner-a" : "owner-b";
    const loser = winner === "a" ? "b" : "a";
    const loserOwner = winner === "a" ? "owner-b" : "owner-a";
    await h.opt({ kind: "seal", runId: winner, owner: winnerOwner });
    await h.opt({ kind: "close", runId: winner, owner: winnerOwner });
    await h.log.markFinished({ companyId: COMPANY, runId: winner, status: "completed", reason: "completed" });
    await expect(h.opt({ kind: "open", runId: loser, owner: loserOwner })).rejects.toMatchObject({ code: "session_run_held" });
    await h.opt({ kind: "release-task", runId: winner });
    await h.opt({ kind: "open", runId: loser, owner: loserOwner });
  });

  it("refuses a pause from a worker that lost the lease, so the marker cannot be forged", async () => {
    const h = inboxHarness();
    await h.start(RUN, "worker");
    await h.opt({ kind: "open", runId: RUN, owner: "worker" });
    await expect(h.opt({ kind: "pause", runId: RUN, owner: "someone-else" })).rejects.toMatchObject({ code: "inbox_lease_lost" });
    expect((await h.opt({ kind: "read" })).state.yielded).toBeNull();
  });

  it("does not let a yielded marker outlive the claim it belongs to", async () => {
    const h = inboxHarness();
    await h.start(RUN, "worker");
    await h.opt({ kind: "open", runId: RUN, owner: "worker" });
    await h.opt({ kind: "pause", runId: RUN, owner: "worker" });
    // The same run id may take its own task back (a resume driving the continuation itself).
    const reopened = await h.opt({ kind: "open", runId: RUN, owner: "worker" });
    expect(reopened.state.yielded).toBeNull();
    // A pause for a run that does not hold the task is a no-op, not a marker for a stranger's run.
    await h.opt({ kind: "pause", runId: "not-this-run", owner: "worker" });
    expect((await h.opt({ kind: "read" })).state.yielded).toBeNull();
  });
});
