import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { GatewayAttachment, GatewayOutboundAttachment, InboundGatewayMessage, MessagingAdapter } from "./messaging-gateway";
import type { MessagingConnection, MessagingIntegrationsRepository, MessagingSession } from "./messaging-integrations-repository";

export class WhatsAppInboundDispatcher {
  private readonly active=new Map<string,AbortController>();
  constructor(private readonly deps:{
    store:WorkspaceStore;repo:MessagingIntegrationsRepository;adapter:MessagingAdapter;
    handleMessage:(input:{context:AuthContext;connection:MessagingConnection;session:MessagingSession;text:string;attachments:GatewayAttachment[];conversationId?:string;replyContext?:any;signal?:AbortSignal;onDelta?:(chunk:string)=>void})=>Promise<{message:string;attachments?:GatewayOutboundAttachment[]}>;
    resetConversation?:(input:{context:AuthContext;conversationId:string})=>Promise<void>;
  }){}
  private context(connection:MessagingConnection):AuthContext{return{workspaceId:connection.workspaceId,userId:connection.userId,companyId:connection.companyId||connection.activeCompanyId||undefined,permissions:connection.permissions};}
  async dispatch(connection:MessagingConnection,message:InboundGatewayMessage){
    const {repo,adapter,store}=this.deps,token=repo.resolveToken(connection),settings=connection.settings;
    if(!await repo.claimInbound(connection,message.eventId,message.messageId))return{status:"duplicate"};
    if(connection.status!=="connected")throw Object.assign(new Error("WhatsApp connection is not connected"),{status:403});
    const group=message.chatType==="group",selfChat=message.isSelfChat===true&&connection.provider==="qr"&&settings.access.selfChat;
    const allowed=selfChat|| (group?settings.groups.enabled&&settings.groups.allowedChatIds.includes(message.externalChatId):settings.access.allowedUserIds.includes(message.externalUserId)||settings.access.allowedUserIds.includes(message.externalChatId));
    if(!allowed)throw Object.assign(new Error("WhatsApp sender/chat is not on the connection allowlist"),{status:403,code:"WHATSAPP_ALLOWLIST_MISMATCH"});
    if(group&&settings.groups.mentionRequired){const own=connection.externalUserId?.split("@")[0]||"";if(!message.text.includes("@"+own)&&!message.text.startsWith("/"))return{status:"mention_required"};}
    const denied=message.attachments.find((item)=>(item.kind==="image"&&!settings.media.images)||((item.kind==="document"||item.kind==="file")&&!settings.media.documents)||(item.kind==="audio"&&!settings.media.audio));
    if(denied)throw Object.assign(new Error(denied.kind+" attachments are disabled"),{status:403});
    if(!message.text&&!message.attachments.length)return{status:"ignored"};
    const session=await repo.getOrCreateSession(connection,message.externalChatId),ctx=this.context(connection);
    const companyId=connection.scope==="account"?session.activeCompanyId:connection.companyId,agentId=connection.scope==="account"?session.activeAgentId:connection.agentId;
    if(companyId){ctx.companyId=companyId;await store.getCompany(ctx,companyId);}if(companyId&&agentId)await store.getCompanyAgent(ctx,companyId,agentId);
    await repo.touchRoute(connection);await repo.record(connection.id,"inbound");
    const text=message.text.trim(),key=connection.id+":"+message.externalChatId,replyTo=settings.groups.replyMode==="reply"?message.messageId:undefined;
    if(/^\/(?:new|reset)$/iu.test(text)){this.active.get(key)?.abort();if(/^\/reset$/iu.test(text)&&session.runtimeConversationId&&this.deps.resetConversation)await this.deps.resetConversation({context:ctx,conversationId:session.runtimeConversationId});await repo.setSessionConversation(session,null);await adapter.sendText(token,message.externalChatId,"A clean NPATI session is ready.",undefined,replyTo);return{status:"reset"};}
    if(/^\/stop$/iu.test(text)){const running=this.active.get(key);running?.abort();await adapter.sendText(token,message.externalChatId,running?"Stopping the active NPATI request.":"There is no active request.",undefined,replyTo);return{status:running?"stopping":"idle"};}
    if(/^\/status$/iu.test(text)){await adapter.sendText(token,message.externalChatId,"NPATI connection: "+connection.status+"\nScope: "+connection.scope+"\nSession: "+(session.runtimeConversationId?"persistent":"new")+"\nRequest: "+(this.active.has(key)?"running":"idle"),undefined,replyTo);return{status:"reported"};}
    if(this.active.has(key)){await adapter.sendText(token,message.externalChatId,"A request is already running. Use /stop first.",undefined,replyTo);return{status:"busy"};}
    const controller=new AbortController();this.active.set(key,controller);
    if(settings.delivery.typing)await adapter.sendTyping?.(token,message.externalChatId).catch(()=>undefined);
    const typing=setInterval(()=>{if(settings.delivery.typing)void adapter.sendTyping?.(token,message.externalChatId).catch(()=>undefined);},4_000);typing.unref?.();
    let streamed="",previewId:string|undefined,last=0,delivery=Promise.resolve();
    const onDelta=(chunk:string)=>{if(!settings.delivery.progressive)return;streamed+=chunk;if(streamed.length-last<160)return;last=streamed.length;const preview=streamed.slice(0,3900);delivery=delivery.then(async()=>{if(!previewId){const ids=await adapter.sendText(token,message.externalChatId,preview,undefined,replyTo);previewId=ids?.[0];}else await adapter.editText?.(token,message.externalChatId,previewId,preview);}).catch(()=>undefined);};
    const progress=setTimeout(()=>{if(settings.delivery.progressive&&settings.notifications.status)delivery=delivery.then(async()=>{if(!previewId){const ids=await adapter.sendText(token,message.externalChatId,"NPATI is working on the request?",undefined,replyTo);previewId=ids?.[0];}}).catch(()=>undefined);},2_000);progress.unref?.();
    void this.deps.handleMessage({context:ctx,connection,session,text,attachments:message.attachments,conversationId:session.runtimeConversationId||undefined,replyContext:message.replyContext,signal:controller.signal,onDelta})
      .then(async(result)=>{await delivery;if(controller.signal.aborted)return;if(previewId&&adapter.editText){await adapter.editText(token,message.externalChatId,previewId,result.message.slice(0,3900));if(result.message.length>3900)await adapter.sendText(token,message.externalChatId,result.message.slice(3900));}else await adapter.sendText(token,message.externalChatId,result.message,undefined,replyTo);if(settings.media.outbound)for(const file of result.attachments||[])await adapter.sendAttachment?.(token,message.externalChatId,file,undefined,replyTo);await repo.record(connection.id,"outbound");})
      .catch(async(error)=>{if(controller.signal.aborted)return;const detail=error instanceof Error?error.message:String(error);await repo.record(connection.id,"outbound",detail);if(settings.notifications.errors)await adapter.sendText(token,message.externalChatId,"NPATI could not complete the request: "+detail,undefined,replyTo).catch(()=>undefined);})
      .finally(()=>{clearInterval(typing);clearTimeout(progress);if(this.active.get(key)===controller)this.active.delete(key);});
    return{status:"accepted"};
  }
}
