import {expect,it,vi} from "vitest";
import type {AIEngine, ChatRequest, OmniRouteMarketplace} from "@npati/omniroute-adapter";
import {InMemoryWorkspaceStore,type AuthContext} from "@npati/workspace";
import {buildApp} from "../apps/agent-api/src/app";
const auth:AuthContext={userId:"internal-audit-user",workspaceId:"internal-audit-workspace",permissions:["workspace:read","workspace:write","business:manage"]};
it.each(["Show Activity & Run Trace and actual errors for Test Bakery", "Read automation execution history for Test Bakery", "Read the inbox for Test Bakery"])("does not run implicit external research for an internal operation: %s",async message=>{
 const store=new InMemoryWorkspaceStore();const company=await store.createCompany(auth,{name:"Test Bakery"},"internal-audit-company");
 const content=(r:ChatRequest)=>String(r.messages[0]?.content).startsWith("Classify")?JSON.stringify({intent:"CHAT",confidence:1,targets:[]}):"NO_ACTION";
 const ai={supportsNativeTools:()=>false,chat:async(r:ChatRequest)=>({content:content(r)}),async *stream(r:ChatRequest){yield content(r);},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","streaming"],healthCheck:async()=>({status:"ok"})} as AIEngine;
 const run=vi.fn(async()=>({kind:"web_search",context:"irrelevant public data",sources:[]}));
 const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace,webResearch:{shouldResearch:()=>true,run} as any});
 try{const response=await app.inject({method:"POST",url:"/chat/stream",payload:{message,contextType:"company",companyId:company.id}});expect(response.statusCode).toBe(200);expect(run).not.toHaveBeenCalled();expect(response.body).not.toContain("irrelevant public data");}finally{await app.close();}
});
