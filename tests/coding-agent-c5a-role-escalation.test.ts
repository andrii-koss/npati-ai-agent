import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "@npati/workspace";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import {
  PolicyEngine,
  type CodeSessionModeName,
  type PolicyRequest,
  type PolicyResult,
} from "../apps/agent-api/src/code-policy-engine";
import {
  authorizeCodeAction,
  createRoleRegistry,
  CodeRbacError,
  type CodeAuthorizationAuditPort,
} from "../apps/agent-api/src/code-rbac";
import {
  CodeMembershipService,
  DEFAULT_COMPANY_ROLE_MATRIX,
  permissionsForCompanyRole,
  type CodeMembershipStore,
  type CompanyMember,
  type CompanyRole,
} from "../apps/agent-api/src/code-membership";
import {
  assertPrincipalMayChangePolicy,
  CodeSessionModeService,
  registerCodeSessionModeRoutes,
} from "../apps/agent-api/src/code-session-mode-routes";
import { CodeProjectTrustService } from "../apps/agent-api/src/code-project-trust";

/**
 * C5a security-gate (SG-2): privilege escalation attempts, exactly as PLAN.md lines 599-606 require.
 *
 * Coverage:
 *  - a `developer` can switch a session to the working modes the plan grants them (`plan`/`ask`/
 *    `auto_edit`, plus the C1 spellings) and never to `full_auto_sandbox` (neither through the HTTP route
 *    nor through repository content nor by changing project rules);
 *  - a `reviewer` cannot run a command, in any session mode;
 *  - lowering a role in the middle of a run stops the actions that needed the higher role: the role is
 *    read per tool call (the store is consulted every time) rather than cached for the whole run;
 *  - a force push into a protected branch is a hard deny for everyone, including an owner holding
 *    `admin:all`, in `full_auto`, with an approval already presented — and repository content cannot
 *    change the protected-branch policy;
 *  - a refusal of a policy surface (session mode, project trust) is journalled, and a refusal never
 *    becomes an allow when the journal is missing.
 *
 * Fixed in C5a part 2C and pinned by `coding-agent-c5a-protected-branches.test.ts` as well: the
 * company-level protected-branch policy is consulted in the PolicyEngine's hard-deny phase, so a *plain*
 * `git push origin main` is `protected_branch_write_denied` and not merely an approval.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";

interface Route {
  method: string;
  url: string;
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

/** Minimal Fastify stand-in: the routes under test are the ones the API actually registers. */
function fakeInstance(routes: Route[]): FastifyInstance {
  return {
    put: (url: string, handler: Route["handler"]) => routes.push({ method: "put", url, handler }),
    post: (url: string, handler: Route["handler"]) => routes.push({ method: "post", url, handler }),
  } as unknown as FastifyInstance;
}

function fakeReply(): { reply: unknown; state: { status: number; body: unknown } } {
  const state = { status: 200, body: undefined as unknown };
  const reply = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    send(payload: unknown) {
      state.body = payload;
      return reply;
    },
  };
  return { reply, state };
}

function context(role: CompanyRole | "agent" | "service", userId: string): AuthContext {
  const permissions = role === "agent" || role === "service" ? ["workspace:read", "workspace:write", "tools:read", "tools:execute"] : [...permissionsForCompanyRole(role)];
  return {
    workspaceId: "ws-1",
    userId,
    companyId: COMPANY,
    permissions,
    role,
  } as unknown as AuthContext;
}

function auditSpy(): { port: CodeAuthorizationAuditPort; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    port: {
      record: async (entry) => {
        entries.push(entry as unknown as Record<string, unknown>);
      },
    },
  };
}

/** The structured shape every refusal in this suite carries. */
interface Refusal {
  code?: string;
  httpStatus?: number;
  retryable?: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/** Resolves to the thrown error (as a structured refusal) or `null` when the call unexpectedly succeeded. */
async function refusal<T>(promise: Promise<T>): Promise<Refusal | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Refusal;
  }
}

interface EngineHarness {
  engine: PolicyEngine;
  approvalRequests: Array<Record<string, unknown>>;
  modeReads: () => number;
  setStoredMode: (mode: CodeSessionModeName) => void;
}

