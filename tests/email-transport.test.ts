import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ImapEmailTransport, SmtpEmailTransport } from "../apps/agent-api/src/email-transport";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { EmailInboxWorker } from "../apps/agent-api/src/email-worker";
import type { CompanyEmailAccount, CompanyEmailMessage } from "../apps/agent-api/src/email-inbox-types";
import type { AuthContext } from "@npati/workspace";

// These suites talk to in-process mail servers on 127.0.0.1. The destination policy (audit M2) refuses private
// addresses unless a self-hosted owner opts in; that policy is pinned in tests/security-audit-m1-m2-email-ssrf.test.ts.
process.env.NPATI_MAIL_ALLOW_PRIVATE_HOSTS = "true";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

function account(overrides: Partial<CompanyEmailAccount> = {}): CompanyEmailAccount {
  const now = new Date().toISOString();
  return {
    id: "account-1", workspaceId: "workspace-1", companyId: "company-1", userId: "user-1",
    emailAddress: "support@example.com", displayName: "Support", agentId: null,
    mode: "autopilot", status: "connected", testMode: false, confidenceThreshold: 0.8,
    languageMode: "auto", fallbackLanguage: "en", imapConfig: {}, smtpConfig: {},
    rateLimits: { maxPerHour: 50, maxPerDay: 500, maxPerRecipientDaily: 5, maxFollowups: 2 },
    signatureConfig: {}, followupConfig: { enabled: false, delayDays: 2, maxFollowups: 2, action: "draft" },
    createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("Email transport", () => {
  it("dispatches a real SMTP conversation and transmits the message body", async () => {
    let receivedData = "";
    const server = net.createServer((socket) => {
      socket.write("220 local test smtp\r\n");
      let buffer = "";
      let dataMode = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (dataMode) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end >= 0) {
            receivedData = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            dataMode = false;
            socket.write("250 2.0.0 queued\r\n");
          }
          return;
        }
        while (buffer.includes("\r\n")) {
          const index = buffer.indexOf("\r\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (/^EHLO /.test(line)) socket.write("250 local\r\n");
          else if (/^AUTH PLAIN /.test(line)) socket.write("235 authenticated\r\n");
          else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write("250 ok\r\n");
          else if (line === "DATA") { dataMode = true; socket.write("354 end with dot\r\n"); break; }
          else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        }
      });
    });
    const port = await listen(server);
    const mailAccount = account({ smtpConfig: { host: "127.0.0.1", port, secure: false, username: "support@example.com", password: "secret" } });
    const now = new Date().toISOString();
    const message: CompanyEmailMessage = {
      id: "message-1", workspaceId: "workspace-1", companyId: "company-1", threadId: "thread-1",
      emailAccountId: mailAccount.id, messageId: "provider-1", direction: "outbound",
      fromAddress: mailAccount.emailAddress, toAddresses: ["customer@example.net"], ccAddresses: [], bccAddresses: [],
      subject: "SMTP integration", bodyText: "Actual transport body", attachments: [], deliveryStatus: "sending",
      isDraft: false, isAiGenerated: true, createdAt: now,
    };

    await SmtpEmailTransport.verify(mailAccount.smtpConfig, 3_000);
    await SmtpEmailTransport.send(mailAccount, message, 3_000);
    expect(receivedData).toContain("Subject: SMTP integration");
    expect(receivedData).toContain("Actual transport body");
  });

  it("polls IMAP by UID and recursively parses nested MIME text and attachments", async () => {
    const raw = [
      "From: Client <client@example.net>", "To: support@example.com", "Subject: Invoice",
      "Message-ID: <imap-42@example.net>", "Content-Type: multipart/mixed; boundary=abc", "",
      "--abc", "Content-Type: multipart/related; boundary=related", "",
      "--related", "Content-Type: multipart/alternative; boundary=alternative", "",
      "--alternative", "Content-Type: text/plain; charset=utf-8", "", "Please review the invoice and photo.",
      "--alternative", "Content-Type: text/html; charset=utf-8", "", "<p>Please review the <b>invoice and photo</b>.</p>",
      "--alternative--",
      "--related", "Content-Type: image/jpeg; name=photo.jpg",
      "Content-Disposition: inline; filename=photo.jpg", "Content-Transfer-Encoding: base64", "",
      Buffer.from("fake photo content").toString("base64"), "--related--",
      "--abc", "Content-Type: application/pdf; name=invoice.pdf",
      "Content-Disposition: attachment; filename=invoice.pdf", "Content-Transfer-Encoding: base64", "",
      Buffer.from("fake pdf content").toString("base64"), "--abc--", "",
    ].join("\r\n");
    const server = net.createServer((socket) => {
      socket.write("* OK local imap ready\r\n");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\r\n")) {
          const index = buffer.indexOf("\r\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const tag = line.split(" ", 1)[0]!;
          if (line.includes(" LOGIN ")) socket.write(`${tag} OK logged in\r\n`);
          else if (line.includes(" SELECT ")) socket.write(`* 1 EXISTS\r\n${tag} OK selected\r\n`);
          else if (line.includes(" UID SEARCH ")) socket.write(`* SEARCH 42\r\n${tag} OK search done\r\n`);
          else if (line.includes(" UID FETCH ")) socket.write(`* 1 FETCH (UID 42 RFC822 {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK fetch done\r\n`);
          else if (line.includes(" LOGOUT")) { socket.write(`* BYE\r\n${tag} OK logout\r\n`); socket.end(); }
        }
      });
    });
    const port = await listen(server);
    const mailAccount = account({ imapConfig: { host: "127.0.0.1", port, secure: false, username: "support@example.com", password: "secret" } });
    await ImapEmailTransport.verify(mailAccount.imapConfig, 3_000);
    const messages = await ImapEmailTransport.poll(mailAccount, 3_000);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe("<imap-42@example.net>");
    expect(messages[0]?.body).toContain("Please review the invoice and photo");
    expect(messages[0]?.bodyHtml).toContain("<b>invoice and photo</b>");
    const photo = messages[0]?.attachments.find((attachment) => attachment.filename === "photo.jpg");
    const invoice = messages[0]?.attachments.find((attachment) => attachment.filename === "invoice.pdf");
    expect(photo).toMatchObject({ contentType: "image/jpeg" });
    expect(invoice).toMatchObject({ contentType: "application/pdf" });
    expect(Buffer.from(invoice!.contentBase64!, "base64").toString()).toBe("fake pdf content");
  });

  it("claims a durable send job and marks the message sent only after SMTP accepts it", async () => {
    const server = net.createServer((socket) => {
      socket.write("220 worker smtp\r\n");
      let buffer = "";
      let dataMode = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (dataMode && buffer.includes("\r\n.\r\n")) {
          buffer = "";
          dataMode = false;
          socket.write("250 accepted\r\n");
          return;
        }
        while (!dataMode && buffer.includes("\r\n")) {
          const index = buffer.indexOf("\r\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (/^EHLO /.test(line)) socket.write("250 local\r\n");
          else if (/^AUTH PLAIN /.test(line)) socket.write("235 authenticated\r\n");
          else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write("250 ok\r\n");
          else if (line === "DATA") { dataMode = true; socket.write("354 continue\r\n"); }
          else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        }
      });
    });
    const port = await listen(server);
    const repo = new EmailInboxRepository();
    const ctx: AuthContext = { userId: "worker-user", workspaceId: "worker-workspace", permissions: ["admin:all"] };
    const createdAccount = await repo.createAccount(ctx, "worker-company", {
      emailAddress: "support@example.com",
      mode: "manual",
      smtpConfig: { host: "127.0.0.1", port, secure: false, username: "support@example.com", password: "secret" },
    });
    const thread = await repo.createThread(ctx, "worker-company", {
      emailAccountId: createdAccount.id, subject: "Worker dispatch", customerEmail: "client@example.net",
    });
    const message = await repo.createMessage(ctx, "worker-company", {
      threadId: thread.id, emailAccountId: createdAccount.id, direction: "outbound",
      fromAddress: createdAccount.emailAddress, toAddresses: [thread.customerEmail], subject: thread.subject,
      bodyText: "Send through the queue", isDraft: false, deliveryStatus: "sending",
    });
    await repo.enqueueJob(ctx, "worker-company", {
      jobType: "send", emailAccountId: createdAccount.id, threadId: thread.id,
      messageId: message.id, idempotencyKey: `send:${message.id}`,
    });

    const worker = new EmailInboxWorker(repo, undefined, undefined, {}, 60_000);
    await worker.tick();

    await expect(repo.getMessage(ctx, "worker-company", message.id)).resolves.toMatchObject({ deliveryStatus: "sent" });
    await expect(repo.getThread(ctx, "worker-company", thread.id)).resolves.toMatchObject({ status: "waiting_customer" });
  });
});
