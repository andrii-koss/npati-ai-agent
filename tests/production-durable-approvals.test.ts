import Fastify from "fastify";
import {describe,expect,it,vi} from "vitest";
import {InMemoryWorkspaceStore} from "@npati/workspace";
import type {AIEngine} from "@npati/omniroute-adapter";
import {CompanyDelegationRuntime,CompanyRuntimeError,type DurableApprovalGateway} from "../apps/agent-api/src/company-runtime";
import {CompanyToolRuntime} from "../apps/agent-api/src/company-tool-runtime";
import {registerCompanyRuntimeRoutes} from "../apps/agent-api/src/company-runtime-routes";
import {RouteGuardTiers} from "../apps/agent-api/src/route-guard-tiers";
import {CompanyApprovalsRepository,type CompanyApproval} from "../apps/agent-api/src/approvals-repository";

const auth={workspaceId:"approval-ws",userId:"approval-user",permissions:["workspace:read","workspace:write","business:manage"]};

async function fixture(){
  const store=new InMemoryWorkspaceStore();await store.initialize();
  let company=await store.createCompany(auth,{name:"Approval Company"},"approval-company");
  const agent=await store.createCompanyAgent(auth,company.id,{name:"Main",role:"Coordinator",modelId:"auto",tools:["Company Memory"],isActive:true},"approval-agent");
  company=await store.setCompanyMainAgent(auth,company.id,agent.id,company.revision);
  return {store,company,agent};
}

