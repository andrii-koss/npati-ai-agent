import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { EmailChatActions } from "../apps/agent-api/src/email-chat-actions";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { ApiKeysRepository } from "../apps/agent-api/src/api-keys-repository";
import { EmailAttachmentStorage } from "../apps/agent-api/src/email-attachment-storage";
import { InMemoryFileMetadataRepository } from "../apps/agent-api/src/file-metadata";
import { InMemoryObjectStorage } from "../apps/agent-api/src/object-storage";

const auth: AuthContext = {
  userId: "email-chat-user",
  workspaceId: "email-chat-workspace",
  permissions: ["workspace:read", "workspace:write", "business:manage"],
};
const otherAuth: AuthContext = {
  userId: "other-email-user",
  workspaceId: auth.workspaceId,
  permissions: ["workspace:read", "workspace:write", "business:manage"],
};

function directive(value: object): string {
  return ["```email-action", JSON.stringify(value), "```"].join("\n");
}

describe("EmailChatActions", () => {
  it("recognizes email settings requests in English and Ukrainian", () => {
    expect(EmailChatActions.isManagementRequest("Update the SMTP host for my mailbox")).toBe(true);
    expect(EmailChatActions.isManagementRequest("Налаштуй правило пошти для VIP клієнтів")).toBe(true);
    expect(EmailChatActions.isManagementRequest("Покажи останні вхідні листи")).toBe(true);
    expect(EmailChatActions.isManagementRequest("Відправ лист клієнтові")).toBe(true);
    expect(EmailChatActions.isManagementRequest("Tell me about email marketing")).toBe(false);
  });

  it("updates every supplied account settings group in the selected company", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const company = await store.createCompany(auth, { name: "New" }, "email-chat-company");
    const account = await repo.createAccount(auth, company.id, { emailAddress: "support@example.com" });

    const result = await EmailChatActions.extractAndExecute(auth, directive({
      action: "account.update",
      companyId: company.id,
      accountId: account.id,
      fields: {
        displayName: "Support",
        mode: "autopilot",
        testMode: true,
        confidenceThreshold: 0.91,
        imapConfig: { host: "imap.example.com", port: 993, secure: true, username: "support@example.com" },
        smtpConfig: { host: "smtp.example.com", port: 465, secure: true, username: "support@example.com" },
        rateLimits: { maxPerHour: 20 },
        signatureConfig: { signature: "Regards, Support" },
        followupConfig: { enabled: true, delayDays: 3, maxFollowups: 2, action: "draft" },
      },
    }), store, repo, { selectedCompanyId: company.id });

    const updated = await repo.getAccount(auth, company.id, account.id);
    expect(result.emailAction?.action).toBe("account.update");
    expect(updated).toMatchObject({
      displayName: "Support",
      mode: "autopilot",
      testMode: true,
      confidenceThreshold: 0.91,
      imapConfig: { host: "imap.example.com" },
      smtpConfig: { host: "smtp.example.com" },
      rateLimits: { maxPerHour: 20 },
      signatureConfig: { signature: "Regards, Support" },
      followupConfig: { enabled: true, delayDays: 3 },
    });
  });

  it("creates rules, templates, and contacts without accepting a foreign company", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const company = await store.createCompany(auth, { name: "Mail Company" }, "email-chat-resources");

    const rule = await EmailChatActions.extractAndExecute(auth, directive({
      action: "rule.create",
      companyId: company.id,
      fields: { name: "VIP", conditions: { isVip: true }, actions: { setPriority: "urgent" } },
    }), store, repo);
    const template = await EmailChatActions.extractAndExecute(auth, directive({
      action: "template.create",
      companyId: company.id,
      fields: { title: "Welcome", category: "support", subjectTemplate: "Welcome", bodyTemplate: "Hello {{customer_name}}" },
    }), store, repo);
    const contact = await EmailChatActions.extractAndExecute(auth, directive({
      action: "contact.upsert",
      companyId: company.id,
      fields: { email: "vip@example.com", name: "VIP Client", isVip: true },
    }), store, repo);

    expect(rule.emailAction?.action).toBe("rule.create");
    expect(template.emailAction?.action).toBe("template.create");
    expect(contact.emailAction?.action).toBe("contact.upsert");
    expect((await repo.listRules(auth, company.id))[0]?.name).toBe("VIP");
    expect((await repo.listTemplates(auth, company.id))[0]?.title).toBe("Welcome");
    expect((await repo.getContact(auth, company.id, "vip@example.com"))?.isVip).toBe(true);
  });

  it("executes multiple settings actions and destructive actions in one authorized scope", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const company = await store.createCompany(auth, { name: "Batch Mail" }, "email-chat-batch");
    const account = await repo.createAccount(auth, company.id, { emailAddress: "batch@example.com", testMode: true });
    const result = await EmailChatActions.extractAndExecute(auth, directive({ actions: [
      { action: "account.update", companyId: company.id, accountId: account.id, fields: { mode: "autopilot" } },
      { action: "rule.create", companyId: company.id, fields: { name: "Urgent", conditions: { subjectKeywords: ["urgent"] }, actions: { setPriority: "urgent" } } },
    ] }), store, repo);
    expect(result.emailActions).toHaveLength(2);
    expect((await repo.getAccount(auth, company.id, account.id))?.mode).toBe("autopilot");
    const rule = (await repo.listRules(auth, company.id))[0]!;
    await EmailChatActions.extractAndExecute(auth, directive({ action: "rule.delete", companyId: company.id, ruleId: rule.id }), store, repo);
    expect(await repo.listRules(auth, company.id)).toEqual([]);
  });

  it("composes, reads, replies, updates, approves drafts, and deletes threads from chat", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const company = await store.createCompany(auth, { name: "Inbox Chat" }, "email-chat-inbox");
    const account = await repo.createAccount(auth, company.id, { emailAddress: "chat@example.com", testMode: true });
    const objects = new InMemoryObjectStorage(); await objects.initialize();
    const attachmentStorage = new EmailAttachmentStorage(objects, new InMemoryFileMetadataRepository());
    const composed = await EmailChatActions.extractAndExecute(auth, directive({
      action: "inbox.compose", companyId: company.id, accountId: account.id,
      fields: { toAddresses: ["client@example.net"], subject: "Chat subject", bodyText: "Hello from chat", attachmentNames: ["brief.txt"] },
    }), store, repo, { attachmentStorage, attachments: [{ filename: "brief.txt", contentType: "text/plain", sizeBytes: 5, contentBase64: Buffer.from("brief").toString("base64") }] });
    const threadId = composed.emailAction!.resourceId;
    expect(composed.cleanText).toContain("simulated");
    const read = await EmailChatActions.extractAndExecute(auth, directive({ action: "inbox.read", companyId: company.id, threadId }), store, repo);
    expect(read.cleanText).toContain("Hello from chat");
    expect((await repo.listMessages(auth, company.id, threadId))[0]?.attachments).toHaveLength(1);
    const draft = await EmailChatActions.extractAndExecute(auth, directive({ action: "inbox.reply", companyId: company.id, threadId, fields: { bodyText: "Draft reply", isDraft: true } }), store, repo);
    const draftId = draft.emailAction!.resourceId;
    await EmailChatActions.extractAndExecute(auth, directive({ action: "draft.update", companyId: company.id, threadId, messageId: draftId, fields: { bodyText: "Updated reply" } }), store, repo);
    await EmailChatActions.extractAndExecute(auth, directive({ action: "draft.approve", companyId: company.id, threadId, messageId: draftId }), store, repo);
    expect((await repo.listMessages(auth, company.id, threadId)).find((item) => item.id === draftId)?.isDraft).toBe(false);
    await EmailChatActions.extractAndExecute(auth, directive({ action: "thread.update", companyId: company.id, threadId, fields: { folder: "archived", priority: "high" } }), store, repo);
    expect((await repo.getThread(auth, company.id, threadId))?.folder).toBe("archived");
    await EmailChatActions.extractAndExecute(auth, directive({ action: "thread.delete", companyId: company.id, threadId }), store, repo);
    expect(await repo.getThread(auth, company.id, threadId)).toBeNull();
  });

  it("blocks cross-user company access and isolates personal mailboxes", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const company = await store.createCompany(auth, { name: "Private Company" }, "email-chat-private");
    const account = await repo.createAccount(auth, company.id, { emailAddress: "owner@example.com" });
    const denied = await EmailChatActions.extractAndExecute(otherAuth, directive({ action: "account.delete", companyId: company.id, accountId: account.id }), store, repo);
    expect(denied.emailAction).toBeUndefined();
    expect(await repo.getAccount(auth, company.id, account.id)).not.toBeNull();

    await EmailChatActions.extractAndExecute(auth, directive({ action: "account.create", companyId: "personal", fields: { emailAddress: "personal@example.com" } }), store, repo);
    const otherList = await EmailChatActions.extractAndExecute(otherAuth, directive({ action: "account.list", companyId: "personal" }), store, repo);
    expect(otherList.cleanText).toContain("No email accounts");
    expect(otherList.cleanText).not.toContain("personal@example.com");
  });

  it("rejects credentials in chat and supports safe permission inspection and revocation", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const apiKeys = new ApiKeysRepository();
    const company = await store.createCompany(auth, { name: "Secure Mail" }, "email-chat-secure");
    const account = await repo.createAccount(auth, company.id, { emailAddress: "secure@example.com" });
    const secret = await EmailChatActions.extractAndExecute(auth, directive({ action: "account.update", companyId: company.id, accountId: account.id, fields: { imapConfig: { host: "imap.example.com", password: "do-not-store-this" } } }), store, repo);
    expect(secret.cleanText).toContain("Не надсилайте пароль");
    expect((await repo.getAccount(auth, company.id, account.id))?.imapConfig.host).toBeUndefined();
    expect(EmailChatActions.containsCredentialSubmission("SMTP password: do-not-store-this")).toBe(true);

    const key = await apiKeys.createApiKey({ companyId: company.id, tenantId: auth.workspaceId, ownerUserId: auth.userId, name: "Email integration", scopes: ["email:view"] });
    const listed = await EmailChatActions.extractAndExecute(auth, directive({ action: "permission.list", companyId: company.id }), store, repo, { apiKeys });
    expect(listed.cleanText).toContain("Email integration");
    expect(listed.cleanText).not.toContain(key.rawToken);
    await EmailChatActions.extractAndExecute(auth, directive({ action: "permission.revoke", companyId: company.id, permissionId: key.id }), store, repo, { apiKeys });
    expect((await apiKeys.listApiKeys(company.id, auth.workspaceId))[0]?.revokedAt).not.toBeNull();
  });
});

