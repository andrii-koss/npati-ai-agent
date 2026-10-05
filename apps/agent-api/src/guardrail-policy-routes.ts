import type {FastifyInstance,FastifyReply} from "fastify";
import {WorkspaceAccessError,type WorkspaceStore} from "@npati/workspace";
import {AuthenticationError,type AuthProvider} from "./auth";
import type {GuardrailPolicyRepository} from "./guardrail-policy-repository";
import {SecurityPolicyEngine} from "./security-guardrails";
import type {AuditLogService} from "./audit-log";

export function registerGuardrailPolicyRoutes(app:FastifyInstance,deps:{auth:AuthProvider;store:WorkspaceStore;repo:GuardrailPolicyRepository;auditLog?:AuditLogService}){
  const error=(reply:FastifyReply,value:unknown)=>{
    const e=value as {status?:number;code?:string;message?:string};
    const status=value instanceof WorkspaceAccessError?403:e.status??500;
    return reply.code(status).send({error:{code:e.code??"GUARDRAIL_POLICY_ERROR",message:e.message??"Guardrail policy request failed"}});
  };
  async function context(request:any,write=false){
    const ctx=await deps.auth.authenticate(request);
    const allowed=ctx.permissions.some((permission:string)=>permission==="*"||permission==="admin:all"||permission===(write?"workspace:write":"workspace:read")||(write&&permission==="business:manage"));
    if(!allowed)throw new AuthenticationError("Permission denied",403,"FORBIDDEN");
    await deps.store.getCompany(ctx,request.params.companyId);
    return ctx;
  }
  app.get<{Params:{companyId:string}}>("/companies/:companyId/security/guardrails",async(request,reply)=>{
    try{const ctx=await context(request);return await deps.repo.get(ctx,request.params.companyId);}catch(e){return error(reply,e);}
  });
  app.put<{Params:{companyId:string};Body:{blockPromptInjection?:boolean;redactPii?:boolean;redactCredentials?:boolean;customBlockedTerms?:string[];maxInputCharacters?:number;expectedRevision:number}}>(
    "/companies/:companyId/security/guardrails",async(request,reply)=>{
      try{
        const ctx=await context(request,true),current=await deps.repo.get(ctx,request.params.companyId);
        const policy=SecurityPolicyEngine.normalize({
          blockPromptInjection:request.body.blockPromptInjection??current.blockPromptInjection,
          redactPii:request.body.redactPii??current.redactPii,
          redactCredentials:request.body.redactCredentials??current.redactCredentials,
          customBlockedTerms:request.body.customBlockedTerms??current.customBlockedTerms,
          maxInputCharacters:request.body.maxInputCharacters??current.maxInputCharacters,
        });
        // C1c: a policy change is privileged and provable; record the change (term values stay out of
        // the journal) before applying it, so an audit outage refuses the change.
        if(deps.auditLog){
          await deps.auditLog.record(ctx,{
            companyId:request.params.companyId,actor:ctx.userId,actorRole:"admin",
            action:"policy.guardrail.update",resourceType:"guardrail_policy",decision:"allowed",
            payload:{before:current,after:policy},
            metadata:{blockPromptInjection:policy.blockPromptInjection,redactPii:policy.redactPii,redactCredentials:policy.redactCredentials,maxInputCharacters:policy.maxInputCharacters,blockedTerms:policy.customBlockedTerms?.length??0,expectedRevision:request.body.expectedRevision},
          });
        }
        return await deps.repo.save(ctx,request.params.companyId,policy,request.body.expectedRevision);
      }catch(e){return error(reply,e);}
    });
}
