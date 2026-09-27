import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { MessagingGateway } from "../apps/agent-api/src/messaging-gateway";
import { MessagingIntegrationsRepository } from "../apps/agent-api/src/messaging-integrations-repository";
import { registerMessagingIntegrationRoutes } from "../apps/agent-api/src/messaging-integrations-routes";
import { WhatsAppInboundDispatcher } from "../apps/agent-api/src/messaging-inbound-dispatcher";
import { WhatsAppMessagingAdapter } from "../apps/agent-api/src/whatsapp-messaging";
import { runMigration049 } from "../packages/workspace/src/migration-049";

import { runMigration050 } from "../packages/workspace/src/migration-050";
const owner:AuthContext={workspaceId:"workspace-wa",userId:"owner-wa",permissions:["workspace:read","business:manage","tools:execute"]};

describe("WhatsApp providers",()=>{
  it("migrates provider discrimination and keeps encrypted sessions tenant isolated",async()=>{
    let sql="";await runMigration049({query:async(value:string)=>{sql=value;return{};}} as any);
    expect(sql).toContain("provider IN ('qr','cloud')");expect(sql).toContain("idx_messaging_connections_whatsapp_restore");
    let selfChatSql="";await runMigration050({query:async(value:string)=>{selfChatSql=value;return{};}} as any);
    expect(selfChatSql).toContain('"selfChat":false');
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("whatsapp-repository-test-key-longer-than-32"));
    const created=await repo.createWhatsApp(owner,null,{displayName:"WA",provider:"cloud",scope:"account",credential:JSON.stringify({provider:"cloud",accessToken:"secret"})});
    expect(created.connection).toMatchObject({channel:"whatsapp",provider:"cloud",scope:"account"});
    expect(created.connection).not.toHaveProperty("encryptedCredential");
    const internal=await repo.getByWebhookSecret(created.webhookSecret,"whatsapp");
    expect(internal?.encryptedCredential).not.toContain("secret");
    expect(repo.resolveToken(internal!)).toContain("secret");
    expect(await repo.getOwned({...owner,userId:"attacker"},created.connection.id)).toBeNull();
  });

  it("validates Cloud credentials, parses quoted messages, chunks output and verifies signatures",async()=>{
    const sent:string[]=[];
    const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
      if(url.includes("fields=display_phone_number"))return new Response(JSON.stringify({verified_name:"NPATI WA"}),{status:200});
      if(url.endsWith("/messages")){sent.push(JSON.parse(String(init?.body)).text.body);return new Response(JSON.stringify({messages:[{id:"wamid.out"}]}),{status:200});}
      throw new Error("Unexpected WhatsApp request: "+url);
    });
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("whatsapp-adapter-test-key-longer-than-32"));
    const adapter=new WhatsAppMessagingAdapter(repo,fetcher as typeof fetch);
    const credential=adapter.createCloudCredential({phoneNumberId:"123",accessToken:"token",appSecret:"app-secret",verifyToken:"verify"});
    await expect(adapter.validateCredential(credential)).resolves.toEqual({externalName:"NPATI WA"});
    const inbound=await adapter.parseInbound({entry:[{changes:[{value:{messages:[{id:"wamid.1",from:"15550001",type:"text",text:{body:"hello"},context:{id:"wamid.0",from:"15550002"}}]}}]}]},credential);
    expect(inbound).toMatchObject({eventId:"wamid.1",externalUserId:"15550001",replyContext:{messageId:"wamid.0"}});
    await adapter.sendText(credential,"15550001","x".repeat(9000));
    expect(sent).toHaveLength(3);expect(sent.every((value)=>value.length<=4000)).toBe(true);
    const raw=Buffer.from('{"ok":true}'),signature="sha256="+createHmac("sha256","app-secret").update(raw).digest("hex");
    expect(adapter.verifyCloudSignature(raw,signature,adapter.credential(credential) as any)).toBe(true);
    expect(adapter.verifyCloudSignature(raw,"sha256=bad",adapter.credential(credential) as any)).toBe(false);
  });

  it("runs a signed Cloud webhook through allowlist, deduplication and the shared runtime callback",async()=>{
    const outbound:string[]=[];
    const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
      if(url.includes("fields=display_phone_number"))return new Response(JSON.stringify({verified_name:"NPATI Cloud"}),{status:200});
      if(url.endsWith("/messages")){outbound.push(JSON.parse(String(init?.body)).text.body);return new Response(JSON.stringify({messages:[{id:"wamid.reply"}]}),{status:200});}
      throw new Error("Unexpected request: "+url);
    });
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("whatsapp-e2e-test-key-longer-than-thirty-two"));
    const whatsapp=new WhatsAppMessagingAdapter(repo,fetcher as typeof fetch),gateway=new MessagingGateway().register(whatsapp);
    const handleMessage=vi.fn(async()=>({message:"Shared runtime result"})),app=Fastify();
    registerMessagingIntegrationRoutes(app,{auth:{authenticate:async()=>owner} as any,store:{} as any,repo,gateway,webhookBaseUrl:"https://ai.npati.test",handleMessage});
    const created=await app.inject({method:"POST",url:"/integrations/whatsapp",payload:{method:"cloud",displayName:"Cloud",phoneNumberId:"123",accessToken:"token",appSecret:"app-secret",verifyToken:"verify"}});
    expect(created.statusCode).toBe(201);const setup=created.json(),id=setup.connection.id,secret=String(setup.webhookUrl).split("/").at(-1)!;
    const managed=(await app.inject({method:"GET",url:"/integrations/messaging/"+id+"/manage"})).json();
    await app.inject({method:"PATCH",url:"/integrations/messaging/"+id,payload:{displayName:"Cloud",scope:"account",settings:{...managed.connection.settings,access:{allowedUserIds:["15550001"]}}}});
    const verification=await app.inject({method:"GET",url:"/v1/integrations/whatsapp/cloud/"+secret+"?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42"});
    expect(verification.statusCode).toBe(200);expect(verification.body).toBe("42");
    const payload={entry:[{changes:[{value:{messages:[{id:"wamid.in.1",from:"15550001",type:"text",text:{body:"Run task"}}]}}]}]},raw=JSON.stringify(payload),signature="sha256="+createHmac("sha256","app-secret").update(raw).digest("hex");
    const inbound=await app.inject({method:"POST",url:"/api/v1/integrations/whatsapp/cloud/"+secret,headers:{"x-hub-signature-256":signature,"content-type":"application/json"},payload:raw});
    expect(inbound.statusCode).toBe(200);expect(inbound.json().status).toBe("accepted");
    await vi.waitFor(()=>expect(handleMessage).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(outbound).toContain("Shared runtime result"));
    const duplicate=await app.inject({method:"POST",url:"/api/v1/integrations/whatsapp/cloud/"+secret,headers:{"x-hub-signature-256":signature,"content-type":"application/json"},payload:raw});
    expect(duplicate.json().status).toBe("duplicate");expect(handleMessage).toHaveBeenCalledOnce();
    await app.close();
  });
  it("runs QR connect -> Message yourself -> NPATI reply -> restart without replying to its own output",async()=>{
    const makeFakeSocket=()=>{
      const handlers=new Map<string,Array<(event:any)=>unknown>>();
      const socket:any={
        user:{id:"15550001:7@s.whatsapp.net",phoneNumber:"15550001@s.whatsapp.net"},
        signalRepository:{lidMapping:{getPNForLID:vi.fn(async()=>null)}},
        ev:{on:(name:string,handler:(event:any)=>unknown)=>{const list=handlers.get(name)||[];list.push(handler);handlers.set(name,list);}},
        sendMessage:vi.fn(async(_chatId:string,_content:any,options:any)=>({key:{id:options?.messageId}})),
        sendPresenceUpdate:vi.fn(async()=>undefined),logout:vi.fn(async()=>undefined),end:vi.fn()
      };
      return{socket,emit:async(name:string,event:any)=>{for(const handler of handlers.get(name)||[])await handler(event);}};
    };
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("whatsapp-self-chat-test-key-longer-than-32"));
    const first=makeFakeSocket(),adapter=new WhatsAppMessagingAdapter(repo,fetch,(()=>first.socket) as any);
    const created=await repo.createWhatsApp(owner,null,{displayName:"Personal WhatsApp",provider:"qr",scope:"account",credential:"{}"});
    const connection=(await repo.getInternal(created.connection.id))!;
    await repo.replaceEncryptedCredential(connection,adapter.createQrCredential(connection.id));
    await repo.updateOwned(owner,connection.id,{displayName:connection.displayName,scope:"account",companyId:null,agentId:null,settings:{...connection.settings,access:{allowedUserIds:[],selfChat:true}}});
    const inbound=vi.fn(async()=>undefined);adapter.setInboundHandler(inbound);
    await adapter.startQr(connection);
    await first.emit("connection.update",{connection:"open"});
    expect(connection.status).toBe("connected");
    await first.emit("messages.upsert",{type:"notify",messages:[{key:{id:"user-1",remoteJid:"15550001@s.whatsapp.net",fromMe:true},message:{conversation:"Run /status"}}]});
    expect(inbound).toHaveBeenCalledWith(connection.id,expect.objectContaining({eventId:"user-1",isSelfChat:true,text:"Run /status"}));
    const [replyId]=await adapter.sendText(repo.resolveToken(connection),"15550001@s.whatsapp.net","NPATI reply");
    await first.emit("messages.upsert",{type:"notify",messages:[{key:{id:replyId,remoteJid:"15550001@s.whatsapp.net",fromMe:true},message:{conversation:"NPATI reply"}}]});
    expect(inbound).toHaveBeenCalledTimes(1);
    await adapter.shutdown();

    const second=makeFakeSocket(),restored=new WhatsAppMessagingAdapter(repo,fetch,(()=>second.socket) as any),afterRestart=vi.fn(async()=>undefined);
    restored.setInboundHandler(afterRestart);await restored.restore();
    await second.emit("messages.upsert",{type:"notify",messages:[{key:{id:replyId,remoteJid:"15550001@s.whatsapp.net",fromMe:true},message:{conversation:"NPATI reply"}}]});
    await second.emit("messages.upsert",{type:"notify",messages:[{key:{id:"user-2",remoteJid:"15550001@s.whatsapp.net",fromMe:true},message:{conversation:"continue"}}]});
    await second.emit("messages.upsert",{type:"notify",messages:[{key:{id:"other-chat",remoteJid:"15550002@s.whatsapp.net",fromMe:true},message:{conversation:"not self"}}]});
    expect(afterRestart).toHaveBeenCalledTimes(1);expect(afterRestart).toHaveBeenCalledWith(connection.id,expect.objectContaining({eventId:"user-2",isSelfChat:true}));
    await repo.updateOwned(owner,connection.id,{displayName:connection.displayName,scope:"account",companyId:null,agentId:null,settings:{...connection.settings,access:{allowedUserIds:[],selfChat:false}}});
    await second.emit("messages.upsert",{type:"notify",messages:[{key:{id:"user-3",remoteJid:"15550001@s.whatsapp.net",fromMe:true},message:{conversation:"disabled"}}]});
    await second.emit("messages.upsert",{type:"notify",messages:[{key:{id:"normal-user",remoteJid:"15550002@s.whatsapp.net",fromMe:false},message:{conversation:"normal bot mode"}}]});
    expect(afterRestart).toHaveBeenCalledTimes(2);expect(afterRestart).toHaveBeenLastCalledWith(connection.id,expect.objectContaining({eventId:"normal-user"}));expect(afterRestart.mock.calls.at(-1)?.[1]).not.toHaveProperty("isSelfChat");
    await restored.shutdown();
  });

  it("bypasses only the DM allowlist for verified self-chat and retains the configured runtime scope",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("whatsapp-self-dispatch-key-longer-than-32"));
    const created=await repo.createWhatsApp(owner,"company-1",{displayName:"Scoped self chat",provider:"qr",scope:"agent",agentId:"agent-1",credential:"{}"});
    const connection=(await repo.getInternal(created.connection.id))!;
    connection.settings={...connection.settings,access:{allowedUserIds:[],selfChat:true},delivery:{typing:false,progressive:false},notifications:{...connection.settings.notifications,status:false}};
    await repo.markConnected(connection,"15550001","15550001@s.whatsapp.net");
    const sendText=vi.fn(async()=>["reply-1"]),handleMessage=vi.fn(async(input:any)=>({message:"Scoped runtime reply: "+input.connection.scope}));
    const dispatcher=new WhatsAppInboundDispatcher({store:{getCompany:vi.fn(async()=>({})),getCompanyAgent:vi.fn(async()=>({}))} as any,repo,adapter:{channel:"whatsapp",validateCredential:vi.fn(),configureWebhook:vi.fn(),parseInbound:vi.fn(),sendText} as any,handleMessage});
    const result=await dispatcher.dispatch(connection,{externalUserId:"15550001@s.whatsapp.net",externalChatId:"15550001@s.whatsapp.net",text:"hello",attachments:[],messageId:"self-runtime-1",eventId:"self-runtime-1",chatType:"private",isSelfChat:true});
    expect(result.status).toBe("accepted");
    await vi.waitFor(()=>expect(handleMessage).toHaveBeenCalledOnce());
    expect(handleMessage.mock.calls[0]![0].connection).toMatchObject({scope:"agent",companyId:"company-1",agentId:"agent-1"});
    await vi.waitFor(()=>expect(sendText).toHaveBeenCalledWith(expect.any(String),"15550001@s.whatsapp.net","Scoped runtime reply: agent",undefined,"self-runtime-1"));
    await expect(dispatcher.dispatch(connection,{externalUserId:"15550002@s.whatsapp.net",externalChatId:"15550002@s.whatsapp.net",text:"blocked",attachments:[],messageId:"normal-1",eventId:"normal-1",chatType:"private"})).rejects.toMatchObject({code:"WHATSAPP_ALLOWLIST_MISMATCH"});
  });
});
