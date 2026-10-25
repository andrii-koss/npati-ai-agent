import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { buildApp } from "../apps/agent-api/src/app";
import { CodeRunRateLimiter, resolveCodeRunRateLimits } from "../apps/agent-api/src/code-run-rate-limit";
import { CodeRunQueue } from "../apps/agent-api/src/code-run-queue";
import { createCodeRunAdmission } from "../apps/agent-api/src/code-run-admission";
import { CodeRunSharedQuota } from "../apps/agent-api/src/code-run-quota";
import { A2AQuotaManager } from "../apps/agent-api/src/a2a-protocol-extensions";
import { RouteGuardTiers } from "../apps/agent-api/src/route-guard-tiers";
import { ProjectApiRateLimiter } from "../apps/agent-api/src/data-studio/rate-limiter";
import { InMemoryStorageProtection, RedisStorageProtection } from "../apps/agent-api/src/storage-protection";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { AIPreferencesStore } from "../apps/agent-api/src/ai-preferences";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { applyCodeInbox, emptyCodeInbox } from "../packages/workspace/src/code-session-inbox";
import { applyCodeProcess, type CodeProcessProjectState } from "../packages/workspace/src/code-process-store";
import { QuotaShareRouter } from "../apps/agent-api/src/routing-transparency-and-dedup";
import { AtomicRpmLeaseManager } from "../apps/agent-api/src/atomic-rpm-rolling-leases";
import { PostgresDataProvider } from "../apps/agent-api/src/data-studio/data-provider";
import { QuotaService } from "../apps/agent-api/src/data-studio/quota-service";
import { usageQuotasEnabled } from "../apps/agent-api/src/usage-quota-policy";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const auth: AuthContext = { workspaceId: "unlimited-test", userId: "owner", permissions: ["*"] };

describe("platform usage quotas are disabled in every deployment", () => {
  it.each([["development", "self_hosted"], ["production", "self_hosted"], ["production", "npati_hosted"]])("admits 105, 200 and 305 sequential code runs in %s / %s, including reconstruction", async (environment, deployment) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("NPATI_DEPLOYMENT_TYPE", deployment);
    vi.stubEnv("NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD", "1");
    vi.stubEnv("NPATI_CODE_RUN_RATE_LIMIT_PER_COMPANY_PER_PERIOD", "1");
    const ticket = { workspaceId: auth.workspaceId, userId: auth.userId, companyId: "company", sessionId: "session" };
    for (const operations of [105, 200, 305]) {
      const queue = new CodeRunQueue({ maxConcurrentPerUser: 1, maxConcurrentPerCompany: 1 });
      const limiter = new CodeRunRateLimiter(resolveCodeRunRateLimits());
      const admission = createCodeRunAdmission(queue, limiter);
      for (let i = 0; i < operations; i++) {
        expect(admission.canAdmit(ticket)).toBe(true);
        const lease = await admission.admit(ticket);
        expect(queue.state().active).toBe(1);
        lease.release();
      }
      expect(queue.state().active).toBe(0);
      expect(limiter.state()).toMatchObject({ enabled: false, windows: [] });
    }
    expect(usageQuotasEnabled()).toBe(false);
  });

  it("keeps concurrency cancellation and recursion guards while ignoring accumulated spending", async () => {
    const manager = new A2AQuotaManager();
    manager.setSessionBudget("session", 1, 0.001, 2);
    const quota = new CodeRunSharedQuota(manager, { dailyLimits: { maxTokensPerUserPerDay: 1, maxTokensPerCompanyPerDay: 1 } });
    for (let i = 0; i < 305; i++) {
      expect(quota.checkQuota("session", 1_000_000, 10, 1, { userId: "owner", companyId: "company" }).allowed).toBe(true);
      quota.recordUsage("session", 1_000_000, 10, { userId: "owner", companyId: "company" });
    }
    expect(manager.getBudget("session")?.usedTokens).toBe(305_000_000);
    expect(quota.checkQuota("session", 1, 0, 3)).toMatchObject({ allowed: false, error: expect.stringContaining("MAX_DEPTH") });
    const queue = new CodeRunQueue({ maxConcurrentPerUser: 1, maxConcurrentPerCompany: 1 });
    const admission = createCodeRunAdmission(queue, new CodeRunRateLimiter());
    const ticket = { workspaceId: auth.workspaceId, userId: "owner", companyId: "company", sessionId: "session" };
    const lease = await admission.admit(ticket);
    expect(admission.canAdmit(ticket)).toBe(false);
    const controller = new AbortController();
    const waiting = admission.admit({ ...ticket, sessionId: "other" }, { signal: controller.signal });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "queue_cancelled" });
    controller.abort(); await rejected; lease.release();
    expect(admission.canAdmit(ticket)).toBe(true);
  });

  it("ignores legacy route/key/IP/upload limits without touching Redis counters", async () => {
    const guard = new RouteGuardTiers({ free: { maxRequestsPerMinute: 1, burstAllowance: 0 } });
    const api = new ProjectApiRateLimiter();
    const limits = { upload: { limit: 1, windowMs: 60_000 }, download: { limit: 1, windowMs: 60_000 }, delete: { limit: 1, windowMs: 60_000 } };
    const storage = new InMemoryStorageProtection(limits);
    // A disabled usage check must not connect to Redis or increment old windows.
    const redis = new RedisStorageProtection("redis://127.0.0.1:1", limits);
    for (let i = 0; i < 305; i++) {
      const status = guard.checkRateLimit("same-client", "free");
      expect(status.allowed).toBe(true);
      expect(RouteGuardTiers.formatHeaders(status)).toEqual({});
      expect(api.check("same-key-and-ip", 1).allowed).toBe(true);
      for (const action of ["upload", "download", "delete"] as const) {
        await storage.consume(auth, action); await redis.consume(auth, action);
      }
    }
    await redis.close();
  });

  it.each([105, 200])("serves %i sequential project-context CHAT requests without a code slot", async count => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Quota test company" }, "quota-test-company");
    const { project } = await store.createProject(auth, company.id, { name: "Quota test project", type: "code_project" }, "quota-test-project");
    const ai = {
      chat: async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 0.99, targets: [] }) }),
      async *stream() { yield "Hello."; },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}),
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" as const }),
    } satisfies AIEngine;
    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const acquire = vi.spyOn(CodeRunQueue.prototype, "acquire");
    {
      const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
      try {
        for (let i = 0; i < count; i++) {
          const result = await app.inject({ method: "POST", url: "/chat/stream", payload: {
            message: "Hello, explain this conversation without changing anything.",
            contextType: "project", companyId: company.id, projectId: project.id, noMemory: true,
          } });
          expect(result.statusCode).toBe(200);
          expect(result.body).toContain("event: result");
          expect(result.body).not.toContain("event: error");
        }
      } finally { await app.close(); }
    }
    expect(acquire).not.toHaveBeenCalled();
  });
});

