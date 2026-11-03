import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodingAgentRunnerPorts,
  type CodeRunToolDescriptor,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * Test G — a run that keeps inspecting without ever changing source must stop early and say so.
 *
 * The live failure this reproduces (`code-run-mvj6ynx7-057n6ili`) made 71 model calls and 107 reads,
 * changed zero files, and only stopped because the old loop detector happened to fire. The guard under
 * test is the no-progress stop, not a rejection counter.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(): CodeSession {
  return {
    id: "session-1", workspaceId: "ws-1", companyId: "company-1", projectId: "project-1", userId: "user-1",
    mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard",
    revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
  { name: "code.fs.grep", version: 1, status: "active", description: "grep", write: false },
  { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
];
const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { path: { type: "string" } } } }));

function readCall(turn: number) {
  return { content: "", toolCalls: [{ id: `read-${turn}`, type: "function" as const, function: { name: "code.fs.read", arguments: JSON.stringify({ path: `components/Component${turn}.tsx` }) } }] };
}

describe("progress guard — inspection without source changes", () => {
  it("stops a read-only loop instead of running until an unrelated limit", async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const reminders: string[] = [];
    const ports: CodingAgentRunnerPorts = {
      flags: { assertEnabled: async () => true },
      rbac: { authorize: async () => ({ allowed: true }) },
      toolRuntime: {
        listTools: () => TOOLS,
        invoke: async (_ctx, input) => {
          toolCalls += 1;
          return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 1 } as never;
        },
        turnSummary: () => ({ files: 0, linesAdded: 0, linesRemoved: 0, changes: [] }),
      },
      engine: {
        chat: async (request): Promise<ChatResult> => {
          if (!request.tools?.length) return { content: JSON.stringify({ status: "clean", findings: [] }) };
          modelCalls += 1;
          return readCall(modelCalls) as ChatResult;
        },
      },
      schemas: SCHEMAS,
      quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
      activity: { record: async () => undefined },
      runEvents: { append: async (entry) => entry },
      sandbox: { release: async () => undefined },
      environment: createCodeRunEnvironmentHolder(),
      snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
      limits: { maxStepsPerRun: 40, maxRunMinutes: 5, parallelReadOnlyCalls: 8, repairLoopAttempts: 1, maxChangedFiles: 25 },
    };
    const result = await new CodingAgentRunner(ports).run({
      ctx, session: session(), prompt: "change the design like the photo", turnId: "turn-1",
      websiteEdit: true,
      onActivity: async (event) => { if (event.stage === "reminder") reminders.push(String(event.title ?? event.reason ?? "")); },
    });

    expect(result.status).toBe("stopped");
    expect(result.reason).toBe("loop_detected");
    // The guard must fire well before the generic turn limit and without a single write.
    expect(modelCalls).toBeLessThanOrEqual(21);
    expect(modelCalls).toBeGreaterThanOrEqual(8);
    expect(toolCalls).toBe(modelCalls);
    expect(result.summary?.filesChanged ?? []).toHaveLength(0);
    expect(String(result.message)).toMatch(/without source progress/i);
  }, 60_000);
});
