export interface TelegramUpdate {
  updateId: number;
  message?: {
    messageId: number;
    from: { id: number; username?: string; firstName?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    voice?: { fileId: string; duration: number };
    photo?: Array<{ fileId: string; width: number; height: number }>;
  };
  callbackQuery?: {
    id: string;
    from: { id: number; username?: string };
    data: string;
  };
}

export class TelegramChannelGateway {
  private readonly botToken: string;
  private readonly sentMessages: Array<{ chatId: number; text: string; options?: unknown }> = [];

  constructor(botToken = "simulated_tg_bot_token") {
    this.botToken = botToken;
  }

  /**
   * 1. Telegram Channel Gateway: Parses updates, routes threads, and sends outbound replies
   */
  parseInboundUpdate(update: TelegramUpdate): {
    chatId: number;
    userId: number;
    username?: string;
    text: string;
    hasVoice: boolean;
    hasPhoto: boolean;
    threadKey: string;
  } | null {
    if (!update.message) return null;

    const msg = update.message;
    const text = msg.text || "";
    const hasVoice = !!msg.voice;
    const hasPhoto = !!(msg.photo && msg.photo.length > 0);

    return {
      chatId: msg.chat.id,
      userId: msg.from.id,
      username: msg.from.username,
      text,
      hasVoice,
      hasPhoto,
      threadKey: `tg_${msg.chat.id}`,
    };
  }

  sendMessage(
    chatId: number,
    text: string,
    options?: { replyToMessageId?: number; parseMode?: "Markdown" | "HTML" }
  ): { success: boolean; messageId: number; chatId: number; text: string } {
    const record = { chatId, text, options };
    this.sentMessages.push(record);

    return {
      success: true,
      messageId: Math.floor(Math.random() * 100_000) + 1,
      chatId,
      text,
    };
  }

  getSentMessages(chatId?: number) {
    return chatId ? this.sentMessages.filter((m) => m.chatId === chatId) : this.sentMessages;
  }
}
