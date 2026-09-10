import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import { AuthenticationError } from "../apps/agent-api/src/auth";
import { ApiKeysRepository } from "../apps/agent-api/src/api-keys-repository";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { registerScopedMemoryRoutes } from "../apps/agent-api/src/scoped-memory-routes";
import { ScopedMemoryEngine } from "../apps/agent-api/src/scoped-memory";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));

function ai(chat=vi.fn(async()=>({content:"ok",model:"auto"}))):AIEngine {
  return {
    chat, async *stream(){yield "";}, listModels:async()=>[], getModel:async()=>undefined,
    executeTool:async()=>({}), searchMemory:async()=>[], saveMemory:async()=>undefined,
    getCapabilities:async()=>["chat"], healthCheck:async()=>({status:"ok"}),
    ensureA2AEnabled:async()=>undefined,
    a2aSend:async()=>({taskId:"scope-plan",content:'{"mode":"single","agentIds":[],"toolRequests":[]}',metadata:{}}),
    ensureCombo:async input=>({name:input.name}),
  };
}

describe("Production scoped memory",()=>{
  it("enforces API-key scopes and isolates the same session id between keys",async()=>{
    const store=new InMemoryWorkspaceStore();
    await store.initialize();
    const owner={workspaceId:"tenant-a",userId:"owner-a",permissions:["workspace:read","workspace:write","business:manage"]};
    const company=await store.createCompany(owner,{name:"Scoped Co"},"scope-company");
    const keys=new ApiKeysRepository();
    const keyA=await keys.createApiKey({companyId:company.id,tenantId:owner.workspaceId,ownerUserId:owner.userId,name:"A",scopes:["memory:read","memory:write"]});
    const keyB=await keys.createApiKey({companyId:company.id,tenantId:owner.workspaceId,ownerUserId:owner.userId,name:"B",scopes:["memory:read","memory:write"]});
    const readOnly=await keys.createApiKey({companyId:company.id,tenantId:owner.workspaceId,ownerUserId:owner.userId,name:"read",scopes:["memory:read"]});
    const memory=new ScopedMemoryEngine();
    const app=Fastify();
    apps.push(app);
    app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof AuthenticationError?error.status:500).send({error:{code:(error as any).code,message:error.message}}));
    registerScopedMemoryRoutes(app,{engine:memory,apiKeys:keys,store,runtime:{} as CompanyDelegationRuntime});
    const headers=(token:string)=>({"x-npati-api-key":token,"content-type":"application/json"});
    const create=async(token:string,code:string)=>app.inject({method:"POST",url:"/company-api/memory",headers:headers(token),payload:{sessionId:"shared-session",title:"Private code",content:code}});
    const a=await create(keyA.rawToken,"ALPHA-7391");
    const b=await create(keyB.rawToken,"BETA-5512");
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((await create(readOnly.rawToken,"DENIED")).statusCode).toBe(403);
    const listA=await app.inject({method:"GET",url:"/company-api/memory?sessionId=shared-session",headers:headers(keyA.rawToken)});
    const listB=await app.inject({method:"GET",url:"/company-api/memory?sessionId=shared-session",headers:headers(keyB.rawToken)});
    expect(JSON.stringify(listA.json())).toContain("ALPHA-7391");
    expect(JSON.stringify(listA.json())).not.toContain("BETA-5512");
    expect(JSON.stringify(listB.json())).toContain("BETA-5512");
    expect(JSON.stringify(listB.json())).not.toContain("ALPHA-7391");
    const deniedDelete=await app.inject({method:"DELETE",url:"/company-api/memory/"+b.json().memory.id+"?sessionId=shared-session",headers:{"x-npati-api-key":keyA.rawToken}});
    expect(deniedDelete.statusCode).toBe(404);
  });

  it("injects only the requested API-key/session memory into the Main Agent model call",async()=>{
    const store=new InMemoryWorkspaceStore();
    await store.initialize();
    const context={workspaceId:"tenant-runtime",userId:"owner-runtime",permissions:["workspace:read","business:manage"],apiKeyId:"key-alpha"};
    const company=await store.createCompany(context,{name:"Injection Co"},"inject-company");
    const main=await store.createCompanyAgent(context,company.id,{name:"Main",role:"Manager",tools:["Knowledge"]},"inject-main");
    await store.setCompanyMainAgent(context,company.id,main.id,company.revision);
    const chat=vi.fn(async(input:any)=>({content:input.messages.at(-1).content.includes("SESSION-7391")?"SESSION-7391":"missing",model:"auto"}));
    const retrieve=vi.fn(async(_ctx,_companyId,_query,scope)=>({
      chunks:[],
      memories:scope?.apiKeyId==="key-alpha"&&scope?.sessionId==="session-a"?[{content:"Scoped fact: SESSION-7391"}]:[],
    }));
    const runtime=new CompanyDelegationRuntime(store,ai(chat),5_000,undefined,retrieve);
    const result=await runtime.execute(context,company.id,{task:"What is my scoped fact?",memoryScope:{apiKeyId:"key-alpha",sessionId:"session-a"}},"inject-run");
    expect(result.run.result).toBe("SESSION-7391");
    expect(retrieve).toHaveBeenCalledWith(context,company.id,"What is my scoped fact?",{apiKeyId:"key-alpha",sessionId:"session-a"});
    expect(JSON.stringify(chat.mock.calls)).toContain("Relevant Company Memory");
    expect(JSON.stringify(chat.mock.calls)).toContain("SESSION-7391");
  });

  it("makes idempotent writes stable and prevents cross-key deletes",async()=>{
    const engine=new ScopedMemoryEngine();
    const base={companyId:"company",tenantId:"tenant",apiKeyId:"key-a",title:"Rule",content:"CODE-1",idempotencyKey:"same-write"};
    const first=await engine.storeMemory(base);
    const duplicate=await engine.storeMemory(base);
    expect(duplicate.id).toBe(first.id);
    expect(await engine.deleteMemory({id:first.id,companyId:"company",tenantId:"tenant",apiKeyId:"key-b"})).toBe(false);
    expect(await engine.deleteMemory({id:first.id,companyId:"company",tenantId:"tenant",apiKeyId:"key-a"})).toBe(true);
  });
});
