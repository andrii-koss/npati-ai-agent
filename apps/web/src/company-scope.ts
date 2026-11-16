import { readSettingsSnapshot, requestSettingsRead } from "./settings-page-cache";
import { getStoredAuthToken } from "./AuthContext";
export const ALL_COMPANIES = "all";

/** Bound cross-company reads so a large company catalog does not flood the API. */
export async function loadCompanyScopes<T>(ids: readonly string[], load: (id: string) => Promise<T>, options: {
  key?: string; onProgress?: (pages: T[]) => void; isActive?: () => boolean; initial?: T[];
} = {}): Promise<T[]> {
  const owner = getStoredAuthToken();
  const active = () => getStoredAuthToken() === owner && options.isActive?.() !== false;
  const results: T[] = options.initial?.slice() ?? new Array(ids.length);
  if (options.key) ids.forEach((id, index) => {
    const cached = readSettingsSnapshot<T>(`scope:${options.key}:${id}`);
    if (cached !== undefined && results[index] === undefined) results[index] = cached;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let emitted = false;
  const publish = () => { timer = undefined; if (active()) options.onProgress?.(results.filter(page => page !== undefined)); };
  const progress = () => {
    if (!options.onProgress) return;
    if (!emitted) { emitted = true; publish(); }
    else if (!timer) timer = setTimeout(publish, 16);
  };
  if (results.some(page => page !== undefined)) progress();
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length && active()) {
        const index = cursor++, id = ids[index]!;
        results[index] = options.key ? await requestSettingsRead(`scope:${options.key}:${id}`, () => load(id), false) : await load(id);
        progress();
      }
    }));
  } finally { clearTimeout(timer); publish(); }
  if (getStoredAuthToken() !== owner) throw new DOMException("Account changed during settings refresh", "AbortError");
  return results;
}