/** Real classifier, real capability lookup shape, scripted flags and approvals. */
function buildEngine(): EngineHarness {
  const approvalRequests: Array<Record<string, unknown>> = [];
  let modeReads = 0;
  let storedMode: CodeSessionModeName = "auto";
  const engine = new PolicyEngine({
    flags: { assertEnabled: async () => true },
    capabilities: { get: (id: string) => ({ id, version: 1, status: "published" }) },
    classifier: (command: string) => classifyShellCommand(command),
    approvals: {
      requestApproval: async (_ctx: AuthContext, _companyId: string, input: Record<string, unknown>) => {
        approvalRequests.push(input);
        return { id: `approval-${approvalRequests.length}` };
      },
      consumeApproved: async () => ({}),
    },
    sessionMode: async () => {
      modeReads += 1;
      return storedMode;
    },
  });
  return {
    engine,
    approvalRequests,
    modeReads: () => modeReads,
    setStoredMode: (mode) => {
      storedMode = mode;
    },
  };
}

function request(ctx: AuthContext, tool: string, extra: Partial<PolicyRequest> = {}): PolicyRequest {
  return { ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, tool, ...extra };
}

async function evaluate(engine: PolicyEngine, input: PolicyRequest): Promise<PolicyResult> {
  return engine.evaluate(input);
}

interface ModeStoreHarness {
  store: { getCodeSession: unknown; updateCodeSession: unknown };
  state: { mode: string; revision: number; updates: Array<{ mode?: string; expectedRevision?: number }> };
  audit: { entries: string[]; port: { record: (entry: { action: string }) => Promise<void> } };
}

