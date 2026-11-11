import type { DevelopmentProcess } from "@npati/shared";

export const STREAMED_DEVELOPMENT_PROGRESS = "npati:streamed-development-progress";
export type StreamedDevelopmentSnapshot = { conversationId: string | null; processes: DevelopmentProcess[] };

/** Keep operation receipts intact for the existing development panel. */
export function developmentProcessSnapshot(value: unknown): DevelopmentProcess[] {
  if (!value || typeof value !== "object") return [];
  const envelope = value as Record<string, unknown>;
  if (envelope.routed !== "chat_development" || !Array.isArray(envelope.processes)) return [];
  return envelope.processes.filter((process): process is DevelopmentProcess => {
    if (!process || typeof process !== "object") return false;
    return ["id", "name", "companyId", "conversationId", "framework", "status", "createdAt", "updatedAt"]
      .every(key => typeof process[key] === "string");
  });
}

export function publishStreamedDevelopment(value: unknown, conversationId: string | null): void {
  const processes = developmentProcessSnapshot(value);
  if (!processes.length) return;
  window.dispatchEvent(new CustomEvent<StreamedDevelopmentSnapshot>(STREAMED_DEVELOPMENT_PROGRESS, {
    detail: { conversationId, processes },
  }));
}
