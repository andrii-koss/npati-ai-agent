import { describe, expect, it, vi } from "vitest";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { DiscordMessagingAdapter } from "../apps/agent-api/src/discord-messaging";
import { MessagingInboundDispatcher } from "../apps/agent-api/src/messaging-inbound-dispatcher";
import { MessagingIntegrationsRepository } from "../apps/agent-api/src/messaging-integrations-repository";
import { runMigration051 } from "../packages/workspace/src/migration-051";

const owner:AuthContext={workspaceId:"workspace-discord",userId:"owner-discord",permissions:["workspace:read","business:manage","tools:execute"]};
class FakeSocket{
  readyState=1;sent:string[]=[];private handlers=new Map<string,Array<(event:any)=>unknown>>();
  addEventListener(type:string,listener:(event:any)=>unknown){const list=this.handlers.get(type)||[];list.push(listener);this.handlers.set(type,list);}
  send(data:string){this.sent.push(data);} close(){}
  async emit(type:string,data:any){for(const handler of this.handlers.get(type)||[])await handler(type==="message"?{data:JSON.stringify(data)}:data);}
}
function discordFetch(downloads:string[],outbound:any[]){
  return vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input),method=init?.method||"GET";
    if(url.endsWith("/users/@me"))return Response.json({id:"bot-1",username:"npati",bot:true});
    if(url.endsWith("/oauth2/applications/@me"))return Response.json({id:"client-1",flags:1<<18});
    if(url.endsWith("/users/@me/guilds"))return Response.json([{id:"guild-1",name:"Acme",permissions:"281026644032"}]);
    if(url.endsWith("/gateway/bot"))return Response.json({url:"wss://gateway.discord.test"});
    if(url.includes("/applications/client-1/commands")){outbound.push({url,method,body:JSON.parse(String(init?.body))});return Response.json([]);}
    if(url.endsWith("/guilds/guild-1/channels"))return Response.json([{id:"channel-1",name:"general",type:0},{id:"thread-1",name:"work",type:11,parent_id:"channel-1"}]);
    if(url.endsWith("/guilds/guild-1/roles"))return Response.json([{id:"role-1",name:"Operators"}]);
    if(url.endsWith("/guilds/guild-1/threads/active"))return Response.json({threads:[{id:"thread-1",name:"work",type:11,parent_id:"channel-1"}]});
    if(url.startsWith("https://cdn.discord.test/")){downloads.push(url);return new Response(new Uint8Array([1,2,3]),{status:200});}
    if(url.includes("/typing")||url.includes("/reactions/"))return new Response(null,{status:204});
    if(url.includes("/messages")){const body=typeof init?.body==="string"?JSON.parse(init.body):init?.body;outbound.push({url,method,body});return Response.json({id:"out-"+outbound.length});}
    throw new Error(`Unexpected Discord request: ${method} ${url}`);
  });
}

