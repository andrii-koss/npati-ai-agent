import type { GatewayAttachment, GatewayOutboundAttachment, InboundGatewayMessage, MessagingAdapter } from "./messaging-gateway";
import type { MessagingConnection, MessagingIntegrationsRepository } from "./messaging-integrations-repository";
import { messagingCommandDefinitions, messagingSlashCommand } from "./messaging-commands";

export type DiscordCredential={provider:"discord";version:1;connectionId:string;botToken:string;clientId:string};
export type DiscordCatalog={guilds:Array<{id:string;name:string;icon?:string|null;channels:Array<{id:string;name:string;type:number;parentId?:string|null}>;roles:Array<{id:string;name:string}>}>};
type DiscordSocket={readyState:number;send(data:string):void;close(code?:number,reason?:string):void;addEventListener(type:string,listener:(event:any)=>void):void};
type DiscordState={connection:MessagingConnection;credential:DiscordCredential;socket?:DiscordSocket;heartbeat?:NodeJS.Timeout;reconnect?:NodeJS.Timeout;attempt:number;sequence?:number;stopped:boolean;botId?:string;channels:Map<string,{id:string;name:string;type:number;parentId?:string|null;guildId?:string}>;guilds:Map<string,{id:string;name:string}>};
type InteractionRef={applicationId:string;token:string;channelId:string};
const API="https://discord.com/api/v10";
const INTENTS=1|512|1024|4096|8192|32768;
const REQUIRED_PERMISSIONS=BigInt(64+1024+2048+16384+32768+65536+2147483648)+274877906944n;
const wait=(ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));
const parseCredential=(raw:string)=>{const value=JSON.parse(raw) as DiscordCredential;if(value.provider!=="discord"||!value.botToken||!value.clientId)throw new Error("Invalid Discord credential");return value;};
const chunks=(text:string,limit=1900)=>{const output:string[]=[];let rest=text||"";while(rest.length>limit){let at=Math.max(rest.lastIndexOf("\n",limit),rest.lastIndexOf(" ",limit));if(at<limit*.5)at=limit;output.push(rest.slice(0,at));rest=rest.slice(at).trimStart();}output.push(rest);return output;};
const attachmentKind=(mime:string):GatewayAttachment["kind"]=>mime.startsWith("image/")?"image":mime.startsWith("audio/")?"audio":"document";

