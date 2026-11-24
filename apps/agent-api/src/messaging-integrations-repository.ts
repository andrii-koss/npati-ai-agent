import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import type { CompanyEmailAccount } from "./email-inbox-types";

export type MessagingChannel = "telegram" | "discord" | "slack" | "whatsapp" | "email";
export type MessagingConnectionStatus = "pending" | "connected" | "paused" | "error";
export type MessagingConnectionScope = "account" | "company" | "agent";
export type WhatsAppProvider = "qr" | "cloud";
export type DiscordDmPolicy="pairing"|"allowlist"|"open"|"disabled";
export type DiscordChannelBinding={guildId:string;channelId:string;companyId?:string|null;agentId?:string|null;requireMention?:boolean;permissions:string[]};
export type SlackConnectionMethod="socket"|"http";
export type SlackChannelBinding={workspaceId:string;channelId:string;companyId?:string|null;agentId?:string|null;requireMention?:boolean;allowedUserIds:string[];permissions:string[]};
export type SlackConnectionSettings={dmPolicy:DiscordDmPolicy;allowedUserIds:string[];allowedWorkspaceIds:string[];allowedChannelIds:string[];requireMention:boolean;channelBindings:SlackChannelBinding[]};
export type DiscordConnectionSettings={
  dmPolicy:DiscordDmPolicy;allowedUserIds:string[];allowedGuildIds:string[];allowedChannelIds:string[];allowedRoleIds:string[];requireMention:boolean;channelBindings:DiscordChannelBinding[];
};
export interface MessagingConnectionSettings {
  access:{allowedUserIds:string[];selfChat:boolean};
  discord:DiscordConnectionSettings;
  slack:SlackConnectionSettings;
  groups:{enabled:boolean;allowedChatIds:string[];mentionRequired:boolean;replyMode:"reply"|"plain"};
  notifications:{automationResults:boolean;backgroundResults:boolean;errors:boolean;status:boolean};
  media:{images:boolean;documents:boolean;audio:boolean;outbound:boolean};
  delivery:{typing:boolean;progressive:boolean};
}
export const defaultMessagingConnectionSettings=():MessagingConnectionSettings=>({access:{allowedUserIds:[],selfChat:false},discord:{dmPolicy:"pairing",allowedUserIds:[],allowedGuildIds:[],allowedChannelIds:[],allowedRoleIds:[],requireMention:true,channelBindings:[]},slack:{dmPolicy:"pairing",allowedUserIds:[],allowedWorkspaceIds:[],allowedChannelIds:[],requireMention:true,channelBindings:[]},groups:{enabled:true,allowedChatIds:[],mentionRequired:true,replyMode:"reply"},notifications:{automationResults:true,backgroundResults:true,errors:true,status:true},media:{images:true,documents:true,audio:true,outbound:true},delivery:{typing:true,progressive:true}});
function normalizeSettings(value?:Partial<MessagingConnectionSettings>|null):MessagingConnectionSettings{const base=defaultMessagingConnectionSettings(),input=value||{};const clean=(values:string[]|undefined)=>[...new Set((values||[]).map(String).map((item)=>item.trim()).filter(Boolean))].slice(0,100);const bindings=(input.discord?.channelBindings||[]).map((item)=>({guildId:String(item.guildId||"").trim(),channelId:String(item.channelId||"").trim(),companyId:item.companyId||null,agentId:item.agentId||null,requireMention:item.requireMention,permissions:clean(item.permissions)})).filter((item)=>item.guildId&&item.channelId).slice(0,100),slackBindings=(input.slack?.channelBindings||[]).map((item)=>({workspaceId:String(item.workspaceId||"").trim(),channelId:String(item.channelId||"").trim(),companyId:item.companyId||null,agentId:item.agentId||null,requireMention:item.requireMention,allowedUserIds:clean(item.allowedUserIds),permissions:clean(item.permissions)})).filter((item)=>item.workspaceId&&item.channelId).slice(0,100);return{access:{...base.access,...input.access,allowedUserIds:clean(input.access?.allowedUserIds)},discord:{...base.discord,...input.discord,allowedUserIds:clean(input.discord?.allowedUserIds),allowedGuildIds:clean(input.discord?.allowedGuildIds),allowedChannelIds:clean(input.discord?.allowedChannelIds),allowedRoleIds:clean(input.discord?.allowedRoleIds),channelBindings:bindings},slack:{...base.slack,...input.slack,allowedUserIds:clean(input.slack?.allowedUserIds),allowedWorkspaceIds:clean(input.slack?.allowedWorkspaceIds),allowedChannelIds:clean(input.slack?.allowedChannelIds),channelBindings:slackBindings},groups:{...base.groups,...input.groups,allowedChatIds:clean(input.groups?.allowedChatIds)},notifications:{...base.notifications,...input.notifications},media:{...base.media,...input.media},delivery:{...base.delivery,...input.delivery}};}
export interface MessagingConnection {
  id:string; workspaceId:string; userId:string; companyId?:string|null; agentId?:string|null; scope:MessagingConnectionScope; channel:MessagingChannel;
  displayName:string; status:MessagingConnectionStatus; botUsername?:string|null; externalUserId?:string|null; provider?:WhatsAppProvider|null;
  externalChatId?:string|null; externalThreadId?:string|null; permissions:string[]; webhookSecret:string;
  encryptedCredential:string; pairingCodeHash?:string|null; pairingExpiresAt?:string|null; pairingLinkHash?:string|null; pairingFailedAttempts?:number; lastInboundAt?:string|null;
  runtimeConversationId?:string|null; activeCompanyId?:string|null; activeAgentId?:string|null; settings:MessagingConnectionSettings; lastOutboundAt?:string|null; lastError?:string|null; createdAt:string; updatedAt:string;
}
export interface MessagingSession {
  id:string; connectionId:string; externalChatId:string; externalThreadId:string;
  runtimeConversationId?:string|null; activeCompanyId?:string|null; activeAgentId?:string|null;
  createdAt:string; updatedAt:string;
}
export type MessagingConnectionView=Omit<MessagingConnection,"webhookSecret"|"encryptedCredential"|"pairingCodeHash">;
const columns=`id,workspace_id AS "workspaceId",user_id AS "userId",company_id AS "companyId",agent_id AS "agentId",connection_scope AS "scope",active_company_id AS "activeCompanyId",active_agent_id AS "activeAgentId",channel,provider,display_name AS "displayName",status,bot_username AS "botUsername",external_user_id AS "externalUserId",external_chat_id AS "externalChatId",external_thread_id AS "externalThreadId",runtime_conversation_id AS "runtimeConversationId",permissions,settings,webhook_secret AS "webhookSecret",encrypted_credential AS "encryptedCredential",pairing_code_hash AS "pairingCodeHash",pairing_expires_at::text AS "pairingExpiresAt",last_inbound_at::text AS "lastInboundAt",last_outbound_at::text AS "lastOutboundAt",last_error AS "lastError",created_at::text AS "createdAt",updated_at::text AS "updatedAt",pairing_link_hash AS "pairingLinkHash",pairing_failed_attempts AS "pairingFailedAttempts"`;
const sessionColumns=`id,connection_id AS "connectionId",external_chat_id AS "externalChatId",external_thread_id AS "externalThreadId",runtime_conversation_id AS "runtimeConversationId",active_company_id AS "activeCompanyId",active_agent_id AS "activeAgentId",created_at::text AS "createdAt",updated_at::text AS "updatedAt"`;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
/** Audit L8: wrong 6-digit pairing codes tolerated before the code is voided. */
export const PAIRING_MAX_FAILED_ATTEMPTS=5;
function view(item:MessagingConnection):MessagingConnectionView{const{webhookSecret:_s,encryptedCredential:_c,pairingCodeHash:_p,pairingLinkHash:_l,...safe}=item;return{...safe,settings:normalizeSettings(item.settings)};}