function buildModeStore(initial = "plan"): ModeStoreHarness {
  const state: ModeStoreHarness["state"] = { mode: initial, revision: 3, updates: [] };
  const auditEntries: string[] = [];
  const store = {
    getCodeSession: async () => ({
      id: SESSION,
      workspaceId: "ws-1",
      companyId: COMPANY,
      projectId: PROJECT,
      userId: "u-owner",
      mode: state.mode,
      status: "active",
      dataClassification: "internal",
      retentionClass: "standard",
      revision: state.revision,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    updateCodeSession: async (_ctx: unknown, _companyId: string, _sessionId: string, patch: { mode?: string; expectedRevision?: number }) => {
      state.updates.push(patch);
      state.mode = patch.mode ?? state.mode;
      state.revision += 1;
      return { id: SESSION, mode: state.mode, revision: state.revision };
    },
  };
  return {
    store: store as unknown as ModeStoreHarness["store"],
    state,
    audit: {
      entries: auditEntries,
      port: {
        record: async (entry: { action: string }) => {
          auditEntries.push(entry.action);
        },
      },
    },
  };
}

/** Membership fixture: enough of the port for the "role is re-read per tool call" harness. */
function buildMembership(seed: Array<{ userId: string; role: CompanyRole }>) {
  const members = new Map<string, CompanyMember>();
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  for (const entry of seed) {
    members.set(`${COMPANY}:${entry.userId}`, {
      id: `cm_${entry.userId}`,
      companyId: COMPANY,
      userId: entry.userId,
      role: entry.role,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    });
  }
  const reads = { membership: 0 };
  const store: CodeMembershipStore = {
    async getCompanyMembership(companyId, userId) {
      reads.membership += 1;
      return members.get(`${companyId}:${userId}`) ?? null;
    },
    async listCompanyMembers(companyId) {
      return [...members.values()].filter((member) => member.companyId === companyId);
    },
    async countCompanyOwners(companyId) {
      return [...members.values()].filter((member) => member.companyId === companyId && member.role === "owner").length;
    },
    async createCompanyInvite() {
      throw new Error("not used in this suite");
    },
    async findCompanyInviteByTokenHash() {
      return null;
    },
    async acceptCompanyInvite() {
      throw new Error("not used in this suite");
    },
    async updateCompanyMemberRole() {
      throw new Error("not used in this suite");
    },
    async removeCompanyMember() {
      throw new Error("not used in this suite");
    },
  };
  return {
    store,
    reads,
    service: new CodeMembershipService({ store }),
    downgrade: (userId: string, role: CompanyRole) => {
      const existing = members.get(`${COMPANY}:${userId}`);
      if (!existing) throw new Error(`unknown member ${userId}`);
      members.set(`${COMPANY}:${userId}`, { ...existing, role, revision: existing.revision + 1 });
    },
  };
}

describe("security-gate: C5a escalation — a developer cannot enable full_auto_sandbox", () => {
  it("refuses the full_auto mode change through the API and leaves the stored mode untouched", async () => {
    const modeStore = buildModeStore("plan");
    const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
    const routes: Route[] = [];
    await registerCodeSessionModeRoutes(fakeInstance(routes), {
      service,
      store: modeStore.store as never,
      audit: modeStore.audit.port,
      getAuthContext: () => context("developer", "u-dev"),
    });
    const put = routes.find((route) => route.method === "put");
    if (!put) throw new Error("the mode route is not registered");
    const { reply, state } = fakeReply();
    await put.handler({ params: { companyId: COMPANY, sessionId: SESSION }, body: { mode: "full_auto", expectedRevision: 3 } }, reply);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ status: "error", code: "session_mode_not_permitted", details: { reason: "session_mode_not_permitted", mode: "full_auto_sandbox", role: "developer" } });
    expect(modeStore.state.mode).toBe("plan");
    expect(modeStore.state.updates).toEqual([]);
  });

  it("grants a developer the working modes the plan gives them and nothing above them (D6)", async () => {
    // C5a (D6): PLAN.md:582 grants plan/ask/auto_edit to a developer. The role -> mode matrix in
    // `code-rbac.ts` (`DEFAULT_CODE_SESSION_MODE_MATRIX`) is what decides it — the route no longer
    // requires owner/admin for *any* mode, and the canonical names are accepted alongside the C1 ones.
    //
    // Every case starts from a mode the target is **not**, so "the mode changed" is an observable
    // property: a session that already holds the requested mode would make that assertion unfalsifiable.
    const allowed: Array<{ mode: string; from: string; persisted: string }> = [
      { mode: "plan", from: "auto", persisted: "plan" },
      { mode: "ask", from: "plan", persisted: "edit" },
      { mode: "auto_edit", from: "plan", persisted: "auto" },
      { mode: "edit", from: "auto_edit", persisted: "edit" },
      { mode: "auto", from: "ask", persisted: "auto" },
    ];
    for (const { mode, from, persisted } of allowed) {
      const modeStore = buildModeStore(from);
      const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
      const updated = await service.setMode(context("developer", "u-dev"), COMPANY, SESSION, { mode, expectedRevision: 3 });
      expect(updated, mode).toBeTruthy();
      expect(modeStore.audit.entries, mode).toEqual(["code.session.mode_change"]);
      expect(modeStore.state.mode, mode).toBe(persisted);
      expect(modeStore.state.updates, mode).toEqual([{ mode: persisted, expectedRevision: 3 }]);
    }
    // Asking for the mode the session already holds is a no-op *allow*, not a refusal: the authority is
    // about the target mode, not about a visible change.
    {
      const modeStore = buildModeStore("plan");
      const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
      const updated = await service.setMode(context("developer", "u-dev"), COMPANY, SESSION, { mode: "plan", expectedRevision: 3 });
      expect(updated.mode).toBe("plan");
      expect(modeStore.audit.entries).toEqual(["code.session.mode_change"]);
    }
    // The unattended mode is refused in both spellings, from a mode that is not the target: the refusal
    // must leave the stored mode byte-for-byte what it was and must be journalled as a denial.
    for (const mode of ["full_auto", "full_auto_sandbox"]) {
      const modeStore = buildModeStore("auto_edit");
      const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
      const failure = await refusal(service.setMode(context("developer", "u-dev"), COMPANY, SESSION, { mode, expectedRevision: 3 }));
      expect(failure?.code, mode).toBe("session_mode_not_permitted");
      expect(failure?.httpStatus, mode).toBe(403);
      expect(modeStore.state.mode, mode).toBe("auto_edit");
      expect(modeStore.state.updates, mode).toEqual([]);
      expect(modeStore.audit.entries, mode).toEqual(["code.session.mode_change.denied"]);
    }
  });

  it("lets owner and admin enable full_auto, audited before the write", async () => {
    for (const role of ["owner", "admin"] as const) {
      const modeStore = buildModeStore("plan");
      const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
      const updated = await service.setMode(context(role, `u-${role}`), COMPANY, SESSION, { mode: "full_auto", expectedRevision: 3 });
      expect(updated.mode, role).toBe("full_auto");
      expect(modeStore.audit.entries, role).toEqual(["code.session.mode_change"]);
      expect(modeStore.state.updates, role).toEqual([{ mode: "full_auto", expectedRevision: 3 }]);
    }
  });

  it("refuses an agent or service principal even when it carries the owner role", async () => {
    const modeStore = buildModeStore("plan");
    const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
    const agents = [context("agent", "agent:runner-1"), { ...context("owner", "u-owner"), externalSubject: "service:automation:1" } as AuthContext];
    for (const agentContext of agents) {
      const routes: Route[] = [];
      await registerCodeSessionModeRoutes(fakeInstance(routes), {
        service,
        store: modeStore.store as never,
        audit: modeStore.audit.port,
        getAuthContext: () => agentContext,
      });
      const put = routes.find((route) => route.method === "put" && route.url.endsWith("/mode"));
      if (!put) throw new Error("the mode route is not registered");
      const { reply, state } = fakeReply();
      await put.handler({ params: { companyId: COMPANY, sessionId: SESSION }, body: { mode: "full_auto", expectedRevision: 3 } }, reply);
      expect(state.status).toBe(403);
      expect(state.body).toMatchObject({ code: "agent_cannot_change_policy" });
      expect(() => assertPrincipalMayChangePolicy(agentContext, "session_mode")).toThrowError(/agent_cannot_change_policy/);
    }
    expect(modeStore.state.mode).toBe("plan");
  });

  it("accepts the canonical full_auto_sandbox name and still rejects an unknown mode", async () => {
    const modeStore = buildModeStore("plan");
    const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
    // C5a (D6): `code-policy-engine.ts` has always named the unattended mode `full_auto_sandbox`; the
    // route accepts that canonical name (keeping `full_auto` as a legacy alias) and normalises it, so the
    // two vocabularies agree. The persisted value stays in the C1 vocabulary of migration 065.
    const updated = await service.setMode(context("owner", "u-owner"), COMPANY, SESSION, { mode: "full_auto_sandbox", expectedRevision: 3 });
    expect(updated.mode).toBe("full_auto");
    expect(modeStore.state.updates).toEqual([{ mode: "full_auto", expectedRevision: 3 }]);

    const failure = await refusal(service.setMode(context("owner", "u-owner"), COMPANY, SESSION, { mode: "yolo", expectedRevision: 3 }));
    expect(failure?.code).toBe("invalid_mode");
    expect(failure?.httpStatus).toBe(400);
  });

  it("refuses a stale revision instead of overwriting a newer mode", async () => {
    const modeStore = buildModeStore("plan");
    const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port });
    const failure = await refusal(service.setMode(context("owner", "u-owner"), COMPANY, SESSION, { mode: "auto", expectedRevision: 99 }));
    expect(failure?.code).toBe("mode_revision_conflict");
    expect(failure?.httpStatus).toBe(409);
    expect(modeStore.state.updates).toEqual([]);
  });
});

