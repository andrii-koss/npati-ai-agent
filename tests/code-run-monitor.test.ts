import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { monitorCodeRun, type DevelopmentProcessProgressItem as Event } from "@npati/shared";
import { registerCodeMonitorRoutes } from "../apps/agent-api/src/code-monitor-routes";
import type { DevelopmentPorts } from "../apps/agent-api/src/chat-development-service";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import { createCodeRunActivitySink, activitySinkForKind } from "../apps/agent-api/src/code-run-activity-sink";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import { executionResultDetails } from "../apps/agent-api/src/chat-development-trace";
import { InMemoryCodeRunStore } from "../packages/workspace/src/in-memory-code-run-store";
import { encodeCodeRunScanCursor, WorkspaceAccessError } from "@npati/workspace";

const start="2026-10-15T10:00:00.000Z", now=Date.parse(start)+1_200_000;
const run={status:"running",startedAt:start};
const event=(n:number,overrides:Partial<Event>={}):Event=>({id:String(n),at:new Date(Date.parse(start)+n*1000).toISOString(),stage:"tool",title:"Run command",tool:"code.shell.exec",command:"npm run build",status:"completed",...overrides});
describe("confirmed progress and suspicious repetition",()=>{
  it("flags command cycles while allowing three retries and distinct sequential edits",()=>{
    expect(monitorCodeRun([1,2,3].map(n=>event(n)),run,Date.parse(start)+3000).warnings).toEqual([]);
    expect(monitorCodeRun([1,2,3,4].flatMap(n=>[event(n*2),event(n*2+1,{id:"other"+n,command:"ls"})]),run,now).warnings.some(w=>w.label==="Possible Loop")).toBe(true);
    const changes=[1,2,3,4,5].map(n=>event(n,{command:undefined,tool:"code.fs.edit",file:"app.js",diff:"+"+n,linesAdded:1}));
    expect(monitorCodeRun(changes,run,Date.parse(start)+6000).warnings).toEqual([]);
  });
  it("does not confuse reads, dry runs, zero diffs or repeated receipts with new progress",()=>{
    const events=[event(1,{tool:"code.fs.read",command:undefined,file:"app.js"}),event(2,{tool:"code.fs.write",command:undefined,file:"app.js",linesAdded:0,linesRemoved:0}),event(3,{tool:"code.fs.write",file:"app.js",linesAdded:2,dryRun:true})];
    expect(monitorCodeRun(events,run,now)).toMatchObject({lastProgressAt:start,progressId:undefined});
    const write=event(4,{tool:"code.fs.write",file:"app.js",diff:"+hello",linesAdded:1});
    expect(monitorCodeRun([...events,write,{...write,id:"later",at:new Date(now-1000).toISOString()}],run,now)).toMatchObject({progressId:"4",lastProgressAt:write.at});
  });
  it("detects silence and stalls, exempts approvals and gives install/build their longer window",()=>{
    expect(monitorCodeRun([],run,now).warnings.map(w=>w.label)).toEqual(["No Progress","Stalled"]);
    expect(monitorCodeRun([],{...run,status:"waiting_for_user"},now).warnings).toEqual([]);
    expect(monitorCodeRun([1,2,3,4,5].map(n=>event(n,{status:"waiting_for_approval",errorCode:"approval_required"})),{...run,status:"waiting_for_user"},now).warnings).toEqual([]);
    expect(monitorCodeRun([event(0,{status:"running",command:"npm install"})],run,Date.parse(start)+360_000).warnings.map(w=>w.label)).toEqual(["No Progress"]);
    expect(monitorCodeRun([event(0,{status:"running",command:"npm install"})],run,now).warnings.map(w=>w.label)).toContain("Stalled");
    expect(monitorCodeRun([event(1)],{...run,status:"failed",finishedAt:new Date(Date.parse(start)+2000).toISOString()},now).durationMs).toBe(2000);
  });
  it("never counts a nonzero exit, failed QA or an envelope failure as success",()=>{
    for(const result of [{ok:false},{success:false},{tests:{passed:1,failed:1,total:2,skipped:0}},{results:[{ok:false}]},{exitCode:2}]) expect(executionResultDetails(result).status).toBe("failed");
  });
});
function fixture() {
  const ctx={workspaceId:"ws",userId:"user",permissions:["*"]};
  const state={runId:"run",workspaceId:"ws",companyId:"co",projectId:"pr",sessionId:"se",status:"running",startedAt:new Date(start),updatedAt:new Date(start),finishedAt:null,details:{}};
  const store={getCompany:vi.fn().mockResolvedValue({}),listProjectQaReports:vi.fn().mockResolvedValue([]),listCodeRunStates:vi.fn().mockResolvedValue([state]),getCodeRunState:vi.fn().mockResolvedValue(state),getUserSetting:vi.fn().mockResolvedValue(null),listCodeActivityEvents:vi.fn().mockResolvedValue([]),listCodeRunTurns:vi.fn().mockResolvedValue([]),getReplayBundle:vi.fn().mockResolvedValue(null)};
  const projects={get:vi.fn().mockResolvedValue({})};
  const deps={store,projects,auth:{authenticate:vi.fn().mockResolvedValue(ctx)}} as unknown as DevelopmentPorts & {auth:AuthProvider};
  return {ctx,state,store,projects,deps};
}
it("serves durable runs without chat bindings, reloads their trace and rejects a foreign workspace",async()=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  try {
    const list=await app.inject("/companies/co/code/monitor/runs");expect(list.json().runs[0].id).toBe("run");
    const first=(await app.inject("/companies/co/code/monitor/runs/run")).json();
    expect(first.events[0]).toMatchObject({id:"run:started",runId:"run"});
    expect((await app.inject("/companies/co/code/monitor/runs/run")).json().events).toEqual(first.events);
    expect((await app.inject("/companies/co/code/monitor/runs/run?cursor=missing")).statusCode).toBe(400);
    f.state.workspaceId="foreign";expect((await app.inject("/companies/co/code/monitor/runs/run")).statusCode).toBe(404);
  } finally {await app.close();}
});
it("pages long histories without losing entries and restores provider HTTP/retry metadata",async()=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  f.store.listCodeRunTurns.mockResolvedValue([{turnIndex:1,startedAt:new Date(start),toolCalls:Array.from({length:121},(_,n)=>({toolCallId:"c"+n,tool:"code.fs.read",outcome:"ok",startedAt:new Date(Date.parse(start)+n),finishedAt:new Date(Date.parse(start)+n+1)}))}]);
  f.store.listCodeActivityEvents.mockResolvedValue([{id:"http",kind:"run_activity",createdAt:new Date(start),payload:{eventType:"model_call",phase:"failed",attempt:1,turn:1,model:"test",httpStatus:429,errorCode:"provider_http_error",retryScheduled:true}}]);
  try {
    let cursor:string|null=null;const ids:string[]=[];
    do {const page=(await app.inject("/companies/co/code/monitor/runs/run?limit=50"+(cursor?"&cursor="+encodeURIComponent(cursor):""))).json();ids.push(...page.events.map((e:Event)=>e.id));cursor=page.page.nextCursor;if(!cursor) expect(page.summary.lastError.error).toBe("AI Provider HTTP 429");} while(cursor);
    expect(new Set(ids).size).toBe(123);
  } finally {await app.close();}
});
it("persists despite logger failure and masks terminal secrets before storage",async()=>{
  const write=vi.fn().mockResolvedValue({id:"saved"});
  const sink=createCodeRunActivitySink({workspaceId:"ws",store:{createCodeActivityEvent:write},log:()=>{throw Error("broken logger");}});
  expect(await sink.record({kind:"run_activity",companyId:"co"},{phase:"failed",httpStatus:502})).toMatchObject({persisted:true});
  await activitySinkForKind(sink,"run_activity").record({kind:"model_call",companyId:"co",phase:"failed",turn:1,httpStatus:502});
  expect(write.mock.calls.at(-1)?.[0].payload).toMatchObject({eventType:"model_call",phase:"failed",httpStatus:502});
  const f=fixture(),terminal=new ProjectTerminalEventsRepository(f.projects);
  await terminal.append(f.ctx,"co","pr",{commandSummary:"TOKEN=private-value npm test",output:"password=private-password",status:"failed",exitCode:1,sandboxId:"sb",riskLevel:"safe",durationMs:10});
  const saved=JSON.stringify(await terminal.list(f.ctx,"co","pr"));expect(saved).not.toContain("private-value");expect(saved).not.toContain("private-password");
});
it("shows failed Sandbox preparation before runtime creation and failed Preview after runtime success",async()=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  const binding={id:"process",companyId:"co",projectId:"pr",sessionId:"se",runId:"run",name:"Site",status:"failed",createdAt:start,updatedAt:new Date(now).toISOString(),progress:[event(1,{id:"preview",tool:undefined,command:undefined,stage:"preview",title:"Preview failed",status:"failed",error:"Server did not start"})]};
  f.store.getUserSetting.mockResolvedValue({value:[binding]});
  try {
    f.store.getCodeRunState.mockResolvedValue(null);f.store.listCodeRunStates.mockResolvedValue([]);
    expect((await app.inject("/companies/co/code/monitor/runs")).json().runs[0]).toMatchObject({id:"run",requestedMode:"coding_setup",status:"failed"});
    expect((await app.inject("/companies/co/code/monitor/runs/run")).json().summary.lastError.error).toBe("Server did not start");
    f.store.getCodeRunState.mockResolvedValue({...f.state,status:"completed",finishedAt:new Date(start)});
    const finished=(await app.inject("/companies/co/code/monitor/runs/run")).json();
    expect(finished.run.status).toBe("failed");expect(finished.summary.lastError.error).toBe("Server did not start");
    binding.status="running";binding.progress[0]!.status="running";
    expect((await app.inject("/companies/co/code/monitor/runs/run")).json().run.status).toBe("running");
  }finally{await app.close();}
});
it("refuses unauthorized reads before loading trace data",async()=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  f.store.getCompany.mockRejectedValue(new WorkspaceAccessError("denied"));
  try {expect((await app.inject("/companies/co/code/monitor/runs/run")).statusCode).toBe(403);expect(f.store.listCodeRunTurns).not.toHaveBeenCalled();}finally{await app.close();}
});
it.each(["budget_exhausted","step_limit","time_limit"])("projects legacy completed/%s as failed without rewriting history",async reason=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  Object.assign(f.state,{status:"completed",finishedAt:new Date(now),details:{stopReason:reason}});
  try {
    const data=(await app.inject("/companies/co/code/monitor/runs/run")).json();
    expect(data.run.status).toBe("failed");expect(data.summary.lastError.errorCode).toBe(reason);expect(f.state.status).toBe("completed");
    expect((await app.inject("/companies/co/code/monitor/runs")).json().runs[0].status).toBe("failed");
  }finally{await app.close();}
});
it("includes persisted Browser QA and JavaScript issues only for the selected run",async()=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  f.store.listProjectQaReports.mockResolvedValue([{id:"qa",runId:"run",status:"failed",summary:"Browser QA failed",createdAt:start,issues:[{type:"console",message:"TypeError in app.js; token=private"}],metrics:{consoleErrorsCount:1}},{id:"foreign",runId:"other",status:"failed",createdAt:start}]);
  try {
    const data=(await app.inject("/companies/co/code/monitor/runs/run")).json();
    expect(data.events.filter((e:Event)=>e.stage==="browser_qa")).toHaveLength(1);
    expect(data.events.find((e:Event)=>e.stage==="browser_qa")).toMatchObject({status:"failed",errorCode:"browser_qa_failed"});
    expect(JSON.stringify(data)).not.toContain("private");
    expect(f.store.listProjectQaReports).toHaveBeenCalledWith(f.ctx,"co","pr",200,"run");
  }finally{await app.close();}
});
it("paginates run history across tied timestamps without duplicates",async()=>{
  const store=new InMemoryCodeRunStore();
  for(const runId of ["a","b","c"]) await store.createCodeRunState({runId,companyId:"co",projectId:"pr",sessionId:"se",workspaceId:"ws",owner:"owner",leaseMs:60000,now:new Date(start)});
  const first=await store.listCodeRunStates({companyId:"co",limit:2});
  const last=first.at(-1)!;
  const second=await store.listCodeRunStates({companyId:"co",limit:2,cursor:encodeCodeRunScanCursor({startedAt:last.startedAt.toISOString(),runId:last.runId,turnIndex:0})});
  expect([...first,...second].map(r=>r.runId)).toEqual(["a","b","c"]);
});
it("reads older Activity pages instead of silently dropping metadata after 200 events",async()=>{
  const f=fixture(),app=Fastify();registerCodeMonitorRoutes(app,f.deps);
  f.store.listCodeActivityEvents.mockResolvedValueOnce(Array.from({length:200},(_,n)=>({id:"metadata"+n,kind:"run_activity",createdAt:new Date(Date.parse(start)+(200-n)*1000),payload:{eventType:"model_call",phase:"completed",turn:n+1,model:"test",durationMs:20}}))).mockResolvedValueOnce([{id:"oldest",kind:"run_activity",createdAt:new Date(start),payload:{eventType:"model_call",phase:"completed",turn:201,model:"test",durationMs:20}}]);
  try {
    const data=(await app.inject("/companies/co/code/monitor/runs/run?limit=100")).json();
    expect(data.page.total).toBe(202);expect(data.events.some((e:Event)=>e.id==="run:thinking:201")).toBe(true);
    expect(f.store.listCodeActivityEvents.mock.calls[1]?.[0]).toMatchObject({cursor:expect.any(String),runId:"run",companyId:"co"});
  }finally{await app.close();}
});
