import { getStoredAuthToken } from "./AuthContext";

const memory = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
const persistence = new Map<string, ReturnType<typeof setTimeout>>();
let identity: string | null | undefined;
let storagePrefix = "";
let epoch = 0;

function scope() {
  const token = getStoredAuthToken();
  if (identity !== token) {
    ++epoch;
    memory.clear(); pending.clear();
    for (const timer of persistence.values()) clearTimeout(timer);
    persistence.clear(); identity = token;
    let first = 2166136261, second = 5381;
    for (const character of token ?? "") { first = Math.imul(first ^ character.charCodeAt(0), 16777619); second = Math.imul(second, 33) ^ character.charCodeAt(0); }
    storagePrefix = `npati_settings_snapshot_v1_${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}_`;
  }
  return token;
}

export function readSettingsSnapshot<T>(key: string): T | undefined {
  if (!scope()) return undefined;
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = sessionStorage.getItem(storagePrefix + key);
    if (raw) { const value = JSON.parse(raw) as T; memory.set(key, value); return value; }
  } catch { /* Storage may be full or unavailable. */ }
  return undefined;
}

export function writeSettingsSnapshot<T>(key: string, value: T, persist = true) {
  if (!scope()) return;
  if (memory.size >= 256 && !memory.has(key)) memory.delete(memory.keys().next().value!);
  memory.set(key, value);
  if (!persist) return;
  clearTimeout(persistence.get(key));
  const prefix = storagePrefix, token = identity;
  persistence.set(key, setTimeout(() => {
    persistence.delete(key);
    if (getStoredAuthToken() !== token) return;
    try { const serialized = JSON.stringify(memory.get(key)); if (serialized.length < 1_000_000) sessionStorage.setItem(prefix + key, serialized); } catch { /* Keep the memory snapshot. */ }
  }, 150));
}

/** Share current reads; a completed read never prevents a later freshness check. */
export function requestSettingsRead<T>(key: string, load: () => Promise<T>, persist = true): Promise<T> {
  scope();
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const token = identity;
  const startedAt = epoch;
  const request = Promise.resolve().then(load).then(value => {
    if (getStoredAuthToken() === token && startedAt === epoch) writeSettingsSnapshot(key, value, persist);
    return value;
  }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

export function clearSettingsSnapshots() {
  scope(); ++epoch; memory.clear(); pending.clear();
  for (const timer of persistence.values()) clearTimeout(timer);
  persistence.clear();
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(storagePrefix)) sessionStorage.removeItem(key); } catch { /* Storage unavailable. */ }
}
