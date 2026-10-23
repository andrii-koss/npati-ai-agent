import {expect,it,vi} from "vitest";
import type {AIEngine, ChatRequest, OmniRouteMarketplace} from "@npati/omniroute-adapter";
import {InMemoryWorkspaceStore,type AuthContext} from "@npati/workspace";
import {buildApp} from "../apps/agent-api/src/app";
const auth:AuthContext={userId:"internal-audit-user",workspaceId:"internal-audit-workspace",permissions:["workspace:read","workspace:write","business:manage"]};
it.each([false,true].flatMap(native => ["Show Activity & Run Trace and actual errors for Test Bakery. Do not treat completed as proof that the website works.", "Read automation execution history for Test Bakery", "Read the inbox for Test Bakery"].map(message=>({native,message}))))("does not run implicit external research for internal operation: $message (native=$native)",async ({native,message})=>{
 const store=new InMemoryWorkspaceStore();const company=await store.createCompany(auth,{name:"Test Bakery"},"internal-audit-company");
 const content=(r:ChatRequest)=>String(r.messages[0]?.content).startsWith("Classify")?JSON.stringify({intent:"CHAT",confidence:1,targets:[]}):"NO_ACTION";
 const ai={supportsNativeTools:()=>native,chat:async(r:ChatRequest)=>{expect(r.tools?.some(t=>["web_search","web_fetch"].includes(t.function.name))).not.toBe(true);return {content:content(r)};},async *stream(r:ChatRequest){yield content(r);},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","streaming"],healthCheck:async()=>({status:"ok"})} as AIEngine;
 const run=vi.fn(async()=>({kind:"web_search",context:"irrelevant public data",sources:[]}));
 const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace,webResearch:{shouldResearch:()=>true,run} as any});
 try{const response=await app.inject({method:"POST",url:"/chat/stream",payload:{message,contextType:"company",companyId:company.id}});expect(response.statusCode).toBe(200);expect(run).not.toHaveBeenCalled();expect(response.body).not.toContain("irrelevant public data");}finally{await app.close();}
});

it("reads a switched company's authorized agent names without a mutation planner",async()=>{
 const store=new InMemoryWorkspaceStore();const company=await store.createCompany(auth,{name:"Read Switch Studio"},"read-switch-studio");const agent=await store.createCompanyAgent(auth,company.id,{name:"Designer",role:"Lead"},"read-switch-designer");await store.setCompanyMainAgent(auth,company.id,agent.id,company.revision);
 const captured:ChatRequest[]=[];const content=(r:ChatRequest)=>{captured.push(r);if(String(r.messages[0]?.content).startsWith("Classify"))return JSON.stringify({intent:"CHAT",confidence:1,targets:[]});expect(JSON.stringify(r.messages)).toContain("Designer");expect(String(r.messages[0]?.content)).not.toContain("Return only one complete company-action");return "Read Switch Studio: Designer";};
 const ai={supportsNativeTools:()=>false,chat:async(r:ChatRequest)=>({content:content(r)}),async *stream(r:ChatRequest){yield content(r);},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","streaming"],healthCheck:async()=>({status:"ok"})} as AIEngine;
 const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace});
 try{const before=await store.getCompany(auth,company.id);const r=await app.inject({method:"POST",url:"/chat/stream",payload:{message:'Switch to company "Read Switch Studio". Tell me its agent names; do not create anything.',contextType:"company",companyId:company.id}});expect(r.statusCode).toBe(200);expect(r.body).toContain("Read Switch Studio: Designer");expect((await store.getCompany(auth,company.id)).revision).toBe(before.revision);}finally{await app.close();}
});

it("preserves a Spanish research recall instead of planning a resume mutation",async()=>{
 const store=new InMemoryWorkspaceStore();const company=await store.createCompany(auth,{name:"Recall Bakery"},"recall-bakery");const conversation=await store.createNeutralConversation(auth,"Research recall");await store.appendNeutralMessage(auth,conversation.id,"assistant","Earlier navigation findings: Apple, Samsung and Google.");
 const answer="Apple, Samsung y Google: observaciones anteriores, dos recomendaciones de navegacion.";let planners=0;
 const ai={supportsNativeTools:()=>false,chat:async(r:ChatRequest)=>{if(String(r.messages[0]?.content).startsWith("Classify"))return{content:JSON.stringify({intent:"CHAT",confidence:1,targets:[]})};planners++;return{content:"NO_ACTION"};},async *stream(){yield answer;},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","streaming"],healthCheck:async()=>({status:"ok"})} as AIEngine;
 const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace});
 try{const r=await app.inject({method:"POST",url:"/chat/stream",payload:{message:"Vuelve al analisis anterior de Apple, Samsung y Google. Sin buscar otra vez, resume dos decisiones de navegacion para nuestra panaderia.",conversationId:conversation.id,contextType:"company",companyId:company.id}});expect(r.statusCode).toBe(200);expect(r.body).toContain(answer);expect(planners).toBe(0);}finally{await app.close();}
});
