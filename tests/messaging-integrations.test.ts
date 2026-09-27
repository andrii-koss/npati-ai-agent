import { describe, expect, it, vi } from "vitest";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { MessagingIntegrationsRepository } from "../apps/agent-api/src/messaging-integrations-repository";
import { MessagingGateway, TelegramMessagingAdapter } from "../apps/agent-api/src/messaging-gateway";
import Fastify from "fastify";
import { registerMessagingIntegrationRoutes } from "../apps/agent-api/src/messaging-integrations-routes";
import { runMigration045 } from "../packages/workspace/src/migration-045";

const owner:AuthContext={workspaceId:"workspace-a",userId:"user-a",permissions:["workspace:read","business:manage","tools:execute"]};

describe("messaging migration",()=>{
  it("uses the existing TEXT identifier type for Company Agent foreign keys",async()=>{
    let sql="";await runMigration045({query:async(statement:string)=>{sql=statement;return{};}} as any);
    expect(sql).toMatch(/agent_id TEXT REFERENCES company_agents\(id\)/);
    expect(sql).not.toMatch(/agent_id UUID REFERENCES company_agents\(id\)/);
  });
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
    expect((await repo.listConnectedForCompany("workspace-a","company-a"))[0]?.externalChatId).toBe("8");
  });
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
});

describe("Telegram ingress",()=>{
  it("pairs one Telegram identity and dispatches through the shared-runtime callback",async()=>{
    const repo=new MessagingIntegrationsRepository(undefined,undefined,new CryptoVault("another-test-master-key-that-is-long-enough-123"));
    const sent:string[]=[];
    const adapter={channel:"telegram",validateCredential:async()=>({externalName:"@npati_bot"}),configureWebhook:async()=>undefined,
      parseInbound:async(payload:any)=>({externalUserId:String(payload.message.from.id),externalChatId:String(payload.message.chat.id),text:payload.message.text,attachments:[],messageId:String(payload.message.message_id)}),
      sendText:async(_token:string,_chat:string,text:string)=>{sent.push(text);}};
    const gateway=new MessagingGateway().register(adapter);
    const handleMessage=vi.fn(async()=>({message:"Runtime result"}));
    const app=Fastify();
    registerMessagingIntegrationRoutes(app,{auth:{authenticate:async()=>owner} as any,store:{getCompany:async()=>({id:"company-a",name:"A"}),getCompanyAgent:async()=>({id:"agent-a",isActive:true})} as any,repo,gateway,webhookBaseUrl:"https://agent.example.com",handleMessage});
    const create=await app.inject({method:"POST",url:"/companies/company-a/integrations/telegram",payload:{botToken:"123456:abcdefghijklmnopqrstuvwxyzABCDEFGH",agentId:"agent-a"}});
    expect(create.statusCode).toBe(201);const setup=create.json();const secret=String(setup.webhookUrl).split("/").at(-1)!;
    const connect=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:1,from:{id:7},chat:{id:8},text:setup.pairingCommand}}});
    expect(connect.json().status).toBe("connected");
    const inbound=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:2,from:{id:7},chat:{id:8},text:"Create a company task"}}});
    expect(inbound.statusCode).toBe(202);await vi.waitFor(()=>expect(handleMessage).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(sent).toContain("Runtime result"));
    const attacker=await app.inject({method:"POST",url:`/api/v1/integrations/telegram/${secret}`,headers:{"x-telegram-bot-api-secret-token":secret},payload:{message:{message_id:3,from:{id:999},chat:{id:8},text:"Read company data"}}});
    expect(attacker.statusCode).toBe(403);expect(handleMessage).toHaveBeenCalledOnce();await app.close();
  });
});
