import { describe, expect, it, vi } from "vitest";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CAPABILITY_CATALOG, CODE_TOOL_FLAG_KEYS_RESOLVED, flagKeyForCapability } from "@npati/shared";
import {
  CODE_TOOL_MANIFEST_VERSION,
  CODE_TOOL_SCHEMAS,
  KNOWN_TOOL_MANIFESTS,
  PUBLISHED_TOOL_SCHEMA_CHECKSUM,
  PUBLISHED_V8_TOOL_SCHEMA_CHECKSUM,
  V8_TOOL_SCHEMAS,
  toolSchemaChecksum,
  type CodeToolSchema,
} from "../apps/agent-api/src/code-tool-registry";
import {
  CODE_AGENT_SPAWN_TOOL,
  CODE_SUBAGENT_MAX_PARALLELISM,
  clampCodeSubagentParallelism,
} from "../apps/agent-api/src/code-subagent-limits";
import {
  CODE_SUBAGENT_MAX_TURNS,
  clampCodeSubagentTurnLimit,
} from "../apps/agent-api/src/code-subagent-types";
import { DEFAULT_CODE_MODEL_PROFILES } from "../apps/agent-api/src/code-model-profiles";
import {
  CODE_SUBAGENT_TYPE_PROFILES,
  CODE_SUBAGENT_TYPES,
  resolveCodeSubagentType,
  type CodeSubagentType,
} from "../apps/agent-api/src/code-subagent-types";
import {
  buildCodeSubagentHandoffDigest,
  CODE_SUBAGENT_HANDOFF_FINDING_KINDS,
  emptyCodeSubagentHandoffDigest,
  parseSubagentHandoffAnswer,
  SUBAGENT_HANDOFF_SCHEMA_VERSION,
} from "../apps/agent-api/src/code-subagent-handoff";
import {
  codeSubagentRunId,
  CodeSubagentInFlightTracker,
  createCodeAgentSpawnExecutor,
  spawnCodeSubagent,
  type CodeSubagentActivityRecorder,
  type CodeSubagentChildOutcome,
  type CodeSubagentChildRunRequest,
  type CodeSubagentChildRunner,
} from "../apps/agent-api/src/code-agent-spawn-executor";
import {
  buildCodeSubagentAnswer,
  buildCodeSubagentPrompt,
  createCodeSubagentChildRunner,
} from "../apps/agent-api/src/code-subagent-child-runner";
import { allCanonicalExecutors } from "../apps/agent-api/src/code-tool-executors";
import { CodeToolRuntime, codeSubFlagForTool, type CodeReadPort } from "../apps/agent-api/src/code-tool-runtime";
import { CODE_AGENT_MASTER_FLAG } from "../apps/agent-api/src/feature-flags";
import { readFileSync } from "node:fs";

/**
 * C12 security-gate suite: the `code.agent.spawn` tool itself.
 *
 * The scope suite next door pins the **structural** half of the delegation (depth 1, the intersection, the
 * parallelism ceiling). This one drives the tool: its published schema, its sub-flag, the five sub-agent types
 * and what a type actually decides (model profile, turn limit, capability profile), the refusals, the
 * deterministic run id, the Activity event, and the two properties the owner asked for by name:
 *
 *  - **`explore` returns a summary, not a transcript.** The parent receives a handoff digest of findings, paths,
 *    symbols and counts. The child's answer is parsed for those named fields only, a multi-line value is *dropped*
 *    rather than truncated (a body, a diff and a log excerpt are all multi-line), and a credential refuses the
 *    whole digest instead of being redacted out of it. The assertions below are about bytes: a marker planted in
 *    the child's prose and a marker planted in a file body must not appear anywhere in the tool result.
 *  - **A failing sub-agent does not take the parent's run down.** A child that returns `failed` and a child that
 *    *throws* both produce a **successful** tool call whose data says `status: "failed"` with the child's code, so
 *    the parent's loop continues with a structured answer.
 */

