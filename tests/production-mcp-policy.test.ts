import Fastify from "fastify";
import {afterEach,describe,expect,it,vi} from "vitest";
import {InMemoryWorkspaceStore} from "@npati/workspace";
import type {AIEngine} from "@npati/omniroute-adapter";
import {ApiKeysRepository} from "../apps/agent-api/src/api-keys-repository";
import {CompanyToolRuntime} from "../apps/agent-api/src/company-tool-runtime";
import {registerMcpPolicyRoutes} from "../apps/agent-api/src/mcp-policy-routes";

const apps:Array<{close():Promise<void>}>=[];afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));

describe("Production MCP deny-by-default policy",()=>{
  it("requires API-key mcp:read scope and permits only the safe MCP allowlist",async()=>{
    const store=new InMemoryWorkspaceStore();await store.initialize();
    const owner={workspaceId:"mcp-ws",userId:"mcp-owner",permissions:["workspace:read","workspace:write","business:manage"]};
    const company=await store.createCompany(owner,{name:"MCP Company"},"mcp-company");
    const keys=new ApiKeysRepository();
    const allowed=await keys.createApiKey({companyId:company.id,tenantId:owner.workspaceId,ownerUserId:owner.userId,name:"read",scopes:["mcp:read"]});
    const denied=await keys.createApiKey({companyId:company.id,tenantId:owner.workspaceId,ownerUserId:owner.userId,name:"chat",scopes:["chat:write"]});
    const mcpCall=vi.fn(async()=>({healthy:true}));
    const tools=new CompanyToolRuntime({executeTool:vi.fn(),mcpCall} as unknown as AIEngine);
    const app=Fastify();apps.push(app);registerMcpPolicyRoutes(app,{apiKeys:keys,store,tools});
    const call=(token:string,name:string)=>app.inject({method:"POST",url:"/company-api/mcp/call",headers:{"x-npati-api-key":token},payload:{name}});

    const noScope=await call(denied.rawToken,"omniroute_get_health");
    expect(noScope.statusCode).toBe(403);expect(noScope.json().error.code).toBe("API_KEY_SCOPE_DENIED");
    const ok=await call(allowed.rawToken,"omniroute_get_health");
    expect(ok.statusCode).toBe(200);expect(ok.json()).toEqual({result:{healthy:true}});
    const unsafe=await call(allowed.rawToken,"omniroute_create_combo");
    expect(unsafe.statusCode).toBe(403);expect(unsafe.json().error.code).toBe("MCP_TOOL_DENIED");
    expect(mcpCall).toHaveBeenCalledTimes(1);
  });

  it("does not let a scoped key cross its Company tenant boundary",async()=>{
    const store=new InMemoryWorkspaceStore();await store.initialize();
    const owner={workspaceId:"mcp-ws-a",userId:"mcp-owner-a",permissions:["workspace:read","workspace:write","business:manage"]};
    const company=await store.createCompany(owner,{name:"Tenant A"},"mcp-company-a");
    const keys=new ApiKeysRepository();
    const key=await keys.createApiKey({companyId:company.id,tenantId:"mcp-ws-b",ownerUserId:owner.userId,name:"forged",scopes:["mcp:read"]});
    const mcpCall=vi.fn(async()=>({healthy:true}));
    const tools=new CompanyToolRuntime({executeTool:vi.fn(),mcpCall} as unknown as AIEngine);
    const app=Fastify();apps.push(app);registerMcpPolicyRoutes(app,{apiKeys:keys,store,tools});
    const response=await app.inject({method:"POST",url:"/company-api/mcp/call",headers:{"x-npati-api-key":key.rawToken},payload:{name:"omniroute_get_health"}});
    expect(response.statusCode).toBe(403);expect(mcpCall).not.toHaveBeenCalled();
  });
});
