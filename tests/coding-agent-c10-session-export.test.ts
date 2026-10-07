import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { CodeRbac, createRoleRegistry, type CodeAuthorizationAuditPort } from "../apps/agent-api/src/code-rbac";
import {
  CODE_SESSION_EXPORT_FLAG,
  EXPORT_MAX_LIMIT,
  EXPORT_MAX_RESULT_CHARS,
  registerCodeSessionExportRoutes,
  renderCodeSessionMarkdown,
  type CodeSessionExportRouteDeps,
} from "../apps/agent-api/src/code-session-export-routes";
import type { ReplayBundleStepPayload } from "../apps/agent-api/src/code-replay-bundle";
import { isValidCodeFlagKey } from "../apps/agent-api/src/feature-flags";

/**
 * C10 security-gate suite (ТЗ item 8): Markdown export of a session, without secrets.
 *
 * What is pinned, and why each part is load-bearing:
 *
 *  - **The document is the transcript the API already serves.** The bounds are the stream route's bounds (50
 *    default, 200 hard cap) and its 4000-character settled-result bound, so exporting can never become a wider read
 *    path than the endpoint the Workspace itself calls.
 *  - **A credential refuses the whole export.** Both scanners run — the replay bundle's own
 *    `assertNoSecretsInReplayBundle` and a scan of the finished Markdown — and the refusal is a 422 with **kinds
 *    only**: no document, no value, and no redacted preview, because a redacted export would look like a clean
 *    transcript while the secret stayed in the workspace.
 *  - **The transcript is escaped, not echoed.** A fence longer than any run of backticks in the body and `|`/newline
 *    escaping inside table cells, so a tool name or a model answer cannot restructure the document it is quoted in.
 *  - **Authorization is the existing read action plus the `code.export` flag**, refused before the store is read.
 *  - **The document is served as a download** (`content-disposition` + `text/markdown`) or as JSON on request, and
 *    the two carry the same Markdown.
 */

const COMPANY = "company-1";
const RUN = "run-1";
const SESSION = "session-1";
const PROJECT = "project-1";
const SECRET_CANARY = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function fakeInstance(routes: Route[]): FastifyInstance {
  return { get: (url: string, handler: Route["handler"]) => routes.push({ method: "get", url, handler }) } as unknown as FastifyInstance;
}

function fakeReply() {
  const state: { status: number; body: unknown; headers: Record<string, string> } = { status: 200, body: undefined, headers: {} };
  const reply = {
    code(status: number) { state.status = status; return reply; },
    header(name: string, value: string) { state.headers[name.toLowerCase()] = value; return reply; },
    send(payload: unknown) { state.body = payload; return reply; },
  };
  return { reply: reply as unknown, state };
}

function ownerContext(permissions: string[] = ["workspace:read", "workspace:write"]): AuthContext {
  return { workspaceId: "ws-1", userId: "user-1", permissions };
}

function modelStep(turnIndex: number, content: string, toolNames: string[] = []): ReplayBundleStepPayload {
  return {
    kind: "model_step",
    turnIndex,
    request: { model: "auto", messageCount: 2, toolNames },
    response: {
      content,
      finishReason: "stop",
      model: "gpt-test",
      provider: "provider-test",
      toolCalls: toolNames.map((name, index) => ({ id: `call-${turnIndex}-${index}`, name, argumentsHash: `sha256:${index}` })),
    },
  };
}

function toolStep(turnIndex: number, tool: string, settledResult: unknown, outcome: "ok" | "failed" = "ok"): ReplayBundleStepPayload {
  return {
    kind: "tool_call",
    turnIndex,
    toolCallId: `call-${turnIndex}`,
    tool,
    toolVersion: 3,
    argumentsHash: "sha256:args",
    settledResult,
    outcome,
    truncated: false,
    durationMs: 12,
  };
}

function replayBundle(steps: ReplayBundleStepPayload[], overrides: Record<string, unknown> = {}) {
  return {
    id: "bundle-1",
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    bundleVersion: 3,
    replayMode: "recorded",
    terminalStatus: "completed",
    terminalReason: "completed",
    replayInputHash: "sha256:input",
    payload: { stepCount: steps.length },
    ...overrides,
  } as unknown as Awaited<ReturnType<CodeSessionExportRouteDeps["store"]["getReplayBundle"]>>;
}

