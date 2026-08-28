import { filterProviders, normalizeCatalog, normalizeModels, PINNED_PROVIDER_CATALOG } from "@npati/omniroute-adapter";
import { describe, expect, it } from "vitest";

const manifest = [
  { id: "openai", auth: { type: "apikey" }, models: [{ id: "gpt-5", name: "GPT 5", supportsReasoning: true }] },
  { id: "opencode", auth: { type: "none" }, models: [{ id: "claude-free", name: "Claude Free" }] },
];
const connection = [{ id: "connection-1", providerId: "openai", active: true, status: "connected" as const, healthy: true }];

describe("AI marketplace normalization", () => {
  it("1. loads the provider catalog from the pinned OmniRoute registry", () => {
    expect(PINNED_PROVIDER_CATALOG.sourceVersion).toBe("v3.8.50");
    expect(PINNED_PROVIDER_CATALOG.providers).toHaveLength(352);
  });

  it("2. normalizes provider auth, model counts, and capabilities", () => {
    const openai = normalizeCatalog(manifest, connection).find((provider) => provider.id === "openai");
    expect(openai).toMatchObject({ authType: "api_key", modelCount: 1, capabilities: expect.arrayContaining(["text", "reasoning"]) });
  });

  it("3. filters connected providers", () => {
    const providers = normalizeCatalog(manifest, connection);
    expect(filterProviders(providers, manifest, { tab: "connected" }).map((provider) => provider.id)).toEqual(["openai"]);
  });

  it("4. filters only providers with actual free metadata", () => {
    const providers = normalizeCatalog(manifest, connection);
    const free = filterProviders(providers, manifest, { tab: "free" });
    expect(free.some((provider) => provider.id === "opencode" && provider.freeStatus === "free")).toBe(true);
    expect(free.some((provider) => provider.id === "openai")).toBe(false);
  });

  it("5. filters the actual local provider category", () => {
    const local = filterProviders(normalizeCatalog(manifest, connection), manifest, { tab: "local" });
    expect(local).toHaveLength(14);
    expect(local.map((provider) => provider.id)).toContain("ollama-local");
  });

  it("6. keeps the full registry for All", () => {
    expect(filterProviders(normalizeCatalog(manifest, connection), manifest, { tab: "all" })).toHaveLength(352);
  });

  it("7. searches by provider and model metadata", () => {
    const providers = normalizeCatalog(manifest, connection);
    expect(filterProviders(providers, manifest, { search: "Claude Free" }).map((provider) => provider.id)).toEqual(["opencode"]);
    expect(filterProviders(providers, manifest, { search: "openai" }).some((provider) => provider.id === "openai")).toBe(true);
  });

  it("8. builds safe provider details and globally unique model ids", () => {
    const provider = normalizeCatalog(manifest, connection).find((item) => item.id === "openai")!;
    const models = normalizeModels(provider, manifest[0]!.models!, new Set(["openai/gpt-5"]));
    expect(provider.connections[0]).not.toHaveProperty("apiKey");
    expect(models[0]).toMatchObject({ id: "openai/gpt-5", upstreamId: "gpt-5", added: true });
  });
});
