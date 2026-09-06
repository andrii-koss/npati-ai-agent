import { describe, expect, it } from "vitest";
import { ToolSandboxRunner } from "../apps/agent-api/src/tool-sandbox";
import { FormatTranslator, type OpenAiMessage } from "../apps/agent-api/src/format-translator";

describe("Tool Sandboxing & Host Separation (ToolSandboxRunner)", () => {
  it("executes safe commands in an isolated temp directory", async () => {
    const runner = new ToolSandboxRunner({ defaultTimeoutMs: 5000 });
    const result = await runner.executeInSandbox("node", ["-e", "console.log('Hello from sandbox');"]);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe("Hello from sandbox");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("sanitizes host environment and removes sensitive variables", () => {
    process.env.POSTGRES_PASSWORD = "secret_db_password_123";
    process.env.NPATI_ENCRYPTION_KEY = "super_secret_master_key";
    process.env.SAFE_CUSTOM_VAR = "public_data";

    const safeEnv = ToolSandboxRunner.sanitizeEnvironment({ INJECTED_KEY: "allowed_val" });

    expect(safeEnv.POSTGRES_PASSWORD).toBeUndefined();
    expect(safeEnv.NPATI_ENCRYPTION_KEY).toBeUndefined();
    expect(safeEnv.INJECTED_KEY).toBe("allowed_val");
  });

  it("detects and blocks dangerous system patterns", () => {
    const check1 = ToolSandboxRunner.validateSafety("rm", ["-rf", "/"]);
    expect(check1.safe).toBe(false);
    expect(check1.violations.length).toBeGreaterThan(0);

    const check2 = ToolSandboxRunner.validateSafety("cat", [".env"]);
    expect(check2.safe).toBe(false);
  });
});

describe("Format Translator (FormatTranslator)", () => {
  it("translates OpenAI Chat to Anthropic Messages format", () => {
    const openaiMsgs: OpenAiMessage[] = [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "Write a quicksort function." },
      { role: "assistant", content: "Here is the code." },
      { role: "tool", name: "linter", content: "No lint errors found." },
    ];

    const anthropicReq = FormatTranslator.openaiToAnthropic(openaiMsgs);

    expect(anthropicReq.system).toBe("You are a helpful coding assistant.");
    expect(anthropicReq.messages.length).toBe(3);
    expect(anthropicReq.messages[0]).toEqual({ role: "user", content: "Write a quicksort function." });
    expect(anthropicReq.messages[1]).toEqual({ role: "assistant", content: "Here is the code." });
    expect(anthropicReq.messages[2].content).toContain("[Tool Output: linter]");

    // Translate back to OpenAI
    const backToOpenai = FormatTranslator.anthropicToOpenai(anthropicReq);
    expect(backToOpenai[0].role).toBe("system");
    expect(backToOpenai[0].content).toBe("You are a helpful coding assistant.");
  });

  it("translates OpenAI Chat to Google Gemini format and normalizes responses", () => {
    const openaiMsgs: OpenAiMessage[] = [
      { role: "system", content: "You are an analytical agent." },
      { role: "user", content: "Explain quantum computing." },
    ];

    const geminiReq = FormatTranslator.openaiToGemini(openaiMsgs);

    expect(geminiReq.systemInstruction?.parts[0].text).toBe("You are an analytical agent.");
    expect(geminiReq.contents[0].role).toBe("user");
    expect(geminiReq.contents[0].parts[0].text).toBe("Explain quantum computing.");

    // Normalize Gemini response to OpenAI Chat format
    const geminiResp = {
      candidates: [
        {
          content: { parts: [{ text: "Quantum computing uses qubits." }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 20,
        totalTokenCount: 35,
      },
    };

    const openaiNormalized = FormatTranslator.geminiToOpenaiResponse(geminiResp, "gemini-2.5-flash");

    expect(openaiNormalized.object).toBe("chat.completion");
    expect(openaiNormalized.model).toBe("gemini-2.5-flash");
    expect(openaiNormalized.choices[0].message.content).toBe("Quantum computing uses qubits.");
    expect(openaiNormalized.usage.total_tokens).toBe(35);
  });
});
