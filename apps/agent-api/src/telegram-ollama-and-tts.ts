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

export interface OllamaModelTag {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export interface TtsSynthesisResult {
  audioBuffer: Buffer;
  format: "mp3" | "opus" | "aac";
  durationEstimateSeconds: number;
  charactersProcessed: number;
  voice: string;
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

export class OllamaApiGateway {
  /**
   * 2. Ollama-Compatible API: Handlers for /api/tags, /api/generate, /api/chat
   */
  handleTags(): { models: OllamaModelTag[] } {
    return {
      models: [
        {
          name: "npati-agent:latest",
          modified_at: new Date().toISOString(),
          size: 4_200_000_000,
          digest: "sha256:npati7b8a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6",
          details: {
            format: "gguf",
            family: "llama",
            parameter_size: "7B",
            quantization_level: "Q4_K_M",
          },
        },
        {
          name: "npati-router:latest",
          modified_at: new Date().toISOString(),
          size: 1_800_000_000,
          digest: "sha256:omniroute3b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7",
          details: {
            format: "gguf",
            family: "qwen",
            parameter_size: "3B",
            quantization_level: "Q4_K_S",
          },
        },
      ],
    };
  }

  handleGenerate(request: { model: string; prompt: string }): {
    model: string;
    response: string;
    done: boolean;
    total_duration: number;
    eval_count: number;
  } {
    const generatedText = `[NPATI Ollama Gateway] Processed prompt: "${request.prompt.slice(0, 50)}..."`;
    return {
      model: request.model,
      response: generatedText,
      done: true,
      total_duration: 150_000_000, // 150ms in nanoseconds
      eval_count: Math.ceil(generatedText.length / 4),
    };
  }

  handleChat(request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }): {
    model: string;
    message: { role: string; content: string };
    done: boolean;
  } {
    const lastMsg = request.messages[request.messages.length - 1]?.content || "";
    return {
      model: request.model,
      message: {
        role: "assistant",
        content: `[NPATI Ollama Chat] Reply to: "${lastMsg.slice(0, 50)}"`,
      },
      done: true,
    };
  }
}

export class TextToSpeechEngine {
  /**
   * 3. Text-to-Speech (TTS): Synthesizes text responses to speech audio streams
   */
  synthesizeSpeech(params: {
    text: string;
    voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | "ukrainian-female";
    speed?: number;
    format?: "mp3" | "opus" | "aac";
  }): TtsSynthesisResult {
    const format = params.format ?? "mp3";
    const voice = params.voice ?? "alloy";
    const speed = params.speed ?? 1.0;

    // Simulated speech generation: ~15 characters per second
    const charsPerSecond = 15 * speed;
    const durationEstimateSeconds = Number(
      Math.max(1, params.text.length / charsPerSecond).toFixed(1)
    );

    // Create synthetic header + mock audio payload
    const mockAudio = Buffer.from(
      `ID3_SYNTHETIC_AUDIO_HEADER_VOICE_${voice}_FORMAT_${format}_CHARS_${params.text.length}`
    );

    return {
      audioBuffer: mockAudio,
      format,
      durationEstimateSeconds,
      charactersProcessed: params.text.length,
      voice,
    };
  }
}
