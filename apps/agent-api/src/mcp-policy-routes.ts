import type {FastifyInstance,FastifyRequest} from "fastify";
import {WorkspaceAccessError,type AuthContext,type WorkspaceStore} from "@npati/workspace";
import type {CapabilityRisk} from "@npati/shared";
import {AuthenticationError} from "./auth";
import type {ApiKeyAuthResult,ApiKeysRepository} from "./api-keys-repository";
import type {CompanyToolExecutor} from "./company-tool-runtime";
import {mcpRuntimeToolId} from "./mcp-runtime-identity";

function tokenOf(request:FastifyRequest){
  const explicit=request.headers["x-npati-api-key"];
  if(typeof explicit==="string"&&explicit.trim())return explicit.trim();
  const authorization=request.headers.authorization;
  return typeof authorization==="string"&&authorization.startsWith("Bearer npati_live_")?authorization.slice(7).trim():"";
}

function hasScope(auth:ApiKeyAuthResult,required:string){
  const scopes=new Set((auth.scopes??[]).map(scope=>scope.trim().toLowerCase()));
  return scopes.has("*")||scopes.has("all")||scopes.has(required);
}

/**
 * The MCP scope level the risk surface requires on top of RBAC.
 *
 * `mcp:execute` — not a new `mcp:admin` string — because `api-keys-repository.ts`'s `API_KEY_SCOPES` is the
 * list a key can actually be minted with, and adding a scope there would be a policy-vocabulary change rather
 * than a wiring step. The scope only says *which family of key may ask*; the authority to decide is the
 * existing owner/admin vocabulary, checked inside `applyMcpRiskOverride` via `hasAdminPermission`, so a key
 * that holds `mcp:execute` without `*`/`owner`/`admin:all` gets a 403 from the flow and nothing is applied.
 */
const MCP_RISK_SCOPE="mcp:execute";

/**
 * C13 (owner decision 5): the **entry point** of the owner/admin flow that may lower a runtime MCP tool's risk.
 *
 * Why it is its own route rather than a flag on the call route: calling a tool and deciding that a tool is
 * low-risk are two different authorities. The call route authenticates with `mcp:read`; this one requires the
 * `mcp:admin` scope **and** the existing owner/admin permission vocabulary — the authorization itself lives in
 * `applyMcpRiskOverride` (`hasAdminPermission`, agent principals refused, the AuditLog written before anything
 * applies), so this handler can neither weaken it nor bypass it. An unwired deployment answers 503 instead of
 * silently accepting the decision, and the durable row it writes is migration 085's
 * `company_mcp_tool_policies`.
 */
export interface McpRuntimeRiskPort {
  apply(input: {
    ctx: AuthContext;
    companyId: string;
    toolId: string;
    risk: CapabilityRisk;
    approvalRequired?: boolean;
    requestId?: string;
    correlationId?: string;
    snapshotId?: string;
  }): Promise<unknown>;
}