describe("Discord integration",()=>{
  it("migrates settings and encrypts credentials per tenant/connection",async()=>{
    let sql="";await runMigration051({query:async(value:string)=>{sql=value;return{};}} as any);
    expect(sql).toContain('"dmPolicy":"pairing"');expect(sql).toContain('"channelBindings":[]');
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("discord-repository-test-key-longer-than-32"));
    const created=await repo.createDiscord(owner,null,{displayName:"Discord",credential:'{"botToken":"secret"}',botUsername:"@npati",scope:"account"});
    const internal=await repo.getInternal(created.connection.id);
    expect(internal?.encryptedCredential).not.toContain("secret");expect(repo.resolveToken(internal!)).toContain("secret");
    expect(await repo.getOwned({...owner,userId:"attacker"},created.connection.id)).toBeNull();
  });

  it("validates identity, registers shared commands, generates invite and chunks output",async()=>{
    const downloads:string[]=[],outbound:any[]=[],fetcher=discordFetch(downloads,outbound),repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("discord-adapter-test-key-longer-than-32")),adapter=new DiscordMessagingAdapter(repo,fetcher as typeof fetch,()=>new FakeSocket());
    const credential=adapter.createCredential("connection-1","Bot token","client-1"),setup=await adapter.validateCredential(credential);
    expect(setup).toMatchObject({externalName:"@npati",botId:"bot-1",messageContentIntent:true});expect(setup.inviteUrl).toContain("applications.commands");
    await adapter.registerCommands(credential);expect(outbound.find((item)=>item.url.includes("/commands")).body.map((item:any)=>item.name)).toEqual(expect.arrayContaining(["status","company","approve","deny"]));const catalog=await adapter.catalog(credential);expect(catalog.guilds[0]?.channels).toContainEqual(expect.objectContaining({id:"thread-1",parentId:"channel-1"}));
    await adapter.sendText(credential,"channel-1","x".repeat(4100));expect(outbound.filter((item)=>item.url.includes("/channels/channel-1/messages"))).toHaveLength(3);await adapter.sendReaction(credential,"channel-1","message-1","✅");expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/reactions/%E2%9C%85/@me"),expect.objectContaining({method:"PUT"}));
  });

  it("authorizes before downloads, pairs DMs, deduplicates, restores threads and reconnects",async()=>{
    const downloads:string[]=[],outbound:any[]=[],sockets:FakeSocket[]=[],fetcher=discordFetch(downloads,outbound),repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("discord-e2e-test-key-longer-than-thirty-two"));
    const created=await repo.createDiscord(owner,null,{displayName:"Discord E2E",credential:"temporary",botUsername:"@npati",scope:"account"}),connection=(await repo.getInternal(created.connection.id))!;
    await repo.replaceEncryptedCredential(connection,JSON.stringify({provider:"discord",version:1,connectionId:connection.id,botToken:"token",clientId:"client-1"}));
    const adapter=new DiscordMessagingAdapter(repo,fetcher as typeof fetch,()=>{const socket=new FakeSocket();sockets.push(socket);return socket;});
    const runtime=vi.fn(async()=>({message:"NPATI reply",attachments:[{name:"result.txt",mimeType:"text/plain",dataBase64:"b2s="}]}));
    const dispatcher=new MessagingInboundDispatcher({store:{} as any,repo,adapter,handleMessage:runtime});
    adapter.setInboundHandler(async(id,message)=>dispatcher.dispatch((await repo.getInternal(id))!,message).then(()=>undefined));
    await adapter.start(connection);const socket=sockets[0]!;
    await socket.emit("message",{op:10,d:{heartbeat_interval:60000}});
    await socket.emit("message",{op:0,t:"READY",s:1,d:{user:{id:"bot-1"},guilds:[{id:"guild-1",name:"Acme"}]}});
    await socket.emit("message",{op:0,t:"GUILD_CREATE",s:2,d:{id:"guild-1",name:"Acme",channels:[{id:"channel-1",name:"general",type:0}],threads:[{id:"thread-1",name:"work",type:11,parent_id:"channel-1"}]}});
    const attachment={id:"file-1",filename:"brief.png",content_type:"image/png",size:3,url:"https://cdn.discord.test/brief.png"};
    await socket.emit("message",{op:0,t:"MESSAGE_CREATE",s:3,d:{id:"blocked",channel_id:"channel-1",guild_id:"guild-1",author:{id:"user-1"},member:{roles:["role-1"]},content:"no mention",mentions:[],attachments:[attachment]}});
    expect(downloads).toEqual([]);expect(runtime).not.toHaveBeenCalled();
    const message={op:0,t:"MESSAGE_CREATE",s:4,d:{id:"allowed",channel_id:"thread-1",guild_id:"guild-1",author:{id:"user-1"},member:{roles:["role-1"]},content:"<@bot-1> inspect",mentions:[{id:"bot-1"}],attachments:[attachment],referenced_message:{id:"prior",content:"context",author:{id:"user-1"}}}};
    await socket.emit("message",message);await vi.waitFor(()=>expect(runtime).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(outbound.some((item)=>item.url.includes("/channels/thread-1/messages"))).toBe(true));
    expect(downloads).toHaveLength(1);expect(runtime.mock.calls[0]![0]).toMatchObject({text:"inspect",replyContext:{messageId:"prior"}});expect(outbound.some((item)=>item.body instanceof FormData)).toBe(true);
    await socket.emit("message",message);expect(runtime).toHaveBeenCalledOnce();
    expect(await repo.listSessionsOwned(owner,connection.id)).toContainEqual(expect.objectContaining({externalChatId:"channel-1",externalThreadId:"thread-1"}));
    await socket.emit("message",{op:0,t:"MESSAGE_CREATE",s:5,d:{id:"pair",channel_id:"dm-1",author:{id:"dm-user"},content:`/connect ${created.pairingCode}`,attachments:[]}});
    expect(connection.externalUserId).toBe("dm-user");
    await adapter.shutdown();const restored=new DiscordMessagingAdapter(repo,fetcher as typeof fetch,()=>{const next=new FakeSocket();sockets.push(next);return next;});await restored.restore();expect(sockets).toHaveLength(2);await restored.shutdown();
  });

  it("applies per-channel Company/Agent and capability restrictions",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("discord-binding-test-key-longer-than-32")),created=await repo.createDiscord(owner,null,{displayName:"Bindings",credential:"raw",botUsername:"@npati",scope:"account"}),connection=(await repo.getInternal(created.connection.id))!;
    connection.status="connected";connection.settings.discord.allowedGuildIds=["guild-1"];connection.settings.discord.channelBindings=[{guildId:"guild-1",channelId:"channel-1",companyId:"company-1",agentId:"agent-1",requireMention:false,permissions:["tools:execute"]}];
    const runtime=vi.fn(async()=>({message:"ok"})),sendText=vi.fn(async()=>["reply"]),store={getCompany:vi.fn(async()=>({id:"company-1"})),getCompanyAgent:vi.fn(async()=>({id:"agent-1"}))};
    const dispatcher=new MessagingInboundDispatcher({store:store as any,repo,adapter:{channel:"discord",validateCredential:vi.fn(),configureWebhook:vi.fn(),parseInbound:vi.fn(),sendText} as any,handleMessage:runtime});
    await dispatcher.dispatch(connection,{externalUserId:"user-1",externalChatId:"channel-1",externalGuildId:"guild-1",roleIds:[],mentioned:false,text:"/approve abcdefgh",attachments:[],messageId:"binding-1",eventId:"binding-1",chatType:"group"});
    await vi.waitFor(()=>expect(runtime).toHaveBeenCalledOnce());expect(runtime.mock.calls[0]![0].connection).toMatchObject({scope:"agent",companyId:"company-1",agentId:"agent-1",permissions:["tools:execute"]});expect(connection.scope).toBe("account");
  });
});