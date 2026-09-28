import net from "node:net";
import tls from "node:tls";
import type { CompanyEmailAccount, CompanyEmailMessage, EmailAttachment, ImapConfig, SmtpConfig } from "./email-inbox-types";

type MailSocket = net.Socket | tls.TLSSocket;

function waitForSocket(socket: MailSocket, event: "connect" | "secureConnect", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Mail connection timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off(event, onReady);
      socket.off("error", onError);
      error ? reject(error) : resolve();
    };
    const onReady = () => finish();
    const onError = (error: Error) => finish(error);
    socket.once(event, onReady);
    socket.once("error", onError);
  });
}

class SmtpSession {
  private buffer = "";
  constructor(readonly socket: MailSocket, private readonly timeoutMs: number) {}

  async readReply(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: { code: number; text: string }) => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        error ? reject(error) : resolve(value!);
      };
      const inspect = () => {
        const lines = this.buffer.split("\r\n");
        for (let index = 0; index < lines.length - 1; index++) {
          const match = lines[index]!.match(/^(\d{3}) ([\s\S]*)$/);
          if (!match) continue;
          const consumed = lines.slice(0, index + 1).join("\r\n") + "\r\n";
          this.buffer = this.buffer.slice(consumed.length);
          finish(undefined, { code: Number(match[1]), text: consumed.trim() });
          return true;
        }
        return false;
      };
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        inspect();
      };
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error("SMTP response timed out")), this.timeoutMs);
      if (inspect()) return;
      this.socket.on("data", onData);
      this.socket.once("error", onError);
    });
  }

  async command(command: string, accepted: number[] = [250]): Promise<{ code: number; text: string }> {
    this.socket.write(command + "\r\n");
    const response = await this.readReply();
    if (!accepted.includes(response.code)) throw new Error(`SMTP ${response.code}: ${response.text}`);
    return response;
  }
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodedHeader(value: string): string {
  const clean = safeHeader(value);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

export class SmtpEmailTransport {
  static async verify(config: SmtpConfig, timeoutMs = 15_000): Promise<void> {
    if (!config.host || !config.port || !config.username) throw new Error("SMTP host, port, and username are required");
    if (config.authType === "oauth2" ? !config.accessToken : !config.password) {
      throw new Error(config.authType === "oauth2" ? "SMTP OAuth access token is required" : "SMTP password is required");
    }
    let socket: MailSocket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
      : net.createConnection({ host: config.host, port: config.port });
    await waitForSocket(socket, config.secure ? "secureConnect" : "connect", timeoutMs);
    let session = new SmtpSession(socket, timeoutMs);
    const greeting = await session.readReply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting rejected: ${greeting.text}`);
    let hello = await session.command(`EHLO ${safeHeader(config.username.split("@")[1] || "localhost")}`);
    if (!config.secure && /STARTTLS/i.test(hello.text)) {
      await session.command("STARTTLS", [220]);
      socket = tls.connect({ socket, servername: config.host, rejectUnauthorized: true });
      await waitForSocket(socket, "secureConnect", timeoutMs);
      session = new SmtpSession(socket, timeoutMs);
      hello = await session.command(`EHLO ${safeHeader(config.username.split("@")[1] || "localhost")}`);
    }
    if (config.authType === "oauth2") {
      const auth = Buffer.from(`user=${config.username}\u0001auth=Bearer ${config.accessToken}\u0001\u0001`).toString("base64");
      await session.command(`AUTH XOAUTH2 ${auth}`, [235]);
    } else {
      const auth = Buffer.from(`\u0000${config.username}\u0000${config.password}`).toString("base64");
      await session.command(`AUTH PLAIN ${auth}`, [235]);
    }
    await session.command("QUIT", [221]).catch(() => undefined);
    socket.end();
  }

  static async send(account: CompanyEmailAccount, message: CompanyEmailMessage, timeoutMs = 15_000): Promise<{ response: string }> {
    const config: SmtpConfig = account.smtpConfig;
    if (!config.host || !config.port) throw new Error("SMTP host and port are required");
    if (!config.username) throw new Error("SMTP username is required");
    if (config.authType === "oauth2" ? !config.accessToken : !config.password) {
      throw new Error(config.authType === "oauth2" ? "SMTP OAuth access token is required" : "SMTP password is required");
    }

    let socket: MailSocket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
      : net.createConnection({ host: config.host, port: config.port });
    await waitForSocket(socket, config.secure ? "secureConnect" : "connect", timeoutMs);
    let session = new SmtpSession(socket, timeoutMs);
    const greeting = await session.readReply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting rejected: ${greeting.text}`);

    let hello = await session.command(`EHLO ${safeHeader(account.emailAddress.split("@")[1] || "localhost")}`);
    if (!config.secure && /STARTTLS/i.test(hello.text)) {
      await session.command("STARTTLS", [220]);
      socket = tls.connect({ socket, servername: config.host, rejectUnauthorized: true });
      await waitForSocket(socket, "secureConnect", timeoutMs);
      session = new SmtpSession(socket, timeoutMs);
      hello = await session.command(`EHLO ${safeHeader(account.emailAddress.split("@")[1] || "localhost")}`);
    }

    if (config.authType === "oauth2") {
      const auth = Buffer.from(`user=${config.username}\u0001auth=Bearer ${config.accessToken}\u0001\u0001`).toString("base64");
      await session.command(`AUTH XOAUTH2 ${auth}`, [235]);
    } else {
      const auth = Buffer.from(`\u0000${config.username}\u0000${config.password}`).toString("base64");
      await session.command(`AUTH PLAIN ${auth}`, [235]);
    }
    const envelopeFrom = safeHeader(config.fromEmail || account.emailAddress);
    await session.command(`MAIL FROM:<${envelopeFrom}>`);
    const recipients = [...message.toAddresses, ...(message.ccAddresses || []), ...(message.bccAddresses || [])];
    if (!recipients.length) throw new Error("SMTP message has no recipients");
    for (const recipient of recipients) await session.command(`RCPT TO:<${safeHeader(recipient)}>`, [250, 251]);
    await session.command("DATA", [354]);

    const attachmentParts = message.attachments.filter((attachment) => attachment.contentBase64);
    const boundary = `npati-${message.id}`;
    const mimeHeaders = attachmentParts.length
      ? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
      : ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"];
    const domain = safeHeader(account.emailAddress.split("@")[1] || "localhost");
    const rawMsgId = (message.messageId || message.id).replace(/[<>]/g, "").trim();
    const formattedMsgId = rawMsgId.includes("@") ? `<${rawMsgId}>` : `<${rawMsgId}@${domain}>`;
    const formattedInReplyTo = message.inReplyTo
      ? (message.inReplyTo.trim().startsWith("<") ? message.inReplyTo.trim() : `<${message.inReplyTo.trim()}>`)
      : "";
    const headers = [
      `From: ${encodedHeader(config.fromName || account.displayName || account.emailAddress)} <${envelopeFrom}>`,
      `To: ${message.toAddresses.map(safeHeader).join(", ")}`,
      message.ccAddresses?.length ? `Cc: ${message.ccAddresses.map(safeHeader).join(", ")}` : "",
      `Subject: ${encodedHeader(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${formattedMsgId}`,
      formattedInReplyTo ? `In-Reply-To: ${safeHeader(formattedInReplyTo)}` : "",
      formattedInReplyTo ? `References: ${safeHeader(formattedInReplyTo)}` : "",
      "MIME-Version: 1.0",
      ...mimeHeaders,
    ].filter(Boolean).join("\r\n");
    const textBody = message.bodyText.replace(/\r?\n/g, "\r\n");
    const body = (attachmentParts.length
      ? [
          `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${textBody}`,
          ...attachmentParts.map((attachment) => {
            const encoded = attachment.contentBase64!.replace(/\s/g, "").match(/.{1,76}/g)?.join("\r\n") || "";
            return `--${boundary}\r\nContent-Type: ${safeHeader(attachment.contentType)}; name="${safeHeader(attachment.filename)}"\r\nContent-Disposition: attachment; filename="${safeHeader(attachment.filename)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`;
          }),
          `--${boundary}--`,
        ].join("\r\n")
      : textBody).replace(/^\./gm, "..");
    socket.write(`${headers}\r\n\r\n${body}\r\n.\r\n`);
    const accepted = await session.readReply();
    if (accepted.code !== 250) throw new Error(`SMTP delivery rejected: ${accepted.text}`);
    await session.command("QUIT", [221]).catch(() => undefined);
    socket.end();
    return { response: accepted.text };
  }
}

