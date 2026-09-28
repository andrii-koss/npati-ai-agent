import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { EmailAIProcessor } from "../apps/agent-api/src/email-ai-processor";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { EmailMessagingAdapter, emailEnvelopeToGatewayMessage } from "../apps/agent-api/src/email-messaging-adapter";
import { runMigration053 } from "../packages/workspace/src/migration-053";

const auth: AuthContext = { workspaceId: "workspace-email-gateway", userId: "user-email-gateway", permissions: ["workspace:read", "workspace:write", "business:manage"] };

describe("Email messaging gateway", () => {
  it("rejects non-allowlisted and automated mail before the runtime", async () => {
    const repo = new EmailInboxRepository();
    await repo.createAccount(auth, "company-security", {
      emailAddress: "agent@company.test", status: "connected", senderPolicy: "allowlist",
      allowedSenders: ["allowed@example.com"], requireAuthenticatedSender: true,
    });
    const routeThroughGateway = vi.fn(async () => true);
    const processor = new EmailAIProcessor(repo, undefined, undefined, { routeThroughGateway });
    const rejected = await processor.processInbound(auth, "company-security", {
      from: "intruder@example.com", to: "agent@company.test", subject: "Request", body: "hello",
      messageId: "<unauthorized-1@example.com>", headers: { "authentication-results": "spf=pass" },
    });
    expect(rejected.actionTaken).toBe("sender_rejected");
    const automated = await processor.processInbound(auth, "company-security", {
      from: "allowed@example.com", to: "agent@company.test", subject: "Automatic reply", body: "away",
      messageId: "<automated-1@example.com>", headers: { "auto-submitted": "auto-replied", "authentication-results": "spf=pass" },
    });
    expect(automated.actionTaken).toBe("sender_rejected");
    expect(routeThroughGateway).not.toHaveBeenCalled();
  });

  it("routes an authenticated sender with a stable email thread and untrusted-content marker", async () => {
    const repo = new EmailInboxRepository();
    await repo.createAccount(auth, "company-route", {
      emailAddress: "support@company.test", status: "connected", senderPolicy: "allowlist",
      allowedDomains: ["example.com"], requireAuthenticatedSender: true,
    });
    const envelopes: any[] = [];
    const processor = new EmailAIProcessor(repo, undefined, undefined, { routeThroughGateway: async (input) => { envelopes.push(input); return true; } });
    const first = await processor.processInbound(auth, "company-route", {
      from: "person@example.com", to: "support@company.test", subject: "Need help", body: "First",
      messageId: "<thread-first@example.com>", headers: { "authentication-results": "mx; dkim=pass header.d=example.com" },
    });
    const second = await processor.processInbound(auth, "company-route", {
      from: "person@example.com", to: "support@company.test", subject: "Re: Need help", body: "Second",
      messageId: "<thread-second@example.com>", inReplyTo: "<thread-first@example.com>",
      references: "<thread-first@example.com>", headers: { "authentication-results": "mx; dmarc=pass header.from=example.com" },
    });
    expect(first.actionTaken).toBe("gateway_dispatched");
    expect(second.thread.id).toBe(first.thread.id);
    const gateway = emailEnvelopeToGatewayMessage(envelopes[1]);
    expect(gateway.externalThreadId).toBe(first.thread.id);
    expect(gateway.senderAuthorized).toBe(true);
    expect(gateway.authenticatedSender).toBe(true);
    expect(gateway.externalUntrustedContent).toBe(true);
  });

  it("creates an approval draft instead of sending by default", async () => {
    const repo = new EmailInboxRepository();
    const account = await repo.createAccount(auth, "company-draft", {
      emailAddress: "agent@company.test", status: "connected", outboundPolicy: "approval_required",
    });
    const thread = await repo.createThread(auth, "company-draft", { emailAccountId: account.id, subject: "Question", customerEmail: "person@example.com" });
    await repo.createMessage(auth, "company-draft", { threadId: thread.id, emailAccountId: account.id, direction: "inbound", fromAddress: "person@example.com", toAddresses: [account.emailAddress], subject: "Question", bodyText: "Hello", messageId: "<draft-parent@example.com>", deliveryStatus: "delivered" });
    const adapter = new EmailMessagingAdapter(repo);
    const ids = await adapter.sendText(account.id, "person@example.com", "Draft response", thread.id);
    const message = await repo.getMessage(auth, "company-draft", ids[0]!);
    const updatedThread = await repo.getThread(auth, "company-draft", thread.id);
    expect(message?.isDraft).toBe(true);
    expect(message?.inReplyTo).toBe("<draft-parent@example.com>");
    expect(updatedThread?.status).toBe("waiting_approval");
    expect(await repo.claimJobs("test-worker", 10)).toEqual([]);
  });

  it("migrates durable provider, scope, sender and outbound policies", async () => {
    let sql = "";
    await runMigration053({ query: async (statement: string) => { sql += statement; return {} as any; } } as any);
    expect(sql).toContain("connection_scope");
    expect(sql).toContain("sender_policy");
    expect(sql).toContain("require_authenticated_sender");
    expect(sql).toContain("outbound_policy");
    expect(sql).toContain("DEFAULT 'allowlist'");
    expect(sql).toContain("DEFAULT 'approval_required'");
  });
});
