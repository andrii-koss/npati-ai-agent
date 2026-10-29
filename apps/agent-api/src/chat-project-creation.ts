import type { AuthContext } from "@npati/workspace";
import type { ChatDevelopmentService } from "./chat-development-service";
import type { ChatProjectIntentResolver } from "./chat-project-intent";

/** A fallback can mention several product kinds in a single-site specification; it cannot authorize a batch. */
export function isChatProjectCreationBatch(intent: Awaited<ReturnType<ChatProjectIntentResolver>> | undefined): boolean {
  return intent?.source === "semantic" && intent.targets.length > 1
    && !intent.decision.needsClarification && !intent.decision.unsupportedIntentMessage;
}

/** Adapt the existing multi-project service to one streamed chat turn, retaining its admission and policy checks. */
export async function runChatProjectCreation(input: {
  service: Pick<ChatDevelopmentService, "start" | "list" | "stop">;
  ctx: AuthContext; companyId: string; message: string; conversationId?: string; requestId: string;
  signal: AbortSignal; progress(processes: unknown[]): Promise<void>;
}) {
  const { service, ctx, signal } = input;
  signal.throwIfAborted();
  const started = await service.start(ctx, input);
  const ids = new Set(started.processes.map(process => process.id));
  const stop = async () => { await Promise.all(started.processes.map(process => service.stop(ctx, process.id))); };
  const abort = () => { void stop().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const processes = (await service.list(ctx)).filter(process => ids.has(process.id));
      await input.progress(processes);
      if (processes.length !== ids.size) throw new Error("Development process disappeared before completion");
      if (processes.every(process => !["running", "preparing", "queued", "stopping"].includes(process.status))) {
        return { ...started, processes, status: processes.every(process => process.status === "completed") ? "completed" : "failed" };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { signal.removeEventListener("abort", abort); }
}
