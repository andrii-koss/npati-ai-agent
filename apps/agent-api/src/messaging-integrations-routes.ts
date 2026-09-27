import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import { MessagingGateway, type GatewayAttachment } from "./messaging-gateway";
import type { MessagingConnection, MessagingIntegrationsRepository } from "./messaging-integrations-repository";

const channels = [
  { id: "telegram", name: "Telegram", available: true, capabilities: ["Chat", "Tasks", "Files", "Automations", "Company actions"] },
  { id: "discord", name: "Discord", available: false, capabilities: [] },
  { id: "slack", name: "Slack", available: false, capabilities: [] },
  { id: "whatsapp", name: "WhatsApp", available: false, capabilities: [] },
  { id: "email", name: "Email", available: false, capabilities: [] },
];
function allowed(ctx: AuthContext, permission: string) { return ctx.permissions.some((p)=>["*","owner","admin:all",permission].includes(p)) || (permission === "business:manage" && ctx.permissions.includes("workspace:write")); }
async function authenticate(auth:AuthProvider,r:FastifyRequest,permission:string){const ctx=await auth.authenticate(r);if(!allowed(ctx,permission))throw new WorkspaceAccessError(`Missing permission: ${permission}`);return ctx;}
function failure(reply:any,error:unknown){const status=Number((error as any)?.status ?? (error instanceof WorkspaceAccessError?403:400));return reply.code(status).send({error:{code:(error as any)?.code||"MESSAGING_INTEGRATION_ERROR",message:error instanceof Error?error.message:String(error)}});}
function runtimeContext(connection:MessagingConnection):AuthContext{return {workspaceId:connection.workspaceId,userId:connection.userId,companyId:connection.companyId||connection.activeCompanyId||undefined,permissions:connection.permissions};}

