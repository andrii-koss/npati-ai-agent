import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CryptoVault, type AuthContext } from "@npati/workspace";
import { MessagingGateway } from "../apps/agent-api/src/messaging-gateway";
import { MessagingIntegrationsRepository } from "../apps/agent-api/src/messaging-integrations-repository";
import { registerMessagingIntegrationRoutes } from "../apps/agent-api/src/messaging-integrations-routes";
import { WhatsAppMessagingAdapter } from "../apps/agent-api/src/whatsapp-messaging";
import { runMigration049 } from "../packages/workspace/src/migration-049";

const owner:AuthContext={workspaceId:"workspace-wa",userId:"owner-wa",permissions:["workspace:read","business:manage","tools:execute"]};

describe("WhatsApp providers",()=>{
  it("migrates provider discrimination and keeps encrypted sessions tenant isolated",async()=>{
    let sql="";await runMigration049({query:async(value:string)=>{sql=value;return{};}} as any);
    expect(sql).toContain("provider IN ('qr','cloud')");expect(sql).toContain("idx_messaging_connections_whatsapp_restore");
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
});