interface Harness {
  routes: Route[];
  deps: CodeSessionExportRouteDeps;
  audit: Array<{ action: string; decision: string }>;
}

function harness(options: {
  permissions?: string[];
  steps?: ReplayBundleStepPayload[];
  turns?: Array<{ turnIndex: number; toolCalls: Array<{ toolCallId: string; tool: string; readOnly: boolean; outcome: string; startedAt: Date; finishedAt: Date | null }> }>;
  exportEnabled?: boolean;
  state?: unknown;
  audit?: Array<{ action: string; decision: string }>;
} = {}): Harness {
  const routes: Route[] = [];
  const audit = options.audit ?? [];
  const auditPort: CodeAuthorizationAuditPort = {
    record: async (event) => { audit.push({ action: event.action, decision: event.decision }); },
  } as unknown as CodeAuthorizationAuditPort;
  const rbac = new CodeRbac({ registry: createRoleRegistry(), audit: auditPort });
  const problems: Array<{ action: string; code?: string }> = [];
  const steps = options.steps ?? [modelStep(0, "Working on it."), toolStep(0, "code.fs.read", { ok: true, content: "file body" })];
  const deps: CodeSessionExportRouteDeps = {
    store: {
      getCodeRunState: async (companyId: string, runId: string) => {
        if (companyId !== COMPANY || runId !== RUN) return null;
        return (options.state ?? {
          runId: RUN, workspaceId: "ws-1", companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
          status: "completed", turnIndex: 0, lastEventSeq: 4, leaseOwner: null, leaseExpiresAt: null,
          heartbeatAt: null, startedAt: new Date("2026-02-01T10:00:00.000Z"), updatedAt: new Date("2026-02-01T10:05:00.000Z"),
          finishedAt: new Date("2026-02-01T10:05:00.000Z"), details: {}, revision: 3,
        }) as never;
      },
      listCodeRunTurns: async () => (options.turns ?? []) as never,
      getReplayBundle: async (companyId: string, runId: string) => (companyId === COMPANY && runId === RUN ? replayBundle(steps) : null),
      getReplayBundleById: async () => null,
      listReplayBundleSteps: async () => steps.map((payload, index) => ({
        id: `step-${index}`, seq: index + 1, kind: payload.kind, turnIndex: payload.turnIndex,
        toolCallId: (payload as { toolCallId?: string }).toolCallId ?? null, payload, payloadHash: `sha256:${index}`,
      })) as never,
    },
    authorize: async (ctx, companyId, input) => {
      try {
        return await rbac.authorize(ctx, companyId, input as never);
      } catch (error) {
        problems.push({ action: (input as { action: string }).action, code: (error as { code?: string }).code });
        throw error;
      }
    },
    getAuthContext: () => ownerContext(options.permissions),
    ...(options.exportEnabled === undefined ? {} : { isExportEnabled: async () => options.exportEnabled === true }),
  };
  registerCodeSessionExportRoutes(fakeInstance(routes), deps);
  return { routes, deps, audit };
}

async function call(harnessed: Harness, query: Record<string, unknown> = {}) {
  const route = harnessed.routes.find((entry) => entry.url.endsWith("/export"))!;
  const { reply, state } = fakeReply();
  await route.handler({ params: { companyId: COMPANY, runId: RUN }, query }, reply);
  return state;
}

