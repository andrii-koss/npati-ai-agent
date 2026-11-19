import { requestSettingsRead } from "./settings-page-cache";
import { getStoredAuthToken } from "./AuthContext";

type Consumer = "page" | "workspace";

export function createSettingsRecordsOpener<Data>(scopeKey: (businessId?: string) => string, load: (businessId?: string) => Promise<Data>) {
  let opening: { token: string | null; key: string; consumer: Consumer; request: Promise<Data> } | undefined;
  return (businessId?: string, consumer: Consumer = "page") => {
    const token = getStoredAuthToken();
    const key = scopeKey(businessId);
    // The lazy route and the workspace may mount at different times during auth restoration.
    if (opening?.token === token && opening.key === key && opening.consumer !== consumer) {
      const { request } = opening;
      opening = undefined;
      return request;
    }
    const request = requestSettingsRead(key, () => load(businessId));
    opening = { token, key, consumer, request };
    return request;
  };
}
