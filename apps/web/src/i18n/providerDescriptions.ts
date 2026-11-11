import type { SupportedLanguage } from "./types";
import { describeProvider, type DescriptionProvider } from "./provider-descriptions";

/** Provider cards use the same descriptive facts in all sixteen languages. */
export function getLocalizedProviderDescription(
  provider: DescriptionProvider,
  _t: (key: any) => string,
  language: SupportedLanguage,
): string {
  return describeProvider(provider, language);
}
