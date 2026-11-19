import type { FastifyInstance, FastifyReply } from "fastify";
import { DEVELOPMENT_PROCESS_SETTINGS_KEY, monitorCodeRun, normalizeCodeRunStatus, sanitizeExecutionTrace, type DevelopmentProcess } from "@npati/shared";
import { WorkspaceAccessError, WorkspaceNotFoundError, encodeCodeRunScanCursor, type AuthContext, type ActivityCodeRun } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { DevelopmentPorts } from "./chat-development-service";
import { developmentTrace, executionTimestamp, sanitizeProgress } from "./chat-development-trace";

const iso = (value: unknown) => new Date(executionTimestamp(value) ?? 0).toISOString();
export const activityCodeRun = (run: ActivityCodeRun) => ({ id:run.runId, companyId:run.companyId, projectId:run.projectId, task:`Coding · ${run.projectId}`, requestedMode:"coding", status:normalizeCodeRunStatus(run.status,run.details.stopReason), createdAt:iso(run.startedAt), completedAt:run.finishedAt ? iso(run.finishedAt) : undefined,workerId:run.leaseOwner ?? undefined,heartbeatAt:run.heartbeatAt?iso(run.heartbeatAt):undefined,leaseExpiresAt:run.leaseExpiresAt?iso(run.leaseExpiresAt):undefined,turnIndex:run.turnIndex });

export async function readCodeRunMonitor(deps: Pick<DevelopmentPorts, "store" | "projects" | "terminalEvents">, ctx: AuthContext, companyId: string, runId: string, query: { cursor?: string; limit?: string } = {}) {
    await deps.store.getCompany(ctx,companyId);
    const recordedRun=await deps.store.getCodeRunState(companyId,runId);
    const run=recordedRun?{...recordedRun,status:normalizeCodeRunStatus(recordedRun.status,recordedRun.details.stopReason)}:null;
    if(!run) {
      const settings=(await deps.store.getUserSetting(ctx,DEVELOPMENT_PROCESS_SETTINGS_KEY))?.value;
      const p=Array.isArray(settings)?(settings as DevelopmentProcess[]).find(p=>p.companyId===companyId && (p.runId ?? p.id)===runId):undefined;
      if(p) {
        if(p.projectId) await deps.projects.get(ctx,companyId,p.projectId);
        const events=(p.progress ?? []).map(sanitizeProgress);
        const completedAt=["failed","completed","cancelled","interrupted"].includes(p.status)?p.updatedAt:undefined;
        const status=["queued","preparing","running","stopping"].includes(p.status)?"running":p.status;
        return {run:{id:runId,companyId,projectId:p.projectId,task:"Preparation · "+sanitizeExecutionTrace(p.name),requestedMode:"coding_setup",status:p.status,createdAt:p.createdAt,completedAt},summary:monitorCodeRun(events,{status,startedAt:p.createdAt,finishedAt:completedAt}),events,page:{total:events.length,nextCursor:null}};
      }
    }
    if(!run || run.workspaceId!==ctx.workspaceId) throw new WorkspaceNotFoundError("Run not found");
    await deps.projects.get(ctx,companyId,run.projectId);
    const settings=(await deps.store.getUserSetting(ctx,DEVELOPMENT_PROCESS_SETTINGS_KEY))?.value;
    const binding=Array.isArray(settings) ? (settings as DevelopmentProcess[]).find(p=>p.companyId===companyId && p.projectId===run.projectId && p.sessionId===run.sessionId) : undefined;
    const process:DevelopmentProcess={...binding,id:binding?.id ?? runId,companyId,projectId:run.projectId,sessionId:run.sessionId,runId,parentConversationId:binding?.parentConversationId ?? "",name:binding?.name ?? "Coding",framework:binding?.framework ?? "",status:run.status==="waiting_for_user"?"awaiting_approval":run.status,hidden:false,createdAt:iso(run.startedAt),updatedAt:iso(run.updatedAt),progress:(binding?.progress ?? []).filter(e=>e.runId===runId || !e.runId && binding?.runId===runId)};
    const events=(await developmentTrace(deps.store,ctx,process,deps.terminalEvents)).filter(e=>!e.runId || e.runId===runId);
    const qaReports=await deps.store.listProjectQaReports(ctx,companyId,run.projectId,200,runId);
    for(const report of qaReports) {
      if(report.runId!==runId) continue;
      events.push(sanitizeProgress({id:"browser-qa:"+report.id,runId,stage:"browser_qa",title:report.summary,at:report.createdAt,status:report.status==="failed" || report.status==="error"?"failed":"completed",errorCode:report.status==="warning"?"browser_qa_warning":report.status==="failed" || report.status==="error"?"browser_qa_failed":undefined,result:JSON.stringify({status:report.status,issues:report.issues,metrics:report.metrics})}));
    }
    // Preview finalization happens after the runner settles its durable state.
    // Its persisted process outcome must not be presented as a successful site build.
    const finalizing=run.status==="completed" && binding?.runId===runId;
    const effectiveStatus=finalizing ? binding.status==="completed"?"completed":binding.status==="awaiting_approval"?"waiting_for_user":["queued","preparing","running","stopping"].includes(binding.status)?"running":binding.status : run.status;
    if(finalizing) for(const event of events) {
      const reported=binding.progress?.find(item=>item.id===event.id && (!item.runId || item.stage==="preview"));
      if(reported) Object.assign(event,sanitizeProgress(reported));
    }
    events.unshift({id:runId+":started",runId,stage:"run",title:"Coding run started",at:iso(run.startedAt),status:"completed"});
    if(run.finishedAt) events.push({id:runId+":finished",runId,stage:"run",title:`Coding runtime ${run.status}`,at:iso(run.finishedAt),status:run.status==="completed"?"completed":run.status==="cancelled"?"cancelled":"failed",errorCode:run.status==="failed"?sanitizeExecutionTrace(String(run.details.stopReason ?? run.details.reason ?? "run_failed")):undefined});
    events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at) || a.id.localeCompare(b.id));
    const limit=Math.min(100,Math.max(1,Number(query.limit)||50)), cursor=query.cursor;
    const index=cursor ? events.findIndex(e=>e.id===cursor) : -1;
    if(cursor && index<0) throw Object.assign(new Error("Invalid monitoring cursor"), { status: 400 });
    const page=events.slice(index+1,index+1+limit);
    const finishedAt=effectiveStatus==="running"?null:finalizing?binding.updatedAt:run.finishedAt?iso(run.finishedAt):null;
    return {run:{...activityCodeRun(run),status:effectiveStatus,completedAt:finishedAt ?? undefined,task:sanitizeExecutionTrace(binding?.name ?? activityCodeRun(run).task)},summary:monitorCodeRun(events,{status:effectiveStatus,startedAt:iso(run.startedAt),finishedAt}),events:page,page:{total:events.length,nextCursor:index+1+limit<events.length?page.at(-1)?.id:null}};
}

