import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import type { AuthProvider } from "../apps/agent-api/src/auth";
import type { AIEngine, ChatRequest } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function runtime() {
  const authProvider: AuthProvider = { authenticate: async () => ({
    workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:read", "workspace:write", "chat:use"],
  }) };
  const aiEngine = {
    chat: async (request: ChatRequest) => ({ content: `Reply: ${String(request.messages.at(-1)?.content)}`, model: request.model }),
    stream: async function* () { yield "ok"; },
    listModels: async () => [{ id: "openai/gpt-test", name: "GPT Test" }],
    getModel: async () => undefined,
    executeTool: async () => ({}),
    synthesizeSpeech: async () => ({ data: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), mimeType: "audio/mpeg", model: "openai/tts-1", voice: "alloy", format: "mp3" as const }),
    searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat", "audio.speech"], healthCheck: async () => ({ status: "ok" as const }),
  } satisfies AIEngine;
  const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as never;
  const app = buildApp({ workspaceStore: new InMemoryWorkspaceStore(), authProvider, aiEngine, marketplace });
  apps.push(app);
  return app;
}

describe("production runtime capabilities #8-#15", () => {
  it("exposes authenticated Ollama model, generate, chat and version contracts", async () => {
    const app = runtime();
    expect((await app.inject({ method: "GET", url: "/api/version" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/tags" })).json().models[0]).toMatchObject({ name: "openai/gpt-test", model: "openai/gpt-test" });
    const generated = await app.inject({ method: "POST", url: "/api/generate", payload: { model: "openai/gpt-test", prompt: "hello", stream: false } });
    expect(generated.json()).toMatchObject({ model: "openai/gpt-test", response: "Reply: hello", done: true });
    const chat = await app.inject({ method: "POST", url: "/api/chat", payload: { model: "openai/gpt-test", messages: [{ role: "user", content: "hello" }] } });
    expect(chat.headers["content-type"]).toContain("application/x-ndjson");
    expect(JSON.parse(chat.body.trim())).toMatchObject({ message: { role: "assistant", content: "Reply: hello" }, done: true });
  });

  it("returns real runtime TTS bytes instead of a synthetic placeholder", async () => {
    const response = await runtime().inject({ method: "POST", url: "/audio/speech", payload: { input: "Hello", model: "openai/tts-1", format: "mp3" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/mpeg");
    expect(response.rawPayload).toEqual(Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]));
  });

  it("has WebChat transport, a dashboard compatibility redirect, and speech controls", async () => {
    const source = await readFile(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain('path="/chat"');
    expect(source).toContain('path="/settings/dashboard" element={<Navigate to="/settings/connections" replace />}');
    const attachments = await readFile(new URL("../apps/web/src/ChatAttachments.tsx", import.meta.url), "utf8");
    const voices = await readFile(new URL("../apps/web/src/speech-voices.ts", import.meta.url), "utf8");
    expect(attachments).toContain('aria-label="Speech voice"');
    expect(attachments).toContain('SPEECH_VOICES.map');
    expect(voices).toContain('{ id: "nova"');
    const api = await readFile(new URL("../apps/agent-api/src/app.ts", import.meta.url), "utf8");
    expect(api).toContain('"/chat/stream"');
  });
});
