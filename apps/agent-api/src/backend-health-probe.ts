/* Core backend health probing helpers.
 * Extracted verbatim from app.ts (step 2a of docs/refactoring/PLAN.md).
 */
import { ServiceHealth } from "@npati/shared";

export function publicServiceEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const endpoint = new URL(value);
    endpoint.username = "";
    endpoint.password = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function coreBackendProbeUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/api/v1")) return `${base}/users/me`;
  if (base.endsWith("/api")) return `${base}/v1/users/me`;
  return `${base}/api/v1/users/me`;
}

export async function defaultCoreBackendHealthCheck(baseUrl: string | undefined): Promise<ServiceHealth> {
  const endpoint = publicServiceEndpoint(baseUrl);
  if (!baseUrl) return { status: "not_configured", detail: "NPATI Core Backend URL is not configured" };
  try {
    const response = await fetch(coreBackendProbeUrl(baseUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    // Authentication endpoints normally answer 401 without a token. A 404 can
    // mean that NPATI_BACKEND_URL points at a reachable host but not the Core API.
    if (response.status === 404 || response.status === 429 || response.status >= 500) {
      return { status: "degraded", detail: `Core API returned HTTP ${response.status}`, endpoint };
    }
    return { status: "ok", detail: `Core API reachable (HTTP ${response.status})`, endpoint };
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : "Core API request failed", endpoint };
  }
}

export async function withHealthTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Health check timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

