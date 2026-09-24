import { describe, expect, it } from "vitest";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { EmailAIProcessor } from "../apps/agent-api/src/email-ai-processor";
import { EmailDnsVerifier } from "../apps/agent-api/src/email-dns-verifier";
import { EmailConnectionTester } from "../apps/agent-api/src/email-connection-tester";
import { EmailAgentTools } from "../apps/agent-api/src/email-agent-tools";
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

    expect(inbound.actionTaken).toBe("autopilot_sent");
    expect(inbound.thread.status).toBe("answered");
    expect(inbound.aiMessage?.isDraft).toBe(false);
    expect(inbound.aiMessage?.deliveryStatus).toBe("sent");
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
    repo.recordSentEmail(companyId, support.id, "rate_limited_client@org.com");

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
    expect(suspCheck.threatLevel).toBe("suspicious");
  });

  it("15. Analytics accurately aggregates email metrics and automation rate", async () => {
    const analytics = await repo.getAnalytics(mockAuth, companyId);
    expect(analytics.receivedEmails).toBeGreaterThan(0);
    expect(analytics.automationRate).toBeGreaterThanOrEqual(0);
    expect(analytics.confidenceDistribution).toBeDefined();
    expect(analytics.volumeByDay.length).toBeGreaterThan(0);
  });
});
