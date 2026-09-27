import { describe, expect, it, vi } from "vitest";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { MessagingIntegrationsRepository } from "../apps/agent-api/src/messaging-integrations-repository";
import { MessagingGateway, TelegramMessagingAdapter } from "../apps/agent-api/src/messaging-gateway";
import Fastify from "fastify";
import { registerMessagingIntegrationRoutes } from "../apps/agent-api/src/messaging-integrations-routes";
import { runMigration045 } from "../packages/workspace/src/migration-045";
import { runMigration046 } from "../packages/workspace/src/migration-046";
import { runMigration047 } from "../packages/workspace/src/migration-047";
import { runMigration048 } from "../packages/workspace/src/migration-048";
import { MessagingScopeRouter } from "../apps/agent-api/src/messaging-scope-router";

const owner:AuthContext={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage","tools:execute"]};

describe("messaging migration",()=>{
  it("uses the existing TEXT identifier type for Company Agent foreign keys",async()=>{
    let sql="";await runMigration045({query:async(statement:string)=>{sql=statement;return{};}} as any);
    expect(sql).toMatch(/agent_id TEXT REFERENCES company_agents\(id\)/);
    expect(sql).not.toMatch(/agent_id UUID REFERENCES company_agents\(id\)/);
  });
  it("adds account scope and makes the Company binding optional",async()=>{let sql="";await runMigration046({query:async(statement:string)=>{sql=statement;return{};}} as any);expect(sql).toContain("connection_scope");expect(sql).toContain("ALTER COLUMN company_id DROP NOT NULL");expect(sql).toContain("active_company_id TEXT");});
  it("adds durable per-topic sessions and inbound deduplication with UUID-compatible connection keys",async()=>{let sql="";await runMigration047({query:async(statement:string)=>{sql=statement;return{};}} as any);expect(sql).toContain("CREATE TABLE IF NOT EXISTS messaging_sessions");expect(sql).toContain("connection_id UUID NOT NULL REFERENCES messaging_connections(id)");expect(sql).not.toContain("connection_id TEXT NOT NULL REFERENCES messaging_connections(id)");expect(sql).toContain("UNIQUE(connection_id, external_chat_id, external_thread_id)");expect(sql).toContain("messaging_inbound_events");});
  it("adds validated JSON settings for the connection management UI",async()=>{let sql="";await runMigration048({query:async(statement:string)=>{sql=statement;return{};}} as any);expect(sql).toContain("ADD COLUMN IF NOT EXISTS settings JSONB");expect(sql).toContain("jsonb_typeof(settings)='object'");});
});

describe("messaging integrations tenant binding",()=>{
  it("encrypts credentials, hides secrets and isolates users",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("test-master-key-that-is-at-least-thirty-two-characters"));
    const created=await repo.createTelegram(owner,"company-a",{displayName:"NPATI Bot",botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"});
    expect(created.connection).not.toHaveProperty("encryptedCredential");
    expect(created.connection).not.toHaveProperty("webhookSecret");
    expect(await repo.list({...owner,userId:"user-b"},"company-a")).toEqual([]);
    const internal=await repo.getByWebhookSecret(created.webhookSecret);
    expect(internal).not.toBeNull();
    expect(internal!.encryptedCredential).not.toContain("123456:");
    expect(repo.resolveToken(internal!)).toBe("123456:abcdefghijklmnopqrstuvwxyzABCDEFGH");
    expect(await repo.bind(internal!,{pairingCode:"000000",externalUserId:"7",externalChatId:"8"})).toBe(false);
    expect(await repo.bind(internal!,{pairingCode:created.pairingCode,externalUserId:"7",externalChatId:"8"})).toBe(true);
    expect((await repo.listConnectedForCompany("workspace-a","user-a","company-a"))[0]?.externalChatId).toBe("8");
  });
  it("supports an account-scoped connection with mutable active context",async()=>{const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("account-scope-master-key-that-is-long-enough-123"));const created=await repo.createTelegram(owner,null,{scope:"account",displayName:"Account Bot",botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"});const internal=await repo.getByWebhookSecret(created.webhookSecret);expect(internal).toMatchObject({scope:"account",companyId:null});await repo.setActiveContext(internal!,"company-b","agent-b");expect(internal).toMatchObject({activeCompanyId:"company-b",activeAgentId:"agent-b"});});
  it("isolates topic sessions and rejects duplicate Telegram updates",async()=>{const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("topic-scope-master-key-that-is-long-enough-123"));const created=await repo.createTelegram(owner,null,{scope:"account",displayName:"Topics",botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"});const connection=(await repo.getByWebhookSecret(created.webhookSecret))!;const first=await repo.getOrCreateSession(connection,"-100","10"),second=await repo.getOrCreateSession(connection,"-100","11");expect(first.id).not.toBe(second.id);await repo.setSessionConversation(first,"conversation-a");await repo.setActiveContext(connection,"company-a","agent-a",first);expect((await repo.getOrCreateSession(connection,"-100","10"))).toMatchObject({runtimeConversationId:"conversation-a",activeCompanyId:"company-a",activeAgentId:"agent-a"});expect(await repo.claimInbound(connection,"update-1","message-1")).toBe(true);expect(await repo.claimInbound(connection,"update-1","message-1")).toBe(false);});
  it("updates connection scope and preferences without exposing another tenant",async()=>{const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("manage-scope-master-key-that-is-long-enough-123")),created=await repo.createTelegram(owner,null,{scope:"account",displayName:"Before",botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"}),connection=(await repo.getByWebhookSecret(created.webhookSecret))!,settings={...connection.settings,groups:{...connection.settings.groups,enabled:false,allowedChatIds:["-1001"]}};const updated=await repo.updateOwned(owner,connection.id,{displayName:"After",scope:"company",companyId:"company-a",agentId:null,settings});expect(updated).toMatchObject({displayName:"After",scope:"company",companyId:"company-a",settings:{groups:{enabled:false,allowedChatIds:["-1001"]}}});expect(await repo.getOwned({...owner,userId:"attacker"},connection.id)).toBeNull();});
});

describe("messaging scope router",()=>{
  it("switches account sessions between Company, Agent and account contexts",async()=>{const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("scope-router-master-key-that-is-long-enough-123"));const created=await repo.createTelegram(owner,null,{scope:"account",displayName:"Account Bot",botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"});const connection=(await repo.getByWebhookSecret(created.webhookSecret))!;const company={id:"company-a",name:"Acme",mainAgentId:"agent-a"};const agent={id:"agent-a",name:"Sales",role:"Sales",isActive:true};const store={listCompanies:async()=>({items:[company],nextCursor:null}),getCompany:async()=>company,listCompanyAgentsPage:async()=>({items:[agent],nextCursor:null}),getCompanyAgent:async()=>agent} as any;const router=new MessagingScopeRouter(store,repo);expect((await router.resolve(owner,connection,"/company Acme")).handled).toBe(true);expect(connection.activeCompanyId).toBe("company-a");expect((await router.resolve(owner,connection,"/agent Sales")).handled).toBe(true);expect(connection.activeAgentId).toBe("agent-a");const active=await router.resolve(owner,connection,"Create a task");expect(active).toMatchObject({handled:false,company:{id:"company-a"},agent:{id:"agent-a"}});await router.resolve(owner,connection,"/account");expect(connection.activeCompanyId).toBeNull();});
  it("does not allow a fixed Company connection to escape its binding",async()=>{const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("fixed-scope-master-key-that-is-long-enough-123")),created=await repo.createTelegram(owner,"company-a",{scope:"company",displayName:"Fixed",botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"}),connection=(await repo.getByWebhookSecret(created.webhookSecret))!,router=new MessagingScopeRouter({getCompany:async()=>({id:"company-a",name:"Acme"})} as any,repo);const result=await router.resolve(owner,connection,"/account");expect(result.handled).toBe(true);expect(result.message).toMatch(/locked/i);expect(connection.companyId).toBe("company-a");});
});

describe("Telegram messaging adapter",()=>{
  it("validates, downloads a photo and sends messages through the adapter boundary",async()=>{
    const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
      if(url.endsWith("/getMe"))return new Response(JSON.stringify({ok:true,result:{username:"npati_test_bot",first_name:"NPATI"}}),{status:200});
      if(url.endsWith("/getFile"))return new Response(JSON.stringify({ok:true,result:{file_path:"photos/a.jpg"}}),{status:200});
      if(url.includes("/file/bot"))return new Response(new Uint8Array([1,2,3]),{status:200});
      if(url.endsWith("/sendMessage")){expect(JSON.parse(String(init?.body)).chat_id).toBe("22");return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});}
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter=new TelegramMessagingAdapter(fetcher as typeof fetch);
    const token="123456:abcdefghijklmnopqrstuvwxyzABCDEFGH";
    expect(await adapter.validateCredential(token)).toEqual({externalName:"@npati_test_bot"});
    const inbound=await adapter.parseInbound({update_id:1,message:{message_id:9,from:{id:11},chat:{id:22},caption:"Review this",photo:[{file_id:"photo-1",width:100,height:100}]}},token);
    expect(inbound).toMatchObject({externalUserId:"11",externalChatId:"22",text:"Review this"});
    expect(inbound?.attachments[0]).toMatchObject({kind:"image",mimeType:"image/jpeg",dataBase64:"AQID"});
    await adapter.sendText(token,"22","Done");
  });
  it("keeps adapters replaceable",()=>{const gateway=new MessagingGateway().register(new TelegramMessagingAdapter(vi.fn() as any));expect(gateway.adapter("telegram").channel).toBe("telegram");expect(()=>gateway.adapter("slack")).toThrow(/unavailable/);});
  it("honors Telegram rate-limit retry_after without duplicating application logic",async()=>{let attempt=0;const sleeper=vi.fn(async()=>undefined);const fetcher=vi.fn(async()=>{attempt++;return attempt===1?new Response(JSON.stringify({ok:false,error_code:429,description:"Too Many Requests",parameters:{retry_after:0}}),{status:429}):new Response(JSON.stringify({ok:true,result:{username:"retry_bot",first_name:"Retry"}}),{status:200});});const adapter=new TelegramMessagingAdapter(fetcher as typeof fetch,sleeper);await expect(adapter.validateCredential("123456:abcdefghijklmnopqrstuvwxyzABCDEFGH")).resolves.toEqual({externalName:"@retry_bot"});expect(fetcher).toHaveBeenCalledTimes(2);expect(sleeper).toHaveBeenCalledOnce();});
  it("preserves topic and reply context and chunks long responses",async()=>{const sent:string[]=[];const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{if(url.endsWith("/sendMessage")){sent.push(JSON.parse(String(init?.body)).text);return new Response(JSON.stringify({ok:true,result:{message_id:sent.length}}),{status:200});}throw new Error(`Unexpected URL ${url}`);});const adapter=new TelegramMessagingAdapter(fetcher as typeof fetch);const inbound=await adapter.parseInbound({update_id:99,message:{message_id:7,message_thread_id:42,from:{id:11},chat:{id:-100,type:"supergroup"},text:"continue",reply_to_message:{message_id:6,text:"original request",from:{id:11}}}},"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH");expect(inbound).toMatchObject({eventId:"99",externalThreadId:"42",chatType:"supergroup",replyContext:{messageId:"6",text:"original request"}});await adapter.sendText("123456:abcdefghijklmnopqrstuvwxyzABCDEFGH","-100","x".repeat(8000),"42");expect(sent).toHaveLength(3);expect(sent.every((item)=>item.length<=3900)).toBe(true);});
  it("sends typing state and native outbound documents to the same topic",async()=>{const calls:string[]=[];const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{calls.push(url.split("/").at(-1)!);if(url.endsWith("/sendChatAction")){expect(JSON.parse(String(init?.body))).toMatchObject({chat_id:"-100",message_thread_id:42,action:"typing"});}if(url.endsWith("/sendDocument")){const form=init?.body as FormData;expect(form.get("chat_id")).toBe("-100");expect(form.get("message_thread_id")).toBe("42");expect((form.get("document") as File).name).toBe("result.pdf");}return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});});const adapter=new TelegramMessagingAdapter(fetcher as typeof fetch);await adapter.sendTyping("123456:abcdefghijklmnopqrstuvwxyzABCDEFGH","-100","42");await adapter.sendAttachment("123456:abcdefghijklmnopqrstuvwxyzABCDEFGH","-100",{kind:"document",name:"result.pdf",mimeType:"application/pdf",dataBase64:Buffer.from("pdf").toString("base64")},"42");expect(calls).toEqual(["sendChatAction","sendDocument"]);});
});

describe("Telegram ingress",()=>{
  it("pairs one Telegram identity and dispatches through the shared-runtime callback",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("another-test-master-key-that-is-long-enough-123"));
    const sent:string[]=[];
    const adapter={channel:"telegram",validateCredential:async()=>({externalName:"@npati_bot"}),configureWebhook:async()=>undefined,
      parseInbound:async(payload:any)=>({externalUserId:String(payload.message.from.id),externalChatId:String(payload.message.chat.id),text:payload.message.text,attachments:[],messageId:String(payload.message.message_id),eventId:String(payload.update_id??payload.message.message_id)}),
      sendText:async(_token:string,_chat:string,text:string)=>{sent.push(text);}};
    const gateway=new MessagingGateway().register(adapter);
    const handleMessage=vi.fn(async()=>({message:"Runtime result"}));
    const app=Fastify();
    registerMessagingIntegrationRoutes(app,{auth:{authenticate:async()=>owner} as any,store:{getCompany:async()=>({id:"company-a",name:"A"}),getCompanyAgent:async()=>({id:"agent-a",isActive:true})} as any,repo,gateway,webhookBaseUrl:"https://agent.example.com",handleMessage});
    const accountCreate=await app.inject({method:"POST",url:"/integrations/telegram",payload:{botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"}});
    expect(accountCreate.statusCode).toBe(201);
    expect(accountCreate.json().connection).toMatchObject({scope:"account",companyId:null});
    const managed=await app.inject({method:"GET",url:`/integrations/messaging/${accountCreate.json().connection.id}/manage`});expect(managed.statusCode).toBe(200);expect(managed.json()).toMatchObject({transport:"webhook",capabilities:{deduplication:true}});expect(managed.json().commands).toContain("approvals");
    const managedConnection=managed.json().connection;const updated=await app.inject({method:"PATCH",url:`/integrations/messaging/${managedConnection.id}`,payload:{displayName:"Managed bot",scope:"account",settings:{...managedConnection.settings,groups:{...managedConnection.settings.groups,enabled:false}}}});expect(updated.statusCode).toBe(200);expect(updated.json().connection).toMatchObject({displayName:"Managed bot",settings:{groups:{enabled:false}}});
    const create=await app.inject({method:"POST",url:"/companies/company-a/integrations/telegram",payload:{botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH",agentId:"agent-a"}});
    expect(create.statusCode).toBe(201);const setup=create.json();const secret=String(setup.webhookUrl).split("/").at(-1)!;
    const connect=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:1,from:{id:7},chat:{id:8},text:setup.pairingCommand}}});
    expect(connect.json().status).toBe("connected");
    const inbound=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:2,from:{id:7},chat:{id:8},text:"Create a company task"}}});
    expect(inbound.statusCode).toBe(202);await vi.waitFor(()=>expect(handleMessage).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(sent).toContain("Runtime result"));
    const duplicate=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:2,from:{id:7},chat:{id:8},text:"Create a company task"}}});expect(duplicate.json().status).toBe("duplicate");expect(handleMessage).toHaveBeenCalledOnce();
    const attacker=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:3,from:{id:999},chat:{id:8},text:"Read company data"}}});
    expect(attacker.statusCode).toBe(403);expect(handleMessage).toHaveBeenCalledOnce();await app.close();
  });
  it("handles status, new-session and stop commands without entering a second runtime",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("command-test-master-key-that-is-long-enough-123")),sent:string[]=[];
    const adapter={channel:"telegram",validateCredential:async()=>({externalName:"@commands_bot"}),configureWebhook:async()=>undefined,parseInbound:async(payload:any)=>({externalUserId:String(payload.message.from.id),externalChatId:String(payload.message.chat.id),text:payload.message.text,attachments:[],messageId:String(payload.message.message_id),eventId:String(payload.update_id)}),sendText:async(_token:string,_chat:string,text:string)=>{sent.push(text);return[String(sent.length)];},sendTyping:async()=>undefined};
    const gateway=new MessagingGateway().register(adapter),handleMessage=vi.fn(async({signal}:{signal?:AbortSignal})=>new Promise<{message:string}>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(new Error("aborted")),{once:true})));
    const app=Fastify();registerMessagingIntegrationRoutes(app,{auth:{authenticate:async()=>owner} as any,store:{} as any,repo,gateway,webhookBaseUrl:"https://agent.example.com",handleMessage});
    const create=await app.inject({method:"POST",url:"/integrations/telegram",payload:{botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"}}),setup=create.json(),secret=String(setup.webhookUrl).split("/").at(-1)!;
    const send=(update_id:number,text:string)=>app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{update_id,message:{message_id:update_id,from:{id:7},chat:{id:8},text}}});
    expect((await send(1,setup.pairingCommand)).json().status).toBe("connected");expect((await send(2,"/status")).json().status).toBe("reported");expect((await send(3,"/new")).json().status).toBe("reset");expect(handleMessage).not.toHaveBeenCalled();
    expect((await send(4,"work until stopped")).json().status).toBe("accepted");await vi.waitFor(()=>expect(handleMessage).toHaveBeenCalledOnce());expect((await send(5,"/stop")).json().status).toBe("stopping");await vi.waitFor(()=>expect(sent.some((item)=>item.includes("Stopping"))).toBe(true));await app.close();
  });
  it("supports reverse-proxied /v1/ webhook route, deep link start commands, and pending guidance",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("proxy-test-master-key-that-is-long-enough-123")),sent:string[]=[];
    const adapter={channel:"telegram",validateCredential:async()=>({externalName:"@npati_ai_bot"}),configureWebhook:async()=>undefined,parseInbound:async(payload:any)=>({externalUserId:String(payload.message.from.id),externalChatId:String(payload.message.chat.id),text:payload.message.text,attachments:[],messageId:String(payload.message.message_id),eventId:String(payload.update_id)}),sendText:async(_token:string,_chat:string,text:string)=>{sent.push(text);return[String(sent.length)];},sendTyping:async()=>undefined};
    const gateway=new MessagingGateway().register(adapter);
    const app=Fastify();
    registerMessagingIntegrationRoutes(app,{auth:{authenticate:async()=>owner} as any,store:{} as any,repo,gateway,webhookBaseUrl:"https://ai.npati.com",handleMessage:async()=>({message:"ok"})});
    const create=await app.inject({method:"POST",url:"/integrations/telegram",payload:{botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"}});
    const setup=create.json(),secret=String(setup.webhookUrl).split("/").at(-1)!;
    // 1. User presses /start before pairing: bot responds with guidance instead of 403 silence
    const pendingStart=await app.inject({method:"POST",url:`/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{update_id:1,message:{message_id:1,from:{id:77},chat:{id:88},text:"/start"}}});
    expect(pendingStart.statusCode).toBe(200);
    expect(pendingStart.json().status).toBe("pairing_required");
    expect(sent.at(-1)).toContain("Welcome to NPATI");
    // 2. User connects via deep link: /start connect_<pairingCode> on the proxied /v1/ path
    const code=setup.pairingCode;
    const proxiedConnect=await app.inject({method:"POST",url:`/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{update_id:2,message:{message_id:2,from:{id:77},chat:{id:88},text:`/start connect_${code}`}}});
    expect(proxiedConnect.statusCode).toBe(200);
    expect(proxiedConnect.json().status).toBe("connected");
    expect(sent.at(-1)).toContain("Telegram is connected to NPATI");
    await app.close();
  });
});
