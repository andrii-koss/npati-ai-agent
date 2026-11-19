// Retired quota algorithms only: activation is confined to this isolated test file.
// Real release-policy and HTTP coverage: usage-quotas-disabled.test.ts.
vi.mock("../apps/agent-api/src/usage-quota-policy", () => ({ usageQuotasEnabled: () => true }));
import { describe, expect, it , vi } from "vitest";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { EmailAIProcessor } from "../apps/agent-api/src/email-ai-processor";
import { EmailDnsVerifier } from "../apps/agent-api/src/email-dns-verifier";
import { EmailConnectionTester } from "../apps/agent-api/src/email-connection-tester";
import { EmailAgentTools } from "../apps/agent-api/src/email-agent-tools";
import { EmailAttachmentStorage } from "../apps/agent-api/src/email-attachment-storage";
import { InMemoryFileMetadataRepository } from "../apps/agent-api/src/file-metadata";
import { InMemoryObjectStorage } from "../apps/agent-api/src/object-storage";
import { registerEmailInboxRoutes } from "../apps/agent-api/src/email-routes";
import Fastify from "fastify";
import type { AuthContext } from "@npati/workspace";

const mockAuth: AuthContext = {
  userId: "user_test_123",
  workspaceId: "ws_test_456",
  permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
};

const companyId = "comp_test_789";