it("performs 305 exact capabilities and creates 205 companies/projects/agents without entity allowances", async () => {
  const store = new InMemoryWorkspaceStore();
  let company = await store.createCompany(auth, { name: "Capabilities" }, "cap-company");
  const agent = await store.createCompanyAgent(auth, company.id, { name: "Main", role: "Coordinator", tools: ["project.data.rows.update"], isActive: true }, "cap-agent");
  company = await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
  const { project } = await store.createProject(auth, company.id, { name: "Data project", type: "code_project", dataBackendId: "backend" }, "cap-project");
  const execute = vi.fn(async () => ({ updated: true }));
  const runtime = new CompanyDelegationRuntime(store, { chat: async () => { throw Error("No planning"); } } as unknown as AIEngine, 10_000, { execute });
  for (let i = 0; i < 305; i++) {
    const result = await runtime.executeChatProjectTool(auth, company.id, project.id, "project.data.rows.update", { projectId: project.id, collection: "products", id: "row-1", row: { name: String(i) } }, "call-" + i);
    expect(result.output).toEqual({ updated: true });
  }
  expect(execute).toHaveBeenCalledTimes(305);
  await expect(runtime.executeChatProjectTool(auth, company.id, project.id, "project.data.rows.delete", { projectId: project.id }, "forbidden")).rejects.toMatchObject({ code: "TOOL_FORBIDDEN" });
  for (let i = 0; i < 205; i++) {
    const c = await store.createCompany(auth, { name: "Disposable " + i }, "company-" + i);
    await store.createProject(auth, company.id, { name: "Site " + i, type: "website" }, "project-" + i);
    await store.createCompanyAgent(auth, company.id, { name: "Agent " + i, role: "Worker" }, "agent-" + i);
  }
});

it("does not restore persisted daily email or monthly AI allowances on reconstruction", async () => {
  const repo = new EmailInboxRepository();
  const account = await repo.createAccount(auth, "email-company", { emailAddress: "test@example.test", rateLimits: { maxPerHour: 1, maxPerDay: 1, maxPerRecipientDaily: 1, maxCompanyPerHour: 1, maxCompanyPerDay: 1, maxFollowups: 3 } });
  for (let i = 0; i < 305; i++) expect(await repo.reserveSendQuota("email-company", account, "same@example.test")).toEqual({ allowed: true });
  const store = new InMemoryWorkspaceStore();
  await store.setUserSetting(auth, "ai.preferences", { addedModels: [], routing: { stopPaidWhenLimitReached: true, monthlyBudgetUsd: 0.01 } }, 0);
  for (let i = 0; i < 2; i++) expect((await new AIPreferencesStore(store).get(auth)).routing.stopPaidWhenLimitReached).toBe(false);
});

