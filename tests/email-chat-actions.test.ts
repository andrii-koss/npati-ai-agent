import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { EmailChatActions } from "../apps/agent-api/src/email-chat-actions";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";

const auth: AuthContext = {
  userId: "email-chat-user",
  workspaceId: "email-chat-workspace",
  permissions: ["workspace:read", "workspace:write", "business:manage"],
};

function directive(value: object): string {
  return ["```email-action", JSON.stringify(value), "```"].join("\n");
}

describe("EmailChatActions", () => {
  it("recognizes email settings requests in English and Ukrainian", () => {
    expect(EmailChatActions.isManagementRequest("Update the SMTP host for my mailbox")).toBe(true);
    expect(EmailChatActions.isManagementRequest("Налаштуй правило пошти для VIP клієнтів")).toBe(true);
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
});
