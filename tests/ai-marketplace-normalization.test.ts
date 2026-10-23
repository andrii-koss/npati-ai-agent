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

  it("3a. does not report a provider whose every connection is disabled as connected", () => {
    const disabled = [{ ...connection[0], active: false }];
    const providers = normalizeCatalog(manifest, disabled);
    const openai = providers.find((provider) => provider.id === "openai");
    expect(openai).toMatchObject({ connected: false, connectionStatus: "not_connected", availability: "requires_credentials" });
    expect(openai?.availabilityReason).toMatch(/disabled/);
    expect(openai?.connections).toHaveLength(1);
    expect(filterProviders(providers, manifest, { tab: "connected" }).map((provider) => provider.id)).not.toContain("openai");
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

  it("9. routes embedded services to service setup instead of generic connect", () => {
    const provider = normalizeCatalog(manifest, connection).find((item) => item.id === "9router");
    expect(provider).toMatchObject({ connectionMode: "embedded_service", availability: "requires_service", connectable: false });
  });

  it("10. keeps verified no-auth adapters connectable", () => {
    const provider = normalizeCatalog(manifest, connection).find((item) => item.id === "opencode");
    expect(provider).toMatchObject({ connectionMode: "no_auth", availability: "ready", connectable: true });
  });

  it("11. does not offer a generic connection for unavailable no-auth adapters", () => {
    const runtimeManifest = [...manifest, { id: "chipotle", auth: { type: "none" }, models: [] }];
    const provider = normalizeCatalog(runtimeManifest, connection).find((item) => item.id === "chipotle");
    expect(provider).toMatchObject({ connectionMode: "no_auth", availability: "unavailable", connectable: false });
  });

  it("12. identifies local CLI providers without exposing the API-key form", () => {
    const runtimeManifest = [...manifest, { id: "auggie", auth: { type: "none" }, models: [] }];
    const provider = normalizeCatalog(runtimeManifest, connection).find((item) => item.id === "auggie");
    expect(provider).toMatchObject({ connectionMode: "local_cli", availability: "requires_local_runtime", connectable: false });
  });

  it("13. keeps catalog-backed media providers connectable outside the chat plugin manifest", () => {
    const provider = normalizeCatalog(manifest, connection).find((item) => item.id === "adobe-firefly");
    expect(provider).toMatchObject({
      connectionMode: "web_session",
      availability: "requires_login",
      connectable: true,
    });
  });

  it("14. hides providers without a supported setup flow while preserving connected providers", () => {
    const providers = normalizeCatalog(manifest, connection);
    const visible = filterProviders(providers, manifest, { connectableOnly: true });
    expect(visible.map((provider) => provider.id)).toContain("openai");
    expect(visible.map((provider) => provider.id)).toContain("opencode");
    expect(visible.map((provider) => provider.id)).toContain("agy");
    expect(visible.map((provider) => provider.id)).not.toContain("adobe-firefly");
    expect(visible.map((provider) => provider.id)).not.toContain("9router");
    expect(visible.map((provider) => provider.id)).not.toContain("auggie");
  });

  it("15. places popular providers first in All before pagination", () => {
    const visible = filterProviders(normalizeCatalog(manifest, connection), manifest, { tab: "all", connectableOnly: true });
    expect(visible.slice(0, 8).map((provider) => provider.id)).toEqual([
      "openai", "anthropic", "gemini", "xai", "openrouter", "groq", "mistral", "deepseek",
    ]);
  });
});
