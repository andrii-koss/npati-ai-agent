import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CryptoVault, type AuthContext } from "@npati/workspace";

export type MessagingChannel = "telegram" | "discord" | "slack" | "whatsapp" | "email";
export type MessagingConnectionStatus = "pending" | "connected" | "paused" | "error";
export interface MessagingConnection {
  id:string; workspaceId:string; userId:string; companyId:string; agentId?:string|null; channel:MessagingChannel;
  displayName:string; status:MessagingConnectionStatus; botUsername?:string|null; externalUserId?:string|null;
  externalChatId?:string|null; externalThreadId?:string|null; permissions:string[]; webhookSecret:string;
  encryptedCredential:string; pairingCodeHash?:string|null; pairingExpiresAt?:string|null; lastInboundAt?:string|null;
  runtimeConversationId?:string|null; lastOutboundAt?:string|null; lastError?:string|null; createdAt:string; updatedAt:string;
}
export type MessagingConnectionView=Omit<MessagingConnection,"webhookSecret"|"encryptedCredential"|"pairingCodeHash">;
const columns=`id,workspace_id AS "workspaceId",user_id AS "userId",company_id AS "companyId",agent_id AS "agentId",channel,display_name AS "displayName",status,bot_username AS "botUsername",external_user_id AS "externalUserId",external_chat_id AS "externalChatId",external_thread_id AS "externalThreadId",runtime_conversation_id AS "runtimeConversationId",permissions,webhook_secret AS "webhookSecret",encrypted_credential AS "encryptedCredential",pairing_code_hash AS "pairingCodeHash",pairing_expires_at::text AS "pairingExpiresAt",last_inbound_at::text AS "lastInboundAt",last_outbound_at::text AS "lastOutboundAt",last_error AS "lastError",created_at::text AS "createdAt",updated_at::text AS "updatedAt"`;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function view(item:MessagingConnection):MessagingConnectionView{const{webhookSecret:_s,encryptedCredential:_c,pairingCodeHash:_p,...safe}=item;return safe;}

