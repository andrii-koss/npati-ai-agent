import { describe, expect, it } from "vitest";
import { visionInferenceCandidates, confirmedVisionInferenceCandidates } from "../apps/agent-api/src/chat-inference-candidates";
import type { AIModelSummary } from "@npati/omniroute-adapter";

const model = (id: string, capabilities: string[]) => ({ id, providerId: id.split("/")[0], name: id, capabilities }) as AIModelSummary;
describe("coding chat image model selection", () => {
  it("uses a known vision model instead of an unknown configured default or text-only selection", () => {
    const added = [model("local/text", ["chat", "text"]), model("connected/vision", ["chat", "text", "vision"])];
    expect(visionInferenceCandidates(["local/text", "unknown/vision"], added)).toEqual(["connected/vision"]);
  });
  it("prefers the selected vision model and removes duplicates", () => {
    const added = [model("first/vision", ["chat", "vision"]), model("selected/vision", ["chat", "vision"])];
    expect(visionInferenceCandidates(["selected/vision", "selected/vision"], added)).toEqual(["selected/vision", "first/vision"]);
  });
  it("requires advertised image support", () => {
    expect(visionInferenceCandidates(["unknown/vision"], [model("local/text", ["chat", "text"])])).toEqual([]);
  });
});


it("rejects a stale stored vision flag when the live provider catalog says text only", async () => {
  const added = [model("deepseek/deepseek-flash", ["chat", "text", "vision"])];
  const calls: string[] = [];
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added, { models: async (provider, _added, refresh) => { expect(refresh).toBe(true); calls.push(provider); return [model(added[0]!.id, ["chat", "text"])]; } })).toEqual([]);
  expect(calls).toEqual(["deepseek"]);
});
it("fails closed on unavailable metadata and keeps a confirmed selected image model", async () => {
  const added = [model("connected/vision", ["chat", "vision"])];
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added, { models: async () => { throw Error("offline"); } })).toEqual([]);
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added, { models: async () => added })).toEqual([added[0]!.id]);
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added)).toEqual([]);
});

it("routes images to a confirmed vision model of a connected provider when no added model can see (A040)", async () => {
  const { resolveConfirmedVisionModel } = await import("../apps/agent-api/src/chat-inference-candidates");
  // The user's added models: DeepSeek with a stale vision claim and a text-only Ollama Cloud model.
  const added = [model("deepseek/deepseek-flash", ["chat", "text", "vision"]), model("ollama-cloud/gemma4:31b", ["chat", "text"])];
  const catalogs: Record<string, AIModelSummary[]> = {
    deepseek: [model("deepseek/deepseek-flash", ["chat", "text"])],
    "ollama-cloud": [model("ollama-cloud/gemma4:31b", ["chat", "text"]), model("ollama-cloud/minimax-m3", ["chat", "text", "vision"])],
  };
  const connected = new Set(["deepseek", "ollama-cloud"]);
  const catalog = {
    models: async (provider: string) => catalogs[provider] ?? [],
    provider: async (provider: string) => ({ connected: connected.has(provider) }),
  } as never;
  expect(await resolveConfirmedVisionModel(["deepseek/deepseek-flash"], added, catalog)).toBe("ollama-cloud/minimax-m3");
  connected.delete("ollama-cloud");
  expect(await resolveConfirmedVisionModel(["deepseek/deepseek-flash"], added, catalog)).toBeUndefined();
});

it("answers honestly instead of sending a photo to a text-only model when no vision model is confirmed", async () => {
  const { buildApp } = await import("../apps/agent-api/src/app");
  const { InMemoryWorkspaceStore } = await import("@npati/workspace");
  const { AIPreferencesStore } = await import("../apps/agent-api/src/ai-preferences");
  const store = new InMemoryWorkspaceStore();
  const auth = { userId: "vision-owner", workspaceId: "vision-ws", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
  await new AIPreferencesStore(store).add(auth, { id: "deepseek/deepseek-flash", name: "DeepSeek", providerId: "deepseek", capabilities: ["chat", "text", "vision"], added: true });
  const seen: unknown[] = [];
  const ai = {
    chat: async (request: { messages: unknown[] }) => { seen.push(request.messages); return { content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [] }) }; },
    async *stream(request: { messages: unknown[] }) { seen.push(request.messages); yield "I can see the photo."; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
  };
  const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }),
    models: async () => [model("deepseek/deepseek-flash", ["chat", "text"])], provider: async () => ({ connected: true }) };
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai as never, marketplace: marketplace as never });
  try {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "What is in this photo?", contextType: "none",
      attachments: [{ kind: "image", name: "photo.png", mimeType: "image/png", dataBase64: pixel }] } });
    expect(response.body).toContain("Working with photos needs a connected model that supports images");
    expect(JSON.stringify(seen)).not.toContain(pixel);
  } finally { await app.close(); }
}, 60_000);