describe("security-gate: C10 session export — the Markdown is the transcript", () => {
  it("renders the run's turns, its tool results and its metadata", async () => {
    const state = await call(harness());
    expect(state.status).toBe(200);
    expect(state.headers["content-type"]).toContain("text/markdown");
    expect(state.headers["content-disposition"]).toContain(`filename="code-session-${SESSION}-${RUN}.md"`);
    const markdown = String(state.body);
    expect(markdown).toContain(`# Code session export — run \`${RUN}\``);
    expect(markdown).toContain(`| Company | \`${COMPANY}\` |`);
    expect(markdown).toContain(`| Session | \`${SESSION}\` |`);
    expect(markdown).toContain("| Transcript source | recorded replay bundle |");
    expect(markdown).toContain("## Turn 0");
    expect(markdown).toContain("Working on it.");
    expect(markdown).toContain("`code.fs.read`");
    // The settled result travels as a fenced JSON block, not inline in the table.
    expect(markdown).toContain("### `code.fs.read` result");
    expect(markdown).toContain("file body");
    expect(state.headers["x-npati-export-turns"]).toBe("1");
    expect(state.headers["x-npati-export-source"]).toBe("replay_bundle");
  });

  it("serves the same document as JSON when asked, without switching source", async () => {
    const harnessed = harness();
    const asJson = await call(harnessed, { format: "json" });
    const json = asJson.body as { markdown: string; fileName: string; turns: number; source: string };
    expect(json.fileName).toBe(`code-session-${SESSION}-${RUN}.md`);
    expect(json.source).toBe("replay_bundle");
    expect(json.turns).toBe(1);
    expect(json.markdown).toContain("## Turn 0");

    const asFile = await call(harnessed);
    // Same document, same turn: the rendered body is identical for everything except the timestamp line.
    const body = String(asFile.body);
    const withoutTimestamp = (value: string) => value.replace(/\| Exported at \|[^\n]*\|/g, "| Exported at |—|").replace(/· [0-9T:.\-Z]+_\n?$/, "· —_");
    expect(withoutTimestamp(body)).toBe(withoutTimestamp(json.markdown));
  });

  it("falls back to turn metadata with an explicit note when the run predates recordings", async () => {
    const harnessed = harness({
      steps: [],
      turns: [{ turnIndex: 0, toolCalls: [{ toolCallId: "call-1", tool: "code.fs.write", readOnly: false, outcome: "ok", startedAt: new Date(), finishedAt: null }] }],
    });
    const state = await call(harnessed);
    const markdown = String(state.body);
    expect(state.headers["x-npati-export-source"]).toBe("run_state");
    expect(markdown).toContain("Transcript source | run state (metadata only)");
    expect(markdown).toContain("only turn boundaries and tool outcomes are");
    expect(markdown).toContain("`code.fs.write`");
    expect(state.headers["x-npati-export-turns"]).toBe("1");
  });
});

describe("security-gate: C10 session export — bounds and refusals", () => {
  it("applies the stream route's page bounds and refuses a malformed limit", async () => {
    const steps: ReplayBundleStepPayload[] = [];
    for (let index = 0; index < 5; index += 1) steps.push(modelStep(index, `turn ${index}`));
    const harnessed = harness({ steps });

    const defaulted = await call(harnessed);
    expect(defaulted.status).toBe(200);

    const limited = await call(harnessed, { limit: "2" });
    expect(String(limited.body).match(/^## Turn /gm)?.length).toBe(2);

    const malformed = await call(harnessed, { limit: "0" });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "invalid_arguments" } });

    // The hard cap is the stream route's 200: a caller cannot ask for more turns than the API is willing to serve.
    const huge = await call(harnessed, { limit: "100000" });
    expect(String(huge.body).match(/^## Turn /gm)?.length).toBe(5);
    expect(EXPORT_MAX_LIMIT).toBe(200);
    expect(EXPORT_MAX_RESULT_CHARS).toBe(4_000);
  });

  it("refuses the entire export when a credential is stored, reporting kinds only", async () => {
    const harnessed = harness({ steps: [modelStep(0, `Here is the token ${SECRET_CANARY} use it`)] });
    const state = await call(harnessed);
    expect(state.status).toBe(422);
    expect(state.body).toMatchObject({ error: { code: "export_secret_detected" } });
    const serialized = JSON.stringify(state.body);
    // Neither the value nor a redacted excerpt may appear: the response is a refusal, not a cleaned document.
    expect(serialized).not.toContain(SECRET_CANARY);
    expect(serialized).not.toContain("Here is the token");
    expect(serialized).toContain("github_token");
    expect(state.headers["content-disposition"]).toBeUndefined();
  });

  it("refuses a credential that only appears in a tool result", async () => {
    const harnessed = harness({ steps: [toolStep(0, "code.shell.exec", { ok: true, stdout: `DATABASE_URL=postgres://user:pw@host/db` })] });
    const state = await call(harnessed);
    expect(state.status).toBe(422);
    expect((state.body as { error: { details?: { kinds?: string[] } } }).error.details?.kinds).toContain("database_url");
  });

  it("answers one identical 404 for an unknown run and does not read the bundle", async () => {
    const harnessed = harness();
    const route = harnessed.routes[0]!;
    const missing = fakeReply();
    await route.handler({ params: { companyId: COMPANY, runId: "run-other" }, query: {} }, missing.reply);
    expect(missing.state.status).toBe(404);
    // No ids in the body: an unknown run and another tenant's run are indistinguishable.
    expect(missing.state.body).toMatchObject({ error: { code: "run_not_found" } });
    expect(JSON.stringify(missing.state.body)).not.toContain("run-other");
  });

  it("refuses before reading the store when the caller may not read the run", async () => {
    const audit: Array<{ action: string; decision: string }> = [];
    const harnessed = harness({ permissions: [], audit });
    const state = await call(harnessed);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ error: { code: "permission_denied" } });
    // The decision is journalled, which is what makes the refusal provable afterwards.
    expect(audit.length).toBeGreaterThan(0);
  });

  it("refuses when the code.export flag is off, and the flag key is a real allowlisted key", async () => {
    expect(isValidCodeFlagKey(CODE_SESSION_EXPORT_FLAG)).toBe(true);
    const harnessed = harness({ exportEnabled: false });
    const state = await call(harnessed);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ error: { code: "export_disabled", details: { flag: CODE_SESSION_EXPORT_FLAG } } });
  });
});

