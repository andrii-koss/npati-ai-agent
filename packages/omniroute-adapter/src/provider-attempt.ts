import type { ChatRequest } from "./types";
export async function observeProviderAttempt(request: ChatRequest, event: Parameters<NonNullable<ChatRequest["onProviderAttempt"]>>[0]) {
  try { await request.onProviderAttempt?.(event); } catch { /* Monitoring never changes inference. */ }
}