describe("Email / AI Inbox Module", () => {
  const repo = new EmailInboxRepository();
  const processor = new EmailAIProcessor(repo);
  const agentTools = new EmailAgentTools(repo);

  it("1. Verifies DNS records (MX, SPF, DKIM, DMARC) with recommendations", async () => {
    const res = await EmailDnsVerifier.verifyDomain("company.com");
    expect(res.domain).toBe("company.com");
    expect(res.verified).toBe(true);
    expect(res.records.length).toBe(4);
    expect(res.records.some((r) => r.recordType === "MX")).toBe(true);
    expect(res.records.some((r) => r.recordType === "SPF")).toBe(true);
    expect(res.records.some((r) => r.recordType === "DKIM")).toBe(true);
    expect(res.records.some((r) => r.recordType === "DMARC")).toBe(true);
  });

  it("2. Tests IMAP and SMTP connection in test mode", async () => {
    const imap = { host: "imap.test.company.com", port: 993, username: "support@company.com" };
    const smtp = { host: "smtp.test.company.com", port: 465, username: "support@company.com" };
    const res = await EmailConnectionTester.testAll(imap, smtp, true);
    expect(res.success).toBe(true);
    expect(res.imapStatus?.ok).toBe(true);
    expect(res.smtpStatus?.ok).toBe(true);
  });

  it("3. Creates and lists independent Company Email Accounts", async () => {
    const supportAcc = await repo.createAccount(mockAuth, companyId, {
      emailAddress: "support@company.com",
      displayName: "Customer Support",
      mode: "approval",
      confidenceThreshold: 0.8,
    });
    expect(supportAcc.id).toBeDefined();
    expect(supportAcc.emailAddress).toBe("support@company.com");
    expect(supportAcc.mode).toBe("approval");
    expect(supportAcc.rateLimits.maxPerRecipientDaily).toBe(100);

    const billingAcc = await repo.createAccount(mockAuth, companyId, {
      emailAddress: "billing@company.com",
      displayName: "Billing Desk",
      mode: "autopilot",
      testMode: true,
    });
    expect(billingAcc.emailAddress).toBe("billing@company.com");

    const accounts = await repo.listAccounts(mockAuth, companyId);
    expect(accounts.length).toBeGreaterThanOrEqual(2);
  });

  it("4. Inbound Email in Approval Mode creates draft ready for human review", async () => {
    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "alice@client.org",
      to: "support@company.com",
      subject: "Help with account settings",
      body: "Hello support, I cannot find the password change button in my profile.",
    });

    expect(inbound.thread.subject).toBe("Help with account settings");
    expect(inbound.thread.status).toBe("draft_ready");
    expect(inbound.actionTaken).toBe("draft_created");
    expect(inbound.aiMessage).toBeDefined();
    expect(inbound.aiMessage?.isDraft).toBe(true);
    expect(inbound.aiMessage?.bodyText).toContain("Thank you for reaching out");
    expect(inbound.confidenceScore).toBeGreaterThanOrEqual(0.7);
  });

  it("5. Inbound Email in Autopilot Mode sends reply automatically", async () => {
    // Update support account to autopilot mode
    const accounts = await repo.listAccounts(mockAuth, companyId);
    const support = accounts.find((a) => a.emailAddress === "support@company.com")!;
    await repo.updateAccount(mockAuth, companyId, support.id, {
      mode: "autopilot",
      testMode: false,
      confidenceThreshold: 0.75,
    });

    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "bob@client.org",
      to: "support@company.com",
      subject: "Refund request for order #1234",
      body: "Please initiate a refund for order #1234. The item was damaged.",
    });

    expect(inbound.actionTaken).toBe("autopilot_queued");
    expect(inbound.thread.status).toBe("ai_processing");
    expect(inbound.aiMessage?.isDraft).toBe(false);
    expect(inbound.aiMessage?.deliveryStatus).toBe("sending");
  });

  it("6. Autopilot with Test Mode active simulates send without external dispatch", async () => {
    const accounts = await repo.listAccounts(mockAuth, companyId);
    const support = accounts.find((a) => a.emailAddress === "support@company.com")!;
    await repo.updateAccount(mockAuth, companyId, support.id, {
      mode: "autopilot",
      testMode: true, // Test mode enabled
    });

    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "charlie@client.org",
      to: "support@company.com",
      subject: "Product catalog inquiry",
      body: "Can you send the pricing sheet for enterprise plans?",
    });

    expect(inbound.actionTaken).toBe("test_mode_simulated");
    expect(inbound.thread.status).toBe("draft_ready");
    expect(inbound.thread.aiClassificationSummary).toContain("Test Mode");
  });

  it("7. Collision Protection: Locks prevent simultaneous AI sending during active human editing", async () => {
    const threads = await repo.listThreads(mockAuth, companyId, { limit: 1 });
    const thread = threads[0]!;

    // Human acquires lock
    const locked = await repo.acquireLock(mockAuth, companyId, thread.id);
    expect(locked).toBe(true);

    // Another inbound message arrives to this thread
    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: thread.customerEmail,
      to: "support@company.com",
      subject: thread.subject,
      body: "Another update while user is editing...",
      threadKey: thread.threadKey,
    });

    expect(inbound.actionTaken).toBe("collision_hold");
    expect(inbound.thread.status).toBe("waiting_human");

    // Human releases lock
    await repo.releaseLock(mockAuth, companyId, thread.id);
  });

  it("8. Human Takeover and Return to AI", async () => {
    const threads = await repo.listThreads(mockAuth, companyId, { limit: 1 });
    const thread = threads[0]!;

    // User takes over
    const taken = await repo.setHumanTakeover(mockAuth, companyId, thread.id, true);
    expect(taken.isHumanTakeover).toBe(true);
    expect(taken.status).toBe("waiting_human");

    // Return to AI
    const resumed = await repo.setHumanTakeover(mockAuth, companyId, thread.id, false);
    expect(resumed.isHumanTakeover).toBe(false);
  });

  it("9. Blacklisted senders are sent to spam and closed", async () => {
    // Add spammer to contact blacklist
    await repo.upsertContact(mockAuth, companyId, {
      email: "spammer@badsource.net",
      isBlacklisted: true,
    });

    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "spammer@badsource.net",
      to: "support@company.com",
      subject: "Buy cheap crypto now!",
      body: "Click here to buy tokens fast.",
    });

    expect(inbound.actionTaken).toBe("blacklisted_ignored");
    expect(inbound.thread.folder).toBe("spam");
    expect(inbound.thread.status).toBe("closed");
  });

  it("10. VIP senders receive Urgent priority and VIP flag", async () => {
    await repo.upsertContact(mockAuth, companyId, {
      email: "ceo@vipcustomer.com",
      name: "VIP Executive",
      isVip: true,
    });

    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "ceo@vipcustomer.com",
      to: "support@company.com",
      subject: "Question about enterprise contract renewal",
      body: "We are reviewing our annual contract terms.",
    });

    expect(inbound.priority).toBe("urgent");
    expect(inbound.thread.isVip).toBe(true);
  });

  it("11. Auto Language Detection answers in Ukrainian for Ukrainian emails", async () => {
    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "ivan@ukr-client.ua",
      to: "support@company.com",
      subject: "Термінове питання щодо оплати рахунку",
      body: "Доброго дня, надішліть будь ласка рахунок-фактуру на нашу компанію.",
    });

    expect(inbound.detectedLanguage).toBe("uk");
    expect(inbound.aiMessage?.bodyText).toContain("Доброго дня");
    expect(inbound.aiMessage?.bodyText).toContain("Дякуємо за ваше звернення");
  });

  it("12. Rate limiting restricts runaway autopilot and converts to draft", async () => {
    const accounts = await repo.listAccounts(mockAuth, companyId);
    const support = accounts.find((a) => a.emailAddress === "support@company.com")!;
    // Set strict per-recipient rate limit
    await repo.updateAccount(mockAuth, companyId, support.id, {
      mode: "autopilot",
      testMode: false,
      rateLimits: { maxPerHour: 10, maxPerDay: 50, maxPerRecipientDaily: 1, maxFollowups: 2 },
    });

    // First email uses up the 1 daily message quota for this recipient
    await repo.recordSentEmail(companyId, support.id, "rate_limited_client@org.com");

    const inbound = await processor.processInbound(mockAuth, companyId, {
      from: "rate_limited_client@org.com",
      to: "support@company.com",
      subject: "Another urgent request",
      body: "I need another reply right away.",
    });

    expect(inbound.actionTaken).toBe("rate_limited_draft");
    expect(inbound.thread.status).toBe("waiting_approval");
    expect(inbound.aiMessage?.isDraft).toBe(true);
  });

  it("13. Email Agent Tools: Extracts verification code, OTP, and links", () => {
    const sampleEmail = `
      Hello!
      Your verification code for Acme Corp is: 489201.
      Alternatively, click the following confirmation link to verify your account:
      https://app.acmecorp.com/auth/verify?token=abc123xyz789
    `;

    const extracted = agentTools.extractVerification(sampleEmail);
    expect(extracted.verificationCode).toBe("489201");
    expect(extracted.verificationLinks.length).toBe(1);
    expect(extracted.verificationLinks[0]).toContain("https://app.acmecorp.com/auth/verify");
  });

  it("14. Link Security Inspector detects dangerous or suspicious URLs", () => {
    // Safe link
    const safeCheck = agentTools.inspectLinkSecurity("https://app.acmecorp.com/dashboard", "billing@acmecorp.com");
    expect(safeCheck.isSafe).toBe(true);
    expect(safeCheck.requiresHumanApproval).toBe(false);

    // Suspicious link with mismatched domain and sensitive form
    const suspCheck = agentTools.inspectLinkSecurity("http://192.168.1.1/signin/password", "support@trustedbank.com");
    expect(suspCheck.isSafe).toBe(false);
    expect(suspCheck.requiresHumanApproval).toBe(true);
    expect(suspCheck.threatLevel).toBe("dangerous");
  });

  it("15. Analytics accurately aggregates email metrics and automation rate", async () => {
    const analytics = await repo.getAnalytics(mockAuth, companyId);
    const settings = await repo.readSettingsData(mockAuth, [companyId], true);
    expect(settings.analytics).toEqual([analytics]);
    expect(settings.accounts.every(account => account.companyId === companyId)).toBe(true);
    expect(analytics.receivedEmails).toBeGreaterThan(0);
    expect(analytics.automationRate).toBeGreaterThanOrEqual(0);
    expect(analytics.confidenceDistribution).toBeDefined();
    expect(analytics.volumeByDay.length).toBeGreaterThan(0);
  });

  it("16. Lists contacts and updates rules and templates without creating duplicates", async () => {
    const listedContacts = await repo.listContacts(mockAuth, companyId);
    expect(listedContacts.some((contact) => contact.email === "ceo@vipcustomer.com")).toBe(true);
    expect(listedContacts.some((contact) => contact.email === "spammer@badsource.net")).toBe(true);
    expect(listedContacts[0]?.isVip).toBe(true);

    const template = await repo.createTemplate(mockAuth, companyId, {
      title: "Initial response",
      category: "support",
      bodyTemplate: "Hello {{customer_name}}",
    });
    const updatedTemplate = await repo.updateTemplate(mockAuth, companyId, template.id, {
      title: "Updated response",
      category: "information",
      bodyTemplate: "Welcome {{customer_name}}",
    });
    expect(updatedTemplate.id).toBe(template.id);
    expect(updatedTemplate.title).toBe("Updated response");
    expect(updatedTemplate.category).toBe("information");

    const rule = await repo.createRule(mockAuth, companyId, {
      name: "VIP approval",
      conditions: { isVip: true },
      actions: { setMode: "approval" },
    });
    const updatedRule = await repo.updateRule(mockAuth, companyId, rule.id, {
      name: "VIP autopilot",
      actions: { setMode: "autopilot", setPriority: "urgent" },
      isActive: false,
    });
    expect(updatedRule.id).toBe(rule.id);
    expect(updatedRule.name).toBe("VIP autopilot");
    expect(updatedRule.actions.setPriority).toBe("urgent");
    expect(updatedRule.isActive).toBe(false);
  });

  it("17. Ignores an IMAP retry with the same provider Message-ID", async () => {
    const payload = {
      from: "retry@client.org",
      to: "support@company.com",
      subject: "Idempotent delivery check",
      body: "This provider message must only be processed once.",
      messageId: "<provider-message-123@example.com>",
    };

    const first = await processor.processInbound(mockAuth, companyId, payload);
    const messageCountAfterFirst = (await repo.listMessages(mockAuth, companyId, first.thread.id)).length;
    const duplicate = await processor.processInbound(mockAuth, companyId, payload);
    const messageCountAfterDuplicate = (await repo.listMessages(mockAuth, companyId, first.thread.id)).length;

    expect(duplicate.actionTaken).toBe("duplicate_ignored");
    expect(duplicate.inboundMessage.id).toBe(first.inboundMessage.id);
    expect(duplicate.thread.id).toBe(first.thread.id);
    expect(messageCountAfterDuplicate).toBe(messageCountAfterFirst);
  });

  it("18. Applies wildcard sender rules to mode, priority, and agent assignment", async () => {
    await repo.createRule(mockAuth, companyId, {
      name: "Route partner mail to a human",
      conditions: { senders: ["*@rules.example"] },
      actions: { setMode: "manual", setPriority: "urgent", setAgentId: "agent_rules_1" },
      priorityOrder: -10,
    });

    const result = await processor.processInbound(mockAuth, companyId, {
      from: "partner@rules.example",
      to: "support@company.com",
      subject: "Partnership question",
      body: "Please ask the assigned account owner to review this request.",
      messageId: "<rules-message-1@rules.example>",
    });

    expect(result.actionTaken).toBe("manual_recorded");
    expect(result.priority).toBe("urgent");
    expect(result.thread.priority).toBe("urgent");
    expect(result.thread.assignedAgentId).toBe("agent_rules_1");
  });

  it("19. Preserves stored mail passwords when a partial account patch omits them", async () => {
    const account = await repo.createAccount(mockAuth, companyId, {
      emailAddress: "secure@company.com",
      imapConfig: { host: "imap.company.com", password: "imap-secret" },
      smtpConfig: { host: "smtp.company.com", password: "smtp-secret" },
    });

    const updated = await repo.updateAccount(mockAuth, companyId, account.id, {
      imapConfig: { host: "imap2.company.com" },
      smtpConfig: { host: "smtp2.company.com" },
    });

    expect(updated.imapConfig.host).toBe("imap2.company.com");
    expect(updated.imapConfig.password).toBe("imap-secret");
    expect(updated.smtpConfig.host).toBe("smtp2.company.com");
    expect(updated.smtpConfig.password).toBe("smtp-secret");
    const stored = (repo as any).memoryAccounts.get(account.id);
    expect(stored.imapConfig.password).toMatch(/^v1\$/);
    expect(stored.smtpConfig.password).toMatch(/^v1\$/);
    expect(stored.imapConfig.password).not.toContain("imap-secret");
  });

  it("binds PostgreSQL email account fields in the same order as the UPDATE placeholders", async () => {
    const existing = {
      id: "account-pg-order", workspaceId: mockAuth.workspaceId, companyId, userId: mockAuth.userId,
      emailAddress: "order@company.com", displayName: "Order", agentId: null,
      provider: "imap_smtp", connectionScope: "company", senderPolicy: "allowlist",
      allowedSenders: ["trusted@example.com"], allowedDomains: ["example.com"],
      requireAuthenticatedSender: true, outboundPolicy: "approval_required",
      mode: "approval", status: "connected", testMode: false, confidenceThreshold: 0.8,
      languageMode: "auto", fallbackLanguage: "en", imapConfig: {}, smtpConfig: {},
      rateLimits: {}, signatureConfig: {}, followupConfig: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    let updateParameters: unknown[] = [];
    const pool = {
      query: async (sql: string, parameters: unknown[]) => {
        if (sql.includes("UPDATE company_email_accounts")) updateParameters = parameters;
        return { rows: [existing] };
      },
    };
    const pgRepo = new EmailInboxRepository(undefined, pool as any);

    await pgRepo.updateAccount(mockAuth, companyId, existing.id, { displayName: "Updated Order" });

    expect(updateParameters.slice(0, 15)).toEqual([
      "Updated Order", null, "imap_smtp", "company", "allowlist",
      ["trusted@example.com"], ["example.com"], true, "approval_required",
      "approval", "connected", false, 0.8, "auto", "en",
    ]);
  });
  it("20. Serializes concurrent processing of the same provider Message-ID", async () => {
    const payload = {
      from: "concurrent@client.org",
      to: "support@company.com",
      subject: "Concurrent delivery",
      body: "Two workers received this exact same provider message.",
      messageId: "<concurrent-message-1@example.com>",
    };

    const results = await Promise.all([
      processor.processInbound(mockAuth, companyId, payload),
      processor.processInbound(mockAuth, companyId, payload),
    ]);

    expect(results.filter((result) => result.actionTaken === "duplicate_ignored")).toHaveLength(1);
    expect(results[0]?.thread.id).toBe(results[1]?.thread.id);
    expect(results[0]?.inboundMessage.id).toBe(results[1]?.inboundMessage.id);
  });

  it("21. Deduplicates durable jobs and requeues retryable failures", async () => {
    const first = await repo.enqueueJob(mockAuth, companyId, {
      jobType: "send", payload: { test: true }, idempotencyKey: "job-idempotency-1", maxAttempts: 3,
    });
    const duplicate = await repo.enqueueJob(mockAuth, companyId, {
      jobType: "send", payload: { test: false }, idempotencyKey: "job-idempotency-1", maxAttempts: 3,
    });
    expect(duplicate.id).toBe(first.id);
    const claimed = (await repo.claimJobs("test-worker", 10)).find((job) => job.id === first.id)!;
    expect(claimed.status).toBe("processing");
    expect(claimed.attemptCount).toBe(1);
    await repo.failJob(claimed, new Error("temporary SMTP outage"));
    const stored = (repo as any).memoryJobs.get(first.id);
    expect(stored.status).toBe("queued");
    expect(stored.lastError).toContain("temporary SMTP outage");
  });

  it("22. Uses the configured AI engine and creates an existing Company Task when a rule requests it", async () => {
    await repo.createAccount(mockAuth, companyId, { emailAddress: "ai@company.com", mode: "approval" });
    await repo.createRule(mockAuth, companyId, {
      name: "Create task for task-domain senders",
      priorityOrder: -20,
      conditions: { domains: ["task.example"] },
      actions: { createTask: true, setMode: "approval" },
    });
    const createdTasks: string[] = [];
    const mockAi = {
      chat: async () => ({ content: "Hello,\n\nThis response came from the configured AI engine.\n\nSupport" }),
    } as any;
    const integratedProcessor = new EmailAIProcessor(repo, undefined, mockAi, {
      createTask: async ({ inboundMessage }) => {
        createdTasks.push(inboundMessage.id);
        return "company-run-1";
      },
    });
    const result = await integratedProcessor.processInbound(mockAuth, companyId, {
      from: "requester@task.example", to: "ai@company.com", subject: "Create a task",
      body: "Please process this request through the company task system.", messageId: "<ai-task-1@task.example>",
    });
    expect(result.aiMessage?.bodyText).toContain("configured AI engine");
    expect(createdTasks).toEqual([result.inboundMessage.id]);
  });

  it("generates each AI draft for the latest inbound message with the full thread history as context", async () => {
    const isolatedRepo = new EmailInboxRepository();
    await isolatedRepo.createAccount(mockAuth, "latest-inbound-company", {
      emailAddress: "support@latest.example", mode: "approval",
      signatureConfig: {
        greeting: "Hello,",
        signature: "Best regards,\nCustomer Support",
        footer: "Confidential",
      },
    });
    const requests: any[] = [];
    const processor = new EmailAIProcessor(isolatedRepo, undefined, {
      chat: async (request: any) => {
        requests.push(request);
        return { content: `Generated reply ${requests.length}` };
      },
    } as any);

    const first = await processor.processInbound(mockAuth, "latest-inbound-company", {
      from: "client@example.com",
      to: "support@latest.example",
      subject: "Re: Project update",
      body: "This is the first customer question.",
      messageId: "<latest-inbound-1@example.com>",
      threadKey: "latest-inbound-thread",
    });
    expect(first.aiMessage?.isAiGenerated).toBe(true);
    await expect(isolatedRepo.listThreads(mockAuth, "latest-inbound-company", { folder: "drafts" })).resolves.toEqual([]);
    await isolatedRepo.createMessage(mockAuth, "latest-inbound-company", {
      threadId: first.thread.id,
      direction: "outbound",
      fromAddress: "support@latest.example",
      toAddresses: ["client@example.com"],
      subject: "Re: Project update",
      bodyText: "This is the manual company reply.",
      isDraft: false,
    });

    const second = await processor.processInbound(mockAuth, "latest-inbound-company", {
      from: "client@example.com",
      to: "support@latest.example",
      subject: "Re: Project update",
      body: "This is the newest customer question.",
      messageId: "<latest-inbound-2@example.com>",
      threadKey: "latest-inbound-thread",
    });

    const latestPrompt = requests.at(-1)?.messages.at(-1)?.content;
    const latestSystemPrompt = requests.at(-1)?.messages.at(0)?.content;
    expect(latestPrompt).toEqual(expect.any(String));
    expect(latestPrompt).toContain("This is the first customer question.");
    expect(latestPrompt).toContain("This is the manual company reply.");
    expect(latestPrompt).toContain("Conversation history (oldest to newest)");
    expect(latestPrompt).toContain("LATEST INBOUND MESSAGE TO ANSWER:\nThis is the newest customer question.");
    expect(latestSystemPrompt).toContain("Translate the configured greeting, closing signature, and footer into the reply language");
    expect(latestSystemPrompt).toContain("Configured greeting source text: Hello,");
    expect(latestSystemPrompt).toContain("Configured closing signature source text: Best regards,\nCustomer Support");
    expect(latestSystemPrompt).toContain("Configured footer source text: Confidential");
    expect(latestSystemPrompt).not.toContain("Required greeting:");
    expect(second.aiMessage?.inReplyTo).toBe("<latest-inbound-2@example.com>");
    expect(second.aiMessage?.bodyText).toBe("Generated reply 2");
    const messages = await isolatedRepo.listMessages(mockAuth, "latest-inbound-company", first.thread.id);
    expect(messages.some((message) => message.id === first.aiMessage?.id)).toBe(false);
    expect(messages.filter((message) => message.isDraft && message.isAiGenerated)).toEqual([
      expect.objectContaining({ id: second.aiMessage?.id }),
    ]);

    await isolatedRepo.createMessage(mockAuth, "latest-inbound-company", {
      threadId: first.thread.id,
      direction: "outbound",
      fromAddress: "support@latest.example",
      toAddresses: ["client@example.com"],
      subject: "Saved user draft",
      bodyText: "Not sent yet",
      isDraft: true,
      isAiGenerated: false,
    });
    await expect(isolatedRepo.listThreads(mockAuth, "latest-inbound-company", { folder: "drafts" })).resolves.toEqual([
      expect.objectContaining({ id: first.thread.id }),
    ]);
    await expect(isolatedRepo.getFolderCounts(mockAuth, "latest-inbound-company")).resolves.toMatchObject({ drafts: 1 });
  });

  it("23. Matches a detected intent and renders the selected response template", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const isolatedProcessor = new EmailAIProcessor(isolatedRepo);
    await isolatedRepo.createAccount(mockAuth, "intent-company", {
      emailAddress: "refunds@company.com", mode: "approval",
    });
    const template = await isolatedRepo.createTemplate(mockAuth, "intent-company", {
      title: "Refund acknowledgement", category: "billing",
      subjectTemplate: "Refund request from {{customer_name}}",
      bodyTemplate: "Hello {{customer_name}}, your refund request is now being reviewed.",
    });
    await isolatedRepo.createRule(mockAuth, "intent-company", {
      name: "Refund intent", priorityOrder: 1,
      conditions: { detectedIntent: "refund" },
      actions: { autoReplyTemplateId: template.id, setPriority: "high" },
    });

    const result = await isolatedProcessor.processInbound(mockAuth, "intent-company", {
      from: "buyer@example.net", to: "refunds@company.com", subject: "Money back request",
      body: "Please refund the charge on my card.", messageId: "<refund-intent@example.net>",
    });

    expect(result.priority).toBe("high");
    expect(result.aiMessage).toMatchObject({
      subject: "Refund request from buyer",
      bodyText: "Hello buyer, your refund request is now being reviewed.",
      isDraft: true,
    });
  });

  it("24. Matches attachment-type rules and starts the selected existing workflow", async () => {
    const isolatedRepo = new EmailInboxRepository();
    await isolatedRepo.createAccount(mockAuth, "workflow-company", {
      emailAddress: "docs@company.com", mode: "manual",
    });
    await isolatedRepo.createRule(mockAuth, "workflow-company", {
      name: "Invoice image workflow", priorityOrder: 1,
      conditions: { attachmentTypes: ["image/*"] },
      actions: { startWorkflowId: "workflow-invoice" },
    });
    const started: string[] = [];
    const workflowProcessor = new EmailAIProcessor(isolatedRepo, undefined, undefined, {
      startWorkflow: async ({ workflowId }) => {
        started.push(workflowId);
        return "workflow-run-1";
      },
    });

    await workflowProcessor.processInbound(mockAuth, "workflow-company", {
      from: "vendor@example.net", to: "docs@company.com", subject: "Invoice scan", body: "Attached.",
      messageId: "<workflow-image@example.net>",
      attachments: [{ filename: "invoice.png", contentType: "image/png", sizeBytes: 3, contentBase64: "YWJj" }],
    });

    expect(started).toEqual(["workflow-invoice"]);
  });

  it("25. Continues an Agent Task once its awaited email reply arrives", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const account = await isolatedRepo.createAccount(mockAuth, "continuation-company", {
      emailAddress: "automation@company.com", mode: "manual", testMode: true,
    });
    const tools = new EmailAgentTools(isolatedRepo);
    const sendResult = await tools.sendEmail(mockAuth, { id: "continuation-company", name: "Continuation", workspaceId: mockAuth.workspaceId } as any, {
      to: "service@example.net", subject: "Verify registration", body: "Please send the verification code.",
      fromEmail: account.emailAddress, taskRunId: "agent-run-original",
    });
    const linkedThread = (await isolatedRepo.listThreads(mockAuth, "continuation-company", { limit: 10 }))[0]!;
    expect(linkedThread.metadata.awaitingAgentRunId).toBe("agent-run-original");
    const continuations: string[] = [];
    const continuationProcessor = new EmailAIProcessor(isolatedRepo, undefined, undefined, {
      continueTask: async ({ awaitingRunId }) => {
        continuations.push(awaitingRunId);
        return "agent-run-continuation";
      },
    });

    const result = await continuationProcessor.processInbound(mockAuth, "continuation-company", {
      from: "service@example.net", to: account.emailAddress, subject: "Verify registration",
      body: "Your verification code is 123456.", threadKey: linkedThread.threadKey,
      inReplyTo: sendResult.messageId, messageId: "<verification-reply@example.net>",
    });

    expect(continuations).toEqual(["agent-run-original"]);
    expect(result.thread.metadata).toMatchObject({
      awaitingAgentRunId: null,
      continuedFromAgentRunId: "agent-run-original",
      continuationRunId: "agent-run-continuation",
    });
  });

  it("26. Enforces a company-wide send limit across independent accounts", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const limits = {
      maxPerHour: 10, maxPerDay: 100, maxPerRecipientDaily: 10, maxFollowups: 2,
      maxCompanyPerHour: 1, maxCompanyPerDay: 10,
    };
    const first = await isolatedRepo.createAccount(mockAuth, "limited-company", {
      emailAddress: "first@company.com", rateLimits: limits,
    });
    const second = await isolatedRepo.createAccount(mockAuth, "limited-company", {
      emailAddress: "second@company.com", rateLimits: limits,
    });

    await expect(isolatedRepo.reserveSendQuota("limited-company", first, "one@example.net"))
      .resolves.toEqual({ allowed: true });
    const denied = await isolatedRepo.reserveSendQuota("limited-company", second, "two@example.net");
    expect(denied).toMatchObject({ allowed: false });
    expect(denied.reason).toContain('Increase "Company / hour"');
  });

  it("27. Requires approval for private hosts and cross-domain redirect parameters", () => {
    const privateLink = agentTools.inspectLinkSecurity("http://127.0.0.1/admin", "security@example.com");
    expect(privateLink).toMatchObject({ threatLevel: "dangerous", requiresHumanApproval: true });
    const redirect = agentTools.inspectLinkSecurity(
      "https://example.com/verify?redirect=https%3A%2F%2Fevil.test%2Flogin",
      "security@example.com"
    );
    expect(redirect.requiresHumanApproval).toBe(true);
    expect(redirect.redirectDomains).toContain("evil.test");
    expect(agentTools.inspectLinkSecurity("https://example.com/help", "blocked@example.com", true)).toMatchObject({
      threatLevel: "dangerous",
      requiresHumanApproval: true,
    });
  });

  it("28. Consumes OAuth PKCE state exactly once", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const account = await isolatedRepo.createAccount(mockAuth, "oauth-company", { emailAddress: "oauth@company.com" });
    await isolatedRepo.createOAuthState(mockAuth, "oauth-company", account.id, {
      stateHash: "state-hash", verifier: "pkce-verifier", tokenUrl: "https://provider.test/token",
      clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.test/api/email/oauth/callback",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(isolatedRepo.consumeOAuthState("state-hash")).resolves.toMatchObject({
      accountId: account.id, verifier: "pkce-verifier", clientSecret: "client-secret",
    });
    await expect(isolatedRepo.consumeOAuthState("state-hash")).resolves.toBeNull();
  });

  it("29. Stores tenant-scoped email notifications and marks them read", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const notification = await isolatedRepo.createNotification(mockAuth, "notification-company", {
      userId: mockAuth.userId, notificationType: "followup_due", title: "Follow-up due", body: "No reply received.",
    });
    await expect(isolatedRepo.listNotifications(mockAuth, "notification-company")).resolves.toEqual([
      expect.objectContaining({ id: notification.id, isRead: false }),
    ]);
    await isolatedRepo.markNotificationRead(mockAuth, "notification-company", notification.id);
    await expect(isolatedRepo.listNotifications(mockAuth, "notification-company")).resolves.toEqual([
      expect.objectContaining({ id: notification.id, isRead: true }),
    ]);
  });

  it("30. Persists email attachments in the shared object-storage lifecycle", async () => {
    const objects = new InMemoryObjectStorage();
    const files = new InMemoryFileMetadataRepository();
    const storage = new EmailAttachmentStorage(objects, files);
    await objects.initialize();
    const payload = Buffer.from("durable email attachment");
    const [attachment] = await storage.persist(mockAuth, "attachment-company", "thread-1", [{
      filename: "evidence.txt",
      contentType: "text/plain",
      sizeBytes: payload.length,
      contentBase64: payload.toString("base64"),
    }]);

    expect(attachment).toMatchObject({ filename: "evidence.txt", contentType: "text/plain", sizeBytes: payload.length });
    expect(attachment!.contentBase64).toBeUndefined();
    expect(attachment!.url).toMatch(/^\/api\/companies\/attachment-company\/email-inbox\/attachments\/[0-9a-f-]{36}$/i);
    const fileId = attachment!.url!.split("/").at(-1)!;
    const opened = await storage.open(mockAuth, "attachment-company", fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream as AsyncIterable<Buffer | Uint8Array | string>) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(payload.toString());
    const [smtpAttachment] = await storage.materialize(mockAuth, "attachment-company", [attachment!]);
    expect(Buffer.from(smtpAttachment!.contentBase64!, "base64").toString()).toBe(payload.toString());
    await expect(storage.open({ ...mockAuth, workspaceId: "another-workspace" }, "attachment-company", fileId)).resolves.toBeNull();
    await expect(files.listCompany(mockAuth, "attachment-company")).resolves.toEqual([
      expect.objectContaining({ id: fileId, status: "ready", companyId: "attachment-company" }),
    ]);
    await expect(storage.remove(mockAuth, "attachment-company", attachment!)).resolves.toBe(true);
    await expect(storage.open(mockAuth, "attachment-company", fileId)).resolves.toBeNull();
  });

  it("31. Keeps a composed message in Sent and correlates the recipient reply into the same Inbox history", async () => {
    const isolatedRepo = new EmailInboxRepository();
    let account = await isolatedRepo.createAccount(mockAuth, "compose-company", {
      emailAddress: "sales@company.com", mode: "manual", testMode: false,
    });
    account = await isolatedRepo.updateAccount(mockAuth, "compose-company", account.id, { status: "connected" });
    account = await isolatedRepo.updateAccount(mockAuth, "compose-company", account.id, {
      status: "imap_error",
      imapConfig: { lastError: "Temporary IMAP polling failure" },
    });
    const app = Fastify();
    registerEmailInboxRoutes(app, {
      auth: { authenticate: async () => mockAuth },
      store: { getCompany: async () => ({ id: "compose-company", name: "Compose Company" }) } as any,
      repo: isolatedRepo,
    });

    const response = await app.inject({
      method: "POST",
      url: "/companies/compose-company/email-inbox/compose",
      payload: {
        accountId: account.id,
        toAddresses: ["customer@example.net"],
        ccAddresses: ["manager@example.net"],
        subject: "A new conversation",
        bodyText: "Hello from the visible Compose Email flow.",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: "queued",
      thread: { customerEmail: "customer@example.net", folder: "sent" },
      message: { fromAddress: "sales@company.com", isDraft: false, isAiGenerated: false, deliveryStatus: "sending" },
    });
    const composed = response.json();
    await expect(isolatedRepo.listThreads(mockAuth, "compose-company", { folder: "sent" })).resolves.toEqual([
      expect.objectContaining({ id: composed.thread.id, subject: "A new conversation" }),
    ]);

    const inbound = await new EmailAIProcessor(isolatedRepo).processInbound(mockAuth, "compose-company", {
      from: "customer@example.net",
      to: "sales@company.com",
      subject: "Re: A new conversation",
      body: "This is the recipient reply.",
      messageId: "<recipient-reply@example.net>",
      inReplyTo: `<${composed.message.messageId}@company.com>`,
    });
    expect(inbound.thread.id).toBe(composed.thread.id);
    await new EmailAIProcessor(isolatedRepo).processInbound(mockAuth, "compose-company", {
      from: "customer@example.net",
      to: "sales@company.com",
      subject: "Re: A new conversation",
      body: "A second new reply.\n\nOn Fri, Sep 25, 2026 customer wrote:\n> Earlier text",
      messageId: "<recipient-reply-2@example.net>",
      inReplyTo: "<recipient-reply@example.net>",
    });
    const history = await isolatedRepo.listMessages(mockAuth, "compose-company", composed.thread.id);
    expect(history.map((message) => message.direction)).toEqual(["outbound", "inbound", "inbound"]);
    await expect(isolatedRepo.listThreads(mockAuth, "compose-company", { folder: "inbox" })).resolves.toEqual([
      expect.objectContaining({ id: composed.thread.id, messagesCount: 3, unreadCount: 2 }),
    ]);
    await expect(isolatedRepo.listThreads(mockAuth, "compose-company", { folder: "sent" })).resolves.toEqual([
      expect.objectContaining({ id: composed.thread.id }),
    ]);
    await expect(isolatedRepo.getFolderCounts(mockAuth, "compose-company")).resolves.toMatchObject({
      inbox: 2, sent: 1, drafts: 0, archived: 0, spam: 0,
    });

    const countsResponse = await app.inject({
      method: "GET", url: "/companies/compose-company/email-inbox/folder-counts",
    });
    expect(countsResponse.statusCode).toBe(200);
    expect(countsResponse.json().counts).toMatchObject({ inbox: 2, sent: 1 });

    const deleted = await app.inject({
      method: "DELETE", url: `/companies/compose-company/email-inbox/threads/${composed.thread.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    await expect(isolatedRepo.isExternalMessageDeleted(mockAuth, "compose-company", "<recipient-reply@example.net>")).resolves.toBe(true);
    await expect(isolatedRepo.isExternalMessageDeleted(mockAuth, "compose-company", "<recipient-reply-2@example.net>")).resolves.toBe(true);
    await expect(isolatedRepo.listThreads(mockAuth, "compose-company", { folder: "inbox" })).resolves.toEqual([]);
    await expect(isolatedRepo.listThreads(mockAuth, "compose-company", { folder: "sent" })).resolves.toEqual([]);
    const jobs = await isolatedRepo.claimJobs("compose-test-worker", 10);
    expect(jobs).toEqual([expect.objectContaining({ jobType: "send", emailAccountId: account.id })]);
    await app.close();
  });

  it("32. Creates an SSL/TLS IMAP and SMTP account through the public API route", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const app = Fastify();
    registerEmailInboxRoutes(app, {
      auth: { authenticate: async () => mockAuth },
      store: { getCompany: async () => ({ id: "mail-company", name: "Mail Company" }) } as any,
      repo: isolatedRepo,
    });

    const response = await app.inject({
      method: "POST",
      url: "/companies/mail-company/email-accounts",
      payload: {
        emailAddress: "test@example.com",
        displayName: "Test mailbox",
        mode: "manual",
        testMode: false,
        imapConfig: { authType: "password", host: "mail.example.com", port: 993, secure: true, username: "test@example.com", password: "secret" },
        smtpConfig: { authType: "password", host: "mail.example.com", port: 465, secure: true, username: "test@example.com", password: "secret" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      account: {
        emailAddress: "test@example.com",
        status: "pending",
        imapConfig: { host: "mail.example.com", port: 993, secure: true, username: "test@example.com" },
        smtpConfig: { host: "mail.example.com", port: 465, secure: true, username: "test@example.com" },
      },
    });
    expect(response.json().account.imapConfig.password).toBeUndefined();
    expect(response.json().account.smtpConfig.password).toBeUndefined();
    await app.close();
  });

  it("33. Supports a private mailbox without a Company and rejects duplicate connections", async () => {
    const isolatedRepo = new EmailInboxRepository();
    const app = Fastify();
    registerEmailInboxRoutes(app, {
      auth: { authenticate: async () => mockAuth },
      store: {
        getCompany: async (_context: AuthContext, companyId: string) => {
          if (companyId === "personal" || companyId.startsWith("personal:")) throw new Error("Personal scope must not require a Company");
          return { id: companyId, name: "Company" };
        },
      } as any,
      repo: isolatedRepo,
    });
    const mailbox = {
      emailAddress: "personal@example.com", mode: "manual", testMode: true,
      imapConfig: { authType: "password", host: "mail.example.com", port: 993, secure: true, username: "personal@example.com", password: "secret" },
      smtpConfig: { authType: "password", host: "mail.example.com", port: 465, secure: true, username: "personal@example.com", password: "secret" },
    };

    const created = await app.inject({ method: "POST", url: "/companies/personal/email-accounts", payload: mailbox });
    expect(created.statusCode).toBe(201);
    expect(created.json().account).toMatchObject({ emailAddress: "personal@example.com", agentId: null, testMode: true });
    expect(created.json().account.companyId).toMatch(/^personal:[0-9a-f]{32}$/);

    const listed = await app.inject({ method: "GET", url: "/companies/personal/email-accounts" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().accounts).toHaveLength(1);

    const duplicate = await app.inject({
      method: "POST", url: "/companies/another-company/email-accounts",
      payload: {
        ...mailbox,
        imapConfig: { authType: "oauth2", host: "mail.example.com", port: 993, secure: true, username: "personal@example.com", accessToken: "oauth-token" },
        smtpConfig: { authType: "oauth2", host: "mail.example.com", port: 465, secure: true, username: "personal@example.com", accessToken: "oauth-token" },
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toMatch(/already connected/i);

    const composed = await app.inject({
      method: "POST", url: "/companies/personal/email-inbox/compose",
      payload: { accountId: created.json().account.id, toAddresses: ["recipient@example.net"], subject: "Personal mailbox", bodyText: "Works without a Company." },
    });
    expect(composed.statusCode).toBe(201);
    expect(composed.json()).toMatchObject({ status: "simulated_send", thread: { folder: "sent" } });
    await app.close();
  });
});

describe("inbound email without a mailbox", () => {
  it("is refused explicitly instead of failing on a placeholder account id", async () => {
    const processor = new EmailAIProcessor(new EmailInboxRepository());
    const auth = { workspaceId: "ws-no-mailbox", userId: "owner", permissions: ["email:manage_accounts"] } as AuthContext;
    await expect(processor.processInbound(auth, "company-without-mailbox", { from: "customer@example.com", subject: "Hello", body: "Do you bake gluten-free bread?" }))
      .rejects.toMatchObject({ status: 409, code: "EMAIL_ACCOUNT_REQUIRED" });
  });
});

describe("email planner scope", () => {
  it("uses the one other company whose inbox has mail from the address the request names", async () => {
    const { EmailChatActions } = await import("../apps/agent-api/src/email-chat-actions");
    const { InMemoryWorkspaceStore } = await import("@npati/workspace");
    const auth = { workspaceId: "ws-scope", userId: "owner", permissions: ["business:manage", "email:manage_accounts"] } as AuthContext;
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const fit = await store.createCompany(auth, { name: "Nordic Fit" }, "fit");
    const bakery = await store.createCompany(auth, { name: "Bakery" }, "bakery");
    await repo.createAccount(auth, bakery.id, { emailAddress: "bakery@example.com", testMode: true } as never);
    await new EmailAIProcessor(repo).processInbound(auth, bakery.id, { from: "e2e-test@example.com", subject: "Late order", body: "My order was two hours late." });
    const prompt = await EmailChatActions.buildSystemPrompt(auth, store, repo, "Прийшов лист зі скаргою від EMAIL_REF_ab_1. Склади відповідь", fit.id, undefined, { EMAIL_REF_ab_1: "e2e-test@example.com" });
    expect(prompt).toContain(bakery.id);
    expect(prompt).not.toContain(`"companyId":"${fit.id}"`);
    expect(EmailChatActions.noActionMessage("Видали лист про лотерею")).toMatch(/^Не вдалося/);
  });
});
