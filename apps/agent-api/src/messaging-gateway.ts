export type GatewayAttachment = { kind: "image" | "audio" | "document" | "file"; name: string; mimeType: string; dataBase64: string };
export type GatewayOutboundAttachment = GatewayAttachment & { caption?: string };
export type GatewayReplyContext = { messageId: string; text: string; externalUserId?: string };
export type InboundGatewayMessage = {
  externalUserId: string; externalChatId: string; externalThreadId?: string; text: string;
  attachments: GatewayAttachment[]; messageId: string; eventId: string; chatType?: string;
  replyContext?: GatewayReplyContext; hasAttachments?: boolean;
};

type TelegramFile = { file_id: string; file_name?: string; mime_type?: string };
type TelegramMessage = {
  message_id: number; message_thread_id?: number; text?: string; caption?: string;
  from?: { id: number; is_bot?: boolean }; chat: { id: number; type?: string };
  photo?: Array<TelegramFile & { width: number; height: number; file_size?: number }>;
  document?: TelegramFile; audio?: TelegramFile; voice?: TelegramFile; video?: TelegramFile;
  reply_to_message?: Pick<TelegramMessage,"message_id"|"text"|"caption"|"from">;
};
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage };

export interface MessagingAdapter {
  readonly channel: string;
  validateCredential(credential: string): Promise<{ externalName: string }>;
  configureWebhook(credential: string, webhookUrl: string, secretToken: string): Promise<void>;
  disconnect?(credential: string): Promise<void>;
  parseInbound(payload: unknown, credential: string,downloadAttachments?:boolean): Promise<InboundGatewayMessage | null>;
  sendText(credential: string, chatId: string, text: string, threadId?: string, replyToMessageId?: string): Promise<string[] | void>;
  editText?(credential:string,chatId:string,messageId:string,text:string):Promise<void>;
  sendTyping?(credential:string,chatId:string,threadId?:string):Promise<void>;
  sendAttachment?(credential:string,chatId:string,attachment:GatewayOutboundAttachment,threadId?:string,replyToMessageId?:string):Promise<void>;
}

type TelegramApiPayload<T>={ok:boolean;result?:T;description?:string;error_code?:number;parameters?:{retry_after?:number}};
const delay=(ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));
function textChunks(text:string,limit=3900){
  if(!text)return[""];
  const chunks:string[]=[];let remaining=text;
  while(remaining.length>limit){let split=Math.max(remaining.lastIndexOf("\n",limit),remaining.lastIndexOf(" ",limit));if(split<limit*.55)split=limit;chunks.push(remaining.slice(0,split));remaining=remaining.slice(split).replace(/^\s+/u,"");}
  if(remaining||!chunks.length)chunks.push(remaining);return chunks;
}

