import type { ActiveSessionRegistry } from "./distributed-session-registry";

type StreamOwner = { workspaceId: string; userId: string };
/** `onUserStop`: the explicit Stop of this stream also stops the work it started (a background code run). */
type StreamRecord = StreamOwner & { controller: AbortController; onUserStop?: () => void };

export class ChatStreamLeaseError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Chat coordination timed out")), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * "Stop generating" is an explicit Stop of the work this stream started, not a disconnect: a background code run
 * outlives a closed tab by design, but must stop when the user stops it. Returns whether that Stop has happened, so
 * the run stops at its next boundary even before its own controller is registered.
 */
export function bindChatStreamUserStop(activeStreams: Map<string, StreamRecord>, streamId: string | undefined, controller: AbortController, stop: () => void): () => boolean {
  let stopped = false;
  const record = streamId ? activeStreams.get(streamId) : undefined;
  if (record?.controller === controller) record.onUserStop = () => { stopped = true; stop(); };
  return () => stopped;
}

/** Reserve identity before provider work or project mutations, across API replicas. */
export async function reserveChatStream(input: {
  owner: StreamOwner; streamId?: string; controller: AbortController;
  activeStreams: Map<string, StreamRecord>; registry: ActiveSessionRegistry;
}): Promise<() => Promise<void>> {
  const { owner, streamId, controller, activeStreams, registry } = input;
  if (!streamId) return async () => undefined;
  const conflict = () => new ChatStreamLeaseError("STREAM_ALREADY_ACTIVE", 409, "This chat stream is already active.");
  if (activeStreams.has(streamId)) throw conflict();
  activeStreams.set(streamId, { ...owner, controller });
  const removeLocal = () => { if (activeStreams.get(streamId)?.controller === controller) activeStreams.delete(streamId); };
  let accepting = true;
  const pending = Promise.resolve().then(() => registry.acquire(owner.workspaceId, owner.userId, "chat:" + streamId, 45));
  // An acquisition finishing after our deadline must not leave a ghost reservation.
  void pending.then(lease => {
    if (!accepting && lease) return bounded(registry.release(owner.workspaceId, owner.userId, lease)).catch(() => undefined);
  }, () => undefined);
  let lease;
  try {
    lease = await bounded(pending);
    if (!lease) throw conflict();
    if (controller.signal.aborted) {
      await bounded(registry.release(owner.workspaceId, owner.userId, lease)).catch(() => undefined);
      throw controller.signal.reason ?? new Error("Chat cancelled");
    }
  } catch (error) {
    accepting = false;
    removeLocal();
    if (error instanceof ChatStreamLeaseError || controller.signal.aborted) throw error;
    throw new ChatStreamLeaseError("CHAT_LEASE_UNAVAILABLE", 503, "Chat session coordination is unavailable. Retry this request.");
  }

  let released = false, renewing = false;
  const heartbeat = setInterval(() => {
    if (released || renewing) return;
    renewing = true;
    void bounded(registry.renew(owner.workspaceId, owner.userId, lease, 45))
      .then(owned => { if (!released && !owned) controller.abort(new ChatStreamLeaseError("CHAT_LEASE_LOST", 503, "Chat session lease was lost.")); })
      .catch(() => { if (!released) controller.abort(new ChatStreamLeaseError("CHAT_LEASE_LOST", 503, "Chat session coordination became unavailable.")); })
      .finally(() => { renewing = false; });
  }, 15000);
  heartbeat.unref?.();
  return async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    removeLocal();
    await bounded(registry.release(owner.workspaceId, owner.userId, lease)).catch(() => undefined);
  };
}