it("accepts operations with more than 1000 historical Inbox/process records without deleting idempotency history", () => {
 const now = new Date();
 const message = applyCodeInbox(emptyCodeInbox(), {kind:"submit",id:"m",requestId:"r",authorId:"owner",text:"a".repeat(2100),mode:"queue"},[],now).state.messages[0]!;
 const state = {...emptyCodeInbox(), messages:Array.from({length:1005},(_,i)=>({...message,id:"old-"+i,requestId:"old-request-"+i,status:"discarded" as const}))};
 const after = applyCodeInbox(state,{kind:"submit",id:"new",requestId:"new-request",authorId:"owner",text:"New operation",mode:"queue"},[],now);
 expect(after.state.messages).toHaveLength(1006);
 expect(after.state.messages[0]).toEqual(state.messages[0]);
 const scope={companyId:"c",projectId:"p",sessionId:"s",dataClassification:"internal" as const,retentionClass:"standard" as const};
 const leases=[{runId:"run",sessionId:"s",owner:"owner",live:true,terminal:false}];
 const reserve={kind:"reserve" as const,operationId:"o",processId:"p",executionKey:JSON.stringify(["c","p","s","run","o"]),payloadHash:"hash",runId:"run",owner:"owner",agentId:"agent",startedRevision:1};
 const initial=applyCodeProcess({operations:[],cleanupToken:null},scope,reserve,leases,now).result.operations[0]!;
 const processes:CodeProcessProjectState={operations:Array.from({length:1005},(_,i)=>({...initial,operationId:"old-"+i,processId:"old-process-"+i,executionKey:JSON.stringify(["c","p","s","run",String(i)]),state:"completed" as const})),cleanupToken:null};
 const result=applyCodeProcess(processes,scope,reserve,leases,now);
 expect(result.result.operations).toHaveLength(1006);
 expect(result.result.operations[0]).toEqual(processes.operations[0]);
});

it("does not enforce legacy fair shares, RPM windows or persisted database usage allowances", async () => {
 const router=new QuotaShareRouter();router.setTenantShare("tenant","starter",1);
 const leases=new AtomicRpmLeaseManager();
 const provider=new PostgresDataProvider({maxCollections:1,maxFields:1,maxQueriesPerMinute:1,maxDatabaseBytes:1});
 const schema={tables:[{name:"existing",columns:[{name:"a",type:"text",nullable:true}],constraints:[],indexes:[],rlsEnabled:false,rlsForced:false,policies:[]}]};
 for(let i=0;i<305;i++) {
  expect(router.isAdmitted("tenant",1000,1).admitted).toBe(true);
  const lease=leases.acquireLease({provider:"fixture",maxRpm:1});expect(lease.granted).toBe(true);
  expect(()=>provider.assertLimits("create_collection",schema,1000000)).not.toThrow();
  expect(()=>provider.assertLimits("add_field",schema,1000000,"existing")).not.toThrow();
 }
 // The quota helper must not even load a persisted allowance. Authorization
 // continues to belong to the calling Data Studio / gateway operation.
 const quotas=new QuotaService({} as never,{} as never);
 await expect(quotas.assertWritesAllowed({} as never,"prod")).resolves.toBeUndefined();
});
it("allows more than 256 authorized child continuations and retains idempotency identities", () => {
 const scope={companyId:"c",projectId:"p",sessionId:"s",dataClassification:"internal" as const,retentionClass:"standard" as const};
 const now=new Date(),parent=[{runId:"parent",sessionId:"s",owner:"owner",live:true,terminal:false}];
 let state=applyCodeProcess({operations:[],cleanupToken:null},scope,{kind:"reserve-child",operationId:"child-op",childRunId:"child",toolCallId:"spawn",agentType:"worker",runId:"parent",owner:"owner"},parent,now).state;
 state.operations[0]!.state="interrupted";
 const child=[{runId:"child",sessionId:"s",owner:"child-owner",live:true,terminal:false}];
 for(let i=0;i<305;i++) state=applyCodeProcess(state,scope,{kind:"continue-child",childRunId:"child",owner:"child-owner",requestId:"request-"+i},child,now).state;
 expect(state.operations[0]!.child?.continueRequestIds).toHaveLength(305);
 const replay=applyCodeProcess(state,scope,{kind:"continue-child",childRunId:"child",owner:"child-owner",requestId:"request-0"},child,now);
 expect(replay.result.claimed).toBe(false);
 expect(replay.state.operations[0]!.child?.continueRequestIds).toHaveLength(305);
 expect(()=>applyCodeProcess(state,scope,{kind:"continue-child",childRunId:"child",owner:"foreign",requestId:"forged"},child,now)).toThrow("process_lease_lost");
});
