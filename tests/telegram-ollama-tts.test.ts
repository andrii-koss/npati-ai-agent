import { describe, expect, it } from "vitest";
import { TelegramChannelGateway } from "../apps/agent-api/src/telegram-ollama-and-tts";

describe("Telegram Channel Gateway (Telegram)", () => {
  it("parses inbound Telegram updates and sends outbound messages", () => {
    const gateway = new TelegramChannelGateway();
    const parsed = gateway.parseInboundUpdate({
      updateId: 1001,
      message: {
        messageId: 55,
        from: { id: 123456, username: "andrii_dev", firstName: "Andrii" },
        chat: { id: -100987654321, type: "supergroup", title: "NPATI Core" },
        text: "/start please help with agent setup",
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.chatId).toBe(-100987654321);
    expect(parsed?.threadKey).toBe("tg_-100987654321");
    const reply = gateway.sendMessage(parsed!.chatId, "Hello from NPATI Agent!", { replyToMessageId: 55 });
    expect(reply.success).toBe(true);
    expect(gateway.getSentMessages(parsed!.chatId)).toHaveLength(1);
  });
});
