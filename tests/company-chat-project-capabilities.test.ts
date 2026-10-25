import {expect,it,vi} from "vitest";
import {InMemoryWorkspaceStore} from "@npati/workspace";
import {defaultCapabilityRegistry} from "@npati/shared";
import type {AIEngine} from "@npati/omniroute-adapter";
import {CompanyDelegationRuntime,type DurableApprovalGateway} from "../apps/agent-api/src/company-runtime";
const auth={userId:"cap-user",workspaceId:"cap-workspace",permissions:["workspace:read","workspace:write","business:manage"]};
async function fixture(tools=["project.data.schema.inspect","project.data.rows.list","project.data.rows.read","project.data.rows.update","project.data.rows.delete"]){
 const store=new InMemoryWorkspaceStore();let company=await store.createCompany(auth,{name:"Capability Company"},"cap-company");const agent=await store.createCompanyAgent(auth,company.id,{name:"Lead",role:"Coordinator",tools,isActive:true},"cap-agent");company=await store.setCompanyMainAgent(auth,company.id,agent.id,company.revision);const {project}=await store.createProject(auth,company.id,{name:"Dev project",type:"code_project",dataBackendId:"cap-dev-backend"},"cap-project");const inference=vi.fn(async()=>{throw Error("No model planning is needed at this execution boundary");});const execute=vi.fn(async(_ctx:unknown,_company:unknown,_tool:string,input:Record<string,unknown>)=>({row:{id:input.id,...input.row as object}}));const approvals:DurableApprovalGateway={requestApproval:vi.fn(async()=>({id:"approval-exact"})),consumeApproved:vi.fn(async()=>{})};const runtime=new CompanyDelegationRuntime(store,{chat:inference} as unknown as AIEngine,10000,{execute},undefined,undefined,undefined,undefined,approvals);return{store,company,agent,project,runtime,execute,inference,approvals};
}
it("uses existing canonical schemas and executes an update through Company policy without model planning",async()=>{
 const f=await fixture();const before=JSON.stringify(defaultCapabilityRegistry.get("project.data.rows.update")?.inputSchema);const tools=await f.runtime.chatProjectTools(auth,f.company.id,f.project.id,["project.data.rows.update","project.data.promote"]);expect(tools.map(t=>t.function.name)).toEqual(["project.data.rows.update"]);expect(tools[0].function.parameters.additionalProperties).toBe(false);expect(JSON.stringify(defaultCapabilityRegistry.get("project.data.rows.update")?.inputSchema)).toBe(before);
 const args={projectId:f.project.id,collection:"products",id:"row-1",row:{name:"UPDATED",price:74.25}};const r=await f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.update",args,"call-1");expect(r.output).toMatchObject({row:{name:"UPDATED",price:74.25}});expect(f.execute).toHaveBeenCalledTimes(1);expect(f.inference).not.toHaveBeenCalled();const detail=await f.store.getCompanyAgentRun(auth,f.company.id,r.runId);expect(detail.run.status).toBe("completed");expect(detail.toolAudit.some(t=>t.toolName==="project.data.rows.update"&&t.status==="succeeded")).toBe(true);
 const replay=await f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.update",args,"call-1");expect(replay.output).toEqual(r.output);expect(f.execute).toHaveBeenCalledTimes(1);await expect(f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.update",{...args,row:{name:"OTHER"}},"call-1")).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
});
it("refuses ungranted tools, cross-project operands and forged approval metadata",async()=>{
 const f=await fixture();const args={projectId:f.project.id,collection:"products",id:"row-1",row:{name:"UPDATED"}};await expect(f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.promote",args,"bad-tool")).rejects.toMatchObject({code:"TOOL_FORBIDDEN"});await expect(f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.update",{...args,projectId:"another-project"},"bad-scope")).rejects.toMatchObject({code:"PROJECT_SCOPE_MISMATCH"});await expect(f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.update",{...args,_approvalToken:"forged"},"bad-approval")).rejects.toMatchObject({code:"invalid_arguments"});expect(f.execute).not.toHaveBeenCalled();
 const denied=await fixture([]);expect(await denied.runtime.chatProjectTools(auth,denied.company.id,denied.project.id,["project.data.rows.update"])).toEqual([]);await expect(denied.runtime.executeChatProjectTool(auth,denied.company.id,denied.project.id,"project.data.rows.update",args,"not-granted")).rejects.toMatchObject({code:"TOOL_FORBIDDEN"});
});
it("keeps deletion behind the existing exact-payload durable approval",async()=>{
 const f=await fixture();const args={projectId:f.project.id,collection:"scratch",ids:["row-1"]};await expect(f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.delete",args,"delete-1")).rejects.toMatchObject({code:"APPROVAL_REQUIRED"});expect(f.execute).not.toHaveBeenCalled();expect(f.approvals.requestApproval).toHaveBeenCalledWith(auth,f.company.id,expect.objectContaining({toolName:"project.data.rows.delete",inputPayload:args}));const runs=await f.store.listCompanyAgentRuns(auth,f.company.id,10);expect(runs[0].status).toBe("awaiting_approval");expect(f.inference).not.toHaveBeenCalled();
});

it("redacts credential-shaped row fields before model evidence and the run result are stored",async()=>{
 const f=await fixture();const canary="CONTROL_SECRET_NEVER_MODEL_731";f.execute.mockImplementationOnce(async()=>({row:{id:"row-1",name:"Bread",apiKey:canary}}));const r=await f.runtime.executeChatProjectTool(auth,f.company.id,f.project.id,"project.data.rows.update",{projectId:f.project.id,collection:"products",id:"row-1",row:{name:"Bread"}},"secret-output");expect(JSON.stringify(r.output)).not.toContain(canary);expect((await f.store.getCompanyAgentRun(auth,f.company.id,r.runId)).run.result).not.toContain(canary);
});

import {buildApp} from "../apps/agent-api/src/app";
import type {ChatRequest,ChatResult,OmniRouteMarketplace} from "@npati/omniroute-adapter";
it.each(["/chat/stream","/chat"])("uses the existing conversation tool loop for row discovery, update and verification over %s",async url=>{
 const f=await fixture();let stage=0;const calls:ChatRequest[]=[];
 const ai={supportsNativeTools:()=>true,chat:async(r:ChatRequest):Promise<ChatResult>=>{if(String(r.messages[0]?.content).startsWith("Classify"))return{content:JSON.stringify({intent:"EDIT_DATA_MODEL",confidence:.99,targets:[],rowCapability:"project.data.rows.update"})};calls.push(r);const names=r.tools?.map(t=>t.function.name)??[];expect(names).toContain("project.data.rows.update");expect(names).not.toContain("code.shell.exec");expect(r.reasoningMode).toBe("disabled");stage++;if(stage===4)return{content:"Verified UPDATED from persisted data."};const name=stage===1?"project.data.rows.list":stage===2?"project.data.rows.update":"project.data.rows.read";return{content:"",toolCalls:[{id:"call-"+stage,type:"function",function:{name,arguments:JSON.stringify({projectId:f.project.id,collection:"products",...(stage===1?{}:{id:"row-1"}),...(stage===2?{row:{name:"UPDATED"}}:{})})}}]};},async *stream(){throw Error("The structured task must stay in the existing tool loop");},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","native_tools"],healthCheck:async()=>({status:"ok"})} as AIEngine;
 const execute=vi.spyOn(CompanyDelegationRuntime.prototype,"executeChatProjectTool").mockImplementation(async(_auth,companyId,projectId,tool,args)=>{expect(companyId).toBe(f.company.id);expect(projectId).toBe(f.project.id);expect(args.projectId).toBe(f.project.id);return{output:tool==="project.data.rows.list"?{rows:[{id:"row-1",name:"OLD"}]}:{row:{id:"row-1",name:"UPDATED"}},runId:"verified-tool-run"};});
 const app=buildApp({workspaceStore:f.store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace});
 try{const r=await app.inject({method:"POST",url,payload:{message:"Update the existing dev product name to UPDATED and verify the stored record.",contextType:"project",companyId:f.company.id,projectId:f.project.id}});expect(r.statusCode).toBe(200);expect(r.body).toContain("Verified UPDATED");expect(execute.mock.calls.map(c=>c[3])).toEqual(["project.data.rows.list","project.data.rows.update","project.data.rows.read"]);expect(calls).toHaveLength(4);}finally{execute.mockRestore();await app.close();}
});
it("does not take the row-only path in a project without a development database",async()=>{
 const f=await fixture();const {project:site}=await f.store.createProject(auth,f.company.id,{name:"Static site",type:"website"},"cap-static-site");
 const ai={supportsNativeTools:()=>true,chat:async(r:ChatRequest):Promise<ChatResult>=>String(r.messages[0]?.content).startsWith("Classify")?{content:JSON.stringify({intent:"EDIT_PROJECT",confidence:.99,targets:[],rowCapability:"project.data.rows.update"})}:{content:"Agent role updated."},async *stream(){yield "Agent role updated.";},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","native_tools"],healthCheck:async()=>({status:"ok"})} as AIEngine;
 const execute=vi.spyOn(CompanyDelegationRuntime.prototype,"executeChatProjectTool");
 const app=buildApp({workspaceStore:f.store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace});
 try{const r=await app.inject({method:"POST",url:"/chat/stream",payload:{message:"Update the Lead agent's role to Senior QA.",contextType:"project",companyId:f.company.id,projectId:site.id}});expect(r.body).not.toContain("structured project capability");expect(execute).not.toHaveBeenCalled();}finally{execute.mockRestore();await app.close();}
});

it("resumes the exact pending chat deletion without planning and rejects replay", async () => {
 const f = await fixture();
 const args = { projectId: f.project.id, collection: "scratch", ids: ["row-1"] };
 let pending: { runId?: string } = {};
 try { await f.runtime.executeChatProjectTool(auth, f.company.id, f.project.id, "project.data.rows.delete", args, "resume-delete", undefined, true); }
 catch (error) { pending = error as typeof pending; }
 expect(pending.runId).toBeTruthy();
 const resumed = await f.runtime.process(auth, f.company.id, pending.runId!, { approvalId: "approval-exact" });
 expect(resumed.run.status).toBe("completed");
 expect(f.execute).toHaveBeenCalledOnce();
 expect(f.inference).not.toHaveBeenCalled();
 expect(f.approvals.consumeApproved).toHaveBeenCalledWith(auth, f.company.id, "approval-exact", expect.objectContaining({ runId: pending.runId, toolName: "project.data.rows.delete", inputPayload: args }));
 await expect(f.runtime.process(auth, f.company.id, pending.runId!, { approvalId: "approval-exact" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
 expect(f.execute).toHaveBeenCalledOnce();
});