export function registerMessagingIntegrationRoutes(app:FastifyInstance,deps:{
  auth:AuthProvider; store:WorkspaceStore; repo:MessagingIntegrationsRepository; gateway:MessagingGateway;
  webhookBaseUrl?:string;
  handleMessage:(input:{context:AuthContext;connection:MessagingConnection;text:string;attachments:GatewayAttachment[];conversationId?:string})=>Promise<{message:string}>;
}){
  const {auth,store,repo,gateway}=deps;
  app.get("/integrations/channels",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read");return {channels,connections:await repo.list(ctx)};}catch(e){return failure(reply,e);}});
  app.post<{Body:{displayName?:string;botToken?:string;scope?:"account"|"company"|"agent";companyId?:string;agentId?:string}}>("/integrations/telegram",async(r,reply)=>{
    try{
      const ctx=await authenticate(auth,r,"business:manage"),scope=r.body?.scope||"account";
      const companyId=scope==="account"?null:r.body?.companyId?.trim()||null;
      const agentId=scope==="agent"?r.body?.agentId?.trim()||null:null;
      if(scope!=="account"&&!companyId)throw new Error("Company is required for this connection scope");
      if(scope==="agent"&&!agentId)throw new Error("Agent is required for Specific Agent scope");
      if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
      const token=r.body?.botToken?.trim();if(!token)throw new Error("Telegram bot token is required");
      const base=deps.webhookBaseUrl?.replace(/\/+$/,"");if(!base)throw Object.assign(new Error("Set NPATI_MESSAGING_WEBHOOK_BASE_URL to the public HTTPS origin before connecting Telegram"),{status:503,code:"TELEGRAM_WEBHOOK_URL_REQUIRED"});
      const adapter=gateway.adapter("telegram"),bot=await adapter.validateCredential(token);
      const created=await repo.createTelegram(ctx,companyId,{scope,displayName:r.body?.displayName?.trim()||bot.externalName,botToken:token,botUsername:bot.externalName,agentId});
      const webhookUrl=`${base}/api/v1/integrations/telegram/${created.webhookSecret}`;
      try{await adapter.configureWebhook(token,webhookUrl,created.webhookSecret);}catch(error){await repo.deleteOwned(ctx,created.connection.id);throw error;}
      return reply.code(201).send({connection:created.connection,pairingCode:created.pairingCode,pairingCommand:`/connect ${created.pairingCode}`,webhookUrl,webhookConfigured:true});
    }catch(e){return failure(reply,e);}
  });
  app.get<{Params:{companyId:string}}>("/companies/:companyId/integrations/messaging",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read");await store.getCompany(ctx,r.params.companyId);return {connections:await repo.list(ctx,r.params.companyId)};}catch(e){return failure(reply,e);}});
  app.post<{Params:{companyId:string};Body:{displayName?:string;botToken?:string;agentId?:string}}>("/companies/:companyId/integrations/telegram",async(r,reply)=>{
    try{
      const ctx=await authenticate(auth,r,"business:manage");await store.getCompany(ctx,r.params.companyId);
      const token=r.body?.botToken?.trim();if(!token)throw new Error("Telegram bot token is required");
      const base=deps.webhookBaseUrl?.replace(/\/+$/,"");if(!base)throw Object.assign(new Error("Set NPATI_MESSAGING_WEBHOOK_BASE_URL to the public HTTPS origin before connecting Telegram"),{status:503,code:"TELEGRAM_WEBHOOK_URL_REQUIRED"});
      if(r.body?.agentId)await store.getCompanyAgent(ctx,r.params.companyId,r.body.agentId);
      const adapter=gateway.adapter("telegram");const bot=await adapter.validateCredential(token);
      const created=await repo.createTelegram(ctx,r.params.companyId,{displayName:r.body?.displayName?.trim()||bot.externalName,botToken:token,botUsername:bot.externalName,agentId:r.body?.agentId});
      const webhookUrl=`${base}/api/v1/integrations/telegram/${created.webhookSecret}`;
      try { await adapter.configureWebhook(token,webhookUrl,created.webhookSecret); }
      catch (error) { await repo.delete(ctx,r.params.companyId,created.connection.id); throw error; }
      return reply.code(201).send({connection:created.connection,pairingCode:created.pairingCode,pairingCommand:`/connect ${created.pairingCode}`,webhookUrl,webhookConfigured:true});
    }catch(e){return failure(reply,e);}
  });
  app.post<{Params:{companyId:string;connectionId:string}}>("/companies/:companyId/integrations/messaging/:connectionId/test",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage");await store.getCompany(ctx,r.params.companyId);const item=await repo.get(ctx,r.params.companyId,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});if(!item.externalChatId)throw new Error("Open the bot and send the pairing command first");await gateway.adapter(item.channel).sendText(repo.resolveToken(item),item.externalChatId,"NPATI connection is active.",item.externalThreadId||undefined);await repo.record(item.id,"outbound");return {ok:true};}catch(e){return failure(reply,e);}});
  app.post<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/test",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});if(!item.externalChatId)throw new Error("Open the bot and send the pairing command first");await gateway.adapter(item.channel).sendText(repo.resolveToken(item),item.externalChatId,"NPATI connection is active.",item.externalThreadId||undefined);await repo.record(item.id,"outbound");return{ok:true};}catch(e){return failure(reply,e);}});
  app.delete<{Params:{companyId:string;connectionId:string}}>("/companies/:companyId/integrations/messaging/:connectionId",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage");await store.getCompany(ctx,r.params.companyId);const item=await repo.get(ctx,r.params.companyId,r.params.connectionId);if(!item)return reply.code(404).send({error:{code:"NOT_FOUND",message:"Connection not found"}});const adapter=gateway.adapter(item.channel);if(adapter.disconnect)await adapter.disconnect(repo.resolveToken(item));await repo.delete(ctx,r.params.companyId,r.params.connectionId);return reply.code(204).send();}catch(e){return failure(reply,e);}});
  app.delete<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)return reply.code(404).send({error:{code:"NOT_FOUND",message:"Connection not found"}});const adapter=gateway.adapter(item.channel);if(adapter.disconnect)await adapter.disconnect(repo.resolveToken(item));await repo.deleteOwned(ctx,item.id);return reply.code(204).send();}catch(e){return failure(reply,e);}});

  app.post<{Params:{secret:string};Body:unknown}>("/api/v1/integrations/telegram/:secret",async(r,reply)=>{
    const connection=await repo.getByWebhookSecret(r.params.secret);
    if(!connection)return reply.code(404).send({error:{code:"INVALID_CONNECTION",message:"Telegram connection not found"}});
    if(r.headers["x-telegram-bot-api-secret-token"]!==connection.webhookSecret)return reply.code(401).send({error:{code:"INVALID_WEBHOOK_SIGNATURE",message:"Invalid Telegram webhook signature"}});
    try{
      const token=repo.resolveToken(connection),adapter=gateway.adapter("telegram"),message=await adapter.parseInbound(r.body,token);
      if(!message)return reply.code(202).send({status:"ignored"});
      const pair=/^\/connect\s+(\d{6})$/i.exec(message.text);
      if(pair){const bound=await repo.bind(connection,{pairingCode:pair[1]!,externalUserId:message.externalUserId,externalChatId:message.externalChatId,externalThreadId:message.externalThreadId});await adapter.sendText(token,message.externalChatId,bound?"Telegram is connected to NPATI. You can now use your NPATI account.":"The pairing code is invalid or expired.",message.externalThreadId);return reply.code(200).send({status:bound?"connected":"rejected"});}
      if(connection.status!=="connected"||connection.externalUserId!==message.externalUserId||connection.externalChatId!==message.externalChatId)return reply.code(403).send({error:{code:"TELEGRAM_BINDING_MISMATCH",message:"This Telegram user/chat is not bound to the connection"}});
      const ctx=runtimeContext(connection),companyId=connection.scope==="account"?connection.activeCompanyId:connection.companyId,agentId=connection.scope==="account"?connection.activeAgentId:connection.agentId;
      if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
      if(!message.text&&!message.attachments.length) return reply.code(202).send({status:"ignored"});
      await repo.record(connection.id,"inbound");
      await adapter.sendText(token,message.externalChatId,"NPATI accepted the request and started working on it.",message.externalThreadId);
      void deps.handleMessage({context:ctx,connection,text:message.text,attachments:message.attachments,conversationId:connection.runtimeConversationId||undefined})
        .then(async(result)=>{await adapter.sendText(token,message.externalChatId,result.message,message.externalThreadId);await repo.record(connection.id,"outbound");})
        .catch(async(error)=>{const detail=error instanceof Error?error.message:String(error);await repo.record(connection.id,"outbound",detail);await adapter.sendText(token,message.externalChatId,`NPATI could not complete the request: ${detail}`,message.externalThreadId).catch(()=>undefined);});
      return reply.code(202).send({status:"accepted",messageId:message.messageId});
    }catch(e){await repo.record(connection.id,"inbound",e instanceof Error?e.message:String(e)).catch(()=>undefined);return failure(reply,e);}
  });
}