export function registerMcpPolicyRoutes(app:FastifyInstance,deps:{
  apiKeys:ApiKeysRepository;
  store:WorkspaceStore;
  tools:CompanyToolExecutor;
  /** Absent means this deployment has no runtime MCP risk surface; the route then fails closed (503). */
  runtimeRisk?:McpRuntimeRiskPort;
}){
  app.post<{Body:{name:string;arguments?:Record<string,unknown>}}>("/company-api/mcp/call",{
    schema:{body:{type:"object",additionalProperties:false,required:["name"],properties:{
      name:{type:"string",minLength:1,maxLength:200},arguments:{type:"object",additionalProperties:true},
    }}},
  },async(request,reply)=>{
    try{
      const auth=await deps.apiKeys.authenticate(tokenOf(request));
      if(!auth.authenticated||!auth.companyId||!auth.tenantId||!auth.userId||!auth.keyId)
        throw new AuthenticationError("A valid Company API key is required",401,auth.error??"INVALID_API_KEY");
      if(!hasScope(auth,"mcp:read"))
        throw new AuthenticationError("API key does not grant mcp:read",403,"API_KEY_SCOPE_DENIED");
      const context:AuthContext={userId:auth.userId,workspaceId:auth.tenantId,apiKeyId:auth.keyId,
        permissions:[...new Set(["workspace:read",...(auth.scopes??[])])]};
      const company=await deps.store.getCompany(context,auth.companyId);
      const result=await deps.tools.execute(context,company,"mcp",{name:request.body.name,arguments:request.body.arguments??{}},AbortSignal.timeout(30_000));
      return {result};
    }catch(error){
      const status=Number((error as any)?.status??(error instanceof WorkspaceAccessError?403:500));
      return reply.code(status).send({error:{code:(error as any)?.code??"MCP_CALL_FAILED",message:error instanceof Error?error.message:"MCP call failed"}});
    }
  });

  /**
   * The owner/admin risk decision for one runtime MCP tool. Deliberately narrow: it names a connection and a
   * tool and a risk class, and it can do nothing else — no schema, no endpoint, no argument, no manifest edit.
   */
  app.post<{Body:{
    connectionId:string;
    toolName:string;
    risk:CapabilityRisk;
    approvalRequired?:boolean;
    requestId?:string;
    correlationId?:string;
    snapshotId?:string;
  }}>("/company-api/mcp/runtime/risk",{
    schema:{body:{type:"object",additionalProperties:false,required:["connectionId","toolName","risk"],properties:{
      connectionId:{type:"string",minLength:1,maxLength:128},
      toolName:{type:"string",minLength:1,maxLength:64},
      risk:{type:"string",enum:["low","medium","high","critical"]},
      approvalRequired:{type:"boolean"},
      requestId:{type:"string",maxLength:200},
      correlationId:{type:"string",maxLength:200},
      snapshotId:{type:"string",maxLength:200},
    }}},
  },async(request,reply)=>{
    try{
      const auth=await deps.apiKeys.authenticate(tokenOf(request));
      if(!auth.authenticated||!auth.companyId||!auth.tenantId||!auth.userId||!auth.keyId)
        throw new AuthenticationError("A valid Company API key is required",401,auth.error??"INVALID_API_KEY");
      if(!hasScope(auth,MCP_RISK_SCOPE))
        throw new AuthenticationError(`API key does not grant ${MCP_RISK_SCOPE}`,403,"API_KEY_SCOPE_DENIED");
      // The port is where the owner/admin permission check and the audit-before-apply order live; this handler
      // only proves the key is allowed to ask, and it fails closed when the flow is not wired at all.
      if(!deps.runtimeRisk)
        return reply.code(503).send({error:{code:"mcp_risk_override_unavailable",message:"The runtime MCP risk policy flow is not wired in this deployment"}});
      const context:AuthContext={userId:auth.userId,workspaceId:auth.tenantId,apiKeyId:auth.keyId,
        permissions:[...new Set(["workspace:read",...(auth.scopes??[])])]};
      await deps.store.getCompany(context,auth.companyId);
      const result=await deps.runtimeRisk.apply({
        ctx:context,
        companyId:auth.companyId,
        toolId:mcpRuntimeToolId(request.body.connectionId,request.body.toolName),
        risk:request.body.risk,
        ...(request.body.approvalRequired===undefined?{}:{approvalRequired:request.body.approvalRequired}),
        ...(request.body.requestId===undefined?{}:{requestId:request.body.requestId}),
        ...(request.body.correlationId===undefined?{}:{correlationId:request.body.correlationId}),
        ...(request.body.snapshotId===undefined?{}:{snapshotId:request.body.snapshotId}),
      });
      return {result};
    }catch(error){
      const mapped=(error as {status?:number;httpStatus?:number})??{};
      const status=Number(mapped.status??mapped.httpStatus??(error instanceof WorkspaceAccessError?403:500));
      return reply.code(status).send({error:{code:(error as {code?:string})?.code??"MCP_RISK_OVERRIDE_FAILED",message:error instanceof Error?error.message:"MCP risk override failed"}});
    }
  });
}
