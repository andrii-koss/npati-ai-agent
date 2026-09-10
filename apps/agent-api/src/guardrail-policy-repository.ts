import type {Pool} from "pg";
import type {AuthContext} from "@npati/workspace";
import {DEFAULT_GUARDRAIL_POLICY,type CompanyGuardrailPolicy} from "./security-guardrails";

export interface StoredGuardrailPolicy extends CompanyGuardrailPolicy {
  companyId:string;workspaceId:string;userId:string;revision:number;updatedAt:string;
}
const columns=`company_id AS "companyId",workspace_id AS "workspaceId",user_id AS "userId",
 block_prompt_injection AS "blockPromptInjection",redact_pii AS "redactPii",redact_credentials AS "redactCredentials",
 custom_blocked_terms AS "customBlockedTerms",max_input_characters AS "maxInputCharacters",revision,updated_at AS "updatedAt"`;

export class GuardrailPolicyRepository {
  private readonly memory=new Map<string,StoredGuardrailPolicy>();
  constructor(private readonly pool?:Pool){}
  async get(ctx:AuthContext,companyId:string):Promise<StoredGuardrailPolicy>{
    if(this.pool){
      const result=await this.pool.query<StoredGuardrailPolicy>(`SELECT ${columns} FROM company_guardrail_policies WHERE company_id=$1 AND workspace_id=$2 AND user_id=$3`,[companyId,ctx.workspaceId,ctx.userId]);
      if(result.rows[0])return result.rows[0];
    }else{
      const found=this.memory.get(ctx.workspaceId+":"+ctx.userId+":"+companyId);if(found)return found;
    }
    return {companyId,workspaceId:ctx.workspaceId,userId:ctx.userId,...DEFAULT_GUARDRAIL_POLICY,revision:0,updatedAt:new Date(0).toISOString()};
  }
  async save(ctx:AuthContext,companyId:string,policy:CompanyGuardrailPolicy,expectedRevision:number):Promise<StoredGuardrailPolicy>{
    if(this.pool){
      const result=await this.pool.query<StoredGuardrailPolicy>(`
        INSERT INTO company_guardrail_policies(company_id,workspace_id,user_id,block_prompt_injection,redact_pii,redact_credentials,custom_blocked_terms,max_input_characters,revision)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,1 WHERE $9=0
        ON CONFLICT(company_id) DO UPDATE SET
          block_prompt_injection=EXCLUDED.block_prompt_injection,redact_pii=EXCLUDED.redact_pii,
          redact_credentials=EXCLUDED.redact_credentials,custom_blocked_terms=EXCLUDED.custom_blocked_terms,
          max_input_characters=EXCLUDED.max_input_characters,revision=company_guardrail_policies.revision+1,updated_at=now()
        WHERE company_guardrail_policies.workspace_id=$2 AND company_guardrail_policies.user_id=$3 AND company_guardrail_policies.revision=$9
        RETURNING ${columns}`,[companyId,ctx.workspaceId,ctx.userId,policy.blockPromptInjection,policy.redactPii,policy.redactCredentials,policy.customBlockedTerms,policy.maxInputCharacters,expectedRevision]);
      if(!result.rows[0])throw Object.assign(Error("Guardrail policy revision conflict"),{status:409,code:"REVISION_CONFLICT"});
      return result.rows[0];
    }
    const key=ctx.workspaceId+":"+ctx.userId+":"+companyId,current=this.memory.get(key);
    if((current?.revision??0)!==expectedRevision)throw Object.assign(Error("Guardrail policy revision conflict"),{status:409,code:"REVISION_CONFLICT"});
    const stored={companyId,workspaceId:ctx.workspaceId,userId:ctx.userId,...policy,revision:expectedRevision+1,updatedAt:new Date().toISOString()};
    this.memory.set(key,stored);return stored;
  }
  async purge(ctx:AuthContext,companyId:string){
    if(this.pool)await this.pool.query("DELETE FROM company_guardrail_policies WHERE company_id=$1 AND workspace_id=$2 AND user_id=$3",[companyId,ctx.workspaceId,ctx.userId]);
    else this.memory.delete(ctx.workspaceId+":"+ctx.userId+":"+companyId);
  }
}
