import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { CodeBackgroundRunRegistry } from "../apps/agent-api/src/code-background-run-registry";
import { CodeRunCancellationRegistry } from "../apps/agent-api/src/code-run-cancellation";
import { CodeSessionRunExecutor, type CodeSessionRunPort } from "../apps/agent-api/src/code-session-run-executor";
import { bindChatStreamUserStop } from "../apps/agent-api/src/chat-stream-lease";
import { registerChatRoutes } from "../apps/agent-api/src/chat-routes";

const auth: AuthContext = { userId: "stop-user", workspaceId: "stop-ws", permissions: ["workspace:write"] };
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * D03 (Stage7 R6): a chat Code request runs as a background run, whose signal a disconnect cannot reach (C10). The
 * chat's "Stop generating" only aborted the stream, so the run kept writing files for 90 s. This drives the same
 * pieces the chat route wires: the stream record, the cancel route, the cancellation registry, the executor and a
 * runner that, like the tool-wave loop, checks the signal and cancelRequested before every tool call.
 */
async function chatCodeRun(owner: { workspaceId: string; userId: string } = auth) {
  const activeStreams = new Map<string, { controller: AbortController; workspaceId: string; userId: string; onUserStop?: () => void }>();
  const background = new CodeBackgroundRunRegistry();
  const cancellation = new CodeRunCancellationRegistry();
  const writes: string[] = [];
  let firstWrites!: () => void;
  const twoWritten = new Promise<void>(resolve => { firstWrites = resolve; });
  const runner: CodeSessionRunPort = { run: async input => {
    for (let index = 1; index <= 12; index += 1) {
      if (input.signal?.aborted || await input.cancelRequested?.()) return { runId: "run", status: "cancelled" };
      writes.push(`src/features/format${String(index).padStart(2, "0")}.cjs`);
      if (writes.length === 2) firstWrites();
      await delay(15);
    }
    return { runId: "run", status: "completed" };
  } };
  const executor = new CodeSessionRunExecutor({ runner, control: cancellation });
  const app = Fastify(); closers.push(() => app.close());
  registerChatRoutes(app, { activeChatStreams: activeStreams, authProvider: { authenticate: async () => auth } } as never);
  const streamController = new AbortController();
  activeStreams.set("stream-1", { workspaceId: owner.workspaceId, userId: owner.userId, controller: streamController });
  const session = { id: "session-1", companyId: "company-1", projectId: "project-1" } as never;
  const sink = background.start({ runId: "run-key", sessionId: "session-1", companyId: "company-1", userId: auth.userId, projectId: "project-1" });
  // The same binding the chat route makes before it starts the executor.
  const userStopped = bindChatStreamUserStop(activeStreams, "stream-1", streamController, () => {
    cancellation.requestSessionCancel({ sessionId: "session-1", companyId: "company-1", projectId: "project-1", requestedBy: auth.userId, runId: "run-key" });
    cancellation.abortLiveRuns("session-1", new Error("Stopped by request"));
  });
  const run = executor.execute({ ctx: auth, session, prompt: "Add 12 format functions", sink: { signal: sink.signal, emitResult: async () => undefined, emitTerminal: (status, reason) => sink.finish(status, reason) },
    abort: reason => { background.abort("run-key", reason instanceof Error ? reason.message : "Stopped by request"); },
    cancelRequested: () => userStopped() || cancellation.isSessionCancelled("session-1") });
  return { app, run, writes, twoWritten, streamController, sink };
}

describe("chat Stop generating stops the code run it started", () => {
  it("stops a background code run at the next tool call after the user's Stop", async () => {
    const f = await chatCodeRun();
    await f.twoWritten;
    const stopped = await f.app.inject({ method: "POST", url: "/chat/streams/stream-1/cancel" });
    expect(stopped.json()).toEqual({ cancelled: true });
    const atStop = f.writes.length;
    const outcome = await f.run;
    expect(f.streamController.signal.aborted).toBe(true);
    expect(f.sink.signal.aborted).toBe(true);
    // At most the call already in flight finishes; nothing new starts after Stop.
    expect(f.writes.length).toBeLessThanOrEqual(atStop + 1);
    expect(f.writes.length).toBeLessThan(12);
    expect(outcome.terminalStatus).toBe("cancelled");
  });

  it("keeps a background run going when the tab only disconnects", async () => {
    const f = await chatCodeRun();
    await f.twoWritten;
    f.streamController.abort(new Error("Client disconnected"));
    await f.run;
    expect(f.writes).toHaveLength(12);
    expect(f.sink.signal.aborted).toBe(false);
  });

  it("does not let another user's Stop reach the run", async () => {
    const f = await chatCodeRun({ workspaceId: "other-ws", userId: "other-user" });
    await f.twoWritten;
    expect((await f.app.inject({ method: "POST", url: "/chat/streams/stream-1/cancel" })).statusCode).toBe(403);
    await f.run;
    expect(f.writes).toHaveLength(12);
  });
});
