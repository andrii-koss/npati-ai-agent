import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import catalog from "../../../../../packages/omniroute-adapter/src/generated/provider-catalog.json";
import { descriptionMessages, describeProvider } from "./index";
import { providerProfiles } from "./profiles";
import { en } from "./en";
import type { SupportedLanguage } from "../types";
import { getLocalizedProviderDescription } from "../providerDescriptions";

describe("provider-specific marketplace descriptions", () => {
  it("covers every pinned provider explicitly and keeps each description unique", () => {
    expect(Object.keys(providerProfiles).sort()).toEqual(catalog.providers.map(p => p.id).sort());
    for (const language of Object.keys(descriptionMessages) as SupportedLanguage[]) {
      const descriptions = catalog.providers.map(provider => describeProvider(provider, language));
      expect(new Set(descriptions).size, language).toBe(catalog.providers.length);
      for (const description of descriptions) {
        expect(description).not.toMatch(/available through|registry|\{(?:models|host)\}|undefined|\$|\d+[,.]?\d*\s*(?:RPM|TPM|RPD)|[\u2013\u2014]/i);
      }
    }
  });

  it("translates every description segment and preserves placeholders in all sixteen languages", () => {
    expect(Object.keys(descriptionMessages)).toHaveLength(16);
    for (const [language, messages] of Object.entries(descriptionMessages)) {
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(messages[key].trim(), `${language}.${key}`).toBeTruthy();
        expect(messages[key].match(/\{\w+\}/g) ?? []).toEqual(en[key].match(/\{\w+\}/g) ?? []);
        if (language !== "en") expect(messages[key], `${language}.${key}`).not.toBe(en[key]);
      }
    }
  });

  it("describes each service's purpose rather than labeling every integration as a chat model", () => {
    const cases = { "adobe-firefly": /Image and video/, assemblyai: /transcription/, "aws-polly": /Speech synthesis/,
      "voyage-ai": /semantic search/, typesafe: /Model evaluation/, "anysearch-search": /Web search/,
      "ollama-local": /own machine/, "azure-openai": /Azure resource/, bedrock: /AWS region/ };
    for (const [id, expected] of Object.entries(cases)) {
      expect(describeProvider({ id, name: id }, "en")).toMatch(expected);
    }
  });

  it("uses current connection metadata instead of assuming that every provider requires an API key", () => {
    const provider = { id: "anysearch-search", name: "AnySearch", authType: "none", connectionMode: "no_auth" };
    expect(describeProvider(provider, "en")).toContain("without a stored API key");
    expect(describeProvider({ id: "openai", name: "OpenAI", authType: "oauth" }, "en")).toContain("signing in");
  });

  it("provides translated capability-based descriptions for future and custom providers", () => {
    expect(describeProvider({ id: "custom-search", name: "Custom Search", capabilities: ["search"], authType: "api_key" }, "uk"))
      .toBe("Custom Search: Вебпошук актуальної інформації. Підключення за API-ключем провайдера.");
    expect(describeProvider({ id: "__proto__", name: "Custom", local: true }, "en")).toContain("your own machine");
  });

  it("never falls back to the registry placeholder even when the old translator returns it", () => {
    expect(getLocalizedProviderDescription({ id: "azure-openai", name: "Azure OpenAI" }, () => "AI provider available through the Npati registry.", "zh"))
      .not.toContain("registry");
  });

  it("keeps every description source file within 800 lines", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const name of readdirSync(directory)) {
      if (name.endsWith(".ts")) expect(readFileSync(join(directory, name), "utf8").trimEnd().split(/\r?\n/).length, name).toBeLessThanOrEqual(800);
    }
    expect(readFileSync(join(directory, "../providerDescriptions.ts"), "utf8").trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(800);
  });
});