describe("email action operands through PII masking", () => {
  it("keeps new addresses opaque to the model and resolves only trusted local references", async () => {
    const store=new InMemoryWorkspaceStore(), repo=new EmailInboxRepository();
    const company=await store.createCompany(auth,{name:"Reference test"},"reference-test");
    const prepared=EmailChatActions.addressReferences("Create email account fixture@npati.test then use fixture@npati.test");
    expect(prepared.prompt).not.toContain("fixture@npati.test");expect(Object.keys(prepared.addresses)).toHaveLength(1);
    const reference=Object.keys(prepared.addresses)[0];
    const result=await EmailChatActions.extractAndExecute(auth,directive({action:"account.create",companyId:company.id,fields:{emailAddress:reference,displayName:"Fixture"}}),store,repo,{selectedCompanyId:company.id,addressReferences:prepared.addresses});
    expect(result.emailAction?.action).toBe("account.create");expect((await repo.listAccounts(auth,company.id))[0].emailAddress).toBe("fixture@npati.test");
  });
  it("rejects forged references without creating an account or bypassing credential checks", async () => {
    const store=new InMemoryWorkspaceStore(), repo=new EmailInboxRepository();const company=await store.createCompany(auth,{name:"Ref denial"},"ref-denial");
    const result=await EmailChatActions.extractAndExecute(auth,directive({action:"account.create",companyId:company.id,fields:{emailAddress:"EMAIL_REF_forged_1"}}),store,repo);
    expect(result.emailAction).toBeUndefined();expect(await repo.listAccounts(auth,company.id)).toHaveLength(0);
  });
});
import type { AIEngine, ChatRequest, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { buildApp } from "../apps/agent-api/src/app";
import { SecurityPolicyEngine } from "../apps/agent-api/src/security-guardrails";
it("creates an email account through chat without sending its address to the model", async () => {
  const store=new InMemoryWorkspaceStore(), repo=new EmailInboxRepository();const company=await store.createCompany(auth,{name:"Private operands"},"private-operands");const captured: ChatRequest[]=[];
  const content=(input:ChatRequest)=>{captured.push(input);if(String(input.messages[0]?.content).startsWith("Classify"))return JSON.stringify({intent:"CHAT",confidence:.99,targets:[]});const ref=/EMAIL_REF_[a-f0-9]+_1/.exec(JSON.stringify(input.messages))?.[0];return directive({action:"account.create",companyId:company.id,fields:{emailAddress:ref,displayName:"Opaque Fixture"}});};
  const ai={chat:async(input:ChatRequest)=>({content:content(input)}),async *stream(input:ChatRequest){yield content(input);},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat","streaming"],healthCheck:async()=>({status:"ok"})} as AIEngine;
  const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>auth},aiEngine:ai,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace});
  try{const r=await app.inject({method:"POST",url:"/chat/stream",payload:{message:"Create email account opaque-fixture@npati.test, display name Opaque Fixture, leave SMTP unconfigured.",contextType:"company",companyId:company.id}});expect(r.statusCode).toBe(200);const accounts=await app.inject({method:"GET",url:"/companies/"+company.id+"/email-accounts"});expect(accounts.json().accounts[0]?.emailAddress).toBe("opaque-fixture@npati.test");expect(JSON.stringify(captured)).not.toContain("opaque-fixture@npati.test");expect(SecurityPolicyEngine.protectText("opaque-fixture@npati.test").sanitized).toContain("[REDACTED_EMAIL]");}finally{await app.close();}
});