/** Read projection of the existing durable records; no second execution history. */
export function registerCodeMonitorRoutes(app: FastifyInstance, deps: DevelopmentPorts & { auth: AuthProvider }) {
  const fail=(reply:FastifyReply,error:unknown)=>{
    const shaped=error as {status?:number;httpStatus?:number;code?:string};
    const status=shaped.httpStatus ?? shaped.status ?? 500;
    return reply.code(status).send({error:{code:shaped.code ?? "monitor_read_failed",message:status===500?"Monitoring read failed":"Monitoring access or request refused"}});
  };
  app.get<{Params:{companyId:string};Querystring:{cursor?:string}}>("/companies/:companyId/code/monitor/runs", async (request,reply) => {
    try {
    const ctx=await deps.auth.authenticate(request), {companyId}=request.params;
    await deps.store.getCompany(ctx,companyId);
    const candidates=await deps.store.listCodeRunStates({companyId,limit:200,cursor:request.query.cursor});
    const runs:{id:string;companyId:string;projectId?:string;task:string;requestedMode:string;status:string;createdAt:string;completedAt?:string}[]=[];
    const access=new Map<string,Promise<boolean>>();
    const canRead=(projectId:string)=>{
      let pending=access.get(projectId);
      if(!pending) {pending=deps.projects.get(ctx,companyId,projectId).then(()=>true,error=>{if(error instanceof WorkspaceAccessError || error instanceof WorkspaceNotFoundError) return false;throw error;});access.set(projectId,pending);}
      return pending;
    };
    await Promise.all(candidates.filter(run=>run.workspaceId===ctx.workspaceId).map(run=>canRead(run.projectId)));
    for(const run of candidates) {
      if(run.workspaceId!==ctx.workspaceId) continue;
      if(await canRead(run.projectId)) runs.push(activityCodeRun(run));
    }
    if(!request.query.cursor) {
      const settings=(await deps.store.getUserSetting(ctx,DEVELOPMENT_PROCESS_SETTINGS_KEY))?.value;
      for(const p of (Array.isArray(settings)?settings:[]) as DevelopmentProcess[]) {
        if(p.companyId!==companyId || p.runId && candidates.some(r=>r.runId===p.runId)) continue;
        if(p.runId && await deps.store.getCodeRunState(companyId,p.runId)) continue;
        // Setup can fail before a Coding Run exists. Preserve its real process identity.
        if(p.projectId && !await canRead(p.projectId)) continue;
        runs.push({id:p.runId ?? p.id,companyId,projectId:p.projectId,task:"Preparation · "+sanitizeExecutionTrace(p.name),requestedMode:"coding_setup",status:p.status,createdAt:p.createdAt,completedAt:["failed","completed","cancelled","interrupted"].includes(p.status)?p.updatedAt:undefined});
      }
    }
    const last=candidates.at(-1);
    return {runs,limit:200,nextCursor:candidates.length===200 && last ? encodeCodeRunScanCursor({startedAt:iso(last.startedAt),runId:last.runId,turnIndex:0}):null};
    } catch(error) {return fail(reply,error);}
  });
  app.get<{Params:{companyId:string;runId:string};Querystring:{cursor?:string;limit?:string}}>("/companies/:companyId/code/monitor/runs/:runId",async(request,reply)=>{
    try {
    const ctx=await deps.auth.authenticate(request), {companyId,runId}=request.params;
    return await readCodeRunMonitor(deps, ctx, companyId, runId, request.query);
    }catch(error){return fail(reply,error);}
  });
}