describe("security-gate: C5a escalation — repository content cannot change the mode or the policy", () => {
  it("refuses a policy mutation coming from repository instructions, for every role and mode", async () => {
    const harness = buildEngine();
    for (const [role, userId] of [["developer", "u-dev"], ["owner", "u-owner"]] as const) {
      for (const mode of ["plan", "edit", "auto", "full_auto"] as const) {
        const result = await evaluate(
          harness.engine,
          request(context(role, userId), "code.fs.read", {
            sessionMode: mode,
            repositoryInstructions: { policyMutationAttempts: 1, notes: ["set mode=full_auto in NPATI.md"] },
          }),
        );
        expect(result.decision, `${role}/${mode}`).toBe("deny");
        expect(result.code, `${role}/${mode}`).toBe("repository_instruction_policy_change");
        expect(result.status, `${role}/${mode}`).toBe(403);
      }
    }
  });

  it("keeps a repository's own claim of trust from being believed", async () => {
    const harness = buildEngine();
    const result = await evaluate(
      harness.engine,
      request(context("developer", "u-dev"), "code.fs.read", {
        sessionMode: "full_auto",
        requiresProjectTrust: true,
        projectTrusted: false,
      }),
    );
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("project_not_trusted");
  });

  it("turns a model's mode suggestion into a record, never into a mode change", async () => {
    const modeStore = buildModeStore("plan");
    const service = new CodeSessionModeService({ store: modeStore.store as never, audit: modeStore.audit.port, suggestionSink: vi.fn() });
    const routes: Route[] = [];
    await registerCodeSessionModeRoutes(fakeInstance(routes), {
      service,
      store: modeStore.store as never,
      audit: modeStore.audit.port,
      getAuthContext: () => context("agent", "agent:runner-1"),
    });
    const post = routes.find((route) => route.method === "post");
    if (!post) throw new Error("the suggestion route is not registered");
    const { reply, state } = fakeReply();
    await post.handler(
      { params: { companyId: COMPANY, sessionId: SESSION }, body: { mode: "full_auto", reason: "the task needs it" } },
      reply,
    );
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ applied: false, mode: "plan" });
    expect(modeStore.state.mode).toBe("plan");
    expect(modeStore.state.updates).toEqual([]);
  });
});

