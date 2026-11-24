import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { WorkspaceAccessError, type AuthContext, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import { MessagingGateway, type GatewayAttachment, type GatewayOutboundAttachment, type GatewayReplyContext, type InboundGatewayMessage, type MessagingAdapter } from "./messaging-gateway";
import { WhatsAppMessagingAdapter, type CloudCredential } from "./whatsapp-messaging";
import { DiscordMessagingAdapter } from "./discord-messaging";
import { SlackMessagingAdapter } from "./slack-messaging";
import type { MessagingConnection, MessagingConnectionSettings, MessagingConnectionScope, MessagingIntegrationsRepository, MessagingSession } from "./messaging-integrations-repository";
import { MessagingInboundDispatcher, WhatsAppInboundDispatcher } from "./messaging-inbound-dispatcher";
import { messagingCommandNames } from "./messaging-commands";
import type { EmailInboxRepository } from "./email-inbox-repository";
import { asAccount } from "./ai-tenant-providers";

const channels = [
  { id: "telegram", name: "Telegram", available: true, capabilities: ["Chat", "Tasks", "Files", "Automations", "Company actions"] },
  { id: "discord", name: "Discord", available: true, capabilities: ["DMs", "Servers", "Threads", "Files", "Commands", "Automations"] },
  { id: "slack", name: "Slack", available: true, capabilities: ["DMs", "Channels", "Threads", "Files", "Commands", "Automations"] },
  { id: "whatsapp", name: "WhatsApp", available: true, capabilities: ["Chat", "Tasks", "Files", "Voice", "Groups", "Automations"] },
  { id: "email", name: "Email", available: true, capabilities: ["Chat Runtime", "Company Agents", "Threads", "Files", "Approvals", "Automations"] },
];
const telegramCommands=[...messagingCommandNames];
function allowed(ctx: AuthContext, permission: string) { return ctx.permissions.some((p)=>["*","owner","admin:all",permission].includes(p)) || (permission === "business:manage" && ctx.permissions.includes("workspace:write")); }
async function authenticate(auth:AuthProvider,r:FastifyRequest,permission:string){const ctx=await auth.authenticate(r);if(!allowed(ctx,permission))throw new WorkspaceAccessError(`Missing permission: ${permission}`);return ctx;}
function failure(reply:any,error:unknown){const status=Number((error as any)?.status ?? (error instanceof WorkspaceAccessError?403:400));return reply.code(status).send({error:{code:(error as any)?.code||"MESSAGING_INTEGRATION_ERROR",message:error instanceof Error?error.message:String(error)}});}
function runtimeContext(connection:MessagingConnection):AuthContext{return {workspaceId:connection.workspaceId,userId:connection.userId,companyId:connection.companyId||connection.activeCompanyId||undefined,permissions:connection.permissions};}
function secureEqual(left:unknown,right:string){if(typeof left!=="string")return false;const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function sessionKey(connection:MessagingConnection,session:MessagingSession){return `${connection.id}:${session.externalChatId}:${session.externalThreadId}`;}

/** Audit L8: one-tap Telegram pairing (t.me deep link carrying an unguessable start token). */
export function telegramPairingLink(botUsername: string | null | undefined, token: string | undefined): string | undefined {
  const name = botUsername?.replace(/^@/, "");
  return name && token && /^[A-Za-z0-9_]{5,32}$/.test(name) ? `https://t.me/${name}?start=${token}` : undefined;
}

export function registerMessagingIntegrationRoutes(app:FastifyInstance,deps:{
  auth:AuthProvider; store:WorkspaceStore; repo:MessagingIntegrationsRepository; gateway:MessagingGateway;
  webhookBaseUrl?:string;
  emailRepo?:EmailInboxRepository;
  handleMessage:(input:{context:AuthContext;connection:MessagingConnection;session:MessagingSession;text:string;attachments:GatewayAttachment[];conversationId?:string;replyContext?:GatewayReplyContext;signal?:AbortSignal;onDelta?:(chunk:string)=>void})=>Promise<{message:string;attachments?:GatewayOutboundAttachment[]}>;
  resetConversation?:(input:{context:AuthContext;conversationId:string})=>Promise<void>;
}){
  const {auth,store,repo,gateway}=deps;
  // Inbound messages arrive without a signed-in session: the reply runs as the connection owner's account, so on a
  // hosted installation it uses that account's own AI key.
  const accountHandleMessage:typeof deps.handleMessage=(input)=>asAccount(input.context,()=>deps.handleMessage(input));
  const activeRuns=new Map<string,AbortController>();
  const whatsapp=(gateway.optionalAdapter("whatsapp") as WhatsAppMessagingAdapter|undefined)??new WhatsAppMessagingAdapter(repo);
  const whatsappDispatcher=new WhatsAppInboundDispatcher({store,repo,adapter:whatsapp,handleMessage:accountHandleMessage,resetConversation:deps.resetConversation});
  whatsapp.setInboundHandler(async(connectionId,message)=>{const connection=await repo.getInternal(connectionId);if(!connection)return;await whatsappDispatcher.dispatch(connection,message).catch(async(error)=>{await repo.record(connection.id,"inbound",error instanceof Error?error.message:String(error));});});
  const slack=(gateway.optionalAdapter("slack") as SlackMessagingAdapter|undefined)??new SlackMessagingAdapter(repo);
  const slackDispatcher=new MessagingInboundDispatcher({store,repo,adapter:slack,handleMessage:accountHandleMessage,resetConversation:deps.resetConversation});
  slack.setInboundHandler(async(connectionId,message)=>{const connection=await repo.getInternal(connectionId);if(!connection)return;await slackDispatcher.dispatch(connection,message).catch(async(error)=>{await repo.record(connection.id,"inbound",error instanceof Error?error.message:String(error));});});
  const discord=(gateway.optionalAdapter("discord") as DiscordMessagingAdapter|undefined)??new DiscordMessagingAdapter(repo);
  const discordDispatcher=new MessagingInboundDispatcher({store,repo,adapter:discord,handleMessage:accountHandleMessage,resetConversation:deps.resetConversation});
  discord.setInboundHandler(async(connectionId,message)=>{const connection=await repo.getInternal(connectionId);if(!connection)return;await discordDispatcher.dispatch(connection,message).catch(async(error)=>{await repo.record(connection.id,"inbound",error instanceof Error?error.message:String(error));});});
  const email=gateway.optionalAdapter("email");
  const emailDispatcher=email?new MessagingInboundDispatcher({store,repo,adapter:email,handleMessage:accountHandleMessage,resetConversation:deps.resetConversation}):undefined;
  async function listConnections(ctx: AuthContext, companyId?: string) {
    if (!deps.emailRepo) return repo.list(ctx, companyId);
    const accounts = await deps.emailRepo.listUserAccounts(ctx);
    const scoped = companyId ? accounts.filter(account => account.companyId === companyId && account.connectionScope !== "account") : accounts;
    await Promise.all(scoped.map(account => repo.ensureEmailConnection(account, ctx.permissions)));
    return repo.list(ctx, companyId, new Set(scoped.map(account => account.id)));
  }
  if(!app.hasContentTypeParser("application/x-www-form-urlencoded"))app.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string"},(_request,body,done)=>done(null,body));
  app.addHook("preParsing",async(request,_reply,payload)=>{if(!request.url.includes("/integrations/whatsapp/cloud/")&&!request.url.includes("/integrations/slack/http/"))return payload;const chunks:Buffer[]=[];for await(const chunk of payload)chunks.push(Buffer.from(chunk));const raw=Buffer.concat(chunks);(request as any).rawBody=raw;return Readable.from(raw);});

  app.get<{ Querystring: { includeCompanies?: string } }>("/integrations/channels", async (request, reply) => {
    try {
      const ctx = await authenticate(auth, request, "workspace:read");
      const includeCompanies = request.query.includeCompanies === "true";
      if (includeCompanies && !ctx.permissions.includes("workspace:read")) throw new WorkspaceAccessError("Missing permission: workspace:read");
      const [connections, companyPage] = await Promise.all([
        listConnections(ctx),
        includeCompanies ? store.listCompanies(ctx) : null,
      ]);
      reply.header("cache-control", "private, no-store");
      return { channels, connections, ...(companyPage ? { companies: companyPage.items.map(({ id, name }) => ({ id, name })) } : {}) };
    } catch (error) { return failure(reply, error); }
  });
  app.get<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/manage",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read"),connection=await repo.getOwned(ctx,r.params.connectionId);if(!connection)throw Object.assign(new Error("Connection not found"),{status:404});const{webhookSecret:_secret,encryptedCredential:_credential,pairingCodeHash:_pairing,...safe}=connection,discordCatalog=connection.channel==="discord"?await discord.catalog(repo.resolveToken(connection)).catch(()=>({guilds:[]})):undefined,slackCatalog=connection.channel==="slack"?await slack.catalog(repo.resolveToken(connection)).catch(()=>({workspaces:[]})):undefined,slackCredential=connection.channel==="slack"?slack.credential(repo.resolveToken(connection)):undefined;return{connection:safe,sessions:await repo.listSessionsOwned(ctx,connection.id),commands:telegramCommands,transport:connection.channel==="whatsapp"?connection.provider:connection.channel==="discord"?"gateway-websocket":connection.channel==="slack"?slackCredential?.method:"webhook",discordCatalog,slackCatalog,webhookUrl:connection.channel==="slack"&&slackCredential?.method==="http"&&deps.webhookBaseUrl?deps.webhookBaseUrl.replace(/\/+$/,"")+"/api/v1/integrations/slack/http/"+connection.webhookSecret:undefined,capabilities:{typing:connection.channel!=="slack",progressiveEditing:true,longMessageChunking:true,retryBackoff:true,deduplication:true,sessionPersistence:true,inboundMedia:["images","documents","audio","video"],outboundMedia:["images","documents"],reactions:connection.channel==="discord"||connection.channel==="slack",voiceChannel:false}};}catch(e){return failure(reply,e);}});
  app.patch<{Params:{connectionId:string};Body:{displayName?:string;scope?:MessagingConnectionScope;companyId?:string|null;agentId?:string|null;settings?:MessagingConnectionSettings}}>("/integrations/messaging/:connectionId",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),current=await repo.getOwned(ctx,r.params.connectionId);if(!current)throw Object.assign(new Error("Connection not found"),{status:404});const scope=r.body?.scope||current.scope,companyId=scope==="account"?null:(r.body?.companyId??current.companyId??null),agentId=scope==="agent"?(r.body?.agentId??current.agentId??null):null;if(scope!=="account"&&!companyId)throw new Error("Company is required for this connection scope");if(scope==="agent"&&!agentId)throw new Error("Agent is required for Specific Agent scope");if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);const connection=await repo.updateOwned(ctx,current.id,{displayName:r.body?.displayName?.trim()||current.displayName,scope,companyId,agentId,settings:r.body?.settings||current.settings});return{connection};}catch(e){return failure(reply,e);}});
  app.post<{Params:{connectionId:string};Body:{botToken?:string}}>("/integrations/messaging/:connectionId/token",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});if(item.channel!=="telegram")throw new Error("Bot tokens apply only to Telegram connections");const token=r.body?.botToken?.trim();if(!token)throw new Error("Telegram bot token is required");const adapter=gateway.adapter("telegram"),bot=await adapter.validateCredential(token),base=deps.webhookBaseUrl?.replace(/\/+$/,'');if(!base)throw Object.assign(new Error("Telegram webhook URL is not configured"),{status:503});const pairing=await repo.replaceCredential(item,token,bot.externalName);await adapter.configureWebhook(token,`${base}/api/v1/integrations/telegram/${item.webhookSecret}`,item.webhookSecret);return{connection:(await repo.list(ctx)).find((entry)=>entry.id===item.id),...pairing,pairingLink:telegramPairingLink(bot.externalName,pairing.pairingLinkToken)};}catch(e){return failure(reply,e);}});
  app.post<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/pairing",async(r,reply)=>{
    try{
      const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);
      if(!item)throw Object.assign(new Error("Connection not found"),{status:404});
      if(item.channel==="whatsapp"){if(item.provider!=="qr")throw new Error("Cloud API connections do not use QR pairing");await whatsapp.startQr(item,true);return{status:"pending"};}
      if(item.channel==="discord"||item.channel==="slack")return repo.issuePairing(item,false);
      const pairing=await repo.issuePairing(item,true);
      const base=deps.webhookBaseUrl?.replace(/\/+$/,'');
      if(base){
        try{
          await gateway.adapter(item.channel).configureWebhook(repo.resolveToken(item),`${base}/api/v1/integrations/telegram/${item.webhookSecret}`,item.webhookSecret);
        }catch{}
      }
      return {...pairing,pairingLink:telegramPairingLink(item.botUsername,pairing.pairingLinkToken)};
    }catch(e){return failure(reply,e);}
  });
  app.post<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/revoke",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});if(item.channel==="whatsapp"&&item.provider==="qr"){await whatsapp.startQr(item,true);return{ok:true};}if(item.channel==="discord"||item.channel==="slack"){await repo.issuePairing(item,false);return{ok:true};}await repo.setStatus(item,"pending");await repo.issuePairing(item,true);return{ok:true};}catch(e){return failure(reply,e);}});
  app.post<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/disconnect",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});await gateway.adapter(item.channel).disconnect?.(repo.resolveToken(item));await repo.setStatus(item,"paused");return{ok:true};}catch(e){return failure(reply,e);}});
  app.post<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/reconnect",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});if(item.channel==="whatsapp"){if(item.provider==="qr")await whatsapp.startQr(item);else{await whatsapp.validateCredential(repo.resolveToken(item));await repo.setStatus(item,"connected");}return{ok:true,status:item.status};}if(item.channel==="discord"){await discord.validateCredential(repo.resolveToken(item));await discord.start(item);return{ok:true,status:item.status};}if(item.channel==="slack"){await slack.validateCredential(repo.resolveToken(item));await slack.start(item);return{ok:true,status:item.status};}const base=deps.webhookBaseUrl?.replace(/\/+$/,'');if(!base)throw Object.assign(new Error("Telegram webhook URL is not configured"),{status:503});await gateway.adapter(item.channel).configureWebhook(repo.resolveToken(item),`${base}/api/v1/integrations/telegram/${item.webhookSecret}`,item.webhookSecret);await repo.setStatus(item,item.externalUserId&&item.externalChatId?"connected":"pending");return{ok:true,status:item.status};}catch(e){return failure(reply,e);}});
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
      return reply.code(201).send({connection:created.connection,pairingCode:created.pairingCode,pairingCommand:`/connect ${created.pairingCode}`,pairingLink:telegramPairingLink(created.connection.botUsername,created.pairingLinkToken),webhookUrl,webhookConfigured:true});
    }catch(e){return failure(reply,e);}
  });
  app.post<{Body:{displayName?:string;botToken?:string;clientId?:string;scope?:"account"|"company"|"agent";companyId?:string;agentId?:string}}>("/integrations/discord",async(r,reply)=>{
    try{
      const ctx=await authenticate(auth,r,"business:manage"),scope=r.body?.scope||"account",companyId=scope==="account"?null:r.body?.companyId?.trim()||null,agentId=scope==="agent"?r.body?.agentId?.trim()||null:null,botToken=r.body?.botToken?.trim(),clientId=r.body?.clientId?.trim();
      if(scope!=="account"&&!companyId)throw new Error("Company is required for this connection scope");if(scope==="agent"&&!agentId)throw new Error("Agent is required for Specific Agent scope");if(!botToken||!clientId)throw new Error("Discord Bot Token and Application / Client ID are required");if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
      const validationCredential=discord.createCredential("validation",botToken,clientId),setup=await discord.validateCredential(validationCredential);
      if(!setup.messageContentIntent)throw Object.assign(new Error("Enable Message Content Intent in the Discord Developer Portal before connecting"),{code:"DISCORD_MESSAGE_CONTENT_INTENT_REQUIRED"});
      const created=await repo.createDiscord(ctx,companyId,{scope,agentId,displayName:r.body?.displayName?.trim()||setup.externalName,botUsername:setup.externalName,credential:validationCredential}),item=await repo.getOwned(ctx,created.connection.id);
      if(!item)throw new Error("Discord connection creation failed");const credential=discord.createCredential(item.id,botToken,clientId);await repo.replaceEncryptedCredential(item,credential);
      try{await discord.registerCommands(credential);await discord.start(item);}catch(error){await repo.deleteOwned(ctx,item.id);throw error;}
      return reply.code(201).send({connection:(await repo.list(ctx)).find((value)=>value.id===item.id),pairingCode:created.pairingCode,pairingCommand:`/connect ${created.pairingCode}`,inviteUrl:setup.inviteUrl,intents:{messageContent:true,required:setup.requiredIntents},permissions:{required:setup.missingPermissions.length===0,missingGuildIds:setup.missingPermissions},bot:{id:setup.botId,name:setup.externalName}});
    }catch(error){return failure(reply,error);}
  });
  app.get<{Params:{connectionId:string}}>("/integrations/discord/:connectionId/setup",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item||item.channel!=="discord")throw Object.assign(new Error("Discord connection not found"),{status:404});const setup=await discord.validateCredential(repo.resolveToken(item));return{...setup,status:item.status};}catch(error){return failure(reply,error);}});
  app.post<{Body:{method?:"socket"|"http"}}>("/integrations/slack/manifest",async(r,reply)=>{try{await authenticate(auth,r,"workspace:read");const method=r.body?.method||"socket",base=deps.webhookBaseUrl?.replace(/\/+$/,""),placeholder=base?base+"/api/v1/integrations/slack/http/CONNECTION_WEBHOOK_SECRET":"https://YOUR_NPATI_ORIGIN/api/v1/integrations/slack/http/CONNECTION_WEBHOOK_SECRET";return{manifest:slack.manifest(method,method==="http"?placeholder:undefined)};}catch(error){return failure(reply,error);}});
  app.post<{Body:{displayName?:string;method?:"socket"|"http";botToken?:string;appToken?:string;signingSecret?:string;scope?:"account"|"company"|"agent";companyId?:string;agentId?:string}}>("/integrations/slack",async(r,reply)=>{
    try{const ctx=await authenticate(auth,r,"business:manage"),scope=r.body?.scope||"account",method=r.body?.method||"socket",companyId=scope==="account"?null:r.body?.companyId?.trim()||null,agentId=scope==="agent"?r.body?.agentId?.trim()||null:null,botToken=r.body?.botToken?.trim(),appToken=r.body?.appToken?.trim(),signingSecret=r.body?.signingSecret?.trim(),base=deps.webhookBaseUrl?.replace(/\/+$/,"");
      if(scope!=="account"&&!companyId)throw new Error("Company is required for this connection scope");if(scope==="agent"&&!agentId)throw new Error("Agent is required for Specific Agent scope");if(!botToken?.startsWith("xoxb-"))throw new Error("A Slack Bot Token starting with xoxb- is required");if(method==="socket"&&!appToken?.startsWith("xapp-"))throw new Error("An App-Level Token starting with xapp- is required for Socket Mode");if(method==="http"&&!signingSecret)throw new Error("Slack Signing Secret is required for HTTP Events");if(method==="http"&&!base)throw Object.assign(new Error("Set NPATI_MESSAGING_WEBHOOK_BASE_URL before connecting Slack HTTP Events"),{status:503});if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
      const validationCredential=slack.createCredential("validation",{method,botToken,appToken,signingSecret}),setup=await slack.validateCredential(validationCredential),created=await repo.createSlack(ctx,companyId,{scope,agentId,displayName:r.body?.displayName?.trim()||setup.externalName,botUsername:setup.externalName,credential:validationCredential}),item=await repo.getOwned(ctx,created.connection.id);if(!item)throw new Error("Slack connection creation failed");const credential=slack.createCredential(item.id,{method,botToken,appToken,signingSecret});await repo.replaceEncryptedCredential(item,credential);
      try{await slack.start(item);}catch(error){await repo.deleteOwned(ctx,item.id);throw error;}const webhookUrl=method==="http"?base+"/api/v1/integrations/slack/http/"+created.webhookSecret:undefined;return reply.code(201).send({connection:(await repo.list(ctx)).find((value)=>value.id===item.id),pairingCode:created.pairingCode,pairingCommand:`/connect ${created.pairingCode}`,webhookUrl,manifest:slack.manifest(method,webhookUrl),workspace:{id:setup.workspaceId,name:setup.workspaceName},bot:{id:setup.botUserId,name:setup.externalName},method});
    }catch(error){return failure(reply,error);}
  });
  app.get<{Params:{connectionId:string}}>("/integrations/slack/:connectionId/setup",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item||item.channel!=="slack")throw Object.assign(new Error("Slack connection not found"),{status:404});const credential=slack.credential(repo.resolveToken(item)),setup=await slack.validateCredential(repo.resolveToken(item)),base=deps.webhookBaseUrl?.replace(/\/+$/,""),webhookUrl=credential.method==="http"&&base?base+"/api/v1/integrations/slack/http/"+item.webhookSecret:undefined;return{...setup,status:item.status,webhookUrl,manifest:slack.manifest(credential.method,webhookUrl)};}catch(error){return failure(reply,error);}});
  const slackHttpHandler=async(r:FastifyRequest<{Params:{secret:string};Body:any}>,reply:any)=>{const item=await repo.getByWebhookSecret(r.params.secret,"slack");if(!item)return reply.code(404).send({error:{code:"INVALID_CONNECTION",message:"Slack connection not found"}});try{const credential=slack.credential(repo.resolveToken(item));if(credential.method!=="http"||!credential.signingSecret)throw Object.assign(new Error("Slack HTTP Events are not enabled"),{status:409});const raw=(r as any).rawBody||Buffer.from(typeof r.body==="string"?r.body:JSON.stringify(r.body));if(!slack.verifySignature(raw,r.headers["x-slack-request-timestamp"],r.headers["x-slack-signature"],credential.signingSecret))return reply.code(401).send({error:{code:"INVALID_SLACK_SIGNATURE",message:"Invalid or expired Slack signature"}});let payload:any=String(r.headers["content-type"]||"").includes("application/x-www-form-urlencoded")?Object.fromEntries(new URLSearchParams(raw.toString("utf8"))):r.body;if(Buffer.isBuffer(payload))payload=payload.toString("utf8");if(typeof payload==="string")payload=Object.fromEntries(new URLSearchParams(payload));if(payload?.payload)payload=JSON.parse(String(payload.payload));if(payload?.type==="url_verification")return reply.send({challenge:payload.challenge});void slack.handlePayload(item,payload,String(payload.event_id||payload.trigger_id||Date.now())).catch((error)=>repo.record(item.id,"inbound",error instanceof Error?error.message:String(error)));return reply.send({ok:true});}catch(error){return failure(reply,error);}};
  app.post("/api/v1/integrations/slack/http/:secret",slackHttpHandler);app.post("/v1/integrations/slack/http/:secret",slackHttpHandler);
  app.post<{Body:{displayName?:string;scope?:"account"|"company"|"agent";companyId?:string;agentId?:string;method?:"qr"|"cloud";phoneNumberId?:string;accessToken?:string;appSecret?:string;verifyToken?:string}}>("/integrations/whatsapp",async(r,reply)=>{
    try{
      const ctx=await authenticate(auth,r,"business:manage"),scope=r.body?.scope||"account",companyId=scope==="account"?null:r.body?.companyId?.trim()||null,agentId=scope==="agent"?r.body?.agentId?.trim()||null:null,method=r.body?.method||"qr";
      if(scope!=="account"&&!companyId)throw new Error("Company is required for this connection scope");if(scope==="agent"&&!agentId)throw new Error("Agent is required for Specific Agent scope");if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
      if(method==="qr"){
        const created=await repo.createWhatsApp(ctx,companyId,{scope,agentId,provider:"qr",displayName:r.body?.displayName?.trim()||"My WhatsApp",credential:"{}"});
        const item=await repo.getOwned(ctx,created.connection.id);if(!item)throw new Error("WhatsApp connection creation failed");await repo.replaceEncryptedCredential(item,whatsapp.createQrCredential(item.id));await whatsapp.startQr(item);
        return reply.code(201).send({connection:(await repo.list(ctx)).find((value)=>value.id===item.id),provider:"qr"});
      }
      const phoneNumberId=r.body?.phoneNumberId?.trim(),accessToken=r.body?.accessToken?.trim(),appSecret=r.body?.appSecret?.trim(),verifyToken=r.body?.verifyToken?.trim();
      if(!phoneNumberId||!accessToken||!appSecret||!verifyToken)throw new Error("Phone Number ID, Access Token, App Secret and Verify Token are required");
      const credential=whatsapp.createCloudCredential({phoneNumberId,accessToken,appSecret,verifyToken}),validated=await whatsapp.validateCredential(credential);
      const created=await repo.createWhatsApp(ctx,companyId,{scope,agentId,provider:"cloud",displayName:r.body?.displayName?.trim()||validated.externalName,credential}),item=await repo.getOwned(ctx,created.connection.id);
      if(!item)throw new Error("WhatsApp Cloud connection creation failed");await repo.markConnected(item,phoneNumberId);
      const base=deps.webhookBaseUrl?.replace(/\/+$/,""),webhookUrl=base?base+"/api/v1/integrations/whatsapp/cloud/"+created.webhookSecret:null;
      return reply.code(201).send({connection:(await repo.list(ctx)).find((value)=>value.id===item.id),provider:"cloud",webhookUrl,validated:true});
    }catch(error){return failure(reply,error);}
  });
  app.get<{Params:{connectionId:string}}>("/integrations/whatsapp/:connectionId/qr",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item||item.channel!=="whatsapp"||item.provider!=="qr")throw Object.assign(new Error("WhatsApp QR connection not found"),{status:404});return{connectionId:item.id,status:item.status,...whatsapp.qrStatus(item.id)};}catch(error){return failure(reply,error);}});
  app.post<{Params:{connectionId:string}}>("/integrations/whatsapp/:connectionId/repair",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item||item.channel!=="whatsapp"||item.provider!=="qr")throw Object.assign(new Error("WhatsApp QR connection not found"),{status:404});await whatsapp.startQr(item,true);return{ok:true,status:"pending"};}catch(error){return failure(reply,error);}});
  const whatsappCloudVerificationHandler=async(r:FastifyRequest<{Params:{secret:string};Querystring:{"hub.mode"?:string;"hub.verify_token"?:string;"hub.challenge"?:string}}>,reply:any)=>{const item=await repo.getByWebhookSecret(r.params.secret,"whatsapp");if(!item||item.provider!=="cloud")return reply.code(404).send();const credential=whatsapp.credential(repo.resolveToken(item)) as CloudCredential;if(r.query["hub.mode"]==="subscribe"&&secureEqual(r.query["hub.verify_token"],credential.verifyToken))return reply.type("text/plain").send(r.query["hub.challenge"]||"");return reply.code(403).send();};
  const whatsappCloudWebhookHandler=async(r:FastifyRequest<{Params:{secret:string};Body:unknown}>,reply:any)=>{const item=await repo.getByWebhookSecret(r.params.secret,"whatsapp");if(!item||item.provider!=="cloud")return reply.code(404).send({error:{code:"INVALID_CONNECTION",message:"WhatsApp Cloud connection not found"}});try{const credential=whatsapp.credential(repo.resolveToken(item)) as CloudCredential,raw=(r as any).rawBody||Buffer.from(JSON.stringify(r.body));if(!whatsapp.verifyCloudSignature(raw,r.headers["x-hub-signature-256"],credential))return reply.code(401).send({error:{code:"INVALID_WEBHOOK_SIGNATURE",message:"Invalid WhatsApp webhook signature"}});let message=await whatsapp.parseInbound(r.body,repo.resolveToken(item),false);if(!message)return reply.send({status:"ignored"});if(message.hasAttachments)message=await whatsapp.parseInbound(r.body,repo.resolveToken(item),true)??message;return reply.send(await whatsappDispatcher.dispatch(item,message));}catch(error){return failure(reply,error);}};
  app.get("/api/v1/integrations/whatsapp/cloud/:secret",whatsappCloudVerificationHandler);app.get("/v1/integrations/whatsapp/cloud/:secret",whatsappCloudVerificationHandler);
  app.post("/api/v1/integrations/whatsapp/cloud/:secret",whatsappCloudWebhookHandler);app.post("/v1/integrations/whatsapp/cloud/:secret",whatsappCloudWebhookHandler);


  app.get<{Params:{companyId:string}}>("/companies/:companyId/integrations/messaging",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"workspace:read");await store.getCompany(ctx,r.params.companyId);return {connections:await listConnections(ctx,r.params.companyId)};}catch(e){return failure(reply,e);}});
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
      return reply.code(201).send({connection:created.connection,pairingCode:created.pairingCode,pairingCommand:`/connect ${created.pairingCode}`,pairingLink:telegramPairingLink(created.connection.botUsername,created.pairingLinkToken),webhookUrl,webhookConfigured:true});
    }catch(e){return failure(reply,e);}
  });
  app.post<{Params:{companyId:string;connectionId:string}}>("/companies/:companyId/integrations/messaging/:connectionId/test",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage");await store.getCompany(ctx,r.params.companyId);const item=await repo.get(ctx,r.params.companyId,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});const target=item.channel==="whatsapp"?(item.settings.access.allowedUserIds[0]||item.externalChatId):item.externalChatId;if(!target)throw new Error("Add an allowed WhatsApp user/chat before testing");await gateway.adapter(item.channel).sendText(repo.resolveToken(item),target,"NPATI connection is active.",item.externalThreadId||undefined);await repo.record(item.id,"outbound");return {ok:true};}catch(e){return failure(reply,e);}});
  app.post<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId/test",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)throw Object.assign(new Error("Connection not found"),{status:404});const target=item.channel==="whatsapp"?(item.settings.access.allowedUserIds[0]||item.externalChatId):item.externalChatId;if(!target)throw new Error("Add an allowed WhatsApp user/chat before testing");await gateway.adapter(item.channel).sendText(repo.resolveToken(item),target,"NPATI connection is active.",item.externalThreadId||undefined);await repo.record(item.id,"outbound");return{ok:true};}catch(e){return failure(reply,e);}});
  app.delete<{Params:{companyId:string;connectionId:string}}>("/companies/:companyId/integrations/messaging/:connectionId",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage");await store.getCompany(ctx,r.params.companyId);const item=await repo.get(ctx,r.params.companyId,r.params.connectionId);if(!item)return reply.code(404).send({error:{code:"NOT_FOUND",message:"Connection not found"}});const adapter=gateway.adapter(item.channel);if(adapter.disconnect)await adapter.disconnect(repo.resolveToken(item));await repo.delete(ctx,r.params.companyId,r.params.connectionId);return reply.code(204).send();}catch(e){return failure(reply,e);}});
  app.delete<{Params:{connectionId:string}}>("/integrations/messaging/:connectionId",async(r,reply)=>{try{const ctx=await authenticate(auth,r,"business:manage"),item=await repo.getOwned(ctx,r.params.connectionId);if(!item)return reply.code(404).send({error:{code:"NOT_FOUND",message:"Connection not found"}});const adapter=gateway.adapter(item.channel);if(adapter.disconnect)await adapter.disconnect(repo.resolveToken(item));await repo.deleteOwned(ctx,item.id);return reply.code(204).send();}catch(e){return failure(reply,e);}});

  const telegramWebhookHandler = async (r: FastifyRequest<{Params:{secret:string};Body:unknown}>, reply: any) => {
    const connection=await repo.getByWebhookSecret(r.params.secret);
    if(!connection)return reply.code(404).send({error:{code:"INVALID_CONNECTION",message:"Telegram connection not found"}});
    if(!secureEqual(r.headers["x-telegram-bot-api-secret-token"],connection.webhookSecret))return reply.code(401).send({error:{code:"INVALID_WEBHOOK_SIGNATURE",message:"Invalid Telegram webhook signature"}});
    try{
      const token=repo.resolveToken(connection),adapter=gateway.adapter("telegram");let message=await adapter.parseInbound(r.body,token,false);
      if(!message)return reply.code(202).send({status:"ignored"});
      if(!await repo.claimInbound(connection,message.eventId,message.messageId))return reply.code(200).send({status:"duplicate",messageId:message.messageId});
      // Audit L8: the deep link sends /start <128-bit token>; the 6-digit /connect code stays as a rate-limited fallback.
      const link=/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{22,64})\s*$/.exec(message.text.trim());
      const pair=link?null:/^\/(?:connect(?:@[A-Za-z0-9_]+)?\s+|start(?:@[A-Za-z0-9_]+)?\s+(?:connect[-_])?)(\d{6})\s*$/i.exec(message.text.trim());
      if(link||pair){
        const bound=await repo.bind(connection,{...(link?{pairingLinkToken:link[1]!}:{pairingCode:pair![1]!}),externalUserId:message.externalUserId,externalChatId:message.externalChatId,externalThreadId:message.externalThreadId});
        await adapter.sendText(token,message.externalChatId,bound?"Telegram is connected to NPATI. You can now use your NPATI account.":"The pairing code is invalid or expired. Please generate a new pairing command in NPATI settings.",message.externalThreadId);
        return reply.code(200).send({status:bound?"connected":"rejected"});
      }
      if(connection.status==="pending"){
        await adapter.sendText(token,message.externalChatId,"👋 Welcome to NPATI!\n\nTo link this Telegram account with NPATI, please generate a pairing command on your NPATI Integrations page and send it here:\n/connect 123456",message.externalThreadId);
        return reply.code(200).send({status:"pairing_required"});
      }
      const group=["group","supergroup"].includes(message.chatType||""),settings=connection.settings,allowedGroup=group&&settings.groups.enabled&&settings.groups.allowedChatIds.includes(message.externalChatId),authorizedChat=connection.externalChatId===message.externalChatId||allowedGroup;
      if(connection.status!=="connected"||connection.externalUserId!==message.externalUserId||!authorizedChat)return reply.code(403).send({error:{code:"TELEGRAM_BINDING_MISMATCH",message:"This Telegram user/chat is not allowed for the connection"}});
      if(group&&!settings.groups.enabled)return reply.code(202).send({status:"groups_disabled"});
      const botMention=connection.botUsername?.toLowerCase(),hasMention=botMention?message.text.toLowerCase().includes(botMention):false;if(group&&settings.groups.mentionRequired&&!hasMention&&!message.text.startsWith("/"))return reply.code(202).send({status:"mention_required"});if(hasMention&&connection.botUsername)message.text=message.text.replace(new RegExp(connection.botUsername.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"ig"),"").trim();
      if(message.hasAttachments)message=await adapter.parseInbound(r.body,token,true)??message;
      const deniedMedia=message.attachments.find((item)=>(item.kind==="image"&&!settings.media.images)||((item.kind==="document"||item.kind==="file")&&!settings.media.documents)||(item.kind==="audio"&&!settings.media.audio));if(deniedMedia)return reply.code(403).send({error:{code:"TELEGRAM_MEDIA_DISABLED",message:`${deniedMedia.kind} attachments are disabled for this connection`}});
      const session=await repo.getOrCreateSession(connection,message.externalChatId,message.externalThreadId),ctx=runtimeContext(connection),companyId=connection.scope==="account"?session.activeCompanyId:connection.companyId,agentId=connection.scope==="account"?session.activeAgentId:connection.agentId;
      if(companyId)ctx.companyId=companyId;
      if(companyId)await store.getCompany(ctx,companyId);if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
      if(!message.text&&!message.attachments.length) return reply.code(202).send({status:"ignored"});
      await repo.touchRoute(connection,message.externalThreadId);await repo.record(connection.id,"inbound");
      const command=message.text.replace(/^\/(\w+)@[A-Za-z0-9_]+/u,"/$1").trim(),key=sessionKey(connection,session);
      if(/^\/(?:new|reset)$/iu.test(command)){
        const running=activeRuns.get(key);if(running)running.abort();
        if(/^\/reset$/iu.test(command)&&session.runtimeConversationId&&deps.resetConversation)await deps.resetConversation({context:ctx,conversationId:session.runtimeConversationId});
        await repo.setSessionConversation(session,null);await adapter.sendText(token,message.externalChatId,/^\/reset$/iu.test(command)?"The current NPATI session was reset. A clean session is ready.":"A new NPATI session is ready. The previous conversation remains saved in NPATI.",message.externalThreadId,message.messageId);return reply.code(200).send({status:"reset"});
      }
      if(/^\/stop$/iu.test(command)){const running=activeRuns.get(key);if(running)running.abort();await adapter.sendText(token,message.externalChatId,running?"Stopping the active NPATI request.":"There is no active request in this Telegram topic.",message.externalThreadId,message.messageId);return reply.code(200).send({status:running?"stopping":"idle"});}
      if(/^\/status$/iu.test(command)){await adapter.sendText(token,message.externalChatId,`NPATI connection: ${connection.status}\nScope: ${connection.scope}\nSession: ${session.runtimeConversationId?"persistent":"new"}\nRequest: ${activeRuns.has(key)?"running":"idle"}`,message.externalThreadId,message.messageId);return reply.code(200).send({status:"reported"});}
      if(activeRuns.has(key)){await adapter.sendText(token,message.externalChatId,"A request is already running in this Telegram topic. Use /stop before starting another one.",message.externalThreadId,message.messageId);return reply.code(202).send({status:"busy"});}
      const controller=new AbortController();activeRuns.set(key,controller);
      const replyTo=settings.groups.replyMode==="reply"?message.messageId:undefined;
      if(settings.delivery.typing)await adapter.sendTyping?.(token,message.externalChatId,message.externalThreadId).catch(()=>undefined);
      const typing=setInterval(()=>{if(settings.delivery.typing)void adapter.sendTyping?.(token,message.externalChatId,message.externalThreadId).catch(()=>undefined);},4_000);typing.unref?.();
      let streamed="",previewId:string|undefined,lastPreviewLength=0,delivery=Promise.resolve();
      const onDelta=(chunk:string)=>{if(!settings.delivery.progressive)return;streamed+=chunk;if(streamed.length-lastPreviewLength<160)return;lastPreviewLength=streamed.length;const preview=streamed.slice(0,3900);delivery=delivery.then(async()=>{if(!previewId){const ids=await adapter.sendText(token,message.externalChatId,preview,message.externalThreadId,replyTo);previewId=ids?.[0];}else await adapter.editText?.(token,message.externalChatId,previewId,preview);}).catch(()=>undefined);};
      const progressTimer=setTimeout(()=>{if(settings.delivery.progressive&&settings.notifications.status)delivery=delivery.then(async()=>{if(!previewId){const ids=await adapter.sendText(token,message.externalChatId,"NPATI is working on the request…",message.externalThreadId,replyTo);previewId=ids?.[0];}}).catch(()=>undefined);},2_000);progressTimer.unref?.();
      void accountHandleMessage({context:ctx,connection,session,text:command,attachments:message.attachments,conversationId:session.runtimeConversationId||undefined,replyContext:message.replyContext,signal:controller.signal,onDelta})
        .then(async(result)=>{await delivery;if(controller.signal.aborted)return;if(previewId&&adapter.editText){await adapter.editText(token,message.externalChatId,previewId,result.message.slice(0,3900));if(result.message.length>3900)await adapter.sendText(token,message.externalChatId,result.message.slice(3900),message.externalThreadId);}else await adapter.sendText(token,message.externalChatId,result.message,message.externalThreadId,replyTo);if(settings.media.outbound)for(const attachment of result.attachments||[])await adapter.sendAttachment?.(token,message.externalChatId,attachment,message.externalThreadId,replyTo);await repo.record(connection.id,"outbound");})
        .catch(async(error)=>{if(controller.signal.aborted)return;const detail=error instanceof Error?error.message:String(error);await repo.record(connection.id,"outbound",detail);if(settings.notifications.errors)await adapter.sendText(token,message.externalChatId,`NPATI could not complete the request: ${detail}`,message.externalThreadId,replyTo).catch(()=>undefined);})
        .finally(()=>{clearInterval(typing);clearTimeout(progressTimer);if(activeRuns.get(key)===controller)activeRuns.delete(key);});
      return reply.code(202).send({status:"accepted",messageId:message.messageId});
    }catch(e){await repo.record(connection.id,"inbound",e instanceof Error?e.message:String(e)).catch(()=>undefined);return failure(reply,e);}
  };

  // Register on both /v1/* (when behind Nginx proxy stripping /api/) and /api/v1/* (direct or unstripped calls)
  app.post<{Params:{secret:string};Body:unknown}>("/api/v1/integrations/telegram/:secret", telegramWebhookHandler);
  app.post<{Params:{secret:string};Body:unknown}>("/v1/integrations/telegram/:secret", telegramWebhookHandler);

  return { dispatchEmail: emailDispatcher
    ? (connection:MessagingConnection,message:InboundGatewayMessage)=>emailDispatcher.dispatch(connection,message) : undefined };
}