class ImapSession {
  private buffer = Buffer.alloc(0);
  private tagCounter = 0;
  constructor(private readonly socket: MailSocket, private readonly timeoutMs: number) {}

  async readUntil(pattern: RegExp): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, data?: Buffer) => {
        clearTimeout(timer); this.socket.off("data", onData); this.socket.off("error", onError);
        error ? reject(error) : resolve(data!);
      };
      const inspect = () => {
        if (!pattern.test(this.buffer.toString("latin1"))) return false;
        const data = this.buffer; this.buffer = Buffer.alloc(0); finish(undefined, data); return true;
      };
      const onData = (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); inspect(); };
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error("IMAP response timed out")), this.timeoutMs);
      if (inspect()) return;
      this.socket.on("data", onData); this.socket.once("error", onError);
    });
  }

  async command(command: string): Promise<Buffer> {
    const tag = `A${String(++this.tagCounter).padStart(4, "0")}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const response = await this.readUntil(new RegExp(`(?:^|\\r\\n)${tag} (?:OK|NO|BAD)[^\\r\\n]*\\r\\n`, "i"));
    const finalLine = response.toString("latin1").match(new RegExp(`${tag} (OK|NO|BAD)[^\\r\\n]*`, "i"));
    if (!finalLine || finalLine[1]?.toUpperCase() !== "OK") throw new Error(`IMAP command failed: ${finalLine?.[0] || command}`);
    return response;
  }
}

function imapQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\").replace(/"/g, '\"')}"`;
}

