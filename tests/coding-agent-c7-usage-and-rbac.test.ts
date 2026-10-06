import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CodeRbac, createRoleRegistry, requiredPermissionForAction, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";
import { DEFAULT_CODE_ROLE_MATRIX } from "../apps/agent-api/src/code-rbac";
import { registerCodeSessionControlRoutes, type CodeSessionControlDeps } from "../apps/agent-api/src/code-session-control-routes";
import type { CodeRunCancellationRegistry } from "../apps/agent-api/src/code-run-cancellation";
import { CodeRunStateLog, readRunEstimate, type CodeRunStateStorePort } from "../apps/agent-api/src/code-run-state";
import { collectCodeSessionUsage } from "../apps/agent-api/src/code-session-usage";

/**
 * C7 security-gate: usage accounting and the RBAC of destructive project actions.
 *
 * Two invariants that are easy to get wrong and expensive to get wrong:
 *  - **An unknown measurement is never reported as zero.** `0` reads as "this run was free" on every dashboard, so
 *    the adapter distinguishes "nothing was ever recorded" (`null`), "a source exists but could not measure"
 *    (`{ unavailable }`) and real totals. Price is never inferred from tokens: `costUsd` stays `null` with a reason.
 *  - **Archiving and deleting a project are administrative acts.** They are allowed for `owner`/`admin` and denied
 *    for `developer`/`reviewer`, using the vocabulary that already exists (`business:manage`) rather than a new
 *    permission system.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";

function context(role: string): AuthContext {
  return { workspaceId: "ws-1", userId: "user-1", companyId: COMPANY, permissions: [], role } as unknown as AuthContext;
}

describe("[C7] [security-gate] code session usage is measured, never invented", () => {
  it("returns null when the session has no recorded runs", async () => {
    const result = await collectCodeSessionUsage({ listBundles: async () => [], listSteps: async () => [] }, { companyId: COMPANY, sessionId: SESSION });
    expect(result).toBe(null);
  });

  it("sums the usage the provider actually reported, across runs of the session", async () => {
    const steps = {
      "bundle-1": [
        { kind: "model_step", payload: { response: { usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } } } },
        { kind: "tool_call", payload: { settledResult: "ignored" } },
        { kind: "model_step", payload: { response: { usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } } } },
      ],
      "bundle-2": [{ kind: "model_step", payload: { response: { usage: { promptTokens: 10, completionTokens: 5 } } } }],
    } as Record<string, Array<{ kind: string; payload: Record<string, unknown> }>>;

    const result = await collectCodeSessionUsage(
      {
        listBundles: async () => [{ id: "bundle-1", runId: "run-1" }, { id: "bundle-2", runId: "run-2" }],
        listSteps: async (_companyId, bundleId) => steps[bundleId] ?? [],
      },
      { companyId: COMPANY, sessionId: SESSION },
    );

    if (!result || "unavailable" in result) throw new Error("expected measured usage");
    expect(result.tokens.input).toBe(160);
    expect(result.tokens.output).toBe(35);
    expect(result.tokens.total).toBe(195);
    expect(result.runs).toBe(2);
    expect(result.source).toBe("code_replay_bundle_usage");
    // Price is not recorded anywhere for code runs, so it must not be presented as a number.
    expect(result.costUsd).toBe(null);
    expect(result.costStatus).toBe("unavailable");
    expect(result.costReason).toBe("no_cost_source_for_code_runs");
  });

  it("does not turn 'the provider reported nothing' into zeros", async () => {
    const result = await collectCodeSessionUsage(
      {
        listBundles: async () => [{ id: "bundle-1", runId: "run-1" }],
        listSteps: async () => [{ kind: "model_step", payload: { response: { content: "hello", usage: null } } }],
      },
      { companyId: COMPANY, sessionId: SESSION },
    );

    expect(result && "unavailable" in result ? result.unavailable : "measured").toBe("provider_did_not_report_usage");
    // The critical assertion: no numeric total is present at all in this answer.
    expect(JSON.stringify(result).includes("\"total\":0")).toBe(false);
    expect(JSON.stringify(result).includes("\"input\":0")).toBe(false);
  });

  it("reports an unreadable source instead of a smaller 'complete' total", async () => {
    const failingBundles = await collectCodeSessionUsage(
      { listBundles: async () => { throw new Error("store_down"); }, listSteps: async () => [] },
      { companyId: COMPANY, sessionId: SESSION },
    );
    const failingSteps = await collectCodeSessionUsage(
      { listBundles: async () => [{ id: "bundle-1", runId: "run-1" }], listSteps: async () => { throw new Error("store_down"); } },
      { companyId: COMPANY, sessionId: SESSION },
    );

    expect(failingBundles && "unavailable" in failingBundles ? failingBundles.unavailable : "measured").toBe("usage_source_unreadable");
    expect(failingSteps && "unavailable" in failingSteps ? failingSteps.unavailable : "measured").toBe("usage_source_unreadable");
  });

  it("falls back to the runner's summary and says it is an estimate", async () => {
    const estimate = {
      tokenCount: 900,
      costUsd: 0.03,
      turns: 3,
      toolCalls: 9,
      filesChanged: 2,
      diffStats: { files: 2, linesAdded: 40, linesRemoved: 5 },
      estimated: true as const,
      source: "runner_summary_estimate",
    };
    const result = await collectCodeSessionUsage(
      { listBundles: async () => [], listSteps: async () => [], loadRunEstimate: async (_companyId, runId) => (runId === "run-1" ? estimate : null) },
      { companyId: COMPANY, sessionId: SESSION, runId: "run-1" },
    );

    if (!result || "unavailable" in result) throw new Error("expected an estimate");
    expect(result.estimated).toBe(true);
    expect(result.source).toBe("runner_summary_estimate");
    // The summary carries a single total: input/output are unknown, and reporting them as 0 would be a measurement
    // we never made.
    expect(result.tokens.total).toBe(900);
    expect(result.tokens.input).toBe(null);
    expect(result.tokens.output).toBe(null);
    // Values reach the answer unchanged — no recalculation, no scaling, no rounding into a different number.
    expect(result.costUsd).toBe(0.03);
    expect(result.turns).toBe(3);
    expect(result.toolCalls).toBe(9);
    expect(result.filesChanged).toBe(2);
    expect(result.diffStats?.linesAdded).toBe(40);
  });

  it("keeps an unknown cost unavailable on the estimate path, never zero", async () => {
    const result = await collectCodeSessionUsage(
      {
        listBundles: async () => [],
        listSteps: async () => [],
        loadRunEstimate: async () => ({
          tokenCount: 120,
          costUsd: null,
          turns: 1,
          toolCalls: 2,
          filesChanged: 0,
          diffStats: { files: 0, linesAdded: 0, linesRemoved: 0 },
          estimated: true as const,
          source: "runner_summary_estimate",
        }),
      },
      { companyId: COMPANY, sessionId: SESSION, runId: "run-1" },
    );

    if (!result || "unavailable" in result) throw new Error("expected an estimate");
    expect(result.costUsd).toBe(null);
    expect(result.costStatus).toBe("unavailable");
    expect(JSON.stringify(result).includes("\"costUsd\":0")).toBe(false);
  });

  it("prefers provider-measured numbers over the estimate", async () => {
    const result = await collectCodeSessionUsage(
      {
        listBundles: async () => [{ id: "bundle-1", runId: "run-1" }],
        listSteps: async () => [{ kind: "model_step", payload: { response: { usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } } } }],
        loadRunEstimate: async () => ({
          tokenCount: 900, costUsd: 0.03, turns: 3, toolCalls: 9, filesChanged: 2,
          diffStats: { files: 2, linesAdded: 1, linesRemoved: 1 }, estimated: true as const, source: "runner_summary_estimate",
        }),
      },
      { companyId: COMPANY, sessionId: SESSION, runId: "run-1" },
    );

    if (!result || "unavailable" in result) throw new Error("expected measured usage");
    expect(result.estimated).toBe(false);
    expect(result.source).toBe("code_replay_bundle_usage");
    expect(result.tokens.total).toBe(12);
    expect(result.costUsd).toBe(null);
  });

  it("returns null when neither a bundle nor an estimate exists", async () => {
    const result = await collectCodeSessionUsage(
      { listBundles: async () => [], listSteps: async () => [], loadRunEstimate: async () => null },
      { companyId: COMPANY, sessionId: SESSION, runId: "run-1" },
    );
    expect(result).toBe(null);
  });
});

describe("[C7] [security-gate] the run estimate is persisted with the terminal state", () => {
  it("stores the estimate next to the stop reason and reads it back unchanged", async () => {
    const applied: Array<Record<string, unknown>> = [];
    const store = {
      applyCodeRunStateEvent: async (input: Record<string, unknown>) => {
        applied.push(input);
        return { runId: input.runId, companyId: input.companyId, lastEventSeq: input.seq };
      },
    } as unknown as CodeRunStateStorePort;
    const log = new CodeRunStateLog({ store, now: () => 1_000 });

    await log.markFinished({
      companyId: COMPANY,
      runId: "run-1",
      status: "completed",
      reason: "completed",
      estimate: { tokenCount: 900, costUsd: 0.03, turns: 3, toolCalls: 9, filesChanged: 2, diffStats: { files: 2, linesAdded: 40, linesRemoved: 5 } },
    });

    const details = applied[0]!.details as Record<string, unknown>;
    // The reason must survive alongside the estimate: the terminal write replaces the details bag.
    expect(details.stopReason).toBe("completed");
    const stored = details.estimate as Record<string, unknown>;
    expect(stored.estimated).toBe(true);
    expect(stored.source).toBe("runner_summary_estimate");
    expect(stored.tokenCount).toBe(900);
    // A count, not a credential: the run-state guard forbids a `token` key, and the stored key is deliberately not
    // that name.
    expect("token" in stored).toBe(false);

    const read = readRunEstimate(details);
    if (!read) throw new Error("expected the estimate to be readable");
    expect(read.tokenCount).toBe(900);
    expect(read.costUsd).toBe(0.03);
    expect(read.estimated).toBe(true);
    expect(read.diffStats.linesRemoved).toBe(5);
  });

  it("never invents an estimate out of an empty or malformed bag", () => {
    expect(readRunEstimate(null)).toBe(null);
    expect(readRunEstimate({})).toBe(null);
    expect(readRunEstimate({ estimate: {} })).toBe(null);
    expect(readRunEstimate({ estimate: { tokenCount: "900" } })).toBe(null);
  });
});

// --- route level -----------------------------------------------------------------------------------------

interface Route { method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<unknown> }

function fakeInstance(routes: Route[]): FastifyInstance {
  const record = (method: string) => (url: string, handler: Route["handler"]) => { routes.push({ method, url, handler }); };
  return { get: record("get"), post: record("post"), patch: record("patch"), put: record("put"), delete: record("delete") } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply, state };
}

async function usageHarness(usage: CodeSessionControlDeps["usage"]) {
  const routes: Route[] = [];
  const registry = createRoleRegistry({ roles: { developer: ["workspace:read", "workspace:write"] } });
  const rbac = new CodeRbac({ registry, audit: { record: async () => {} } as CodeAuthorizationAuditPort });
  const deps = {
    sessions: {
      get: async () => ({ id: SESSION, projectId: PROJECT, companyId: COMPANY, mode: "ask", status: "active" }) as unknown as CodeSession,
      list: async () => [],
    },
    cancellation: {} as unknown as CodeRunCancellationRegistry,
    ...(usage ? { usage } : {}),
    authorize: (ctx: AuthContext, companyId: string, input: { action: string; permission: string }) => rbac.authorize(ctx, companyId, input),
    getAuthContext: () => context("developer"),
  } as unknown as CodeSessionControlDeps;
  await registerCodeSessionControlRoutes(fakeInstance(routes), deps);
  const route = routes.find((entry) => entry.method === "get" && entry.url.endsWith("/usage"));
  if (!route) throw new Error("usage route was not registered");
  return route;
}

describe("[C7] [security-gate] usage route surfaces the reason it cannot measure", () => {
  it("answers unavailable with the source reason instead of a total", async () => {
    const route = await usageHarness(async () => ({ unavailable: "provider_did_not_report_usage" }));
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, sessionId: SESSION } }, reply);
    const body = state.body as { status: string; reason: string; usage: unknown };
    expect(body.status).toBe("unavailable");
    expect(body.reason).toBe("provider_did_not_report_usage");
    expect(body.usage).toBe(null);
  });

  it("answers ok with the measured numbers when they exist", async () => {
    const route = await usageHarness(async () => ({ tokens: { input: 5, output: 7, total: 12 }, costUsd: null, runs: 1, source: "code_replay_bundle_usage" }));
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, sessionId: SESSION } }, reply);
    const body = state.body as { status: string; usage: { tokens: { total: number }; costUsd: unknown } };
    expect(body.status).toBe("ok");
    expect(body.usage.tokens.total).toBe(12);
    expect(body.usage.costUsd).toBe(null);
  });

  it("marks an estimated answer as an estimate and exposes a flat total for the UI", async () => {
    const route = await usageHarness(async () => ({
      tokens: { input: null, output: null, total: 900 },
      costUsd: 0.03,
      runs: 1,
      source: "runner_summary_estimate",
      estimated: true,
      turns: 3,
    }));
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, sessionId: SESSION } }, reply);
    const body = state.body as { status: string; usage: { estimated?: boolean; source?: string; totalTokens?: number; inputTokens?: number | null; tokens: { total: number; input: number | null } } };
    expect(body.status).toBe("ok");
    expect(body.usage.estimated).toBe(true);
    expect(body.usage.source).toBe("runner_summary_estimate");
    // The flat total exists so a reader that shows one number never has to fall back to `0`.
    expect(body.usage.totalTokens).toBe(900);
    expect(body.usage.inputTokens).toBe(null);
    expect(body.usage.tokens.total).toBe(900);
    expect(JSON.stringify(body).includes("\"total\":0")).toBe(false);
  });

  it("answers unavailable when nothing was ever recorded for the session", async () => {
    const route = await usageHarness(async () => null);
    const { reply, state } = fakeReply();
    await route.handler({ params: { companyId: COMPANY, sessionId: SESSION } }, reply);
    const body = state.body as { status: string; reason: string };
    expect(body.status).toBe("unavailable");
    expect(body.reason).toBe("usage_not_recorded_for_session");
  });
});

// --- RBAC of destructive project actions -----------------------------------------------------------------

describe("[C7] [security-gate] archive and delete are administrative actions", () => {
  const actions = ["code.project.archive", "code.project.delete"];

  async function authorizeOutcome(rbac: CodeRbac, role: string, action: string, permission: string): Promise<string> {
    try {
      await rbac.authorize(context(role), COMPANY, { action, permission, projectId: PROJECT });
      return "allowed";
    } catch (error) {
      return (error as { code?: string }).code ?? "threw";
    }
  }

  function rbacWithShippedMatrix(): CodeRbac {
    return new CodeRbac({ registry: createRoleRegistry(DEFAULT_CODE_ROLE_MATRIX), audit: { record: async () => {} } as CodeAuthorizationAuditPort });
  }

  it("uses the existing vocabulary instead of inventing a permission", () => {
    for (const action of actions) {
      expect(requiredPermissionForAction(action)).toBe("business:manage");
    }
  });

  it("allows owner and admin", async () => {
    const rbac = rbacWithShippedMatrix();
    for (const role of ["owner", "admin"]) {
      for (const action of actions) {
        const outcome = await authorizeOutcome(rbac, role, action, requiredPermissionForAction(action)!);
        expect(`${role}:${action}=${outcome}`).toBe(`${role}:${action}=allowed`);
      }
    }
  });

  it("denies developer and reviewer", async () => {
    const rbac = rbacWithShippedMatrix();
    for (const role of ["developer", "reviewer"]) {
      for (const action of actions) {
        const outcome = await authorizeOutcome(rbac, role, action, requiredPermissionForAction(action)!);
        expect(`${role}:${action}=${outcome}`).toBe(`${role}:${action}=permission_denied`);
      }
    }
  });

  it("cannot be authorized by handing in the permission the caller prefers", async () => {
    const rbac = rbacWithShippedMatrix();
    // A developer asks for the destructive action while claiming a permission they do hold.
    const outcome = await authorizeOutcome(rbac, "developer", "code.project.delete", "workspace:write");
    expect(outcome).toBe("permission_action_mismatch");
  });
});