export class MessagingIntegrationsRepository{
  private readonly pool?:Pool; private readonly memory=new Map<string,MessagingConnection>();
  private readonly sessions=new Map<string,MessagingSession>(); private readonly inboundEvents=new Set<string>(); private lastInboundCleanupAt=0;
  constructor(databaseUrl?:string,pool?:Pool,private readonly vault=new CryptoVault()){this.pool=pool??(databaseUrl?.trim()?new Pool({connectionString:databaseUrl,max:5}):undefined);}
  async list(ctx: AuthContext, companyId?: string, activeEmailIds?: ReadonlySet<string>): Promise<MessagingConnectionView[]> {
    if (this.pool) {
      const result = await this.pool.query<MessagingConnection>(`
        SELECT ${columns} FROM messaging_connections
        WHERE workspace_id = $1 AND user_id = $2 AND ($3::text IS NULL OR company_id = $3)
          AND (channel <> 'email' OR EXISTS (
            SELECT 1 FROM company_email_accounts account
            WHERE account.id = messaging_connections.id
              AND account.workspace_id = messaging_connections.workspace_id
              AND account.user_id = messaging_connections.user_id AND account.deleted_at IS NULL
          ))
        ORDER BY created_at DESC`, [ctx.workspaceId, ctx.userId, companyId ?? null]);
      return result.rows.map(view);
    }
    return [...this.memory.values()].filter(item => item.workspaceId === ctx.workspaceId && item.userId === ctx.userId
      && (!companyId || item.companyId === companyId)
      && (item.channel !== "email" || !activeEmailIds || activeEmailIds.has(item.id))).map(view);
  }
  async createTelegram(ctx:AuthContext,companyId:string|null,input:{displayName:string;botToken:string;botUsername?:string;agentId?:string|null;scope?:MessagingConnectionScope}){
    const id=randomUUID(),now=new Date().toISOString(),pairingCode=String(randomInt(100000,1000000));
    const scope=input.scope??(input.agentId?"agent":"company");
    const item:MessagingConnection={id,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,agentId:input.agentId||null,scope,activeCompanyId:scope==="account"?null:companyId,activeAgentId:scope==="agent"?input.agentId||null:null,channel:"telegram",provider:null,displayName:input.displayName.trim(),status:"pending",botUsername:input.botUsername||null,permissions:[...new Set(ctx.permissions)],settings:defaultMessagingConnectionSettings(),webhookSecret:randomBytes(32).toString("hex"),encryptedCredential:this.vault.encrypt(input.botToken),pairingCodeHash:hash(pairingCode),pairingExpiresAt:new Date(Date.now()+900_000).toISOString(),createdAt:now,updatedAt:now};
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`INSERT INTO messaging_connections(id,workspace_id,user_id,company_id,agent_id,connection_scope,active_company_id,active_agent_id,channel,display_name,status,bot_username,permissions,webhook_secret,encrypted_credential,pairing_code_hash,pairing_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${columns}`,[id,item.workspaceId,item.userId,item.companyId,item.agentId,item.scope,item.activeCompanyId,item.activeAgentId,item.channel,item.displayName,item.status,item.botUsername,item.permissions,item.webhookSecret,item.encryptedCredential,item.pairingCodeHash,item.pairingExpiresAt]);{const created=result.rows[0]!;const pairingLinkToken=await this.rotatePairingLink(created);return{connection:view(created),pairingCode,pairingLinkToken,webhookSecret:created.webhookSecret};}}
    this.memory.set(id,item);const pairingLinkToken=await this.rotatePairingLink(item);return{connection:view(item),pairingCode,pairingLinkToken,webhookSecret:item.webhookSecret};
  }
  async createDiscord(ctx:AuthContext,companyId:string|null,input:{displayName:string;credential:string;botUsername:string;agentId?:string|null;scope?:MessagingConnectionScope}){
    const id=randomUUID(),now=new Date().toISOString(),scope=input.scope??"account",pairingCode=String(randomInt(100000,1000000));
    const item:MessagingConnection={id,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,agentId:input.agentId||null,scope,activeCompanyId:scope==="account"?null:companyId,activeAgentId:scope==="agent"?input.agentId||null:null,channel:"discord",provider:null,displayName:input.displayName.trim(),status:"pending",botUsername:input.botUsername,permissions:[...new Set(ctx.permissions)],settings:defaultMessagingConnectionSettings(),webhookSecret:randomBytes(32).toString("hex"),encryptedCredential:this.vault.encrypt(input.credential),pairingCodeHash:hash(pairingCode),pairingExpiresAt:new Date(Date.now()+900_000).toISOString(),createdAt:now,updatedAt:now};
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`INSERT INTO messaging_connections(id,workspace_id,user_id,company_id,agent_id,connection_scope,active_company_id,active_agent_id,channel,provider,display_name,status,bot_username,permissions,settings,webhook_secret,encrypted_credential,pairing_code_hash,pairing_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'discord',NULL,$9,'pending',$10,$11,$12::jsonb,$13,$14,$15,$16) RETURNING ${columns}`,[id,item.workspaceId,item.userId,item.companyId,item.agentId,item.scope,item.activeCompanyId,item.activeAgentId,item.displayName,item.botUsername,item.permissions,JSON.stringify(item.settings),item.webhookSecret,item.encryptedCredential,item.pairingCodeHash,item.pairingExpiresAt]);{const created=result.rows[0]!;const pairingLinkToken=await this.rotatePairingLink(created);return{connection:view(created),pairingCode,pairingLinkToken,webhookSecret:created.webhookSecret};}}
    this.memory.set(id,item);const pairingLinkToken=await this.rotatePairingLink(item);return{connection:view(item),pairingCode,pairingLinkToken,webhookSecret:item.webhookSecret};
  }
  async createSlack(ctx:AuthContext,companyId:string|null,input:{displayName:string;credential:string;botUsername:string;agentId?:string|null;scope?:MessagingConnectionScope}){
    const id=randomUUID(),now=new Date().toISOString(),scope=input.scope??"account",pairingCode=String(randomInt(100000,1000000));
    const item:MessagingConnection={id,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,agentId:input.agentId||null,scope,activeCompanyId:scope==="account"?null:companyId,activeAgentId:scope==="agent"?input.agentId||null:null,channel:"slack",provider:null,displayName:input.displayName.trim(),status:"pending",botUsername:input.botUsername,permissions:[...new Set(ctx.permissions)],settings:defaultMessagingConnectionSettings(),webhookSecret:randomBytes(32).toString("hex"),encryptedCredential:this.vault.encrypt(input.credential),pairingCodeHash:hash(pairingCode),pairingExpiresAt:new Date(Date.now()+900_000).toISOString(),createdAt:now,updatedAt:now};
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`INSERT INTO messaging_connections(id,workspace_id,user_id,company_id,agent_id,connection_scope,active_company_id,active_agent_id,channel,provider,display_name,status,bot_username,permissions,settings,webhook_secret,encrypted_credential,pairing_code_hash,pairing_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'slack',NULL,$9,'pending',$10,$11,$12::jsonb,$13,$14,$15,$16) RETURNING ${columns}`,[id,item.workspaceId,item.userId,item.companyId,item.agentId,item.scope,item.activeCompanyId,item.activeAgentId,item.displayName,item.botUsername,item.permissions,JSON.stringify(item.settings),item.webhookSecret,item.encryptedCredential,item.pairingCodeHash,item.pairingExpiresAt]);{const created=result.rows[0]!;const pairingLinkToken=await this.rotatePairingLink(created);return{connection:view(created),pairingCode,pairingLinkToken,webhookSecret:created.webhookSecret};}}
    this.memory.set(id,item);const pairingLinkToken=await this.rotatePairingLink(item);return{connection:view(item),pairingCode,pairingLinkToken,webhookSecret:item.webhookSecret};
  }
  async createWhatsApp(ctx:AuthContext,companyId:string|null,input:{displayName:string;provider:WhatsAppProvider;credential:string;agentId?:string|null;scope?:MessagingConnectionScope}){
    const id=randomUUID(),now=new Date().toISOString(),scope=input.scope??"account";
    const item:MessagingConnection={id,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,agentId:input.agentId||null,scope,activeCompanyId:scope==="account"?null:companyId,activeAgentId:scope==="agent"?input.agentId||null:null,channel:"whatsapp",provider:input.provider,displayName:input.displayName.trim(),status:"pending",permissions:[...new Set(ctx.permissions)],settings:defaultMessagingConnectionSettings(),webhookSecret:randomBytes(32).toString("hex"),encryptedCredential:this.vault.encrypt(input.credential),createdAt:now,updatedAt:now};
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`INSERT INTO messaging_connections(id,workspace_id,user_id,company_id,agent_id,connection_scope,active_company_id,active_agent_id,channel,provider,display_name,status,permissions,settings,webhook_secret,encrypted_credential) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16) RETURNING ${columns}`,[id,item.workspaceId,item.userId,item.companyId,item.agentId,item.scope,item.activeCompanyId,item.activeAgentId,item.channel,item.provider,item.displayName,item.status,item.permissions,JSON.stringify(item.settings),item.webhookSecret,item.encryptedCredential]);return{connection:view(result.rows[0]!),webhookSecret:result.rows[0]!.webhookSecret};}
    this.memory.set(id,item);return{connection:view(item),webhookSecret:item.webhookSecret};
  }
  async ensureEmailConnection(account:CompanyEmailAccount,permissions:string[]):Promise<MessagingConnection>{
    const existing=await this.getInternal(account.id),now=new Date().toISOString();
    const scope:MessagingConnectionScope=account.connectionScope;
    const companyId=scope==="account"?null:account.companyId;
    const status:MessagingConnectionStatus=account.status==="connected"?"connected":account.status==="pending"?"pending":account.status==="disabled"?"paused":"error";
    const settings=defaultMessagingConnectionSettings();
    settings.access.allowedUserIds=[...account.allowedSenders,...account.allowedDomains.map((domain)=>`*@${domain}`)];
    settings.delivery.typing=false;
    settings.delivery.progressive=false;
    const updates = {
      companyId,agentId:scope==="agent"?account.agentId||null:null,scope,
      activeCompanyId:scope==="account"?null:companyId,activeAgentId:scope==="agent"?account.agentId||null:null,
      displayName:account.displayName||account.emailAddress,status,permissions:[...new Set(permissions)],settings,
    };
    if (existing && (Object.keys(updates) as (keyof typeof updates)[]).every(key => isDeepStrictEqual(existing[key], updates[key]))) return existing;
    const item:MessagingConnection=existing?{...existing,...updates,updatedAt:now}:{
      id:account.id,workspaceId:account.workspaceId,userId:account.userId,companyId,
      agentId:scope==="agent"?account.agentId||null:null,scope,channel:"email",provider:null,
      activeCompanyId:scope==="account"?null:companyId,activeAgentId:scope==="agent"?account.agentId||null:null,
      displayName:account.displayName||account.emailAddress,status,botUsername:account.emailAddress,
      permissions:[...new Set(permissions)],settings,webhookSecret:randomBytes(32).toString("hex"),
      encryptedCredential:this.vault.encrypt(account.id),createdAt:now,updatedAt:now,
    };
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`INSERT INTO messaging_connections
      (id,workspace_id,user_id,company_id,agent_id,connection_scope,active_company_id,active_agent_id,channel,provider,display_name,status,bot_username,permissions,settings,webhook_secret,encrypted_credential)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'email',NULL,$9,$10,$11,$12,$13::jsonb,$14,$15)
      ON CONFLICT(id) DO UPDATE SET company_id=EXCLUDED.company_id,agent_id=EXCLUDED.agent_id,connection_scope=EXCLUDED.connection_scope,active_company_id=EXCLUDED.active_company_id,active_agent_id=EXCLUDED.active_agent_id,display_name=EXCLUDED.display_name,status=EXCLUDED.status,bot_username=EXCLUDED.bot_username,permissions=EXCLUDED.permissions,settings=EXCLUDED.settings,updated_at=now()
      RETURNING ${columns}`,[item.id,item.workspaceId,item.userId,item.companyId,item.agentId,item.scope,item.activeCompanyId,item.activeAgentId,item.displayName,item.status,item.botUsername,item.permissions,JSON.stringify(item.settings),item.webhookSecret,item.encryptedCredential]);return result.rows[0]!;}
    this.memory.set(item.id,item);return item;
  }
  async get(ctx:AuthContext,companyId:string,id:string):Promise<MessagingConnection|null>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND company_id=$4`,[id,ctx.workspaceId,ctx.userId,companyId]);return result.rows[0]??null;}const item=this.memory.get(id);return item?.workspaceId===ctx.workspaceId&&item.userId===ctx.userId&&item.companyId===companyId?item:null;}
  async getOwned(ctx:AuthContext,id:string):Promise<MessagingConnection|null>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,[id,ctx.workspaceId,ctx.userId]);return result.rows[0]??null;}const item=this.memory.get(id);return item?.workspaceId===ctx.workspaceId&&item.userId===ctx.userId?item:null;}
  async getInternal(id:string):Promise<MessagingConnection|null>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE id=$1`,[id]);return result.rows[0]??null;}return this.memory.get(id)??null;}
  async updateOwned(ctx:AuthContext,id:string,input:{displayName:string;scope:MessagingConnectionScope;companyId:string|null;agentId:string|null;settings:MessagingConnectionSettings}):Promise<MessagingConnectionView>{
    const settings=normalizeSettings(input.settings),activeCompanyId=input.scope==="account"?null:input.companyId,activeAgentId=input.scope==="agent"?input.agentId:null;
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`UPDATE messaging_connections SET display_name=$4,connection_scope=$5,company_id=$6,agent_id=$7,active_company_id=$8,active_agent_id=$9,settings=$10::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING ${columns}`,[id,ctx.workspaceId,ctx.userId,input.displayName.trim(),input.scope,input.companyId,input.agentId,activeCompanyId,activeAgentId,JSON.stringify(settings)]);if(!result.rows[0])throw Object.assign(new Error("Connection not found"),{status:404});return view(result.rows[0]);}
    const item=await this.getOwned(ctx,id);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});Object.assign(item,{displayName:input.displayName.trim(),scope:input.scope,companyId:input.companyId,agentId:input.agentId,activeCompanyId,activeAgentId,settings,updatedAt:new Date().toISOString()});return view(item);
  }
  async issuePairing(item:MessagingConnection,clearAccess=true){const pairingCode=String(randomInt(100000,1000000)),pairingCodeHash=hash(pairingCode),pairingExpiresAt=new Date(Date.now()+900_000).toISOString();if(this.pool)await this.pool.query(`UPDATE messaging_connections SET status='pending',external_user_id=CASE WHEN $4 THEN NULL ELSE external_user_id END,external_chat_id=CASE WHEN $4 THEN NULL ELSE external_chat_id END,external_thread_id=CASE WHEN $4 THEN NULL ELSE external_thread_id END,pairing_code_hash=$2,pairing_expires_at=$3,updated_at=now() WHERE id=$1`,[item.id,pairingCodeHash,pairingExpiresAt,clearAccess]);Object.assign(item,{status:"pending" as const,pairingCodeHash,pairingExpiresAt,...(clearAccess?{externalUserId:null,externalChatId:null,externalThreadId:null}:{})});const pairingLinkToken=await this.rotatePairingLink(item);return{pairingCode,pairingCommand:`/connect ${pairingCode}`,pairingLinkToken};}
  async replaceCredential(item:MessagingConnection,token:string,botUsername:string){const encryptedCredential=this.vault.encrypt(token);if(this.pool)await this.pool.query(`UPDATE messaging_connections SET encrypted_credential=$2,bot_username=$3,last_error=NULL,updated_at=now() WHERE id=$1`,[item.id,encryptedCredential,botUsername]);item.encryptedCredential=encryptedCredential;item.botUsername=botUsername;return this.issuePairing(item,true);}
  async setStatus(item:MessagingConnection,status:MessagingConnectionStatus){if(this.pool)await this.pool.query(`UPDATE messaging_connections SET status=$2,updated_at=now() WHERE id=$1`,[item.id,status]);item.status=status;item.updatedAt=new Date().toISOString();}
  async listSessionsOwned(ctx:AuthContext,connectionId:string):Promise<MessagingSession[]>{const owned=await this.getOwned(ctx,connectionId);if(!owned)return[];if(this.pool){const result=await this.pool.query<MessagingSession>(`SELECT ${sessionColumns} FROM messaging_sessions WHERE connection_id=$1 ORDER BY updated_at DESC LIMIT 100`,[connectionId]);return result.rows;}return[...this.sessions.values()].filter((item)=>item.connectionId===connectionId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  async getByWebhookSecret(secret:string,channel?:MessagingChannel):Promise<MessagingConnection|null>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE webhook_secret=$1 AND ($2::text IS NULL OR channel=$2)`,[secret,channel||null]);return result.rows[0]??null;}return[...this.memory.values()].find((item)=>item.webhookSecret===secret&&(!channel||item.channel===channel))??null;}
  async listWhatsAppQr():Promise<MessagingConnection[]>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE channel='whatsapp' AND provider='qr' AND status<>'paused'`);return result.rows;}return[...this.memory.values()].filter((item)=>item.channel==="whatsapp"&&item.provider==="qr"&&item.status!=="paused");}
  async listSlack():Promise<MessagingConnection[]>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE channel='slack' AND status<>'paused'`);return result.rows.map((item)=>({...item,settings:normalizeSettings(item.settings)}));}return[...this.memory.values()].filter((item)=>item.channel==="slack"&&item.status!=="paused");}
  async listDiscord():Promise<MessagingConnection[]>{if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE channel='discord' AND status<>'paused'`);return result.rows.map((item)=>({...item,settings:normalizeSettings(item.settings)}));}return[...this.memory.values()].filter((item)=>item.channel==="discord"&&item.status!=="paused");}
  async allowDiscordGuild(item:MessagingConnection,guildId:string){const settings=normalizeSettings(item.settings);if(settings.discord.allowedGuildIds.includes(guildId))return;settings.discord.allowedGuildIds.push(guildId);if(this.pool)await this.pool.query(`UPDATE messaging_connections SET settings=$2::jsonb,updated_at=now() WHERE id=$1`,[item.id,JSON.stringify(settings)]);item.settings=settings;item.updatedAt=new Date().toISOString();}
  async listConnectedForCompany(workspaceId:string,userId:string,companyId:string,agentId?:string|null):Promise<MessagingConnection[]>{
    if(this.pool){const result=await this.pool.query<MessagingConnection>(`SELECT ${columns} FROM messaging_connections WHERE workspace_id=$1 AND user_id=$2 AND status='connected' AND (connection_scope='account' OR (company_id=$3 AND (agent_id IS NULL OR $4::text IS NULL OR agent_id=$4)))`,[workspaceId,userId,companyId,agentId||null]);return result.rows;}
    return[...this.memory.values()].filter((item)=>item.workspaceId===workspaceId&&item.userId===userId&&item.status==="connected"&&(item.scope==="account"||(item.companyId===companyId&&(!item.agentId||!agentId||item.agentId===agentId))));
  }
  resolveToken(item:MessagingConnection){return this.vault.decrypt(item.encryptedCredential);}
  async replaceEncryptedCredential(item:MessagingConnection,credential:string){const encrypted=this.vault.encrypt(credential);if(this.pool)await this.pool.query(`UPDATE messaging_connections SET encrypted_credential=$2,updated_at=now() WHERE id=$1`,[item.id,encrypted]);item.encryptedCredential=encrypted;item.updatedAt=new Date().toISOString();}
  async markConnected(item:MessagingConnection,externalUserId:string,externalChatId?:string|null){if(this.pool)await this.pool.query(`UPDATE messaging_connections SET status='connected',external_user_id=$2,external_chat_id=COALESCE($3,external_chat_id),last_error=NULL,updated_at=now() WHERE id=$1`,[item.id,externalUserId,externalChatId||null]);Object.assign(item,{status:"connected" as const,externalUserId,externalChatId:externalChatId||item.externalChatId||null,lastError:null,updatedAt:new Date().toISOString()});}
  async setError(item:MessagingConnection,error:string){if(this.pool)await this.pool.query(`UPDATE messaging_connections SET status='error',last_error=$2,updated_at=now() WHERE id=$1`,[item.id,error]);Object.assign(item,{status:"error" as const,lastError:error,updatedAt:new Date().toISOString()});}
  async setRuntimeConversationId(item:MessagingConnection,conversationId:string):Promise<string>{
    if(this.pool){const result=await this.pool.query<{runtimeConversationId:string}>(`UPDATE messaging_connections SET runtime_conversation_id=COALESCE(runtime_conversation_id,$2),updated_at=now() WHERE id=$1 RETURNING runtime_conversation_id AS "runtimeConversationId"`,[item.id,conversationId]);return result.rows[0]?.runtimeConversationId||conversationId;}
    item.runtimeConversationId ||= conversationId;item.updatedAt=new Date().toISOString();return item.runtimeConversationId;
  }
  private sessionKey(connectionId:string,chatId:string,threadId?:string|null){return `${connectionId}:${chatId}:${threadId||""}`;}
  async hasSession(item:MessagingConnection,chatId:string,threadId?:string|null):Promise<boolean>{const normalized=threadId||"";if(this.pool){const result=await this.pool.query(`SELECT 1 FROM messaging_sessions WHERE connection_id=$1 AND external_chat_id=$2 AND external_thread_id=$3 LIMIT 1`,[item.id,chatId,normalized]);return Boolean(result.rowCount);}return this.sessions.has(this.sessionKey(item.id,chatId,normalized));}
  async getOrCreateSession(item:MessagingConnection,chatId:string,threadId?:string|null):Promise<MessagingSession>{
    const normalizedThread=threadId||"",legacyConversation=item.externalChatId===chatId&&(item.externalThreadId||"")===normalizedThread?item.runtimeConversationId||null:null;
    if(this.pool){
      const id=randomUUID();
      const result=await this.pool.query<MessagingSession>(`INSERT INTO messaging_sessions(id,connection_id,external_chat_id,external_thread_id,runtime_conversation_id,active_company_id,active_agent_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(connection_id,external_chat_id,external_thread_id) DO UPDATE SET updated_at=now()
        RETURNING ${sessionColumns}`,[id,item.id,chatId,normalizedThread,legacyConversation,item.activeCompanyId||null,item.activeAgentId||null]);
      return result.rows[0]!;
    }
    const key=this.sessionKey(item.id,chatId,normalizedThread),existing=this.sessions.get(key);if(existing){existing.updatedAt=new Date().toISOString();return existing;}
    const now=new Date().toISOString(),created:MessagingSession={id:randomUUID(),connectionId:item.id,externalChatId:chatId,externalThreadId:normalizedThread,runtimeConversationId:legacyConversation,activeCompanyId:item.activeCompanyId||null,activeAgentId:item.activeAgentId||null,createdAt:now,updatedAt:now};this.sessions.set(key,created);return created;
  }
  async setSessionConversation(session:MessagingSession,conversationId:string|null):Promise<void>{
    if(this.pool)await this.pool.query(`UPDATE messaging_sessions SET runtime_conversation_id=$2,updated_at=now() WHERE id=$1`,[session.id,conversationId]);
    session.runtimeConversationId=conversationId;session.updatedAt=new Date().toISOString();
  }
  async claimInbound(item:MessagingConnection,eventId:string,messageId?:string):Promise<boolean>{
    if(this.pool){if(Date.now()-this.lastInboundCleanupAt>3_600_000){this.lastInboundCleanupAt=Date.now();await this.pool.query(`DELETE FROM messaging_inbound_events WHERE received_at < now() - interval '30 days'`);}const result=await this.pool.query(`INSERT INTO messaging_inbound_events(connection_id,event_id,message_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[item.id,eventId,messageId||null]);return Boolean(result.rowCount);}
    const key=`${item.id}:${eventId}`;if(this.inboundEvents.has(key))return false;this.inboundEvents.add(key);if(this.inboundEvents.size>10_000){for(const old of [...this.inboundEvents].slice(0,2_000))this.inboundEvents.delete(old);}return true;
  }
  async hasInboundEvent(item:MessagingConnection,eventId:string):Promise<boolean>{if(this.pool){const result=await this.pool.query(`SELECT 1 FROM messaging_inbound_events WHERE connection_id=$1 AND event_id=$2`,[item.id,eventId]);return Boolean(result.rowCount);}return this.inboundEvents.has(`${item.id}:${eventId}`);}
  async touchRoute(item:MessagingConnection,threadId?:string|null,chatId?:string|null):Promise<void>{
    if(this.pool)await this.pool.query(`UPDATE messaging_connections SET external_thread_id=$2,external_chat_id=COALESCE($3,external_chat_id),last_inbound_at=now(),updated_at=now() WHERE id=$1`,[item.id,threadId||null,chatId||null]);
    item.externalThreadId=threadId||null;if(chatId)item.externalChatId=chatId;item.lastInboundAt=new Date().toISOString();item.updatedAt=new Date().toISOString();
  }
  async setActiveContext(item:MessagingConnection,companyId:string|null,agentId:string|null,session?:MessagingSession):Promise<void>{
    if(session){if(this.pool)await this.pool.query(`UPDATE messaging_sessions SET active_company_id=$2,active_agent_id=$3,updated_at=now() WHERE id=$1`,[session.id,companyId,agentId]);session.activeCompanyId=companyId;session.activeAgentId=agentId;session.updatedAt=new Date().toISOString();return;}
    if(this.pool){await this.pool.query(`UPDATE messaging_connections SET active_company_id=$2,active_agent_id=$3,updated_at=now() WHERE id=$1`,[item.id,companyId,agentId]);}
    else{item.activeCompanyId=companyId;item.activeAgentId=agentId;item.updatedAt=new Date().toISOString();}
  }
  /**
   * Security audit 2026-11-24, L8. Two ways to pair, both expiring with the pairing window:
   *  - a deep link (`t.me/<bot>?start=<token>`) carrying a 128-bit token: unguessable, so failed attempts are not counted
   *    and a stranger cannot burn it;
   *  - the 6-digit `/connect` code as a fallback: PAIRING_MAX_FAILED_ATTEMPTS wrong codes void it until the owner issues
   *    a new one.
   * The binding and the attempt counter are single conditional UPDATEs, so concurrent guesses cannot outrun the limit.
   */
  private async rotatePairingLink(item:MessagingConnection):Promise<string>{
    const pairingLinkToken=randomBytes(16).toString("base64url"),pairingLinkHash=hash(pairingLinkToken);
    if(this.pool)await this.pool.query(`UPDATE messaging_connections SET pairing_link_hash=$2,pairing_failed_attempts=0 WHERE id=$1`,[item.id,pairingLinkHash]);
    Object.assign(item,{pairingLinkHash,pairingFailedAttempts:0});
    return pairingLinkToken;
  }
  async bind(item:MessagingConnection,input:{pairingCode?:string;pairingLinkToken?:string;externalUserId:string;externalChatId:string;externalThreadId?:string|null}){
    const byLink=typeof input.pairingLinkToken==="string"&&input.pairingLinkToken.length>=16;
    const candidate=hash(byLink?input.pairingLinkToken!:String(input.pairingCode??""));
    if(this.pool){
      const column=byLink?"pairing_link_hash":"pairing_code_hash";
      const limit=byLink?"":` AND pairing_failed_attempts<${PAIRING_MAX_FAILED_ATTEMPTS}`;
      const bound=await this.pool.query(`UPDATE messaging_connections SET status='connected',external_user_id=$2,external_chat_id=$3,external_thread_id=$4,pairing_code_hash=NULL,pairing_link_hash=NULL,pairing_failed_attempts=0,pairing_expires_at=NULL,last_inbound_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND ${column}=$5 AND pairing_expires_at>now()${limit}`,[item.id,input.externalUserId,input.externalChatId,input.externalThreadId||null,candidate]);
      if(bound.rowCount)return true;
      if(!byLink)await this.pool.query(`UPDATE messaging_connections SET pairing_failed_attempts=pairing_failed_attempts+1,pairing_code_hash=CASE WHEN pairing_failed_attempts+1>=${PAIRING_MAX_FAILED_ATTEMPTS} THEN NULL ELSE pairing_code_hash END,updated_at=now() WHERE id=$1 AND pairing_code_hash IS NOT NULL`,[item.id]);
      return false;
    }
    const live=this.memory.get(item.id)??item;
    const expired=!live.pairingExpiresAt||Date.parse(live.pairingExpiresAt)<Date.now();
    const expected=byLink?live.pairingLinkHash:live.pairingCodeHash;
    if(expired||!expected||(!byLink&&(live.pairingFailedAttempts??0)>=PAIRING_MAX_FAILED_ATTEMPTS)||candidate!==expected){
      if(!byLink&&live.pairingCodeHash){live.pairingFailedAttempts=(live.pairingFailedAttempts??0)+1;if(live.pairingFailedAttempts>=PAIRING_MAX_FAILED_ATTEMPTS)live.pairingCodeHash=null;}
      return false;
    }
    Object.assign(live,{status:"connected" as const,externalUserId:input.externalUserId,externalChatId:input.externalChatId,externalThreadId:input.externalThreadId||null,pairingCodeHash:null,pairingLinkHash:null,pairingFailedAttempts:0,pairingExpiresAt:null,lastInboundAt:new Date().toISOString(),lastError:null,updatedAt:new Date().toISOString()});
    if(live!==item)Object.assign(item,live);
    return true;
  }
  async record(id:string,direction:"inbound"|"outbound",error?:string|null){const field=direction==="inbound"?"last_inbound_at":"last_outbound_at";if(this.pool){await this.pool.query(`UPDATE messaging_connections SET ${field}=now(),last_error=$2,updated_at=now() WHERE id=$1`,[id,error||null]);return;}const item=this.memory.get(id);if(item){if(direction==="inbound")item.lastInboundAt=new Date().toISOString();else item.lastOutboundAt=new Date().toISOString();item.lastError=error||null;item.updatedAt=new Date().toISOString();}}
  async delete(ctx:AuthContext,companyId:string,id:string){if(this.pool)return Boolean((await this.pool.query(`DELETE FROM messaging_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND company_id=$4`,[id,ctx.workspaceId,ctx.userId,companyId])).rowCount);return await this.get(ctx,companyId,id)?this.memory.delete(id):false;}
  async deleteOwned(ctx:AuthContext,id:string){if(this.pool)return Boolean((await this.pool.query(`DELETE FROM messaging_connections WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,[id,ctx.workspaceId,ctx.userId])).rowCount);return await this.getOwned(ctx,id)?this.memory.delete(id):false;}
  async close(){if(this.pool)await this.pool.end().catch(()=>undefined);}
}
