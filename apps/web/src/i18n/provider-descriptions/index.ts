import type { SupportedLanguage } from "../types";
import { en, type DescriptionMessages } from "./en";
import { uk } from "./uk";
import { de } from "./de";
import { fr } from "./fr";
import { es } from "./es";
import { it } from "./it";
import { pl } from "./pl";
import { pt } from "./pt";
import { nl } from "./nl";
import { tr } from "./tr";
import { ru } from "./ru";
import { zh } from "./zh";
import { ja } from "./ja";
import { ko } from "./ko";
import { ar } from "./ar";
import { hi } from "./hi";
import { providerProfiles, type ProviderProfile } from "./profiles";

export const descriptionMessages: Record<SupportedLanguage, DescriptionMessages> = {
  en, uk, de, fr, es, it, pl, pt, nl, tr, ru, zh, ja, ko, ar, hi,
};

export interface DescriptionProvider {
  id: string;
  name: string;
  description?: string;
  authHint?: string;
  category?: string;
  authType?: string;
  connectionMode?: string;
  local?: boolean;
  website?: string;
  capabilities?: string[];
}

function connection(provider: DescriptionProvider, profile: ProviderProfile): keyof DescriptionMessages {
  if (profile.connection === "cliLogin") return "cliLogin";
  if (provider.local || provider.connectionMode === "local") return "localRuntime";
  if (provider.connectionMode === "web_session" || provider.authType === "web_session") return "webSession";
  if (provider.connectionMode === "oauth" || provider.authType === "oauth") return "oauth";
  if (provider.connectionMode === "no_auth" || provider.authType === "none") return "none";
  if (provider.connectionMode === "local_cli") return "cliLogin";
  if (provider.connectionMode === "cloud_agent") return "cloudLogin";
  if (provider.authType === "api_key") return "apiKey";
  return profile.connection;
}

/** New/custom providers get useful capability and connection text, never a registry placeholder. */
function customProfile(provider: DescriptionProvider): ProviderProfile {
  const capabilities = provider.capabilities ?? [];
  const has = (...values: string[]) => values.some(value => capabilities.includes(value));
  const focus = provider.local ? "local"
    : has("webSearch", "search") ? "search"
    : has("webFetch", "fetch") ? "fetch"
    : has("embedding", "embeddings", "rerank") ? "embedding"
    : has("image", "textToImage") ? "image"
    : has("video", "textToVideo") ? "video"
    : has("audio", "speech") ? "voice" : "llm";
  let host: string | undefined;
  try { host = new URL(provider.website ?? "").hostname.replace(/^www\./, ""); } catch { /* Optional website. */ }
  return { name: provider.name, focus, connection: "configured", ...(host ? { host } : {}) };
}

export function describeProvider(provider: DescriptionProvider, language: SupportedLanguage): string {
  const messages = descriptionMessages[language];
  const profile = Object.hasOwn(providerProfiles, provider.id.toLowerCase())
    ? providerProfiles[provider.id.toLowerCase()]! : customProfile(provider);
  const parts = [messages[profile.focus]];
  if (profile.models && ["llm", "hosted", "gateway", "coding", "local", "vision", "web"].includes(profile.focus)) {
    parts.push(messages.models.replace("{models}", profile.models));
  }
  if (profile.focus !== "automatic") parts.push(messages[connection(provider, profile)]);
  // A provider's actual service address distinguishes otherwise similar API integrations.
  if (profile.host && !profile.models) parts.push(messages.site.replace("{host}", profile.host));
  return `${profile.name}: ${parts.join(" ")}`.replace(/[\u2013\u2014]/g, "-");
}
