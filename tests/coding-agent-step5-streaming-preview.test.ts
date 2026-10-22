import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CodeSessionRunExecutor } from "../apps/agent-api/src/code-session-run-executor";
import { canReusePreviewSession } from "../apps/agent-api/src/project-preview-reuse";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodingAgentRunnerPorts,
  type CodeRunToolDescriptor,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * Step 5 — streaming and preview reuse.
 *
 * The wire-level text-delta contract (only `content`, never reasoning or tool arguments) is tested next to
 * `readChatStream` in `omniroute-chat-stream.test.ts`; this file covers the transport chain above it and the
 * preview-reuse decision.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(): CodeSession {
  return {
    id: "session-1", workspaceId: "ws-1", companyId: "company-1", projectId: "project-1", userId: "user-1",
    mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard",
    revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Step 5 — preview reuse without a restart", () => {
  it("reuses a development server and a static server", () => {
    expect(canReusePreviewSession({ verifiedBuild: false, framework: "nextjs" })).toBe(true);
    expect(canReusePreviewSession({ verifiedBuild: false, framework: "vite" })).toBe(true);
    expect(canReusePreviewSession({ verifiedBuild: true, framework: "static" })).toBe(true);
  });

  it("never reuses a production build server, an explicit command or an explicit port", () => {
    expect(canReusePreviewSession({ verifiedBuild: true, framework: "nextjs" })).toBe(false);
    expect(canReusePreviewSession({ verifiedBuild: true, framework: "vite" })).toBe(false);
    expect(canReusePreviewSession({ verifiedBuild: undefined, framework: "nextjs" })).toBe(false);
    expect(canReusePreviewSession({ verifiedBuild: false, framework: "nextjs", command: "npm run dev" })).toBe(false);
    expect(canReusePreviewSession({ verifiedBuild: false, framework: "static", port: 3001 })).toBe(false);
  });
});

describe("Step 5 — the executor forwards assistant prose before the result", () => {
  it("emits deltas first and the result exactly once", async () => {
    const calls: string[] = [];
    const executor = new CodeSessionRunExecutor({
      runner: {
        run: async (input) => {
          input.onTextDelta?.("Hel");
          input.onTextDelta?.("lo");
          return { status: "completed", runId: "run-1", message: "Hello", summary: {} } as never;
        },
      },
      control: { clearSession: () => undefined, registerController: () => undefined, unregisterController: () => undefined },
    });
    const executed = await executor.execute({
      ctx,
      session: session(),
      prompt: "hi",
      sink: {
        signal: new AbortController().signal,
        emitResult: () => calls.push("result"),
        emitTerminal: () => calls.push("terminal"),
        emitDelta: (text) => calls.push(`delta:${text}`),
      },
    });
    expect(calls).toEqual(["delta:Hel", "delta:lo", "result", "terminal"]);
    expect(executed.result).toMatchObject({ message: "Hello" });
  });

  it("does not fail the run when the transport has no delta channel", async () => {
    const executor = new CodeSessionRunExecutor({
      runner: { run: async (input) => { input.onTextDelta?.("x"); return { status: "completed", runId: "run-1", message: "x", summary: {} } as never; } },
      control: { clearSession: () => undefined, registerController: () => undefined, unregisterController: () => undefined },
    });
    await expect(executor.execute({
      ctx, session: session(), prompt: "hi",
      sink: { signal: new AbortController().signal, emitResult: () => undefined, emitTerminal: () => undefined },
    })).resolves.toMatchObject({ result: { message: "x" } });
  });
});

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
  { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
];
const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { path: { type: "string" } } } }));

describe("Step 5 — the runner turns streaming on for the transport", () => {
  it("passes the delta listener to the model call and streams text before the run settles", async () => {
    const deltaSeen: string[] = [];
    const requests: Array<{ onTextDelta?: (text: string) => void }> = [];
    const ports: CodingAgentRunnerPorts = {
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: {
        listTools: () => TOOLS,
        invoke: async (_ctx, input) => ({ ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 1 }) as never,
        turnSummary: () => ({ files: 1, linesAdded: 1, linesRemoved: 0, changes: [{ path: "src/a.ts", tool: "code.fs.edit", status: "modified", diff: "@@ -1 +1 @@\n-a\n+b\n" }] }),
      },
      engine: {
        chat: async (request) => {
          requests.push(request);
          request.onTextDelta?.("streamed ");
          request.onTextDelta?.("answer");
          return { content: "streamed answer" } as ChatResult;
        },
      },
      schemas: SCHEMAS,
      quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
      activity: { record: async () => undefined },
      runEvents: { append: async (entry) => entry },
      sandbox: { release: async () => undefined },
      environment: createCodeRunEnvironmentHolder(),
      snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
      limits: { maxStepsPerRun: 6, maxRunMinutes: 5, parallelReadOnlyCalls: 8, repairLoopAttempts: 1, maxChangedFiles: 25 },
    };
    const result = await new CodingAgentRunner(ports).run({
      ctx, session: session(), prompt: "say hello", turnId: "turn-5",
      onTextDelta: (text) => deltaSeen.push(text),
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("streamed answer");
    expect(deltaSeen.join("")).toBe("streamed answer");
    expect(requests[0]?.onTextDelta).toBeTypeOf("function");
  });

  it("does not stream when the transport does not ask for it", async () => {
    const requests: Array<{ onTextDelta?: (text: string) => void }> = [];
    const ports: CodingAgentRunnerPorts = {
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: {
        listTools: () => TOOLS,
        invoke: async (_ctx, input) => ({ ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 1 }) as never,
        turnSummary: () => ({ files: 0, linesAdded: 0, linesRemoved: 0, changes: [] }),
      },
      engine: { chat: async (request) => { requests.push(request); return { content: "done" } as ChatResult; } },
      schemas: SCHEMAS,
      quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
      activity: { record: async () => undefined },
      runEvents: { append: async (entry) => entry },
      sandbox: { release: async () => undefined },
      environment: createCodeRunEnvironmentHolder(),
      snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
      limits: { maxStepsPerRun: 6, maxRunMinutes: 5, parallelReadOnlyCalls: 8, repairLoopAttempts: 1, maxChangedFiles: 25 },
    };
    await new CodingAgentRunner(ports).run({ ctx, session: session(), prompt: "hi", turnId: "turn-5" });
    expect(requests[0]?.onTextDelta).toBeUndefined();
  });
});