function decodeMimeWord(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, data: string) => Buffer.from(data, "base64").toString("utf8"));
}

function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  return decodeMimeWord(unfolded.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() || "");
}

export interface PolledImapMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  headers: Record<string, string>;
  authenticationResults?: string;
  attachments: EmailAttachment[];
}

function decodePartBody(body: string, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(body.replace(/\s/g, ""), "base64");
  if (encoding === "quoted-printable") {
    const decoded = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(decoded, "latin1");
  }
  return Buffer.from(body, "utf8");
}

function parseMimeContent(raw: string): { body: string; bodyHtml?: string; attachments: EmailAttachment[] } {
  const separator = raw.search(/\r?\n\r?\n/);
  const headers = separator >= 0 ? raw.slice(0, separator) : raw;
  const content = separator >= 0 ? raw.slice(separator).replace(/^\r?\n\r?\n/, "") : "";
  const contentType = headerValue(headers, "Content-Type") || "text/plain";
  const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!boundary) {
    const decoded = decodePartBody(content, headerValue(headers, "Content-Transfer-Encoding").toLowerCase()).toString("utf8").trim();
    return contentType.toLowerCase().startsWith("text/html")
      ? { body: decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), bodyHtml: decoded, attachments: [] }
      : { body: decoded, attachments: [] };
  }

  let textBody = "";
  let htmlBody: string | undefined;
  const attachments: EmailAttachment[] = [];
  const parts = content.split(`--${boundary}`).slice(1);
  for (const rawPart of parts) {
    if (rawPart.startsWith("--")) break;
    const part = rawPart.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const partSeparator = part.search(/\r?\n\r?\n/);
    if (partSeparator < 0) continue;
    const partHeaders = part.slice(0, partSeparator);
    const partBody = part.slice(partSeparator).replace(/^\r?\n\r?\n/, "");
    const partType = (headerValue(partHeaders, "Content-Type") || "text/plain").split(";", 1)[0]!.trim().toLowerCase();
    const disposition = headerValue(partHeaders, "Content-Disposition");
    const filename = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean)
      || headerValue(partHeaders, "Content-Type").match(/name\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
    const decoded = decodePartBody(partBody, headerValue(partHeaders, "Content-Transfer-Encoding").toLowerCase());
    if (partType.startsWith("multipart/")) {
      const nested = parseMimeContent(part);
      if (!textBody && nested.body) textBody = nested.body;
      if (!htmlBody && nested.bodyHtml) htmlBody = nested.bodyHtml;
      attachments.push(...nested.attachments);
      continue;
    }
    if (filename || /attachment/i.test(disposition)) {
      attachments.push({
        filename: decodeMimeWord(filename || "attachment"), contentType: partType,
        sizeBytes: decoded.length, contentBase64: decoded.toString("base64"),
      });
    } else if (partType === "text/plain" && !textBody) textBody = decoded.toString("utf8").trim();
    else if (partType === "text/html" && !htmlBody) htmlBody = decoded.toString("utf8").trim();
  }
  if (!textBody && htmlBody) textBody = htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { body: textBody, bodyHtml: htmlBody, attachments };
}