export class MessagingIntegrationsRepository{
  private readonly pool?:Pool; private readonly memory=new Map<string,MessagingConnection>();
  constructor(databaseUrl?:string,pool?:Pool,private readonly vault=new CryptoVault()){this.pool=pool??(databaseUrl?.trim()?new Pool({connectionString:databaseUrl,max:5}):undefined);}
  async list(ctx:AuthContext,companyId?:string):Promise<MessagingConnectionView[]>{
    let rows:MessagingConnection[];
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE workspace_id=$1 AND user_id=$2 AND ($3::text IS NULL OR company_id=$3) ORDER BY created_at DESC`,[ctx.workspaceId,ctx.userId,companyId??null]);rows=result.rows;}
    else rows=[...this.memory.values()].filter((item)=>item.workspaceId===ctx.workspaceId&&item.userId===ctx.userId&&(!companyId||item.companyId===companyId));
    return rows.map(view);
  }
  async createTelegram(ctx:AuthContext,companyId:string,input:{displayName:string;botToken:string;botUsername?:string;agentId?:string|null}){
    const id=randomUUID(),now=new Date().toISOString(),pairingCode=String(randomInt(100000,1000000));
    const item:MessagingConnection={id,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,agentId:input.agentId||null,channel:"telegram",displayName:input.displayName.trim(),status:"pending",botUsername:input.botUsername||null,permissions:[...new Set(ctx.permissions)],webhookSecret:randomBytes(32).toString("hex"),encryptedCredential:this.vault.encrypt(input.botToken),pairingCodeHash:hash(pairingCode),pairingExpiresAt:new Date(Date.now()+900_000).toISOString(),createdAt:now,updatedAt:now};
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`INSERT INTO messaging_connections(id,workspace_id,user_id,company_id,agent_id,channel,display_name,status,bot_username,permissions,webhook_secret,encrypted_credential,pairing_code_hash,pairing_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${columns}`,[id,item.workspaceId,item.userId,item.companyId,item.agentId,item.channel,item.displayName,item.status,item.botUsername,item.permissions,item.webhookSecret,item.encryptedCredential,item.pairingCodeHash,item.pairingExpiresAt]);return{connection:view(result.rows[0]!),pairingCode,webhookSecret:result.rows[0]!.webhookSecret};}
    this.memory.set(id,item);return{connection:view(item),pairingCode,webhookSecret:item.webhookSecret};
  }
  async get(ctx:AuthContext,companyId:string,id:string):Promise<MessagingConnection|null>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND company_id=$4`,[id,ctx.workspaceId,ctx.userId,companyId]);return result.rows[0]??null;}const item=this.memory.get(id);return item?.workspaceId===ctx.workspaceId&&item.userId===ctx.userId&&item.companyId===companyId?item:null;}
  async getByWebhookSecret(secret:string):Promise<MessagingConnection|null>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE webhook_secret=$1 AND channel='telegram'`,[secret]);return result.rows[0]??null;}return[...this.memory.values()].find((item)=>item.webhookSecret===secret&&item.channel==="telegram")??null;}
  async listConnectedForCompany(workspaceId:string,companyId:string,agentId?:string|null):Promise<MessagingConnection[]>{
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE workspace_id=$1 AND company_id=$2 AND status='connected' AND (agent_id IS NULL OR $3::uuid IS NULL OR agent_id=$3)`,[workspaceId,companyId,agentId||null]);return result.rows;}
    return[...this.memory.values()].filter((item)=>item.workspaceId===workspaceId&&item.companyId===companyId&&item.status==="connected"&&(!item.agentId||!agentId||item.agentId===agentId));
  }
  resolveToken(item:MessagingConnection){return this.vault.decrypt(item.encryptedCredential);}
  async setRuntimeConversationId(item:MessagingConnection,conversationId:string):Promise<string>{
    if(this.pool){const result=await this.pool.query<{runtimeConversationId:string}>(`UPDATE messaging_connections SET runtime_conversation_id=COALESCE(runtime_conversation_id,$2),updated_at=now() WHERE id=$1 RETURNING runtime_conversation_id AS "runtimeConversationId"`,[item.id,conversationId]);return result.rows[0]?.runtimeConversationId||conversationId;}
    item.runtimeConversationId ||= conversationId;item.updatedAt=new Date().toISOString();return item.runtimeConversationId;
  }
  async bind(item:MessagingConnection,input:{pairingCode:string;externalUserId:string;externalChatId:string;externalThreadId?:string|null}){
    if(!item.pairingCodeHash||hash(input.pairingCode)!==item.pairingCodeHash||!item.pairingExpiresAt||Date.parse(item.pairingExpiresAt)<Date.now())return false;
    if(this.pool)await this.pool.query(`UPDATE messaging_connections SET status='connected',external_user_id=$2,external_chat_id=$3,external_thread_id=$4,pairing_code_hash=NULL,pairing_expires_at=NULL,last_inbound_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`,[item.id,input.externalUserId,input.externalChatId,input.externalThreadId||null]);
    else Object.assign(item,{status:"connected" as const,externalUserId:input.externalUserId,externalChatId:input.externalChatId,externalThreadId:input.externalThreadId||null,pairingCodeHash:null,pairingExpiresAt:null,lastInboundAt:new Date().toISOString(),lastError:null,updatedAt:new Date().toISOString()});return true;
  }
  async record(id:string,direction:"inbound"|"outbound",error?:string|null){const field=direction==="inbound"?"last_inbound_at":"last_outbound_at";if(this.pool){await this.pool.query(`UPDATE messaging_connections SET ${field}=now(),last_error=$2,updated_at=now() WHERE id=$1`,[id,error||null]);return;}const item=this.memory.get(id);if(item){if(direction==="inbound")item.lastInboundAt=new Date().toISOString();else item.lastOutboundAt=new Date().toISOString();item.lastError=error||null;item.updatedAt=new Date().toISOString();}}
  async delete(ctx:AuthContext,companyId:string,id:string){if(this.pool)return Boolean((await this.pool.query(`DELETE FROM messaging_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND company_id=$4`,[id,ctx.workspaceId,ctx.userId,companyId])).rowCount);return await this.get(ctx,companyId,id)?this.memory.delete(id):false;}
  async close(){if(this.pool)await this.pool.end().catch(()=>undefined);}
}
