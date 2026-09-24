import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ImapEmailTransport, SmtpEmailTransport } from "../apps/agent-api/src/email-transport";
import type { CompanyEmailAccount, CompanyEmailMessage } from "../apps/agent-api/src/email-inbox-types";

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

    await SmtpEmailTransport.send(mailAccount, message, 3_000);
    expect(receivedData).toContain("Subject: SMTP integration");
    expect(receivedData).toContain("Actual transport body");
  });

  it("polls IMAP by UID and parses MIME attachments", async () => {
    const raw = [
      "From: Client <client@example.net>", "To: support@example.com", "Subject: Invoice",
      "Message-ID: <imap-42@example.net>", "Content-Type: multipart/mixed; boundary=abc", "",
      "--abc", "Content-Type: text/plain; charset=utf-8", "", "Please review the invoice.",
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
    const messages = await ImapEmailTransport.poll(mailAccount, 3_000);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe("<imap-42@example.net>");
    expect(messages[0]?.body).toContain("Please review the invoice");
    expect(messages[0]?.attachments[0]).toMatchObject({ filename: "invoice.pdf", contentType: "application/pdf" });
    expect(Buffer.from(messages[0]!.attachments[0]!.contentBase64!, "base64").toString()).toBe("fake pdf content");
  });
});