export class TelegramMessagingAdapter implements MessagingAdapter {
  readonly channel = "telegram";
  constructor(private readonly fetcher: typeof fetch = fetch,private readonly sleeper:(ms:number)=>Promise<void>=delay) {}
  private async call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const safeRetry=new Set(["getMe","getFile","sendChatAction","editMessageText","setWebhook","setMyCommands","deleteWebhook"]);
    for(let attempt=0;attempt<4;attempt++){
      const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(()=>({ok:false,description:`Telegram API ${method} returned ${response.status}`})) as TelegramApiPayload<T>;
      if(response.ok&&payload.ok)return payload.result as T;
      const retryAfter=Math.max(0,Number(payload.parameters?.retry_after||0))*1000;
      const retryable=payload.error_code===429||response.status===429||(response.status>=500&&safeRetry.has(method));
      if(retryable&&attempt<3){await this.sleeper(Math.min(30_000,retryAfter||250*2**attempt));continue;}
      throw Object.assign(new Error(payload.description || `Telegram API ${method} failed`),{status:response.status,code:payload.error_code,retryAfterMs:retryAfter});
    }
    throw new Error(`Telegram API ${method} failed after retries`);
  }
  async validateCredential(token: string) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw new Error("Invalid Telegram bot token format");
    const bot = await this.call<{ username?: string; first_name: string }>(token.trim(), "getMe");
    return { externalName: bot.username ? `@${bot.username}` : bot.first_name };
  }
  async configureWebhook(token: string, webhookUrl: string, secretToken: string) {
    await this.call(token, "setWebhook", { url: webhookUrl, secret_token: secretToken, allowed_updates: ["message", "edited_message"], drop_pending_updates: false });
    await this.call(token,"setMyCommands",{commands:[
      {command:"new",description:"Start a new NPATI session"},{command:"reset",description:"Reset the current session"},{command:"stop",description:"Stop the active request"},{command:"status",description:"Show connection and request status"},
      {command:"companies",description:"List Companies"},{command:"company",description:"Select a Company"},{command:"agents",description:"List active Agents"},{command:"agent",description:"Select an Agent"},{command:"context",description:"Show active context"},{command:"account",description:"Use the entire NPATI account"},
      {command:"runs",description:"List tasks and Automation runs"},{command:"approvals",description:"List pending approvals"},{command:"approve",description:"Approve an action by ID"},{command:"deny",description:"Deny an action by ID"},
    ]});
  }
  async disconnect(token: string) { await this.call(token, "deleteWebhook", { drop_pending_updates: true }); }
  private async download(token: string, file: TelegramFile, kind: GatewayAttachment["kind"], fallback: string): Promise<GatewayAttachment> {
    const metadata = await this.call<{ file_path: string }>(token, "getFile", { file_id: file.file_id });
    const response = await this.fetcher(`https://api.telegram.org/file/bot${token}/${metadata.file_path}`);
    if (!response.ok) throw new Error("Telegram file download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Telegram attachment exceeds the 20 MB limit");
    return { kind, name: file.file_name || fallback, mimeType: file.mime_type || (kind === "image" ? "image/jpeg" : "application/octet-stream"), dataBase64: bytes.toString("base64") };
  }
  async parseInbound(payload: unknown, token: string,downloadAttachments=true): Promise<InboundGatewayMessage | null> {
    const update = payload as TelegramUpdate; const message = update?.message ?? update?.edited_message;
    if (!message?.from || message.from.is_bot) return null;
    const attachments: GatewayAttachment[] = [];
    const photo = message.photo?.at(-1);if(downloadAttachments){
      if (photo) attachments.push(await this.download(token, photo, "image", `telegram-${message.message_id}.jpg`));
      if (message.document) attachments.push(await this.download(token, message.document, "document", `telegram-${message.message_id}.bin`));
      if (message.audio) attachments.push(await this.download(token, message.audio, "audio", message.audio.file_name || `telegram-${message.message_id}.mp3`));
      if (message.voice) attachments.push(await this.download(token, message.voice, "audio", `telegram-${message.message_id}.ogg`));
      if (message.video) attachments.push(await this.download(token, message.video, "file", message.video.file_name || `telegram-${message.message_id}.mp4`));
    }
    const reply=message.reply_to_message,replyText=(reply?.text||reply?.caption||"").trim();
    return { externalUserId:String(message.from.id),externalChatId:String(message.chat.id),externalThreadId:message.message_thread_id == null ? undefined : String(message.message_thread_id),text:(message.text || message.caption || "").trim(),attachments,hasAttachments:Boolean(photo||message.document||message.audio||message.voice||message.video),messageId:String(message.message_id),eventId:String(update.update_id),chatType:message.chat.type,replyContext:reply&&replyText?{messageId:String(reply.message_id),text:replyText,externalUserId:reply.from?String(reply.from.id):undefined}:undefined };
  }
  async sendText(token: string, chatId: string, text: string, threadId?: string,replyToMessageId?:string) {
    const ids:string[]=[];
    for (const chunk of textChunks(text)) {const result=await this.call<{message_id:number}>(token, "sendMessage", { chat_id: chatId, text: chunk, ...(threadId ? { message_thread_id: Number(threadId) } : {}),...(replyToMessageId?{reply_parameters:{message_id:Number(replyToMessageId)}}:{}) });ids.push(String(result.message_id));replyToMessageId=undefined;}
    return ids;
  }
  async editText(token:string,chatId:string,messageId:string,text:string){await this.call(token,"editMessageText",{chat_id:chatId,message_id:Number(messageId),text:text.slice(0,3900)});}
  async sendTyping(token:string,chatId:string,threadId?:string){await this.call(token,"sendChatAction",{chat_id:chatId,action:"typing",...(threadId?{message_thread_id:Number(threadId)}:{})});}
  async sendAttachment(token:string,chatId:string,attachment:GatewayOutboundAttachment,threadId?:string,replyToMessageId?:string){
    const bytes=Buffer.from(attachment.dataBase64,"base64"),nativePhoto=attachment.kind==="image"&&bytes.length<=10*1024*1024,method=nativePhoto?"sendPhoto":"sendDocument",field=nativePhoto?"photo":"document";
    for(let attempt=0;attempt<4;attempt++){
      const form=new FormData();form.set("chat_id",chatId);if(threadId)form.set("message_thread_id",threadId);if(replyToMessageId)form.set("reply_parameters",JSON.stringify({message_id:Number(replyToMessageId)}));if(attachment.caption)form.set("caption",attachment.caption.slice(0,1000));
      form.set(field,new Blob([new Uint8Array(bytes)],{type:attachment.mimeType}),attachment.name);
      const response=await this.fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",body:form});const payload=await response.json().catch(()=>({ok:false,description:`Telegram API ${method} returned ${response.status}`})) as TelegramApiPayload<unknown>;
      if(response.ok&&payload.ok)return;const retryAfter=Math.max(0,Number(payload.parameters?.retry_after||0))*1000;if((payload.error_code===429||response.status===429)&&attempt<3){await this.sleeper(Math.min(30_000,retryAfter||250*2**attempt));continue;}throw new Error(payload.description||`Telegram API ${method} failed`);
    }
  }
}

export class MessagingGateway {
  private readonly adapters = new Map<string, MessagingAdapter>();
  register(adapter: MessagingAdapter) { this.adapters.set(adapter.channel, adapter); return this; }
  adapter(channel: string) { const adapter=this.adapters.get(channel); if(!adapter)throw new Error(`Messaging adapter ${channel} is unavailable`); return adapter; }
}
