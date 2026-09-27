export type GatewayAttachment = { kind: "image" | "audio" | "document" | "file"; name: string; mimeType: string; dataBase64: string };
export type InboundGatewayMessage = {
  externalUserId: string; externalChatId: string; externalThreadId?: string; text: string;
  attachments: GatewayAttachment[]; messageId: string;
};

type TelegramFile = { file_id: string; file_name?: string; mime_type?: string };
type TelegramMessage = {
  message_id: number; message_thread_id?: number; text?: string; caption?: string;
  from?: { id: number; is_bot?: boolean }; chat: { id: number };
  photo?: Array<TelegramFile & { width: number; height: number; file_size?: number }>;
  document?: TelegramFile; audio?: TelegramFile; voice?: TelegramFile;
};
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage };

export interface MessagingAdapter {
  readonly channel: string;
  validateCredential(credential: string): Promise<{ externalName: string }>;
  configureWebhook(credential: string, webhookUrl: string, secretToken: string): Promise<void>;
  disconnect?(credential: string): Promise<void>;
  parseInbound(payload: unknown, credential: string): Promise<InboundGatewayMessage | null>;
  sendText(credential: string, chatId: string, text: string, threadId?: string): Promise<void>;
}

export class TelegramMessagingAdapter implements MessagingAdapter {
  readonly channel = "telegram";
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json() as { ok: boolean; result?: T; description?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram API ${method} failed`);
    return payload.result as T;
  }
  async validateCredential(token: string) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw new Error("Invalid Telegram bot token format");
    const bot = await this.call<{ username?: string; first_name: string }>(token.trim(), "getMe");
    return { externalName: bot.username ? `@${bot.username}` : bot.first_name };
  }
  async configureWebhook(token: string, webhookUrl: string, secretToken: string) {
    await this.call(token, "setWebhook", { url: webhookUrl, secret_token: secretToken, allowed_updates: ["message", "edited_message"], drop_pending_updates: false });
  }
  async disconnect(token: string) { await this.call(token, "deleteWebhook", { drop_pending_updates: true }); }
  private async download(token: string, file: TelegramFile, kind: GatewayAttachment["kind"], fallback: string): Promise<GatewayAttachment> {
    const metadata = await this.call<{ file_path: string }>(token, "getFile", { file_id: file.file_id });
    const response = await this.fetcher(`https://api.telegram.org/file/bot${token}/${metadata.file_path}`);
    if (!response.ok) throw new Error("Telegram file download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Telegram attachment exceeds the 20 MB limit");
    return { kind, name: file.file_name || fallback, mimeType: file.mime_type || (kind === "image" ? "image/jpeg" : "application/octet-stream"), dataBase64: bytes.toString("base64") };
  }
  async parseInbound(payload: unknown, token: string): Promise<InboundGatewayMessage | null> {
    const update = payload as TelegramUpdate; const message = update?.message ?? update?.edited_message;
    if (!message?.from || message.from.is_bot) return null;
    const attachments: GatewayAttachment[] = [];
    const photo = message.photo?.at(-1); if (photo) attachments.push(await this.download(token, photo, "image", `telegram-${message.message_id}.jpg`));
    if (message.document) attachments.push(await this.download(token, message.document, "document", `telegram-${message.message_id}.bin`));
    if (message.audio) attachments.push(await this.download(token, message.audio, "audio", message.audio.file_name || `telegram-${message.message_id}.mp3`));
    if (message.voice) attachments.push(await this.download(token, message.voice, "audio", `telegram-${message.message_id}.ogg`));
    return { externalUserId:String(message.from.id),externalChatId:String(message.chat.id),externalThreadId:message.message_thread_id == null ? undefined : String(message.message_thread_id),text:(message.text || message.caption || "").trim(),attachments,messageId:String(message.message_id) };
  }
  async sendText(token: string, chatId: string, text: string, threadId?: string) {
    const chunks = text.match(/[\s\S]{1,3900}/g) || [text];
    for (const chunk of chunks) await this.call(token, "sendMessage", { chat_id: chatId, text: chunk, ...(threadId ? { message_thread_id: Number(threadId) } : {}) });
  }
}

export class MessagingGateway {
  private readonly adapters = new Map<string, MessagingAdapter>();
  register(adapter: MessagingAdapter) { this.adapters.set(adapter.channel, adapter); return this; }
  adapter(channel: string) { const adapter=this.adapters.get(channel); if(!adapter)throw new Error(`Messaging adapter ${channel} is unavailable`); return adapter; }
}