describe("security-gate: C5a escalation — a developer cannot change project rules", () => {
  function trustFixture(initial: { trusted: boolean; revision: number } = { trusted: false, revision: 0 }) {
    const writes: Array<Record<string, unknown>> = [];
    const auditEntries: string[] = [];
    const store = {
      getProjectCodeTrust: async () => ({ ...initial, id: "pct_1", workspaceId: "ws-1", companyId: COMPANY, projectId: PROJECT, updatedAt: "2026-01-01T00:00:00.000Z" }),
      setProjectCodeTrust: async (_ctx: unknown, _companyId: string, _projectId: string, input: Record<string, unknown>) => {
        writes.push(input);
        return { ...initial, id: "pct_1", trusted: Boolean(input.trusted) };
      },
    };
    const service = new CodeProjectTrustService({
      store: store as never,
      audit: {
        record: async (entry: { action: string }) => {
          auditEntries.push(entry.action);
        },
      },
    });
    return { service, writes, auditEntries };
  }

  it("refuses project trust to a developer and a reviewer, writing nothing but a denial entry (D7)", async () => {
    for (const role of ["developer", "reviewer"] as const) {
      const fixture = trustFixture();
      const failure = await refusal(fixture.service.trust(context(role, `u-${role}`), COMPANY, PROJECT, { expectedRevision: 0 }));
      expect(failure?.code, role).toBe("code_trust_admin_required");
      expect(failure?.httpStatus, role).toBe(403);
      expect(fixture.writes, role).toEqual([]);
      // C5a (D7): a refusal is journalled too, so an escalation attempt leaves a trace. The trust record
      // itself is still never written.
      expect(fixture.auditEntries, role).toEqual(["code.project.trust.denied"]);
    }
  });

  it("lets an owner grant trust, audited before the write", async () => {
    const fixture = trustFixture();
    await fixture.service.trust(context("owner", "u-owner"), COMPANY, PROJECT, { expectedRevision: 0, reason: "reviewed" });
    expect(fixture.auditEntries).toEqual(["code.project.trust"]);
    expect(fixture.writes).toHaveLength(1);
  });

  it("refuses a policy change coming from an agent in the policy engine itself", async () => {
    const harness = buildEngine();
    const result = await evaluate(
      harness.engine,
      request(context("agent", "agent:runner-1"), "code.fs.edit", { sessionMode: "full_auto", policyChange: "project_rules" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("agent_cannot_change_policy");
    expect(result.phase).toBe("trust");
  });
});

describe("security-gate: C5a escalation — a reviewer cannot run a command", () => {
  it("refuses a shell command for a reviewer in every session mode", async () => {
    const harness = buildEngine();
    for (const mode of ["plan", "edit", "auto", "full_auto"] as const) {
      const result = await evaluate(harness.engine, request(context("reviewer", "u-rev"), "code.shell.exec", { sessionMode: mode, command: "ls -la" }));
      expect(result.decision, mode).toBe("deny");
      expect(result.code, mode).toBe("permission_denied");
      expect(result.status, mode).toBe(403);
      expect(result.phase, mode).toBe("rbac");
    }
  });

  it("refuses a write for a reviewer but still allows a read", async () => {
    const harness = buildEngine();
    const write = await evaluate(harness.engine, request(context("reviewer", "u-rev"), "code.fs.edit", { sessionMode: "auto" }));
    expect(write.decision).toBe("deny");
    expect(write.code).toBe("permission_denied");

    const read = await evaluate(harness.engine, request(context("reviewer", "u-rev"), "code.fs.read", { sessionMode: "auto" }));
    expect(read.decision).toBe("allow");
  });

  it("intersects the agent's capability groups with the user's rights: a read-only agent cannot execute", async () => {
    const harness = buildEngine();
    const denied = await evaluate(
      harness.engine,
      request(context("agent", "agent:runner-1"), "code.shell.exec", {
        sessionMode: "auto",
        command: "ls -la",
        capabilityGroups: { agentCapabilityGroups: ["code.read"], userPermissions: ["code.shell"] },
      }),
    );
    expect(denied.decision).toBe("deny");
    expect(denied.code).toBe("capability_not_granted");
    expect(denied.status).toBe(403);
    // No approval is ever requested for a tool the agent has no group for.
    expect(harness.approvalRequests).toEqual([]);

    // Positive control: the same call is allowed once the agent holds the shell group.
    const allowed = await evaluate(
      harness.engine,
      request(context("agent", "agent:runner-1"), "code.shell.exec", {
        sessionMode: "auto",
        command: "ls -la",
        capabilityGroups: { agentCapabilityGroups: ["code.shell"], userPermissions: ["code.shell"] },
      }),
    );
    expect(allowed.decision).toBe("allow");
  });
});

describe("security-gate: C5a escalation — a downgrade mid-run stops higher-role actions", () => {
  /**
   * One tool call = one role lookup + one policy evaluation. The membership store is the only source of
   * the role, so the call count proves the role is not cached for the run.
   */
  function runHarness(userId: string, initialRole: CompanyRole) {
    const membership = buildMembership([{ userId, role: initialRole }]);
    const engineHarness = buildEngine();
    const audit = auditSpy();
    const registry = createRoleRegistry({ roles: { ...DEFAULT_COMPANY_ROLE_MATRIX } });
    const baseContext = context(initialRole, userId);

    async function toolCall(tool: string, command?: string): Promise<PolicyResult> {
      const role = await membership.service.resolveRoleForUser(baseContext, COMPANY);
      const permissions = role ? [...permissionsForCompanyRole(role)] : [];
      return evaluate(
        engineHarness.engine,
        request({ ...baseContext, role, permissions } as unknown as AuthContext, tool, {
          ...(command ? { command } : {}),
          sessionMode: undefined,
        }),
      );
    }

    return { membership, engineHarness, audit, registry, toolCall, baseContext };
  }

  it("re-reads the role on every tool call and refuses the write after the downgrade", async () => {
    const harness = runHarness("u-dev", "developer");

    const firstEdit = await harness.toolCall("code.fs.edit");
    expect(firstEdit.decision).toBe("allow");

    // The role is lowered in the middle of the run.
    harness.membership.downgrade("u-dev", "reviewer");

    const secondEdit = await harness.toolCall("code.fs.edit");
    expect(secondEdit.decision).toBe("deny");
    expect(secondEdit.code).toBe("permission_denied");

    const shell = await harness.toolCall("code.shell.exec", "ls -la");
    expect(shell.decision).toBe("deny");
    expect(shell.code).toBe("permission_denied");

    const read = await harness.toolCall("code.fs.read");
    expect(read.decision).toBe("allow");

    // Four calls read the role four times: nothing about the role is cached for the run.
    expect(harness.membership.reads.membership).toBe(4);
    // The session mode is read on the calls that reach the mode phase. The two refusals short-circuit in
    // the RBAC phase, which is where the downgrade has to bite.
    expect(harness.engineHarness.modeReads()).toBe(2);
  });

  it("applies the same per-call role to the RBAC gate the routes call", async () => {
    const userId = "u-dev";
    const harness = runHarness(userId, "developer");
    const baseContext = harness.baseContext;

    const asDeveloper = await authorizeCodeAction(baseContext, COMPANY, { permission: "workspace:write", action: "code.fs.edit" }, {
      registry: harness.registry,
      audit: harness.audit.port,
    });
    expect(asDeveloper).toMatchObject({ allowed: true, role: "developer" });

    harness.membership.downgrade(userId, "reviewer");
    const role = await harness.membership.service.resolveRoleForUser(baseContext, COMPANY);
    const asReviewer = { ...baseContext, role, permissions: [...permissionsForCompanyRole(role)] } as unknown as AuthContext;

    const writeFailure = await refusal(
      authorizeCodeAction(asReviewer, COMPANY, { permission: "workspace:write", action: "code.fs.edit" }, {
        registry: harness.registry,
        audit: harness.audit.port,
      }),
    );
    expect(writeFailure).toBeInstanceOf(CodeRbacError);
    expect(writeFailure?.code).toBe("permission_denied");

    const read = await authorizeCodeAction(asReviewer, COMPANY, { permission: "workspace:read", action: "code.fs.read" }, {
      registry: harness.registry,
      audit: harness.audit.port,
    });
    expect(read).toMatchObject({ allowed: true, role: "reviewer" });
  });
});

describe("security-gate: C5a escalation — protected branches and force push", () => {
  const PROTECTED = ["main", "master", "release"];

  it("classifies a force push into a protected branch as a hard deny", () => {
    for (const command of ["git push --force origin main", "git push -f origin master", "git push --force origin release"]) {
      const result = classifyShellCommand(command);
      expect(result.risk, command).toBe("hard_deny");
      expect(result.matched, command).toContain("protected_branch_force_push");
    }
  });

  it("denies the force push for an owner holding admin:all, in full_auto, with an approval presented", async () => {
    const harness = buildEngine();
    const owner = { ...context("owner", "u-owner"), permissions: ["workspace:read", "workspace:write", "admin:all"] } as AuthContext;
    const result = await evaluate(
      harness.engine,
      request(owner, "code.shell.exec", {
        sessionMode: "full_auto",
        command: "git push --force origin main",
        approved: true,
        approvalId: "approval-1",
      }),
    );
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("command_hard_denied");
    expect(result.status).toBe(403);
    expect(result.phase).toBe("hard_deny");
    // The hard-deny phase precedes the approval phase, so the approval was never even consulted.
    expect(harness.approvalRequests).toEqual([]);
  });

  it("denies the force push for an agent principal too", async () => {
    const harness = buildEngine();
    const result = await evaluate(
      harness.engine,
      request(context("agent", "agent:runner-1"), "code.shell.exec", { sessionMode: "full_auto", command: "git push --force origin main" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("command_hard_denied");
  });

  it("does not hard-deny a force push to an unprotected branch, and never auto-allows it either", async () => {
    const harness = buildEngine();
    const result = await evaluate(
      harness.engine,
      request(context("owner", "u-owner"), "code.shell.exec", {
        sessionMode: "full_auto",
        command: "git push --force origin feature/topic",
        networkEnforcementGuaranteed: true,
      }),
    );
    expect(result.code).not.toBe("command_hard_denied");
    expect(result.phase).not.toBe("hard_deny");
    expect(result.decision).toBe("require_approval");
  });

  it("treats the protected-branch list as server-side data, not as something a caller can relax", async () => {
    // The list is an option of the classifier, and a caller-supplied request field cannot reach it.
    expect(classifyShellCommand("git push --force origin prod", { protectedBranches: [...PROTECTED, "prod"] }).risk).toBe("hard_deny");
    expect(classifyShellCommand("git push --force origin prod").risk).not.toBe("hard_deny");

    const harness = buildEngine();
    const sneaky = {
      ...request(context("owner", "u-owner"), "code.shell.exec", { sessionMode: "full_auto", command: "git push --force origin main" }),
      protectedBranches: [],
      protected_branches: [],
      options: { protectedBranches: [] },
    } as unknown as PolicyRequest;
    const result = await evaluate(harness.engine, sneaky);
    expect(result.decision).toBe("deny");
    expect(result.code).toBe("command_hard_denied");
  });

  it("does not let repository content rewrite the branch policy or change the verdict", async () => {
    // A command that would rewrite the branch policy is never `safe`, and in full_auto it is still an
    // approval rather than an implicit allow.
    const rewrite = "git config --local branch.main.protected false";
    expect(classifyShellCommand(rewrite).risk).not.toBe("safe");
    const harness = buildEngine();
    const evaluated = await evaluate(
      harness.engine,
      request(context("developer", "u-dev"), "code.shell.exec", { sessionMode: "full_auto", command: rewrite }),
    );
    expect(evaluated.decision).toBe("require_approval");

    const dropPolicyFile = 'echo \'{"protected":[]}\' > .npati/protected-branches.json';
    expect(classifyShellCommand(dropPolicyFile).risk).not.toBe("safe");

    // Evaluating repository content does not mutate the policy: the next force push is still a hard deny.
    expect(classifyShellCommand("git push --force origin main").risk).toBe("hard_deny");
  });
});