export class DiscordMessagingAdapter implements MessagingAdapter{
  readonly channel="discord";private readonly states=new Map<string,DiscordState>();private inbound?: (connectionId:string,message:InboundGatewayMessage)=>Promise<void>;
  private readonly interactions=new Map<string,InteractionRef>();private readonly webhookMessages=new Map<string,InteractionRef>();
  constructor(private readonly repo:MessagingIntegrationsRepository,private readonly fetcher:typeof fetch=fetch,private readonly socketFactory:(url:string)=>DiscordSocket=(url)=>new WebSocket(url) as unknown as DiscordSocket){}
  setInboundHandler(value:(connectionId:string,message:InboundGatewayMessage)=>Promise<void>){this.inbound=value;}
  createCredential(connectionId:string,botToken:string,clientId:string){return JSON.stringify({provider:"discord",version:1,connectionId,botToken:botToken.replace(/^Bot\s+/iu,"").trim(),clientId:clientId.trim()} satisfies DiscordCredential);}
  credential(raw:string){return parseCredential(raw);}
  inviteUrl(clientId:string){return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${REQUIRED_PERMISSIONS.toString()}&scope=bot%20applications.commands`;}
  private async request(value:DiscordCredential,path:string,method="GET",body?:unknown,authenticated=true){
    for(let attempt=0;attempt<5;attempt++){
      const response=await this.fetcher(API+path,{method,headers:{...(authenticated?{authorization:"Bot "+value.botToken}:{}),...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
      const data=await response.json().catch(()=>({})) as any;
      if(response.ok)return data;
      const retryMs=Math.min(30_000,Math.max(250,Number(data?.retry_after||0)*1000||250*2**attempt));
      if((response.status===429||response.status>=500)&&attempt<4){await wait(retryMs);continue;}
      throw Object.assign(new Error(data?.message||`Discord API returned ${response.status}`),{status:response.status,code:data?.code});
    }
    throw new Error("Discord API retry limit reached");
  }
  async validateCredential(raw:string){
    const value=parseCredential(raw),[user,application,guilds]=await Promise.all([
      this.request(value,"/users/@me"),this.request(value,"/oauth2/applications/@me"),this.request(value,"/users/@me/guilds")
    ]);
    if(!user.bot)throw new Error("Discord token does not belong to a bot");
    if(String(application.id)!==value.clientId)throw new Error("Application / Client ID does not match the Bot Token");
    const flags=Number(application.flags||0),messageContentIntent=Boolean(flags&(1<<18)||flags&(1<<19));
    const missingPermissions=(guilds as any[]).filter((guild)=>{const permissions=BigInt(String(guild.permissions||"0"));return(permissions&REQUIRED_PERMISSIONS)!==REQUIRED_PERMISSIONS;}).map((guild)=>String(guild.id));
    return{externalName:`@${user.username}`,botId:String(user.id),applicationId:String(application.id),inviteUrl:this.inviteUrl(value.clientId),messageContentIntent,requiredIntents:["Guilds","Guild Messages","Direct Messages","Message Content"],missingPermissions,guildCount:(guilds as any[]).length};
  }
  async configureWebhook(raw:string){await this.registerCommands(raw);}
  async registerCommands(raw:string){const value=parseCredential(raw);await this.request(value,`/applications/${value.clientId}/commands`,"PUT",messagingCommandDefinitions.map((command)=>({...command,type:1})));}
  async restore(){for(const connection of await this.repo.listDiscord())await this.start(connection).catch((error)=>this.repo.setError(connection,error instanceof Error?error.message:String(error)));}
  async start(connection:MessagingConnection){
    await this.stop(connection.id,false);const credential=parseCredential(this.repo.resolveToken(connection));
    if(credential.connectionId!==connection.id)throw new Error("Discord session isolation check failed");
    const state:DiscordState={connection,credential,attempt:0,stopped:false,channels:new Map(),guilds:new Map()};this.states.set(connection.id,state);
    await this.open(state);
  }
  private async open(state:DiscordState){
    if(state.stopped)return;const gateway=await this.request(state.credential,"/gateway/bot"),url=String(gateway.url||"wss://gateway.discord.gg");
    const socket=this.socketFactory(url+"/?v=10&encoding=json");state.socket=socket;
    socket.addEventListener("message",(event)=>void this.onGateway(state,event.data).catch((error)=>this.repo.setError(state.connection,error instanceof Error?error.message:String(error))));
    socket.addEventListener("close",(event)=>{if(state.heartbeat)clearInterval(state.heartbeat);if(state.stopped)return;if(event?.code===4014){void this.repo.setError(state.connection,"Discord Message Content intent is not enabled");return;}state.attempt++;const ms=Math.min(60_000,1000*2**Math.min(state.attempt,6));state.reconnect=setTimeout(()=>void this.open(state),ms);state.reconnect.unref?.();});
  }
  private send(state:DiscordState,payload:unknown){if(state.socket?.readyState===1)state.socket.send(JSON.stringify(payload));}
  private async onGateway(state:DiscordState,input:any){
    const text=typeof input==="string"?input:input instanceof ArrayBuffer?Buffer.from(input).toString("utf8"):Buffer.isBuffer(input)?input.toString("utf8"):String(input);
    const packet=JSON.parse(text);if(typeof packet.s==="number")state.sequence=packet.s;
    if(packet.op===10){const interval=Number(packet.d?.heartbeat_interval||45_000);state.heartbeat=setInterval(()=>this.send(state,{op:1,d:state.sequence??null}),interval);state.heartbeat.unref?.();this.send(state,{op:2,d:{token:state.credential.botToken,intents:INTENTS,properties:{os:process.platform,browser:"NPATI",device:"NPATI"}}});return;}
    if(packet.op===1){this.send(state,{op:1,d:state.sequence??null});return;}
    if(packet.op===7){state.socket?.close(4000,"Discord requested reconnect");return;}
    if(packet.op!==0)return;
    if(packet.t==="READY"){
      state.attempt=0;state.botId=String(packet.d.user.id);
      for(const guild of packet.d.guilds||[]){state.guilds.set(String(guild.id),{id:String(guild.id),name:String(guild.name||guild.id)});await this.repo.allowDiscordGuild(state.connection,String(guild.id));}
      if((packet.d.guilds||[]).length)await this.repo.setStatus(state.connection,"connected");
      return;
    }
    if(packet.t==="GUILD_CREATE"){const guildId=String(packet.d.id);state.guilds.set(guildId,{id:guildId,name:String(packet.d.name||guildId)});for(const channel of packet.d.channels||[])this.rememberChannel(state,channel,guildId);for(const thread of packet.d.threads||[])this.rememberChannel(state,thread,guildId);await this.repo.allowDiscordGuild(state.connection,guildId);await this.repo.setStatus(state.connection,"connected");return;}
    if(packet.t==="CHANNEL_CREATE"||packet.t==="THREAD_CREATE"){this.rememberChannel(state,packet.d,String(packet.d.guild_id||""));return;}
    if(packet.t==="THREAD_LIST_SYNC"){for(const thread of packet.d.threads||[])this.rememberChannel(state,thread,String(packet.d.guild_id||""));return;}
    if(packet.t==="MESSAGE_CREATE"){await this.handleMessage(state,packet.d,String(packet.s??packet.d.id));return;}
    if(packet.t==="INTERACTION_CREATE"){await this.handleInteraction(state,packet.d);return;}
    if(packet.t==="MESSAGE_REACTION_ADD"){await this.handleReaction(state,packet.d,String(packet.s??""));return;}
  }
  private rememberChannel(state:DiscordState,channel:any,guildId:string){state.channels.set(String(channel.id),{id:String(channel.id),name:String(channel.name||channel.id),type:Number(channel.type),parentId:channel.parent_id?String(channel.parent_id):null,guildId});}
  private binding(connection:MessagingConnection,guildId:string|undefined,channelId:string,parentId?:string|null){return connection.settings.discord.channelBindings.find((item)=>item.guildId===guildId&&(item.channelId===channelId||item.channelId===parentId));}
  private authorized(connection:MessagingConnection,input:{userId:string;guildId?:string;channelId:string;parentId?:string|null;roleIds:string[];mentioned:boolean;text:string}){
    const settings=connection.settings.discord;if(!input.guildId){
      if(/^\/connect\s+\d{6}$/u.test(input.text))return true;
      if(settings.dmPolicy==="disabled")return false;if(settings.dmPolicy==="open")return true;
      return settings.allowedUserIds.includes(input.userId)||connection.externalUserId===input.userId;
    }
    if(!connection.settings.groups.enabled||!settings.allowedGuildIds.includes(input.guildId))return false;
    if(settings.allowedChannelIds.length&&!settings.allowedChannelIds.some((id)=>id===input.channelId||id===input.parentId))return false;
    if(settings.allowedRoleIds.length&&!input.roleIds.some((id)=>settings.allowedRoleIds.includes(id)))return false;
    const binding=this.binding(connection,input.guildId,input.channelId,input.parentId),requireMention=binding?.requireMention??settings.requireMention;
    return !requireMention||input.mentioned||input.text.startsWith("/");
  }
  private async downloadFiles(files:any[]):Promise<GatewayAttachment[]>{
    const output:GatewayAttachment[]=[];for(const file of files||[]){const size=Number(file.size||0);if(size>25*1024*1024)throw new Error("Discord attachment exceeds 25 MB");const response=await this.fetcher(String(file.url));if(!response.ok)throw new Error("Discord attachment download failed");const bytes=Buffer.from(await response.arrayBuffer());if(bytes.byteLength>25*1024*1024)throw new Error("Discord attachment exceeds 25 MB");const mime=String(file.content_type||"application/octet-stream");output.push({kind:attachmentKind(mime),name:String(file.filename||"discord-file"),mimeType:mime,dataBase64:bytes.toString("base64")});}return output;
  }
  private async fresh(state:DiscordState){const latest=await this.repo.getInternal(state.connection.id);if(latest)state.connection=latest;return state.connection;}
  private async handleMessage(state:DiscordState,data:any,eventId:string){
    const connection=await this.fresh(state),userId=String(data.author?.id||"");if(!userId||data.author?.bot||userId===state.botId)return;
    const channelId=String(data.channel_id),cached=state.channels.get(channelId),parentId=cached?.parentId||null,guildId=data.guild_id?String(data.guild_id):undefined,roles=(data.member?.roles||[]).map(String),mentioned=(data.mentions||[]).some((item:any)=>String(item.id)===state.botId);
    let text=String(data.content||"").replace(new RegExp(`<@!?${state.botId}>`,"g"),"").trim();
    const pair=/^\/connect\s+(\d{6})$/u.exec(text);if(pair){const bound=await this.repo.bind(connection,{pairingCode:pair[1]!,externalUserId:userId,externalChatId:channelId});await this.sendText(this.repo.resolveToken(connection),channelId,bound?"Discord DM paired with NPATI.":"The pairing code is invalid or expired.");return;}
    if(!this.authorized(connection,{userId,guildId,channelId,parentId,roleIds:roles,mentioned,text}))return;
    const attachments=await this.downloadFiles(data.attachments||[]),reply=data.referenced_message,replyText=String(reply?.content||"").trim(),externalChatId=parentId||channelId,externalThreadId=parentId?channelId:undefined;
    const message:InboundGatewayMessage={externalUserId:userId,externalChatId,externalThreadId,externalGuildId:guildId,roleIds:roles,mentioned,text,attachments,hasAttachments:Boolean((data.attachments||[]).length),messageId:String(data.id),eventId:`discord:${eventId}:${data.id}`,chatType:guildId?"group":"private",replyContext:reply&&replyText?{messageId:String(reply.id),text:replyText,externalUserId:String(reply.author?.id||"")}:undefined};
    if(this.inbound)await this.inbound(connection.id,message);
  }
  private async handleInteraction(state:DiscordState,data:any){
    if(Number(data.type)!==2)return;const connection=await this.fresh(state),channelId=String(data.channel_id),cached=state.channels.get(channelId),parentId=cached?.parentId||null,guildId=data.guild_id?String(data.guild_id):undefined,user=data.member?.user||data.user,userId=String(user?.id||""),roles=(data.member?.roles||[]).map(String),text=messagingSlashCommand(String(data.data?.name||""),data.data?.options);
    if(!this.authorized(connection,{userId,guildId,channelId,parentId,roleIds:roles,mentioned:true,text})){await this.request(state.credential,`/interactions/${data.id}/${data.token}/callback`,"POST",{type:4,data:{content:"This Discord user/channel is not authorized for this NPATI connection.",flags:64}},false);return;}
    await this.request(state.credential,`/interactions/${data.id}/${data.token}/callback`,"POST",{type:5},false);this.interactions.set(String(data.id),{applicationId:String(data.application_id),token:String(data.token),channelId});
    if(this.inbound)await this.inbound(connection.id,{externalUserId:userId,externalChatId:parentId||channelId,externalThreadId:parentId?channelId:undefined,externalGuildId:guildId,roleIds:roles,mentioned:true,text,attachments:[],messageId:String(data.id),eventId:"discord-interaction:"+String(data.id),chatType:guildId?"group":"private"});
  }
  private async handleReaction(state:DiscordState,data:any,eventId:string){
    const connection=await this.fresh(state),channelId=String(data.channel_id),cached=state.channels.get(channelId),parentId=cached?.parentId||null,guildId=data.guild_id?String(data.guild_id):undefined,userId=String(data.user_id),roles=(data.member?.roles||[]).map(String),emoji=data.emoji?.name||data.emoji?.id;
    if(userId===state.botId||!this.authorized(connection,{userId,guildId,channelId,parentId,roleIds:roles,mentioned:true,text:"[reaction]"}))return;
    if(this.inbound)await this.inbound(connection.id,{externalUserId:userId,externalChatId:parentId||channelId,externalThreadId:parentId?channelId:undefined,externalGuildId:guildId,roleIds:roles,mentioned:true,text:`[Discord reaction: ${emoji}]`,attachments:[],messageId:String(data.message_id),eventId:`discord-reaction:${eventId}:${data.message_id}:${userId}:${emoji}`,chatType:guildId?"group":"private"});
  }
  async parseInbound(payload:any,raw:string,downloadAttachments=true):Promise<InboundGatewayMessage|null>{const value=parseCredential(raw),data=payload?.d||payload;if(!data?.id||!data?.author||data.author.bot)return null;return{externalUserId:String(data.author.id),externalChatId:String(data.channel_id),externalGuildId:data.guild_id?String(data.guild_id):undefined,text:String(data.content||""),attachments:downloadAttachments?await this.downloadFiles(data.attachments||[]):[],hasAttachments:Boolean(data.attachments?.length),messageId:String(data.id),eventId:"discord:"+String(payload?.s||data.id),chatType:data.guild_id?"group":"private"};}
  private target(chatId:string,threadId?:string){return threadId||chatId;}
  async sendText(raw:string,chatId:string,text:string,threadId?:string,replyTo?:string){
    const value=parseCredential(raw),ids:string[]=[];let first=true;
    for(const chunk of chunks(text)){let result:any;const interaction=first&&replyTo?this.interactions.get(replyTo):undefined;if(interaction){result=await this.request(value,`/webhooks/${interaction.applicationId}/${interaction.token}/messages/@original`,"PATCH",{content:chunk},false);this.interactions.delete(replyTo!);if(result?.id)this.webhookMessages.set(String(result.id),interaction);}else result=await this.request(value,`/channels/${this.target(chatId,threadId)}/messages`,"POST",{content:chunk,allowed_mentions:{parse:[]},...(first&&replyTo?{message_reference:{message_id:replyTo,fail_if_not_exists:false}}:{})});ids.push(String(result.id||""));first=false;}return ids;
  }
  async editText(raw:string,chatId:string,messageId:string,text:string){const value=parseCredential(raw),interaction=this.webhookMessages.get(messageId);if(interaction){await this.request(value,`/webhooks/${interaction.applicationId}/${interaction.token}/messages/${messageId}`,"PATCH",{content:text.slice(0,1900)},false);return;}await this.request(value,`/channels/${chatId}/messages/${messageId}`,"PATCH",{content:text.slice(0,1900)});}
  async sendTyping(raw:string,chatId:string,threadId?:string){await this.request(parseCredential(raw),`/channels/${this.target(chatId,threadId)}/typing`,"POST");}
  async sendAttachment(raw:string,chatId:string,attachment:GatewayOutboundAttachment,threadId?:string,replyTo?:string){
    const value=parseCredential(raw),bytes=Buffer.from(attachment.dataBase64,"base64"),form=new FormData(),payload={content:attachment.caption||"",allowed_mentions:{parse:[]},...(replyTo?{message_reference:{message_id:replyTo,fail_if_not_exists:false}}:{})};form.set("payload_json",JSON.stringify(payload));form.set("files[0]",new Blob([new Uint8Array(bytes)],{type:attachment.mimeType}),attachment.name);
    for(let attempt=0;attempt<5;attempt++){const response=await this.fetcher(API+`/channels/${this.target(chatId,threadId)}/messages`,{method:"POST",headers:{authorization:"Bot "+value.botToken},body:form}),data=await response.json().catch(()=>({})) as any;if(response.ok)return;if((response.status===429||response.status>=500)&&attempt<4){await wait(Math.min(30_000,Number(data.retry_after||0)*1000||250*2**attempt));continue;}throw new Error(data.message||"Discord attachment upload failed");}
  }
  async sendReaction(raw:string,chatId:string,messageId:string,emoji:string){const value=parseCredential(raw);await this.request(value,`/channels/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,"PUT");}
  async catalog(raw:string):Promise<DiscordCatalog>{const value=parseCredential(raw),guilds=await this.request(value,"/users/@me/guilds");return{guilds:await Promise.all((guilds as any[]).map(async(guild)=>{const[channels,roles,activeThreads]=await Promise.all([this.request(value,`/guilds/${guild.id}/channels`),this.request(value,`/guilds/${guild.id}/roles`),this.request(value,`/guilds/${guild.id}/threads/active`).catch(()=>({threads:[]}))]);return{id:String(guild.id),name:String(guild.name),icon:guild.icon||null,channels:[...(channels as any[]),...((activeThreads as any).threads||[])].filter((item)=>[0,5,10,11,12,15].includes(Number(item.type))).map((item)=>({id:String(item.id),name:String(item.name),type:Number(item.type),parentId:item.parent_id?String(item.parent_id):null})),roles:(roles as any[]).map((item)=>({id:String(item.id),name:String(item.name)}))};}))};}
  async stop(id:string,logout=true){const state=this.states.get(id);if(!state)return;state.stopped=true;if(state.heartbeat)clearInterval(state.heartbeat);if(state.reconnect)clearTimeout(state.reconnect);state.socket?.close(logout?1000:4000,logout?"Disconnected":"Restarting");this.states.delete(id);}
  async disconnect(raw:string){await this.stop(parseCredential(raw).connectionId,true);}
  async shutdown(){await Promise.all([...this.states.keys()].map((id)=>this.stop(id,false)));}
}
