import { describe, expect, it } from "vitest";
import {
  TelegramChannelGateway,
  OllamaApiGateway,
  TextToSpeechEngine,
} from "../apps/agent-api/src/telegram-ollama-and-tts";

describe("Telegram Channel Gateway (Telegram)", () => {
  it("parses inbound Telegram updates and sends outbound messages", () => {
    const gateway = new TelegramChannelGateway();

    const update = {
      updateId: 1001,
      message: {
        messageId: 55,
        from: { id: 123456, username: "andrii_dev", firstName: "Andrii" },
        chat: { id: -100987654321, type: "supergroup", title: "NPATI Core" },
        text: "/start please help with agent setup",
      },
    };

    const parsed = gateway.parseInboundUpdate(update);
    expect(parsed).not.toBeNull();
    expect(parsed?.chatId).toBe(-100987654321);
    expect(parsed?.username).toBe("andrii_dev");
    expect(parsed?.threadKey).toBe("tg_-100987654321");
    expect(parsed?.hasVoice).toBe(false);

    // Send reply
    const reply = gateway.sendMessage(parsed!.chatId, "Hello from NPATI Agent!", {
      replyToMessageId: 55,
    });
    expect(reply.success).toBe(true);
    expect(gateway.getSentMessages(parsed!.chatId).length).toBe(1);
  });
});

describe("Ollama-Compatible API Gateway (Ollama-compatible API)", () => {
  it("provides tags, generate, and chat endpoints conforming to Ollama specs", () => {
    const gateway = new OllamaApiGateway();

    // /api/tags
    const tags = gateway.handleTags();
    expect(tags.models.length).toBeGreaterThanOrEqual(2);
    expect(tags.models[0]!.name).toBe("npati-agent:latest");
    expect(tags.models[0]!.details.format).toBe("gguf");

    // /api/generate
    const gen = gateway.handleGenerate({
      model: "npati-agent:latest",
      prompt: "Explain routing strategies",
    });
    expect(gen.done).toBe(true);
    expect(gen.response).toContain("Processed prompt");

    // /api/chat
    const chat = gateway.handleChat({
      model: "npati-agent:latest",
      messages: [{ role: "user", content: "Hello Ollama" }],
    });
    expect(chat.done).toBe(true);
    expect(chat.message.role).toBe("assistant");
    expect(chat.message.content).toContain("Reply to: \"Hello Ollama\"");
  });
});

describe("Text-to-Speech Engine (Text-to-Speech)", () => {
  it("synthesizes speech audio buffers with selected voice and format", () => {
    const tts = new TextToSpeechEngine();

    const res = tts.synthesizeSpeech({
      text: "Вітаємо у системі NPATI Agent. Усі сервіси працюють стабільно.",
      voice: "ukrainian-female",
      format: "opus",
      speed: 1.0,
    });

    expect(res.voice).toBe("ukrainian-female");
    expect(res.format).toBe("opus");
    expect(res.charactersProcessed).toBeGreaterThan(30);
    expect(res.durationEstimateSeconds).toBeGreaterThan(0);
    expect(res.audioBuffer.length).toBeGreaterThan(10);
  });
});