export class ImapEmailTransport {
  static async verify(config: ImapConfig, timeoutMs = 15_000): Promise<void> {
    if (!config.host || !config.port || !config.username) throw new Error("IMAP host, port, and username are required");
    if (config.authType === "oauth2" ? !config.accessToken : !config.password) {
      throw new Error(config.authType === "oauth2" ? "IMAP OAuth access token is required" : "IMAP password is required");
    }
    let socket: MailSocket = config.secure !== false
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
      : net.createConnection({ host: config.host, port: config.port });
    await waitForSocket(socket, config.secure !== false ? "secureConnect" : "connect", timeoutMs);
    let session = new ImapSession(socket, timeoutMs);
    await session.readUntil(/(?:^|\r\n)\* (?:OK|PREAUTH)[^\r\n]*\r\n/i);
    if (config.secure === false && config.tls === true) {
      await session.command("STARTTLS");
      socket = tls.connect({ socket, servername: config.host, rejectUnauthorized: true });
      await waitForSocket(socket, "secureConnect", timeoutMs);
      session = new ImapSession(socket, timeoutMs);
    }
    if (config.authType === "oauth2") {
      const auth = Buffer.from(`user=${config.username}\u0001auth=Bearer ${config.accessToken}\u0001\u0001`).toString("base64");
      await session.command(`AUTHENTICATE XOAUTH2 ${auth}`);
    } else {
      await session.command(`LOGIN ${imapQuote(config.username)} ${imapQuote(config.password!)}`);
    }
    await session.command("LOGOUT").catch(() => undefined);
    socket.end();
  }

  static async poll(account: CompanyEmailAccount, timeoutMs = 20_000): Promise<PolledImapMessage[]> {
    const config: ImapConfig = account.imapConfig;
    if (!config.host || !config.port) throw new Error("IMAP host and port are required");
    if (!config.username) throw new Error("IMAP username is required");
    if (config.authType === "oauth2" ? !config.accessToken : !config.password) {
      throw new Error(config.authType === "oauth2" ? "IMAP OAuth access token is required" : "IMAP password is required");
    }
    let socket: MailSocket = config.secure !== false
      ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
      : net.createConnection({ host: config.host, port: config.port });
    await waitForSocket(socket, config.secure !== false ? "secureConnect" : "connect", timeoutMs);
    let session = new ImapSession(socket, timeoutMs);
    await session.readUntil(/(?:^|\r\n)\* (?:OK|PREAUTH)[^\r\n]*\r\n/i);
    if (config.secure === false && config.tls === true) {
      await session.command("STARTTLS");
      socket = tls.connect({ socket, servername: config.host, rejectUnauthorized: true });
      await waitForSocket(socket, "secureConnect", timeoutMs);
      session = new ImapSession(socket, timeoutMs);
    }
    if (config.authType === "oauth2") {
      const auth = Buffer.from(`user=${config.username}\u0001auth=Bearer ${config.accessToken}\u0001\u0001`).toString("base64");
      await session.command(`AUTHENTICATE XOAUTH2 ${auth}`);
    } else {
      await session.command(`LOGIN ${imapQuote(config.username)} ${imapQuote(config.password!)}`);
    }
    await session.command(`SELECT ${imapQuote(config.mailbox || "INBOX")}`);
    const startUid = Math.max(1, (config.lastUid || 0) + 1);
    const search = await session.command(`UID SEARCH UID ${startUid}:*`);
    const searchLine = search.toString("latin1").match(/\* SEARCH([^\r\n]*)/i)?.[1] || "";
    const uids = searchLine.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite).slice(0, 100);
    const messages: PolledImapMessage[] = [];
    for (const uid of uids) {
      const fetched = await session.command(`UID FETCH ${uid} (UID RFC822)`);
      const marker = fetched.toString("latin1").match(/\{(\d+)\}\r\n/);
      if (!marker || marker.index === undefined) continue;
      const start = marker.index + marker[0].length;
      const raw = fetched.subarray(start, start + Number(marker[1])).toString("utf8");
      const separator = raw.search(/\r?\n\r?\n/);
      const headers = separator >= 0 ? raw.slice(0, separator) : raw;
      const mime = parseMimeContent(raw);
      const fromHeader = headerValue(headers, "From");
      const toHeader = headerValue(headers, "To");
      messages.push({
        uid,
        from: fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader,
        to: toHeader.match(/<([^>]+)>/)?.[1] || toHeader || account.emailAddress,
        subject: headerValue(headers, "Subject") || "No Subject",
        body: mime.body,
        bodyHtml: mime.bodyHtml,
        messageId: headerValue(headers, "Message-ID") || undefined,
        inReplyTo: headerValue(headers, "In-Reply-To") || undefined,
        references: headerValue(headers, "References") || undefined,
        headers: {
          "auto-submitted": headerValue(headers, "Auto-Submitted"),
          precedence: headerValue(headers, "Precedence"),
          "list-unsubscribe": headerValue(headers, "List-Unsubscribe"),
          "authentication-results": headerValue(headers, "Authentication-Results"),
          "return-path": headerValue(headers, "Return-Path"),
        },
        authenticationResults: headerValue(headers, "Authentication-Results") || undefined,
        attachments: mime.attachments,
      });
    }
    await session.command("LOGOUT").catch(() => undefined);
    socket.end();
    return messages;
  }
}
