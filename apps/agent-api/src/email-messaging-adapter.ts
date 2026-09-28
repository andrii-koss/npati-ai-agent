import type { AuthContext } from "@npati/workspace";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { CompanyEmailAccount, CompanyEmailMessage, CompanyEmailThread, EmailAttachment } from "./email-inbox-types";
import type { EmailInboundTrust, InboundEmailPayload } from "./email-ai-processor";
import type { GatewayOutboundAttachment, InboundGatewayMessage, MessagingAdapter } from "./messaging-gateway";

export interface EmailGatewayEnvelope {
  account: CompanyEmailAccount;
  thread: CompanyEmailThread;
  inboundMessage: CompanyEmailMessage;
  payload: InboundEmailPayload;
  trust: EmailInboundTrust;
}

function context(account: CompanyEmailAccount): AuthContext {
  return { workspaceId: account.workspaceId, userId: account.userId, companyId: account.companyId, permissions: ["workspace:read", "workspace:write", "business:manage", "email:view", "email:read_messages", "email:send_messages"] };
}

function gatewayAttachment(attachment: EmailAttachment) {
  if (!attachment.contentBase64) return null;
  const kind = attachment.contentType.startsWith("image/") ? "image" : attachment.contentType.startsWith("audio/") ? "audio" : "document";
  return { kind, name: attachment.filename, mimeType: attachment.contentType, dataBase64: attachment.contentBase64 } as const;
}

export function emailEnvelopeToGatewayMessage(envelope: EmailGatewayEnvelope): InboundGatewayMessage {
  const attachments = (envelope.payload.attachments || []).map(gatewayAttachment).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const decision = /^(APPROVE|DENY)\b/i.exec(envelope.inboundMessage.bodyText.trim())?.[1]?.toLowerCase();
  const approvalId = `${envelope.thread.subject}\n${envelope.inboundMessage.bodyText}`
    .match(/\b[0-9a-f]{8}-[0-9a-f-]{19,}\b/i)?.[0];
  const text = decision && approvalId ? `/${decision === "approve" ? "approve" : "deny"} ${approvalId}` : envelope.inboundMessage.bodyText;
  return {
    externalUserId: envelope.inboundMessage.fromAddress.toLowerCase(),
    externalChatId: envelope.inboundMessage.fromAddress.toLowerCase(),
    externalThreadId: envelope.thread.id,
    text,
    attachments,
    hasAttachments: (envelope.payload.attachments?.length || 0) > 0,
    messageId: envelope.inboundMessage.messageId || envelope.inboundMessage.id,
    eventId: envelope.inboundMessage.messageId || envelope.inboundMessage.id,
    chatType: "email",
    replyContext: envelope.inboundMessage.inReplyTo ? { messageId: envelope.inboundMessage.inReplyTo, text: envelope.thread.subject } : undefined,
    senderAuthorized: envelope.trust.authorized,
    authenticatedSender: envelope.trust.authenticated,
    externalUntrustedContent: true,
  };
}

export class EmailMessagingAdapter implements MessagingAdapter {
  readonly channel = "email";
  private readonly lastOutbound = new Map<string, string>();

  constructor(private readonly repo: EmailInboxRepository, private readonly onQueued?: () => void) {}

  async validateCredential(accountId: string) {
    const account = await this.repo.getAccountInternal(accountId);
    if (!account) throw new Error("Email account not found");
    return { externalName: account.emailAddress };
  }

  async configureWebhook(): Promise<void> {}

  async parseInbound(payload: unknown): Promise<InboundGatewayMessage | null> {
    const envelope = payload as EmailGatewayEnvelope;
    if (!envelope?.account?.id || !envelope?.thread?.id || !envelope?.inboundMessage?.id) return null;
    return emailEnvelopeToGatewayMessage(envelope);
  }

  async sendText(accountId: string, chatId: string, text: string, threadId?: string): Promise<string[]> {
    const account = await this.repo.getAccountInternal(accountId);
    if (!account || !threadId) throw new Error("Email account or thread is unavailable");
    const ctx = context(account);
    const thread = await this.repo.getThread(ctx, account.companyId, threadId);
    if (!thread) throw new Error("Email thread is unavailable");
    const messages = await this.repo.listMessages(ctx, account.companyId, thread.id);
    const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
    let policy = account.outboundPolicy;
    if (policy === "auto_send") {
      const quota = await this.repo.reserveSendQuota(account.companyId, account, chatId);
      if (!quota.allowed) policy = "approval_required";
    }
    const isDraft = policy !== "auto_send";
    const message = await this.repo.createMessage(ctx, account.companyId, {
      threadId: thread.id,
      emailAccountId: account.id,
      direction: "outbound",
      fromAddress: account.emailAddress,
      toAddresses: [chatId],
      subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
      bodyText: text,
      inReplyTo: latestInbound?.messageId || latestInbound?.id,
      attachments: [],
      deliveryStatus: "sending",
      isDraft,
      isAiGenerated: true,
    });
    const key = `${accountId}:${chatId}:${threadId}`;
    this.lastOutbound.set(key, message.id);
    await this.repo.updateThread(ctx, account.companyId, thread.id, {
      status: policy === "draft_only" ? "draft_ready" : policy === "approval_required" ? "waiting_approval" : "ai_processing",
    });
    if (!isDraft) {
      await this.repo.enqueueJob(ctx, account.companyId, {
        jobType: "send", emailAccountId: account.id, threadId: thread.id, messageId: message.id,
        payload: { source: "messaging_gateway" }, idempotencyKey: `send:${message.id}`,
      });
      setTimeout(() => this.onQueued?.(), 100).unref?.();
    }
    return [message.id];
  }

  async sendAttachment(accountId: string, chatId: string, attachment: GatewayOutboundAttachment, threadId?: string): Promise<void> {
    if (!threadId) return;
    const account = await this.repo.getAccountInternal(accountId);
    const messageId = this.lastOutbound.get(`${accountId}:${chatId}:${threadId}`);
    if (!account || !messageId) return;
    const ctx = context(account);
    const message = await this.repo.getMessage(ctx, account.companyId, messageId);
    if (!message) return;
    await this.repo.updateMessage(ctx, account.companyId, message.id, { attachments: [...message.attachments, {
      filename: attachment.name, contentType: attachment.mimeType,
      sizeBytes: Buffer.from(attachment.dataBase64, "base64").byteLength, contentBase64: attachment.dataBase64,
    }] });
  }
}
