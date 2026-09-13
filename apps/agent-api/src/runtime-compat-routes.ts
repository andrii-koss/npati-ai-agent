import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AIEngine, SpeechAudioFormat } from "@npati/omniroute-adapter";
import { AuthenticationError, type AuthProvider } from "./auth";
import { AdmissionError, type PriorityTier } from "./resilience-admission-queue";

type OllamaMessage = { role: "system" | "user" | "assistant"; content: string };

function ollamaError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: error.message });
  if (error instanceof AdmissionError) return reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000)))).code(error.code === "ADMISSION_CANCELLED" ? 499 : 429).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : "Runtime request failed";
  const status = /required|invalid|empty/i.test(message) ? 400 : 502;
  return reply.code(status).send({ error: message });
}

async function authorize(auth: AuthProvider, request: FastifyRequest) {
  const scope = await auth.authenticate(request);
  if (!scope.permissions.includes("chat:use")) throw new AuthenticationError("Missing permission: chat:use", 403, "FORBIDDEN");
  return scope;
}

function admissionFor(scope: Awaited<ReturnType<AuthProvider["authenticate"]>>) {
  const tier: PriorityTier = scope.permissions.includes("admin:all") ? "enterprise" : scope.permissions.includes("workspace:write") ? "pro" : "free";
  return { tenantId: scope.workspaceId, tier, queueTimeoutMs: 30_000 };
}

function digest(model: string) {
  return `sha256:${createHash("sha256").update(model).digest("hex")}`;
}

function ollamaPayload(model: string, content: string, chat: boolean) {
  return {
    model,
    created_at: new Date().toISOString(),
    ...(chat ? { message: { role: "assistant", content } } : { response: content }),
    done: true,
    done_reason: "stop",
  };
}

export function registerRuntimeCompatRoutes(app: FastifyInstance, ai: AIEngine, auth: AuthProvider) {
  app.get("/api/version", async (request, reply) => {
    try {
      await authorize(auth, request);
      return { version: "0.1.0", runtime: "NPATI via OmniRoute" };
    } catch (error) { return ollamaError(reply, error); }
  });

  app.get("/api/tags", async (request, reply) => {
    try {
      await authorize(auth, request);
      const models = await ai.listModels();
      return { models: models.map((model) => ({
        name: model.id,
        model: model.id,
        modified_at: new Date(0).toISOString(),
        size: 0,
        digest: digest(model.id),
        details: { format: "remote", family: model.id.split("/", 1)[0] || "omniroute", parameter_size: "unknown", quantization_level: "unknown" },
      })) };
    } catch (error) { return ollamaError(reply, error); }
  });

  app.post<{ Body: { model?: string; prompt?: string; system?: string; stream?: boolean } }>("/api/generate", async (request, reply) => {
    try {
      const scope = await authorize(auth, request);
      const model = request.body.model?.trim();
      const prompt = request.body.prompt?.trim();
      if (!model || !prompt) return reply.code(400).send({ error: "model and prompt are required" });
      const result = await ai.chat({ model, admission: admissionFor(scope), messages: [
        ...(request.body.system?.trim() ? [{ role: "system" as const, content: request.body.system.trim() }] : []),
        { role: "user", content: prompt },
      ] });
      const payload = ollamaPayload(result.model ?? model, result.content, false);
      return request.body.stream === false ? payload : reply.type("application/x-ndjson").send(`${JSON.stringify(payload)}\n`);
    } catch (error) { return ollamaError(reply, error); }
  });

  app.post<{ Body: { model?: string; messages?: OllamaMessage[]; stream?: boolean } }>("/api/chat", async (request, reply) => {
    try {
      const scope = await authorize(auth, request);
      const model = request.body.model?.trim();
      const messages = Array.isArray(request.body.messages)
        ? request.body.messages.filter((item) => item && ["system", "user", "assistant"].includes(item.role) && typeof item.content === "string")
        : [];
      if (!model || messages.length === 0) return reply.code(400).send({ error: "model and messages are required" });
      const result = await ai.chat({ model, messages, admission: admissionFor(scope) });
      const payload = ollamaPayload(result.model ?? model, result.content, true);
      return request.body.stream === false ? payload : reply.type("application/x-ndjson").send(`${JSON.stringify(payload)}\n`);
    } catch (error) { return ollamaError(reply, error); }
  });

  app.post<{ Body: { input?: string; text?: string; model?: string; voice?: string; response_format?: SpeechAudioFormat; format?: SpeechAudioFormat; speed?: number } }>("/audio/speech", async (request, reply) => {
    try {
      await authorize(auth, request);
      if (!ai.synthesizeSpeech) return reply.code(503).send({ error: { code: "TTS_UNAVAILABLE", message: "The configured AI runtime does not support text-to-speech." } });
      const text = (request.body.input ?? request.body.text ?? "").trim();
      if (!text) return reply.code(400).send({ error: { code: "TTS_INPUT_REQUIRED", message: "Text-to-speech input is required." } });
      if (text.length > 4_096) return reply.code(413).send({ error: { code: "TTS_INPUT_TOO_LARGE", message: "Text-to-speech input must be 4096 characters or fewer." } });
      const audio = await ai.synthesizeSpeech({
        text,
        model: request.body.model,
        voice: request.body.voice,
        format: request.body.response_format ?? request.body.format,
        speed: request.body.speed,
      });
      return reply
        .header("content-type", audio.mimeType)
        .header("content-disposition", `inline; filename="speech.${audio.format}"`)
        .header("x-npati-model", audio.model)
        .header("cache-control", "no-store")
        .send(Buffer.from(audio.data));
    } catch (error) { return ollamaError(reply, error); }
  });
}
