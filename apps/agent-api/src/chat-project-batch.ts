import { randomUUID } from "node:crypto";
import { WorkspaceAccessError, type AuthContext, type Project } from "@npati/workspace";
import type { CodeService } from "./code-service";
import type { CodeSessionRunExecutor, CodeSessionRunInput } from "./code-session-run-executor";
import type { CodeRunAdmission } from "./code-run-admission";
import type { ProjectPreviewService } from "./project-preview-service";
import type { FeatureFlagService } from "./feature-flags";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { CODE_TOOL_MANIFEST_VERSION } from "./code-tool-registry";

/** The part of a change the user asked for in several projects ("в обох зміни фон") that belongs to one of them. */
function editPrompt(message: string, project: Project) {
  return message + "\n\nThis request names several projects; this run is the part for ONLY " + project.name + " (Project ID " + project.id + "). "
    + "Other projects run separately, so do not say they could not be changed. Make the requested change here, only what was asked, in this project's own files.";
}

/** Sequential adapter over the existing scoped services and admitted Code executor; no new runtime or queue. */
export async function runChatProjectBatch(input: {
  ctx: AuthContext; projects: Project[]; intent: "PREVIEW_PROJECT" | "REVIEW_PROJECT" | "TEST_PROJECT" | "EDIT_PROJECT"; message: string; signal: AbortSignal;
  code: Pick<CodeService,"listSessions"|"createSession">; executor: Pick<CodeSessionRunExecutor,"execute">;
  preview: Pick<ProjectPreviewService,"getPreviewStatus"|"startPreview">; flags: Pick<FeatureFlagService,"assertEnabled">;
  admission: CodeRunAdmission; queueTimeoutMs: number; noMemory?: boolean; responseLanguage?: CodeSessionRunInput["responseLanguage"];
  cancelRequested(sessionId: string): boolean; emitDelta?(text: string): void;
}) {
  const {ctx,projects,signal}=input;
  if(projects.length<2||projects.length>4||new Set(projects.map(p=>p.companyId)).size!==1)throw new Error("Invalid scoped project batch");
  const edit=input.intent==="EDIT_PROJECT";
  const results: Array<{projectId:string;companyId:string;name:string;run?:unknown;preview?:unknown}>=[];
  for(const project of projects){signal.throwIfAborted();const companyId=project.companyId;
    await input.flags.assertEnabled(ctx,CODE_AGENT_MASTER_FLAG,{companyId,userId:ctx.userId});
    if(input.intent==="PREVIEW_PROJECT"){
      if(!ctx.permissions.includes("workspace:write")&&!ctx.permissions.includes("admin:all"))throw new WorkspaceAccessError("Starting Preview requires workspace:write");
      await input.flags.assertEnabled(ctx,"code.shell",{companyId,userId:ctx.userId});
      let preview=await input.preview.getPreviewStatus(ctx,companyId,project.id);
      if(!preview.isRunning){await input.preview.startPreview(ctx,companyId,project.id,{signal});preview=await input.preview.getPreviewStatus(ctx,companyId,project.id);}
      if(!preview.isRunning)throw new Error("Preview did not become ready for "+project.name);
      results.push({projectId:project.id,companyId,name:project.name,preview});continue;
    }
    let session=(await input.code.listSessions(ctx,companyId,project.id,{limit:1}))[0];
    // Keep old pins immutable. New viewing capabilities use a normal new session, never a rewritten manifest.
    if(!session||session.toolManifestVersion!==CODE_TOOL_MANIFEST_VERSION)session=await input.code.createSession(ctx,companyId,project.id,{mode:"auto"});
    const lease=await input.admission.admit({workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,sessionId:session.id},{signal,timeoutMs:input.queueTimeoutMs});
    try{
      const outcome=await input.executor.execute({ctx,session,runId:"code-batch-"+randomUUID(),websiteEdit:true,...(edit?{}:{readOnlyIntent:true}),noMemory:input.noMemory,responseLanguage:input.responseLanguage,
        prompt:edit?editPrompt(input.message,project):input.message+"\nThis is the scoped part for ONLY "+project.name+" (Project ID "+project.id+"). Other named projects run separately. Inspect source as needed, then use actual Browser QA input actions to verify the requested mouse/keyboard transitions. Each inspection opens a fresh browser: put a complete move sequence and Restart in one actions array. Do not write source or infer runtime input success from source, HTTP or screenshots alone. Report actual interactionTrace before/after state and report ID; honestly disclose unavailable checks.",
        toolContext:{userMessage:input.message},cancelRequested:()=>input.cancelRequested(session!.id),sink:{signal,emitResult:async()=>{},emitTerminal:()=>{},emitDelta:text=>input.emitDelta?.(text)}});
      results.push({projectId:project.id,companyId,name:project.name,run:outcome.result});
      if((outcome.result as {status?:string})?.status!=="completed")return{status:"failed",reason:"project_batch_incomplete",message:(edit?"Project change did not complete: ":"Project inspection did not complete: ")+project.name+(results.length>1?". Completed before it: "+results.slice(0,-1).map(r=>r.name).join(", "):""),projects:results};
    }finally{lease.release();}
  }
  return{status:"completed",message:results.map(r=>r.name+" ["+r.projectId+"]: "+((r.run as {message?:string})?.message??"")+(r.preview?"Live Preview running":"")).join("\n\n"),projects:results};
}