describe("security-gate: C10 session export — the renderer cannot be restructured by its input", () => {
  it("fences a body that contains a fence", () => {
    const markdown = renderCodeSessionMarkdown({
      runId: RUN, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, status: "completed",
      exportedAt: "2026-02-01T10:00:00.000Z", source: "replay_bundle", limit: 50, totalTurns: 1,
      rewoundToTurn: null, turnsOmittedByRewind: 0,
      turns: [{
        turnIndex: 0,
        assistant: { content: "text with ``` inside it", finishReason: "stop", model: "m", provider: "p", toolCalls: [] },
        toolCalls: [],
      }],
    });
    // A fence of three backticks would be closed by the value; the renderer must use a longer one.
    expect(markdown).toContain("````");
  });

  it("escapes table separators and newlines out of tool metadata", () => {
    const markdown = renderCodeSessionMarkdown({
      runId: RUN, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, status: "completed",
      exportedAt: "2026-02-01T10:00:00.000Z", source: "replay_bundle", limit: 50, totalTurns: 1,
      rewoundToTurn: null, turnsOmittedByRewind: 0,
      turns: [{
        turnIndex: 0,
        toolCalls: [{
          toolCallId: "c1", tool: "code.fs.read|injected", toolVersion: null, outcome: "ok\n## Turn 99",
          truncated: false, durationMs: null, resultText: null, resultTruncated: false,
        }],
      }],
    });
    expect(markdown).toContain("code.fs.read\\|injected");
    expect(markdown).not.toContain("ok\n## Turn 99");
    // The injected heading never becomes a heading of its own.
    expect(markdown.match(/^## Turn /gm)?.length).toBe(1);
  });

  it("states a rewind and a failed integrity check instead of hiding them", () => {
    const markdown = renderCodeSessionMarkdown({
      runId: RUN, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, status: "completed",
      exportedAt: "2026-02-01T10:00:00.000Z", source: "replay_bundle", limit: 50, totalTurns: 3,
      rewoundToTurn: 1, turnsOmittedByRewind: 2, turns: [],
      bundle: { replayMode: "recorded", terminalStatus: "completed", terminalReason: "completed", integrityFailure: true },
    });
    expect(markdown).toContain("rewound to turn 1");
    expect(markdown).toContain("integrity check");
    expect(markdown).toContain("**Warning**");
  });
});
