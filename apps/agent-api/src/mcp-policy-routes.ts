import type {FastifyInstance,FastifyRequest} from "fastify";
import {WorkspaceAccessError,type AuthContext,type WorkspaceStore} from "@npati/workspace";
import {AuthenticationError} from "./auth";
import type {ApiKeyAuthResult,ApiKeysRepository} from "./api-keys-repository";
import type {CompanyToolExecutor} from "./company-tool-runtime";

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

export function registerMcpPolicyRoutes(app:FastifyInstance,deps:{apiKeys:ApiKeysRepository;store:WorkspaceStore;tools:CompanyToolExecutor}){
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
}