describe("Production durable approvals and route tiers",()=>{
  it("stops a high-risk tool, then consumes one exact approval before execution",async()=>{
    const {store,company,agent}=await fixture();
    const remove=vi.fn(async()=>true);
    const toolRuntime=new CompanyToolRuntime({executeTool:vi.fn()} as unknown as AIEngine,undefined,undefined,undefined,{
      memories:vi.fn(async()=>[]),getMemory:vi.fn(),searchMemories:vi.fn(async()=>[]),addMemory:vi.fn(),updateMemory:vi.fn(),deleteMemory:remove,
    });
    const approvalId="11111111-1111-4111-8111-111111111111";
    let consumed=false;
    const approvals:DurableApprovalGateway={
      requestApproval:vi.fn(async()=>({id:approvalId})),
      consumeApproved:vi.fn(async(_ctx,_company,id,input)=>{
        if(id!==approvalId||input.inputPayload.id!=="memory-1")throw Object.assign(new Error("Approval context or payload does not match"),{code:"APPROVAL_INVALID",status:409});
        if(consumed)throw Object.assign(new Error("Approval has already been consumed"),{code:"APPROVAL_ALREADY_USED",status:409});
        consumed=true;
      }),
    };
    const ai={
      executeTool:vi.fn(),ensureA2AEnabled:vi.fn(),ensureCombo:vi.fn(async input=>({name:input.name})),
      a2aSend:vi.fn(async()=>({taskId:"plan",content:JSON.stringify({mode:"single",agentIds:[agent.id],toolRequests:[{agentId:agent.id,tool:"storage.company_memory",input:{operation:"delete",id:"memory-1"}}]}),metadata:{}})),
      chat:vi.fn(async()=>({content:"done",model:"auto"})),
    } as unknown as AIEngine;
    const runtime=new CompanyDelegationRuntime(store,ai,10_000,toolRuntime,undefined,undefined,undefined,undefined,approvals);
    const first=await runtime.execute(auth,company.id,{task:"Delete memory one"},"approval-run");
    expect(first.run.errorCode).toBe("APPROVAL_REQUIRED");expect(remove).not.toHaveBeenCalled();
    expect((await runtime.process(auth,company.id,first.run.id)).run.status).toBe("awaiting_approval");
    expect(ai.a2aSend).toHaveBeenCalledOnce();
    vi.mocked(ai.a2aSend!).mockRejectedValueOnce(new Error("Approval resume must not replan"));
    const resumed=await runtime.process(auth,company.id,first.run.id,{approvalId});
    expect(resumed.run.status).toBe("completed");expect(remove).toHaveBeenCalledOnce();
    await expect(runtime.process(auth,company.id,first.run.id,{approvalId})).rejects.toMatchObject({code:"APPROVAL_INVALID",status:409});
    expect(remove).toHaveBeenCalledOnce();
    expect((await runtime.process(auth,company.id,first.run.id)).run.status).toBe("completed");
    expect(ai.a2aSend).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect((await store.getCompanyAgentRun(auth,company.id,first.run.id)).run.status).toBe("completed");
  });

  it.each(["cancelled", "failed"] as const)("does not replay a %s run", async (status) => {
    const { store, company } = await fixture();
    const ai = { a2aSend: vi.fn(), chat: vi.fn(), executeTool: vi.fn() } as unknown as AIEngine;
    const runtime = new CompanyDelegationRuntime(store, ai);
    const created = await runtime.create(auth, company.id, { task: "A terminal task" }, "terminal-" + status);
    await store.updateCompanyAgentRun(auth, company.id, created.run.id, { status, errorCode: "ORIGINAL_REASON" });
    expect((await runtime.process(auth, company.id, created.run.id)).run).toMatchObject({ status, errorCode: "ORIGINAL_REASON" });
    expect(ai.a2aSend).not.toHaveBeenCalled();
    expect(ai.chat).not.toHaveBeenCalled();
    expect(ai.executeTool).not.toHaveBeenCalled();
  });
  it("preserves typed approval conflicts through the HTTP resume route", async () => {
    const app = Fastify();
    const process = vi.fn(async () => { throw new CompanyRuntimeError("APPROVAL_INVALID", "Run is not awaiting approval", 409); });
    registerCompanyRuntimeRoutes(app, { process } as unknown as CompanyDelegationRuntime, { authenticate: async () => auth });
    try {
      const response = await app.inject({ method: "POST", url: "/companies/company-1/runs/run-1/resume", payload: { approvalId: "11111111-1111-4111-8111-111111111111" } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "APPROVAL_INVALID" } });
      expect(process).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each(["model_unavailable", "model_routing_failed"])("returns HTTP 503 for %s rather than reporting successful admission", async (code) => {
    const app = Fastify();
    const execute = vi.fn(async () => ({ run: { id: "run-1", status: "failed", errorCode: code }, toolAudit: [] }));
    registerCompanyRuntimeRoutes(app, { execute } as unknown as CompanyDelegationRuntime, { authenticate: async () => auth });
    try {
      const response = await app.inject({ method: "POST", url: "/companies/company-1/runs", headers: { "idempotency-key": "model-failure-01" }, payload: { task: "A task" } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ run: { status: "failed", errorCode: code } });
    } finally { await app.close(); }
  });
  it("enforces the configured route tier and emits standard rate-limit headers",async()=>{
    const app=Fastify();
    const runtime={list:vi.fn(async()=>[])} as unknown as CompanyDelegationRuntime;
    const authProvider={authenticate:vi.fn(async()=>auth)};
    const guard=new RouteGuardTiers({pro:{maxRequestsPerMinute:1,burstAllowance:0}});
    registerCompanyRuntimeRoutes(app,runtime,authProvider,undefined,guard);
    const first=await app.inject({method:"GET",url:"/companies/company-1/runs"});
    expect(first.statusCode).toBe(200);expect(first.headers["x-ratelimit-tier"]).toBe("pro");
    const limited=await app.inject({method:"GET",url:"/companies/company-1/runs"});
    expect(limited.statusCode).toBe(429);expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("expires pending approvals and atomically rejects replay after consumption",async()=>{
    const base:CompanyApproval={id:"approval-id",workspaceId:auth.workspaceId,companyId:"company-1",userId:auth.userId,
      runId:"run-1",agentId:"agent-1",toolName:"storage.company_memory.delete",riskLevel:"critical",actionSummary:"delete",
      inputPayload:{operation:"delete",id:"memory-1"},payloadHash:new (await import("@npati/shared")).RiskApprovalService().computePayloadHash({operation:"delete",id:"memory-1"}),
      status:"pending",requestedAt:new Date(Date.now()-10_000).toISOString(),expiresAt:new Date(Date.now()-1_000).toISOString()};
    const expiredRepo=new CompanyApprovalsRepository("postgres://unused");
    (expiredRepo as any).pool={query:vi.fn().mockResolvedValueOnce({rows:[base]}).mockResolvedValueOnce({rows:[]})};
    await expect(expiredRepo.decide(auth,"company-1",base.id,"approved")).rejects.toMatchObject({code:"APPROVAL_EXPIRED"});

    const approved={...base,status:"approved" as const,expiresAt:new Date(Date.now()+60_000).toISOString(),consumedAt:new Date().toISOString()};
    const repo=new CompanyApprovalsRepository("postgres://unused");
    (repo as any).pool={query:vi.fn().mockResolvedValueOnce({rows:[approved]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[approved]})};
    await expect(repo.consumeApproved(auth,"company-1",base.id,{runId:"run-1",agentId:"agent-1",toolName:base.toolName,inputPayload:base.inputPayload})).resolves.toMatchObject({status:"approved"});
    await expect(repo.consumeApproved(auth,"company-1",base.id,{runId:"run-1",agentId:"agent-1",toolName:base.toolName,inputPayload:base.inputPayload})).rejects.toMatchObject({code:"APPROVAL_ALREADY_USED"});
  });
});
