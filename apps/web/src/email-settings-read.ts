import { mergeEmailAnalytics } from "./email-company-scope";
import { api, type Agent, type Company, type EmailAccount, type EmailAnalytics } from "./email-settings-types";
import { readSettingsSnapshot, removeSettingsSnapshot, requestSettingsRead } from "./settings-page-cache";

type EmailSettingsSnapshot = {
  companies: Company[];
  accounts: EmailAccount[];
  agents: Agent[];
  analytics: EmailAnalytics | null;
};

const key = (scope: string) => `email-settings:open:${scope}`;

export function readCachedEmailSettings(scope: string) {
  return readSettingsSnapshot<EmailSettingsSnapshot>(key(scope));
}

export function invalidateEmailSettings(scope: string) {
  removeSettingsSnapshot(key("all"));
  if (scope !== "all") removeSettingsSnapshot(key(scope));
}

export function readEmailSettings(scope: string) {
  return requestSettingsRead(key(scope), async () => {
    const params = scope === "all" ? "" : `?${new URLSearchParams({ company: scope })}`;
    const data = await api<Omit<EmailSettingsSnapshot, "analytics"> & { analytics: EmailAnalytics[] }>(`/email/settings/open${params}`);
    return { ...data, analytics: scope === "all" ? mergeEmailAnalytics(data.analytics) : data.analytics[0] ?? null };
  });
}
