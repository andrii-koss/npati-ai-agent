export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicRequest {
  system?: string;
  messages: AnthropicMessage[];
}

export interface GeminiContentPart {
  text: string;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiContentPart[];
}

export interface GeminiRequest {
  systemInstruction?: { parts: GeminiContentPart[] };
  contents: GeminiContent[];
}

export class FormatTranslator {
  /**
   * Translate OpenAI Chat messages to Anthropic Messages format
   */
  static openaiToAnthropic(messages: OpenAiMessage[]): AnthropicRequest {
    const systemParts: string[] = [];
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else if (msg.role === "user") {
        anthropicMessages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        anthropicMessages.push({ role: "assistant", content: msg.content });
      } else if (msg.role === "tool") {
        // Embed tool outputs into user role block for Anthropic
        anthropicMessages.push({ role: "user", content: `[Tool Output: ${msg.name || "tool"}]: ${msg.content}` });
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: anthropicMessages,
    };
  }

  /**
   * Translate Anthropic Messages request back to OpenAI Chat messages
   */
  static anthropicToOpenai(req: AnthropicRequest): OpenAiMessage[] {
    const openaiMessages: OpenAiMessage[] = [];

    if (req.system) {
      openaiMessages.push({ role: "system", content: req.system });
    }

    for (const msg of req.messages) {
      openaiMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }

    return openaiMessages;
  }

  /**
   * Translate OpenAI Chat messages to Google Gemini format
   */
  static openaiToGemini(messages: OpenAiMessage[]): GeminiRequest {
    const systemParts: string[] = [];
    const geminiContents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else if (msg.role === "user" || msg.role === "tool") {
        geminiContents.push({
          role: "user",
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === "assistant") {
        geminiContents.push({
          role: "model",
          parts: [{ text: msg.content }],
        });
      }
    }

    return {
      systemInstruction: systemParts.length > 0 ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined,
      contents: geminiContents,
    };
  }

  /**
   * Normalize a Gemini response payload into OpenAI Chat completion format
   */
  static geminiToOpenaiResponse(geminiResp: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  }, model = "gemini-2.5-flash"): {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
      index: number;
      message: { role: "assistant"; content: string };
      finish_reason: string;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  } {
    const candidate = geminiResp.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";
    const finishReason = candidate?.finishReason?.toLowerCase() || "stop";

    return {
      id: `chatcmpl_gemini_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: geminiResp.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: geminiResp.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: geminiResp.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }
}