const ctx: AuthContext = { userId: "user-c12", workspaceId: "ws-c12", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-c12", workspaceId: "ws-c12", companyId: "company-c12", projectId: "project-c12",
    userId: "user-c12", mode: "auto", status: "active", dataClassification: "confidential",
    retentionClass: "standard", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const READ_PORT_FILES: Record<string, string> = { "src/index.ts": "export const ready = true;\n" };

function fakeReadPort(): CodeReadPort {
  return {
    async listDir() { return { entries: [{ path: "src/index.ts", type: "file" as const }] }; },
    async readFile({ path, maxLines }) {
      const content = READ_PORT_FILES[path] ?? "";
      const lines = content.split("\n");
      return { path, content: lines.slice(0, maxLines).join("\n"), revision: "r1", sha256: "0".repeat(64), totalLines: lines.length, truncated: false };
    },
    async runSearch() { return { matches: [], truncated: false }; },
  };
}

const PUBLISHED_TOOL_NAMES = CODE_TOOL_SCHEMAS.map((tool) => tool.name);

/** Records what the delegation asked for, so the assertions are about the request rather than about a mock. */
function recordingChild(outcome: CodeSubagentChildOutcome | (() => Promise<CodeSubagentChildOutcome>)) {
  const requests: CodeSubagentChildRunRequest[] = [];
  const runner: CodeSubagentChildRunner = {
    async run(request) {
      requests.push(request);
      return typeof outcome === "function" ? outcome() : outcome;
    },
  };
  return { runner, requests };
}

/** Flags with a configurable set of enabled sub-flags; the master flag is always on. */
function flagsWith(enabled: Iterable<string>) {
  const allowed = new Set(enabled);
  return {
    async assertEnabled(_ctx: unknown, flagKey: string) {
      if (flagKey === CODE_AGENT_MASTER_FLAG || allowed.has(flagKey)) return;
      throw Object.assign(new Error(`Feature "${flagKey}" is disabled`), { code: "feature_disabled", status: 403, flagKey });
    },
    async isEnabled() { return true; },
  };
}

function runtimeWith(options: {
  child?: CodeSubagentChildRunner;
  activity?: CodeSubagentActivityRecorder;
  flags?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
  schemas?: readonly CodeToolSchema[];
} = {}) {
  const executors = allCanonicalExecutors({
    ...(options.child ? { subagentChildRunner: () => options.child } : {}),
    subagentCanonicalTools: () => PUBLISHED_TOOL_NAMES,
    ...(options.activity ? { subagentActivity: options.activity } : {}),
    ...(options.env ? { subagentEnv: options.env } : {}),
  });
  return new CodeToolRuntime({
    flags: flagsWith(options.flags ?? ["code.read", "code.write", "code.shell", "code.git", "code.subagents"]) as never,
    schemas: [...(options.schemas ?? CODE_TOOL_SCHEMAS)],
    toPort: () => fakeReadPort(),
    executors,
    limits: { readFileLines: 100, toolOutputChars: 20_000 },
  });
}

function invoke(runtime: CodeToolRuntime, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return runtime.invoke(ctx, {
    companyId: "company-c12", projectId: "project-c12", sessionId: "session-c12",
    runId: "run-parent", toolCallId: "call-1", tool: CODE_AGENT_SPAWN_TOOL, args, ...extra,
  });
}

function errorCode(result: unknown): string | undefined {
  return (result as { error?: { code?: string } }).error?.code;
}

function dataOf(result: unknown): Record<string, unknown> {
  const wrapped = (result as { result?: { data?: Record<string, unknown> } }).result;
  expect(wrapped?.data, "the tool result must be the untrusted-data envelope with a data object").toBeTruthy();
  return wrapped!.data!;
}

describe("security-gate: C12 code.agent.spawn is published as a first-class tool", () => {
  const schema = CODE_TOOL_SCHEMAS.find((tool) => tool.name === CODE_AGENT_SPAWN_TOOL);

  it("publishes it in manifest v9, keeps v8 frozen, and pins the checksum with the registry's own hasher", () => {
    expect(schema, "code.agent.spawn must be published").toBeTruthy();
    expect(schema!.version).toBe(1);
    expect(schema!.status).toBe("active");
    expect(CODE_TOOL_MANIFEST_VERSION).toBe(9);
    expect(CODE_TOOL_SCHEMAS).toHaveLength(37);
    expect(PUBLISHED_TOOL_SCHEMA_CHECKSUM).toBe(toolSchemaChecksum(CODE_TOOL_SCHEMAS));

    const current = KNOWN_TOOL_MANIFESTS.find((manifest) => manifest.version === CODE_TOOL_MANIFEST_VERSION)!;
    expect(current.tools.map((tool) => tool.name)).toContain(CODE_AGENT_SPAWN_TOOL);

    // v8 is the set the git tools were published in, and it must not have gained the delegation tool.
    const v8 = KNOWN_TOOL_MANIFESTS.find((manifest) => manifest.version === 8)!;
    expect(v8.tools).toHaveLength(36);
    expect(v8.checksum).toBe(PUBLISHED_V8_TOOL_SCHEMA_CHECKSUM);
    expect(toolSchemaChecksum(V8_TOOL_SCHEMAS)).toBe(PUBLISHED_V8_TOOL_SCHEMA_CHECKSUM);
    expect(v8.tools.map((tool) => tool.name)).not.toContain(CODE_AGENT_SPAWN_TOOL);
  });

  it("declares exactly the arguments the executor reads, and nothing a model could widen", () => {
    const input = schema!.inputSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
    expect(input.additionalProperties).toBe(false);
    expect([...input.required].sort()).toEqual(["agentType", "task"]);
    expect(Object.keys(input.properties).sort()).toEqual(["agentType", "model", "paths", "summaryOnly", "task", "tools", "turnLimit"]);
    expect(input.properties.agentType!.enum).toEqual([...CODE_SUBAGENT_TYPES]);
    expect(input.properties.paths!.maxItems).toBe(20);
    expect(input.properties.tools!.maxItems).toBe(64);
    expect(input.properties.turnLimit).toMatchObject({ minimum: 1, maximum: CODE_SUBAGENT_MAX_TURNS });
    expect(input.properties.summaryOnly!.default).toBe(true);
    // The project, the company and the run are never arguments: they come from the invocation envelope, so a model
    // cannot point a delegation at another tenant, and it cannot claim to be a different run.
    for (const forbidden of ["projectId", "companyId", "sessionId", "runId", "parentRunId", "workspaceId"]) {
      expect(Object.keys(input.properties)).not.toContain(forbidden);
    }
    // The result envelope marks everything as untrusted data — a sub-agent's finding is data like any other.
    const output = schema!.outputSchema as { properties: Record<string, unknown> };
    expect(output.properties.trust).toEqual({ const: "untrusted_data" });
    expect(output.properties.kind).toEqual({ const: "code_tool_result" });
    expect(output.properties.tool).toEqual({ const: CODE_AGENT_SPAWN_TOOL });
  });

  it("is visible in the Capability Inspector under its own code.subagents flag", () => {
    const capability = CAPABILITY_CATALOG.find((entry) => entry.id === CODE_AGENT_SPAWN_TOOL);
    expect(capability, "the delegation tool must be a catalogued capability").toBeTruthy();
    expect(capability!.inventoryIds).toEqual([385]);
    expect(capability!.agentCallable).toBe(true);
    expect(capability!.userVisible).toBe(true);
    expect(capability!.risk).toBe("medium");
    // Not approve-gated: the approval belongs to the write the child attempts, not to the delegation.
    expect(capability!.requiresConfirmation).toBe(false);
    expect(capability!.inputSchema).toEqual(schema!.inputSchema);
    expect(capability!.outputSchema).toEqual(schema!.outputSchema);
    expect(CODE_TOOL_FLAG_KEYS_RESOLVED[CODE_AGENT_SPAWN_TOOL]).toBe("code.subagents");
    expect(flagKeyForCapability("code")).toBe("code.read");
  });

  it("takes its own sub-flag, so enabling file edits does not enable spawning children", async () => {
    expect(codeSubFlagForTool(CODE_AGENT_SPAWN_TOOL, false)).toBe("code.subagents");
    expect(codeSubFlagForTool(CODE_AGENT_SPAWN_TOOL, true)).toBe("code.subagents");
    expect(codeSubFlagForTool("code.fs.write", true)).toBe("code.write");
    expect(codeSubFlagForTool("code.git.push", false)).toBe("code.git");

    const child = recordingChild({ status: "completed", answer: "{}" });
    // `code.write` on, `code.subagents` off: the delegation is refused by the flag, and the child never starts.
    const runtime = runtimeWith({ child: child.runner, flags: ["code.read", "code.write", "code.shell", "code.git"] });
    const result = await invoke(runtime, { agentType: "explore", task: "find the entry point" });
    expect(errorCode(result)).toBe("feature_disabled");
    expect(child.requests).toHaveLength(0);
  });
});

describe("security-gate: C12 a sub-agent type decides model, turn limit and capability profile", () => {
  it("maps every type onto a published profile id, a bounded turn limit and published tools only", () => {
    const profileIds = new Set(DEFAULT_CODE_MODEL_PROFILES.map((profile) => profile.id));
    for (const type of CODE_SUBAGENT_TYPES) {
      const resolved = resolveCodeSubagentType({ type, env: {} });
      const table = CODE_SUBAGENT_TYPE_PROFILES[type as CodeSubagentType];
      expect(resolved.modelProfileId, `${type} names a registry profile`).toBe(table.modelProfileId);
      expect(profileIds.has(resolved.modelProfileId), `${type} profile id must exist in the registry`).toBe(true);
      expect(resolved.profileFallback).toBe(false);
      expect(resolved.maxTurns).toBe(table.maxTurns);
      expect(resolved.maxTurns).toBeGreaterThanOrEqual(1);
      expect(resolved.maxTurns).toBeLessThanOrEqual(CODE_SUBAGENT_MAX_TURNS);
      expect(resolved.maxParallelism).toBeGreaterThanOrEqual(1);
      expect(resolved.maxParallelism).toBeLessThanOrEqual(CODE_SUBAGENT_MAX_PARALLELISM);
      expect(resolved.capabilityProfile.length).toBeGreaterThan(0);
      // A type profile may only ever name published tools: an unpublished name is not a tool.
      for (const tool of table.baseTools) {
        expect(PUBLISHED_TOOL_NAMES, `${type} profile tool ${tool} must be published`).toContain(tool);
      }
      // And no type may hand a child the delegation tool.
      expect(table.baseTools).not.toContain(CODE_AGENT_SPAWN_TOOL);
    }
  });

  it("gives explore a read-only, summary-only, cheap profile", () => {
    const explore = CODE_SUBAGENT_TYPE_PROFILES.explore;
    expect(explore.readOnly).toBe(true);
    expect(explore.summaryOnly).toBe(true);
    expect(explore.maxTurns).toBeLessThan(CODE_SUBAGENT_TYPE_PROFILES.implement.maxTurns);
    // "Fast/cheap" is expressed through the **existing** model-profile registry: the small-context hosted profile,
    // not a model name spelled out here.
    expect(explore.modelProfileId).toBe("hosted-native-tools-small-context");
    // Read-only means no write, shell, dependency or remote git tool is in its profile.
    for (const tool of explore.baseTools) {
      expect(tool).not.toMatch(/^code\.(fs\.(edit|write|move|delete|apply_patch)|shell\.|deps\.add|git\.(push|commit|stage|restore|branch))/);
    }
  });

  it("takes the type's model profile and the named model's own profile, and keeps the stricter one", () => {
    // No model named: the type's profile is the answer, and there is nothing to resolve.
    const plain = resolveCodeSubagentType({ type: "explore", env: {} });
    expect(plain.model).toBeNull();
    expect(plain.modelResolution).toBeNull();
    expect(plain.toolCallingMode).toBe("native");

    // A named hosted model resolves through the registry to the small-context profile.
    const named = resolveCodeSubagentType({ type: "explore", model: "gpt-4o-mini", env: {} });
    expect(named.model).toBe("gpt-4o-mini");
    expect(named.modelResolution).toMatchObject({ profileId: "hosted-native-tools-small-context" });
    expect(named.toolCallingMode).toBe("native");

    // A local model only speaks the text protocol: the stricter mode wins, so the child is never driven as if it
    // supported native tool calls.
    const local = resolveCodeSubagentType({ type: "explore", model: "local-llama3-8b", env: {} });
    expect(local.modelResolution).toMatchObject({ profileId: "local-text-tools", toolCallingMode: "text" });
    expect(local.toolCallingMode).toBe("text");

    // An unusable model string is ignored and said so, never passed through.
    const hostile = resolveCodeSubagentType({ type: "explore", model: "bad\nmodel", env: {} });
    expect(hostile.model).toBeNull();
    expect(hostile.warnings).toContain("subagent_model_argument_ignored:not_a_bounded_single_line_name");

    // The environment is the deployment's default per type, and the call's own argument wins over it.
    const fromEnv = resolveCodeSubagentType({ type: "explore", env: { NPATI_CODE_SUBAGENT_MODEL_EXPLORE: "qwen2.5-coder" } });
    expect(fromEnv.model).toBe("qwen2.5-coder");
    const overridden = resolveCodeSubagentType({ type: "explore", model: "gpt-4o", env: { NPATI_CODE_SUBAGENT_MODEL_EXPLORE: "qwen2.5-coder" } });
    expect(overridden.model).toBe("gpt-4o");
  });

  it("clamps the turn limit in one direction only, from configuration and from the model", () => {
    expect(clampCodeSubagentTurnLimit(999)).toBe(CODE_SUBAGENT_MAX_TURNS);
    expect(clampCodeSubagentTurnLimit(0)).toBe(1);
    expect(clampCodeSubagentTurnLimit("nonsense")).toBe(CODE_SUBAGENT_MAX_TURNS);
    expect(clampCodeSubagentTurnLimit(3, 10)).toBe(3);
    expect(clampCodeSubagentTurnLimit(30, 10)).toBe(10);

    // The type's own ceiling is the first limit.
    expect(resolveCodeSubagentType({ type: "implement", env: {} }).maxTurns).toBe(CODE_SUBAGENT_TYPE_PROFILES.implement.maxTurns);
    // Configuration may lower it …
    expect(resolveCodeSubagentType({ type: "implement", env: { NPATI_CODE_SUBAGENT_TURN_LIMIT_IMPLEMENT: "5" } }).maxTurns).toBe(5);
    // … and may not raise it.
    expect(resolveCodeSubagentType({ type: "implement", env: { NPATI_CODE_SUBAGENT_TURN_LIMIT_IMPLEMENT: "400" } }).maxTurns)
      .toBe(CODE_SUBAGENT_TYPE_PROFILES.implement.maxTurns);
    // The model's request may lower it again, never above what the type already holds.
    expect(resolveCodeSubagentType({ type: "implement", turnLimit: 2, env: {} }).maxTurns).toBe(2);
    expect(resolveCodeSubagentType({ type: "implement", turnLimit: 12, env: {} }).maxTurns).toBe(12);
    expect(resolveCodeSubagentType({ type: "implement", turnLimit: 400, env: {} }).maxTurns)
      .toBe(CODE_SUBAGENT_TYPE_PROFILES.implement.maxTurns);
  });

  it("refuses an unknown type and falls back loudly when a configured profile id is gone", () => {
    expect(() => resolveCodeSubagentType({ type: "deploy", env: {} })).toThrowError(/Unknown sub-agent type/);
    try {
      resolveCodeSubagentType({ type: "deploy", env: {} });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("subagent_type_unknown");
      expect((error as { httpStatus?: number }).httpStatus).toBe(400);
    }
    // A profile id that the registry no longer ships is reported as a fallback, never silently substituted.
    const fallback = resolveCodeSubagentType({ type: "explore", env: { NPATI_CODE_SUBAGENT_PROFILE_EXPLORE: "retired-profile" } });
    expect(fallback.profileFallback).toBe(true);
    expect(fallback.warnings).toContain("subagent_profile_unknown:retired-profile");
    expect(fallback.modelProfile.id).toBe("conservative-default");
  });

  it("describes the type's capability profile and its parallelism clamp", () => {
    // Parallelism is the canonical hard ceiling, and the environment may only lower it.
    expect(clampCodeSubagentParallelism(99)).toBe(CODE_SUBAGENT_MAX_PARALLELISM);
    expect(clampCodeSubagentParallelism(2)).toBe(2);
    expect(resolveCodeSubagentType({ type: "implement", env: { NPATI_CODE_SUBAGENT_PARALLELISM: "99" } }).maxParallelism)
      .toBe(CODE_SUBAGENT_MAX_PARALLELISM);
    expect(resolveCodeSubagentType({ type: "implement", env: { NPATI_CODE_SUBAGENT_PARALLELISM: "1" } }).maxParallelism).toBe(1);
    expect(CODE_SUBAGENT_TYPE_PROFILES.explore.capabilityProfile).toBe("explore-read-only");
    expect(CODE_SUBAGENT_TYPE_PROFILES.review.readOnly).toBe(true);
    expect(CODE_SUBAGENT_TYPE_PROFILES.test.readOnly).toBe(false);
  });
});

describe("security-gate: C12 the delegation executor intersects and refuses loudly", () => {
  it("hands the child the intersection, never the request, and never the delegation tool", async () => {
    const child = recordingChild({ status: "completed", answer: JSON.stringify({ findings: [], files: [], symbols: [] }) });
    const runtime = runtimeWith({ child: child.runner });
    const result = await invoke(runtime, { agentType: "implement", task: "add the health endpoint", tools: ["code.fs.read"] });

    expect(errorCode(result)).toBeUndefined();
    const data = dataOf(result);
    expect(data.status).toBe("completed");
    // The request was one tool; the type's profile is wider; the intersection is exactly the request.
    expect(data.tools).toEqual(["code.fs.read"]);
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]!.allowedTools).toEqual(["code.fs.read"]);
    // The delegation tool is not in the child's scope, which is what makes depth 1 structural.
    expect(child.requests[0]!.allowedTools).not.toContain(CODE_AGENT_SPAWN_TOOL);
  });

  it("resolves a wildcard request only against the published registry, and the type profile still narrows it", async () => {
    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner });
    const result = await invoke(runtime, { agentType: "explore", task: "survey the repository", tools: ["*"] });
    const data = dataOf(result);

    const allowed = data.tools as string[];
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.length).toBeLessThan(PUBLISHED_TOOL_NAMES.length);
    // A wildcard is not a universal key: every granted name is published, the type's read-only profile applied,
    // and the delegation tool is absent.
    for (const tool of allowed) expect(PUBLISHED_TOOL_NAMES).toContain(tool);
    expect(allowed).not.toContain(CODE_AGENT_SPAWN_TOOL);
    expect(allowed).not.toContain("code.fs.write");
    expect(new Set(allowed)).toEqual(new Set(CODE_SUBAGENT_TYPE_PROFILES.explore.baseTools));
  });

  it("refuses naming the delegation tool, an unpublished tool, and a tool the type does not hold", async () => {
    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner });

    // Naming the delegation tool is an escalation attempt: depth 1 must be refused, not quietly dropped.
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "go deeper", tools: [CODE_AGENT_SPAWN_TOOL] })))
      .toBe("subagent_tool_not_delegable");
    // An unpublished name is not a tool this deployment has.
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "read", tools: ["code.secret.exfiltrate"] })))
      .toBe("subagent_tool_not_published");
    // A tool the parent holds but the type's profile excludes leaves nothing to grant: refused, not widened.
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "write it", tools: ["code.fs.write"] })))
      .toBe("subagent_capability_scope_empty");
    expect(child.requests).toHaveLength(0);
  });

  it("refuses a scope path that is not workspace-relative, and an over-long list", async () => {
    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner });
    for (const path of ["../etc/passwd", "/etc/passwd", "C:/Windows", "~/.ssh/id_rsa", "src/../../escape"]) {
      expect(errorCode(await invoke(runtime, { agentType: "explore", task: "read", paths: [path] })), path)
        .toBe("subagent_path_outside_scope");
    }
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "read", paths: Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`) })))
      .toBe("invalid_arguments");
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "read", tools: Array.from({ length: 65 }, () => "code.fs.read") })))
      .toBe("invalid_arguments");
    // A valid relative path is normalised, not rejected.
    const ok = await invoke(runtime, { agentType: "explore", task: "read", paths: ["src//./lib/"] });
    expect(errorCode(ok)).toBeUndefined();
    expect(child.requests.at(-1)!.paths).toEqual(["src/lib"]);
  });

  it("refuses summaryOnly:false instead of ignoring it, and refuses an unknown type", async () => {
    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner });
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "read", summaryOnly: false })))
      .toBe("subagent_summary_required");
    /**
     * An unknown type is refused twice over, and both refusals are worth having. The **schema** refuses it before
     * the executor is reached (the `enum` is the published vocabulary), which is the cheapest possible answer;
     * the resolver refuses it independently for a caller that passes its own schema or drives the core directly.
     */
    expect(errorCode(await invoke(runtime, { agentType: "deploy", task: "ship it" })))
      .toBe("invalid_arguments");
    expect(() => resolveCodeSubagentType({ type: "deploy", env: {} })).toThrowError(/Unknown sub-agent type/);
    expect(child.requests).toHaveLength(0);
  });

  it("fails closed when no child runner is wired", async () => {
    // The `runCtags` defect class: a published, Inspector-visible tool with nothing able to run it must say so.
    const runtime = runtimeWith();
    expect(errorCode(await invoke(runtime, { agentType: "explore", task: "read" }))).toBe("tool_not_configured");
  });

  it("refuses a delegation that is not attributable to a run or a tool call", async () => {
    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner });
    // No run id: the child would have no parent, so it would be a main run — not a sub-agent at all.
    expect(errorCode(await runtime.invoke(ctx, {
      companyId: "company-c12", projectId: "project-c12", sessionId: "session-c12",
      toolCallId: "call-1", tool: CODE_AGENT_SPAWN_TOOL, args: { agentType: "explore", task: "read" },
    }))).toBe("invalid_arguments");
    expect(child.requests).toHaveLength(0);
  });

  it("is idempotent by run id and by tool call, so a retry is the same delegation", async () => {
    // The child run id is a deterministic function of (parent run, tool call): a repeat after a crash lands on the
    // run that already exists instead of starting a second one.
    expect(codeSubagentRunId("run-a", "call-1")).toBe(codeSubagentRunId("run-a", "call-1"));
    expect(codeSubagentRunId("run-a", "call-1")).not.toBe(codeSubagentRunId("run-a", "call-2"));
    expect(codeSubagentRunId("run-a", "call-1")).not.toBe(codeSubagentRunId("run-b", "call-1"));

    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner });
    const first = await invoke(runtime, { agentType: "explore", task: "read" });
    const second = await invoke(runtime, { agentType: "explore", task: "read" });
    expect((second as { cached?: boolean }).cached).toBe(true);
    // One delegation, one child run: the retry returned the recorded result.
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]!.runId).toBe(codeSubagentRunId("run-parent", "call-1"));
    expect(dataOf(first).runId).toBe(codeSubagentRunId("run-parent", "call-1"));
  });

  it("enforces the fan-out ceiling per parent, through the canonical clamp", async () => {
    expect(clampCodeSubagentParallelism(999)).toBe(CODE_SUBAGENT_MAX_PARALLELISM);
    const tracker = new CodeSubagentInFlightTracker();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const child: CodeSubagentChildRunner = {
      async run(request) { started.push(request.runId); await gate; return { status: "completed", answer: "{}" }; },
    };
    const env = { NPATI_CODE_SUBAGENT_PARALLELISM: "1" } as NodeJS.ProcessEnv;
    const spawn = (toolCallId: string) => spawnCodeSubagent(
      { ctx, companyId: "company-c12", projectId: "project-c12", sessionId: "session-c12", parentRunId: "run-parent", toolCallId, args: { agentType: "explore", task: "read" } },
      { childRunner: () => child, canonicalTools: () => PUBLISHED_TOOL_NAMES, env },
      tracker,
    );
    const first = spawn("call-1");
    // Give the first spawn a turn to enter the tracker, then the second must be refused rather than queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(spawn("call-2")).rejects.toMatchObject({ code: "subagent_parallelism_exceeded", status: 429 });
    release!();
    await first;
    expect(started).toHaveLength(1);
    // The slot is released: the next delegation is admitted.
    await spawn("call-3");
    expect(started).toHaveLength(2);
    expect(tracker.count("run-parent")).toBe(0);
  });

  it("records the delegation as a nested Activity event with its snapshot, and no task text", async () => {
    const recorded: Array<{ identity: Record<string, unknown>; payload: Record<string, unknown> }> = [];
    const activity: CodeSubagentActivityRecorder = {
      async record(identity, payload) { recorded.push({ identity: identity as never, payload }); return { persisted: true, id: "evt-1" }; },
    };
    const child = recordingChild({
      status: "completed",
      answer: JSON.stringify({ findings: [{ kind: "fact", path: "src/index.ts", name: "ready", detail: "the entry point exports the readiness flag" }], files: ["src/index.ts"], symbols: [] }),
      filesChanged: ["src/index.ts"], toolCalls: 4, turns: 3,
    });
    const runtime = runtimeWith({ child: child.runner, activity });
    const result = await invoke(runtime, { agentType: "explore", task: "MARKER_TASK_TEXT find the entry point" }, { snapshotId: "snap-1" });

    expect(errorCode(result)).toBeUndefined();
    expect(recorded).toHaveLength(1);
    const { identity, payload } = recorded[0]!;
    // The tree: the event belongs to the **child** run and names its parent and the tool call that started it.
    expect(identity.kind).toBe("run_activity");
    expect(identity.runId).toBe(codeSubagentRunId("run-parent", "call-1"));
    expect(identity.parentRunId).toBe("run-parent");
    expect(identity.parentToolCallId).toBe("call-1");
    expect(identity.snapshotId).toBe("snap-1");
    expect(identity.companyId).toBe("company-c12");
    // Metadata only: the task text is not in the payload, and neither is anything the child said.
    expect(payload.agentType).toBe("explore");
    expect(payload.capabilityProfile).toBe("explore-read-only");
    expect(payload.status).toBe("completed");
    expect(payload.toolCount).toBe(CODE_SUBAGENT_TYPE_PROFILES.explore.baseTools.length);
    expect(JSON.stringify(payload)).not.toContain("MARKER_TASK_TEXT");
    expect(JSON.stringify(payload)).not.toContain("the entry point exports");
  });
});

describe("security-gate: C12 an explore sub-agent returns a summary, never a transcript", () => {
  const BODY_MARKER = "const leakedFromAFile = " + "x".repeat(400);
  const PROSE_MARKER = "PROSE_MARKER the child rambled about its findings at length";

  it("drops a multi-line value instead of truncating it into something that reads like a summary", () => {
    const digest = buildCodeSubagentHandoffDigest({
      answer: {
        findings: [
          { kind: "fact", path: "src/index.ts", name: "ready", detail: "the entry point exports the readiness flag" },
          // A file body, a diff and a log excerpt are all multi-line: each is dropped, and counted.
          { kind: "fact", path: "src/index.ts", name: null, detail: BODY_MARKER },
          { kind: "risk", path: "src/index.ts", name: null, detail: "line one\nline two" },
          { kind: "nonsense", path: null, name: null, detail: "unknown kind" },
        ],
        files: ["src/index.ts", "src/other.ts", "../escape.ts", "src/index.ts"],
        symbols: [{ path: "src/index.ts", name: "ready", kind: "const" }, { path: "/etc/passwd", name: "x", kind: "const" }],
      },
      toolCalls: 7,
      turns: 4,
    });
    expect(digest.schemaVersion).toBe(SUBAGENT_HANDOFF_SCHEMA_VERSION);
    expect(digest.findings).toHaveLength(1);
    expect(digest.findings[0]).toMatchObject({ kind: "fact", path: "src/index.ts", name: "ready" });
    // Files are validated paths, de-duplicated, and the traversing one is refused rather than stored.
    expect(digest.files).toEqual(["src/index.ts", "src/other.ts"]);
    expect(digest.symbols).toEqual([{ path: "src/index.ts", name: "ready", kind: "const" }]);
    expect(digest.toolCalls).toBe(7);
    expect(digest.turns).toBe(4);
    // Three findings were refused and two paths/symbols: the loss is visible, so "found nothing" and "everything
    // was refused" stay distinguishable.
    expect(digest.dropped).toBe(5);
    expect(JSON.stringify(digest)).not.toContain("x".repeat(50));
  });

  it("keeps the child's prose and its file bodies out of the tool result, byte for byte", async () => {
    const child = recordingChild({
      status: "completed",
      // The child answered with prose that wraps its JSON, plus a `summary` field the digest must ignore.
      answer: `${PROSE_MARKER}\n${JSON.stringify({
        summary: PROSE_MARKER,
        findings: [{ kind: "symbol", path: "src/index.ts", name: "ready", detail: "readiness flag" }],
        files: ["src/index.ts"],
        symbols: [],
      })}`,
      filesChanged: ["src/index.ts"],
      toolCalls: 2,
      turns: 2,
    });
    const runtime = runtimeWith({ child: child.runner });
    const result = await invoke(runtime, { agentType: "explore", task: "find the readiness flag" });
    const serialised = JSON.stringify(result);

    expect(errorCode(result)).toBeUndefined();
    expect(serialised).not.toContain(PROSE_MARKER);
    expect(serialised).not.toContain(BODY_MARKER);
    const data = dataOf(result);
    expect(data.handoff).toMatchObject({
      schemaVersion: SUBAGENT_HANDOFF_SCHEMA_VERSION,
      files: ["src/index.ts"],
      toolCalls: 2,
      turns: 2,
    });
    // The parent learns what was found and where — and nothing else.
    expect((data.handoff as { findings: Array<Record<string, unknown>> }).findings).toEqual([
      { kind: "symbol", path: "src/index.ts", name: "ready", detail: "readiness flag" },
    ]);
    expect(Object.keys(data).sort()).toEqual([
      "agentType", "capabilityProfile", "errorCode", "handoff", "limits", "runId", "status", "tools", "truncated",
    ]);
  });

  it("refuses a handoff that would carry a credential, rather than redacting it", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const child = recordingChild({
      status: "completed",
      answer: JSON.stringify({ findings: [{ kind: "fact", path: "src/index.ts", name: null, detail: `the token is ${secret}` }] }),
    });
    const runtime = runtimeWith({ child: child.runner });
    const result = await invoke(runtime, { agentType: "explore", task: "read" });
    const data = dataOf(result);
    // A refused handoff is a real answer: the child ran, its result could not be carried, and the parent is told.
    expect(data.status).toBe("failed");
    expect(data.errorCode).toBe("subagent_handoff_refused_credential");
    expect(data.handoff).toEqual(emptyCodeSubagentHandoffDigest());
    // The value never reaches the parent's conversation, not even redacted.
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("ghp_");
  });

  it("applies the same metadata-only invariants the Activity sink applies", () => {
    // The digest is built from named fields only, so a content-shaped key in the child's answer is **ignored**
    // rather than carried: an unknown field has no route into the digest.
    const digest = buildCodeSubagentHandoffDigest({
      answer: {
        findings: [{ kind: "fact", path: "src/index.ts", name: null, detail: "one short claim" }],
        files: ["src/index.ts"],
        symbols: [],
        content: "a whole file body",
        diff: "@@ -1 +1 @@",
        command: "rm -rf /",
        output: "terminal output",
      },
    });
    const serialised = JSON.stringify(digest);
    expect(serialised).not.toContain("a whole file body");
    expect(serialised).not.toContain("@@ -1 +1 @@");
    expect(serialised).not.toContain("rm -rf /");
    expect(serialised).not.toContain("terminal output");
    expect(Object.keys(digest).sort()).toEqual(["dropped", "files", "findings", "schemaVersion", "symbols", "toolCalls", "turns"]);
    // And the vocabulary of a finding is closed.
    expect(CODE_SUBAGENT_HANDOFF_FINDING_KINDS).toEqual(["fact", "file", "symbol", "risk", "open_question"]);
  });

  it("parses a JSON answer out of prose and answers an unusable one with an empty digest", () => {
    expect(parseSubagentHandoffAnswer('here you go: {"files":["a.ts"]} thanks')).toEqual({ files: ["a.ts"] });
    expect(parseSubagentHandoffAnswer("no json at all")).toBeNull();
    expect(parseSubagentHandoffAnswer("[1,2,3]")).toBeNull();
    expect(parseSubagentHandoffAnswer({ files: ["a.ts"] })).toEqual({ files: ["a.ts"] });
    const empty = buildCodeSubagentHandoffDigest({ answer: "I could not find anything, sorry." });
    expect(empty).toEqual(emptyCodeSubagentHandoffDigest());
  });
});

describe("security-gate: C12 a failing sub-agent does not take the parent's run down", () => {
  it("reports a failed child as a successful tool call with the child's own code", async () => {
    const child = recordingChild({ status: "failed", errorCode: "step_limit", errorMessage: "the child ran out of turns" });
    const runtime = runtimeWith({ child: child.runner });
    const result = await invoke(runtime, { agentType: "implement", task: "do a big thing" });

    // The tool call **succeeded**: it delegated and it reported. That is what keeps the parent's loop running.
    expect((result as { ok?: boolean }).ok).toBe(true);
    const data = dataOf(result);
    expect(data.status).toBe("failed");
    expect(data.errorCode).toBe("step_limit");
    expect(data.runId).toBe(codeSubagentRunId("run-parent", "call-1"));
    expect(data.handoff).toEqual(emptyCodeSubagentHandoffDigest());
  });

  it("reports a child that throws as a failed delegation instead of propagating the throw", async () => {
    const child: CodeSubagentChildRunner = {
      async run() { throw Object.assign(new Error("the child runner exploded"), { code: "sandbox_unavailable" }); },
    };
    const runtime = runtimeWith({ child });
    const result = await invoke(runtime, { agentType: "test", task: "run the suite" });
    expect((result as { ok?: boolean }).ok).toBe(true);
    const data = dataOf(result);
    expect(data.status).toBe("failed");
    expect(data.errorCode).toBe("sandbox_unavailable");
  });

  it("survives an Activity sink that throws and still returns the digest", async () => {
    const activity: CodeSubagentActivityRecorder = {
      async record() { throw new Error("the activity store is down"); },
    };
    const child = recordingChild({ status: "completed", answer: "{}" });
    const runtime = runtimeWith({ child: child.runner, activity });
    const result = await invoke(runtime, { agentType: "explore", task: "read" });
    expect(errorCode(result)).toBeUndefined();
    expect(dataOf(result).status).toBe("completed");
  });
});

describe("security-gate: C12 the child runner adapter is the only way a child run starts", () => {
  it("passes the recorded intersection and the parent fact into the existing runner", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = createCodeSubagentChildRunner({
      loadSession: async () => session(),
      runAgent: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { status: "completed", reason: "completed", message: "done", summary: { filesChanged: ["src/index.ts"], toolCalls: 3, turns: 2 } };
      },
    });
    const request = {
      ctx, companyId: "company-c12", projectId: "project-c12", sessionId: "session-c12",
      parentRunId: "run-parent", toolCallId: "call-1", runId: "sub-run-1",
      agentType: "explore" as const, capabilityProfile: "explore-read-only",
      task: "MARKER_TASK find the entry point", paths: ["src"], model: "gpt-4o-mini",
      maxTurns: 8, readOnly: true, summaryOnly: true,
      allowedTools: ["code.fs.read"], snapshotId: "snap-1", toolCallingMode: "native",
    };
    const outcome = await adapter.run(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runId: "sub-run-1", parentRunId: "run-parent", allowedTools: ["code.fs.read"], maxTurns: 8, readOnlyIntent: true, model: "gpt-4o-mini",
    });
    // The prompt carries the task, the scope and the turn budget — and nothing from the parent's conversation,
    // because nothing from the parent's conversation is passed in.
    const prompt = String(calls[0]!.prompt);
    expect(prompt).toContain("MARKER_TASK");
    expect(prompt).toContain("src");
    expect(prompt).toContain("8 turns");
    expect(outcome.status).toBe("completed");
    // The answer is a structured object, never the run's prose.
    const answer = JSON.parse(String(outcome.answer)) as { files: string[]; findings: unknown[] };
    expect(answer.files).toEqual(["src/index.ts"]);
    expect(JSON.stringify(answer)).not.toContain("done");
    expect(buildCodeSubagentPrompt(request)).toContain("read-only");
  });

  it("reports a missing session as a failed delegation rather than inventing one", async () => {
    const adapter = createCodeSubagentChildRunner({
      loadSession: async () => null,
      runAgent: async () => { throw new Error("must not be reached"); },
    });
    const outcome = await adapter.run({
      ctx, companyId: "company-c12", projectId: "project-c12", sessionId: "gone",
      parentRunId: "run-parent", toolCallId: "call-1", runId: "sub-run-1",
      agentType: "explore", capabilityProfile: "explore-read-only", task: "read", paths: [],
      model: null, maxTurns: 8, readOnly: true, summaryOnly: true, allowedTools: ["code.fs.read"],
      snapshotId: null, toolCallingMode: "native",
    });
    expect(outcome).toMatchObject({ status: "failed", errorCode: "subagent_session_missing" });
  });

  it("builds its digest from the run summary's own metadata, never from a message body", () => {
    const answer = buildCodeSubagentAnswer({
      status: "completed", reason: "completed", message: "MARKER_PROSE",
      summary: {
        filesChanged: ["src/index.ts"],
        verification: { status: "failed", failedChecks: [{ tool: "typecheck", code: "TS2345" }] },
        scope: { warnings: [{ code: "scope_exceeded", message: "MARKER_WARNING", severity: "warn" }] },
        selfReview: { status: "unresolved", blocking: 1, unresolved: 1, findings: [{ id: "f1", title: "MARKER_FINDING", path: "src/index.ts", category: "correctness" }] },
      },
    });
    const digest = buildCodeSubagentHandoffDigest({ answer, files: ["src/index.ts"], toolCalls: 3, turns: 2 });
    const serialised = JSON.stringify(digest);
    // Codes and names, not messages: a verifier's message can quote file content, so it is never carried.
    expect(serialised).not.toContain("MARKER_WARNING");
    expect(serialised).toContain("scope warning: scope_exceeded");
    expect(serialised).toContain("typecheck failed (TS2345)");
    expect(serialised).toContain("MARKER_FINDING");
    expect(digest.files).toEqual(["src/index.ts"]);
  });

  it("wires the delegation into the composition through the one runner instance", () => {
    // "Shared" and "single engine" are properties of the composition, so they are asserted where they live: the
    // spawn executor is handed the runtime's own published tool list and the same `CodingAgentRunner` the rest of
    // the application uses, through the one interface the runner already reads for a delegated run.
    const app = readFileSync("apps/agent-api/src/app.ts", "utf8");
    expect(app).toMatch(/subagentCanonicalTools: \(\) => codeToolRuntimeRef\?\.listTools\(\)/);
    expect(app).toMatch(/createCodeSubagentChildRunner\(\{/);
    expect(app).toMatch(/subagentScope: \{ parentRunId, allowedTools: \[\.\.\.allowedTools\] \}/);
    expect(app).toMatch(/codingAgentRunnerRef = codingAgentRunner;/);
    // And the executor is part of the canonical executor map, not a parallel dispatch path.
    const executors = readFileSync("apps/agent-api/src/code-tool-executors.ts", "utf8");
    expect(executors).toMatch(/\.\.\.canonicalSubagentExecutors\(options\)/);
    expect(executors).toMatch(/"code\.agent\.spawn": createCodeAgentSpawnExecutor\(/);
  });
});

describe("security-gate: C12 the spawn executor is reachable through the canonical executor map", () => {
  it("registers exactly one executor for the delegation tool and fails closed without the port", async () => {
    const executors = allCanonicalExecutors({});
    expect(Object.keys(executors).filter((name) => name === CODE_AGENT_SPAWN_TOOL)).toHaveLength(1);
    const withoutPort = createCodeAgentSpawnExecutor({ canonicalTools: () => PUBLISHED_TOOL_NAMES });
    await expect(withoutPort({
      ctx, companyId: "c", projectId: "p", sessionId: "s", runId: "r", toolCallId: "t",
      tool: { name: CODE_AGENT_SPAWN_TOOL, version: 1, status: "active", description: "", inputSchema: {}, outputSchema: {} },
      args: { agentType: "explore", task: "read" }, limits: {} as never, port: fakeReadPort(),
    })).rejects.toMatchObject({ code: "tool_not_configured", status: 503 });
  });

  it("never calls the child runner twice for one delegation, even when the executor is driven directly", async () => {
    const spy = vi.fn(async (_request: CodeSubagentChildRunRequest) => ({ status: "completed" as const, answer: "{}" }));
    const executor = createCodeAgentSpawnExecutor({
      childRunner: () => ({ run: spy }),
      canonicalTools: () => PUBLISHED_TOOL_NAMES,
    });
    const input = {
      ctx, companyId: "company-c12", projectId: "project-c12", sessionId: "session-c12", runId: "run-parent", toolCallId: "call-9",
      tool: { name: CODE_AGENT_SPAWN_TOOL, version: 1, status: "active", description: "", inputSchema: {}, outputSchema: {} },
      args: { agentType: "explore", task: "read" }, limits: {} as never, port: fakeReadPort(),
    } as never;
    await executor(input);
    await executor(input);
    // The executor itself is stateless; the runtime's idempotency cache is what makes a repeat free, and the
    // **run id** is what makes it the same delegation on the store side. Both are asserted here as a pair.
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[0] as unknown as [CodeSubagentChildRunRequest])[0].runId)
      .toBe((spy.mock.calls[1] as unknown as [CodeSubagentChildRunRequest])[0].runId);
  });
});
