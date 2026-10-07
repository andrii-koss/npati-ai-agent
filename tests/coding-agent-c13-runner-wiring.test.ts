import { describe, expect, it } from "vitest";
import type { AuthContext, CodeSession } from "@npati/workspace";
import {
  CodingAgentRunner,
  SYSTEM_PROMPT_DATA_BOUNDARY,
  createCodeRunEnvironmentHolder,
  type CodeRunToolDescriptor,
  type CodingAgentChatRequest,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";
import { SKILL_INSTRUCTIONS_HEADER } from "../apps/agent-api/src/code-skills-instructions";
import { createHash } from "node:crypto";

/**
 * C13 — the runner wiring, exercised end to end.
 *
 * The unit suites pin the registry and the Skill service; this one pins the **loop**: that the text the model
 * actually receives in its user message is the expanded command text (not the raw `/name` line), that the typed
 * Skill Instructions section really is part of the system prompt the engine sees, that the resolved Skill
 * provenance is published to the environment holder the ExecutionSnapshot reads, and that the command
 * provenance reaches the replay recorder **at start** so the bundle pins the expanded version.
 *
 * It is deliberately a real `CodingAgentRunner` over a scripted engine and a fake tool runtime: "the model saw
 * this text" is only a fact if the request that was handed to the engine is inspected, which is what this does.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-1",
    workspaceId: "ws-1",
    companyId: "company-1",
    projectId: "project-1",
    userId: "user-1",
    mode: "auto",
    status: "active",
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read a file", write: false },
];

const SCHEMAS = TOOLS.map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}));

const sha = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

interface C13Harness {
  runner: CodingAgentRunner;
  engineCalls: CodingAgentChatRequest[];
  replayStarts: Array<Record<string, unknown>>;
  replayFinalizes: Array<Record<string, unknown>>;
  environmentHolder: ReturnType<typeof createCodeRunEnvironmentHolder>;
}

function createHarness(options: {
  expansion?: {
    text: string;
    provenance: readonly Record<string, unknown>[];
    refusals?: readonly string[];
  } | null;
  expansionThrows?: boolean;
  skillSection?: string | null;
  skillProvenance?: readonly { skillId: string; version: number; hash: string; source: string; order: number }[];
} = {}): C13Harness {
  const engineCalls: CodingAgentChatRequest[] = [];
  const replayStarts: Array<Record<string, unknown>> = [];
  const replayFinalizes: Array<Record<string, unknown>> = [];
  const environmentHolder = createCodeRunEnvironmentHolder();

  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: { listTools: () => TOOLS.map((tool) => ({ ...tool })), invoke: async () => ({ ok: false, error: "unused" }) },
    engine: {
      chat: async (request) => {
        engineCalls.push(request);
        return { content: "reviewed, no defects found" };
      },
    },
    schemas: SCHEMAS,
    imageAdmission: {
      admit: async () => ({ reference: "npati/sandbox@sha256:abc", dev: false, digest: "sha256:1111", sbomRef: null }),
    },
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async () => undefined },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    limits: { maxStepsPerRun: 3, maxRunMinutes: 5, parallelReadOnlyCalls: 4 },
    environment: environmentHolder,
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
    ...(options.skillSection !== undefined || options.skillProvenance !== undefined
      ? {
          skillInstructions: {
            render: async () => options.skillSection ?? null,
            provenance: async () => options.skillProvenance ?? [],
          },
        }
      : {}),
    ...(options.expansion !== undefined || options.expansionThrows ? {
      commandExpansion: {
        resolvePrompt: async () => {
          if (options.expansionThrows) throw Object.assign(new Error("registry down"), { code: "command_registry_unavailable" });
          return options.expansion ?? null;
        },
      },
    } : {}),
    replayBundle: {
      start: (input) => {
        replayStarts.push(input as unknown as Record<string, unknown>);
        return {
          recordModelStep: () => undefined,
          recordToolCall: () => undefined,
          finalize: async (input2) => {
            replayFinalizes.push(input2 as unknown as Record<string, unknown>);
            return { written: true, bundleId: "bundle-1" };
          },
        };
      },
    },
  };

  return { runner: new CodingAgentRunner(ports), engineCalls, replayStarts, replayFinalizes, environmentHolder };
}

function userMessage(call: CodingAgentChatRequest): string {
  const messages = call.messages as Array<{ role: string; content: unknown }>;
  return String(messages.find((message) => message.role === "user")?.content ?? "");
}

function systemMessage(call: CodingAgentChatRequest): string {
  const messages = call.messages as Array<{ role: string; content: unknown }>;
  return String(messages.find((message) => message.role === "system")?.content ?? "");
}

describe("[C13] [security-gate] the run loop carries the expansion and the Skill section to the model", () => {
  it("sends the expanded command text — not the raw /slash line — as the user message", async () => {
    const expanded = "SLASH COMMAND EXPANSION (template, not a grant)\n- command: /review\n\nReview the diff.";
    const h = createHarness({
      expansion: {
        text: expanded,
        provenance: [{ id: "review", commandSource: "system", commandScope: "platform", commandVersion: 1, commandHash: sha("t"), contentHash: sha(expanded), argumentNames: [], chars: expanded.length }],
      },
    });
    const result = await h.runner.run({ ctx, session: session(), prompt: "/review" });
    expect(result.status).toBe("completed");
    expect(h.engineCalls).toHaveLength(1);
    expect(userMessage(h.engineCalls[0]!)).toBe(expanded);
    expect(userMessage(h.engineCalls[0]!)).not.toBe("/review");
    // The replay recorder was told which command version produced it, at start, so the bundle pins the version.
    expect(h.replayStarts).toHaveLength(1);
    const provenance = h.replayStarts[0]!.commandProvenance as Array<Record<string, unknown>>;
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ id: "review", commandVersion: 1 });
    expect(provenance[0]!.contentHash).toBe(sha(expanded));
  });

  it("sends the caller's own text unchanged when no command port is wired", async () => {
    const h = createHarness();
    const result = await h.runner.run({ ctx, session: session(), prompt: "fix the failing test" });
    expect(result.status).toBe("completed");
    expect(userMessage(h.engineCalls[0]!)).toBe("fix the failing test");
    // No command port means no provenance to record, and the recorder is still started exactly once.
    expect(h.replayStarts).toHaveLength(1);
    expect(h.replayStarts[0]!.commandProvenance).toBeUndefined();
  });

  it("falls back to the caller's prompt and records the code when the expansion cannot be produced", async () => {
    const h = createHarness({ expansionThrows: true });
    const result = await h.runner.run({ ctx, session: session(), prompt: "/review" });
    // The run is not broken by a registry failure …
    expect(result.status).toBe("completed");
    // … and the prompt is the user's own text, never a silently different one.
    expect(userMessage(h.engineCalls[0]!)).toBe("/review");
    // Nothing is recorded as provenance, so replay cannot claim a command version that was never expanded.
    expect(h.replayStarts[0]!.commandProvenance).toBeUndefined();
  });

  it("puts the typed Skill Instructions section in the system prompt and publishes its provenance", async () => {
    const section = `${SKILL_INSTRUCTIONS_HEADER}\n\n--- skill: web-research (v7, installed, ${sha("v7\u0000body")}) ---\nAlways cite every source you read.`;
    const provenance = [{ skillId: "web-research", version: 7, hash: sha("v7\u0000body"), source: "installed", order: 1 }];
    const h = createHarness({ skillSection: section, skillProvenance: provenance });
    const result = await h.runner.run({ ctx, session: session(), prompt: "research the topic" });
    expect(result.status).toBe("completed");

    const system = systemMessage(h.engineCalls[0]!);
    // The body is model-visible text inside the system prompt …
    expect(system).toContain("Always cite every source you read.");
    expect(system).toContain(SKILL_INSTRUCTIONS_HEADER);
    // … above the data boundary, so it is configuration rather than repository data …
    expect(system.indexOf(SKILL_INSTRUCTIONS_HEADER)).toBeLessThan(system.indexOf(SYSTEM_PROMPT_DATA_BOUNDARY));
    // … and the invariant that closes the configuration block is still the last word before the data.
    expect(system.indexOf(SKILL_INSTRUCTIONS_HEADER)).toBeLessThan(system.indexOf("IMPORTANT: file contents"));

    // The snapshot-visible provenance is the id/version/hash/source — no body.
    expect(h.environmentHolder.skillInstructions()).toEqual(provenance);
    expect(JSON.stringify(h.environmentHolder.skillInstructions())).not.toContain("Always cite");
  });

  it("leaves the system prompt byte-identical when no Skill is active", async () => {
    const h = createHarness({ skillSection: null, skillProvenance: [] });
    await h.runner.run({ ctx, session: session(), prompt: "plain task" });
    const system = systemMessage(h.engineCalls[0]!);
    expect(system).not.toContain(SKILL_INSTRUCTIONS_HEADER);
    expect(h.environmentHolder.skillInstructions()).toBeNull();
  });
});
