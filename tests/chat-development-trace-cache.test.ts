import {describe,expect,it,vi} from "vitest";
import type {AuthContext,CodeRunStateRecord,WorkspaceStore} from "@npati/workspace";
import type {DevelopmentProcess} from "@npati/shared";
import {developmentTrace} from "../apps/agent-api/src/chat-development-trace";
const ctx:AuthContext={workspaceId:"workspace",userId:"owner",permissions:["workspace:read"]};
function fixture(){
 const run={runId:"run",workspaceId:"workspace",companyId:"company",projectId:"project",sessionId:"session",status:"completed",revision:1,details:{},startedAt:new Date(),updatedAt:new Date()} as CodeRunStateRecord;
 const activity=vi.fn(async()=>[]);
 const store={getCodeRunState:vi.fn(async()=>({...run})),listCodeActivityEvents:activity,listCodeRunTurns:vi.fn(async()=>[]),getReplayBundle:vi.fn(async()=>null)} as unknown as WorkspaceStore;
 const process:DevelopmentProcess={id:"process",companyId:"company",projectId:"project",sessionId:"session",runId:"run",name:"Store",framework:"Next.js",status:"completed",hidden:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),progress:[{id:"file",stage:"tool",title:"Original",at:new Date().toISOString(),status:"completed"}]};
 return {run,activity,store,process};
}
describe("completed development trace cache",()=>{
 it("reuses finished transcripts, isolates response mutations and invalidates on persisted revisions",async()=>{
  const f=fixture();
  const first=await developmentTrace(f.store,ctx,f.process);first[0]!.title="mutated client response";
  expect((await developmentTrace(f.store,ctx,f.process))[0]!.title).toBe("Original");
  expect(f.activity).toHaveBeenCalledTimes(1);
  f.run.revision++;
  await developmentTrace(f.store,ctx,f.process);expect(f.activity).toHaveBeenCalledTimes(2);
  f.process.updatedAt="2099-01-01T00:00:00Z";
  await developmentTrace(f.store,ctx,f.process);expect(f.activity).toHaveBeenCalledTimes(3);
 });
 it("always reads live runs and never caches a failed infrastructure read",async()=>{
  const f=fixture();f.run.status="running";f.process.status="running";
  await developmentTrace(f.store,ctx,f.process);await developmentTrace(f.store,ctx,f.process);expect(f.activity).toHaveBeenCalledTimes(2);
  f.run.status="completed";f.process.status="completed";
  f.activity.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(developmentTrace(f.store,ctx,f.process)).rejects.toThrow("database unavailable");
  await developmentTrace(f.store,ctx,f.process);expect(f.activity).toHaveBeenCalledTimes(4);
 });
});
