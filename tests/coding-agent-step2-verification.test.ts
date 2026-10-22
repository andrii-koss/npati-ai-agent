import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import type { CodeToolInvokeFailure, CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import {
  classifyVerificationChange,
  planVerification,
  verificationFingerprint,
} from "../apps/agent-api/src/code-verification-plan";
import {
  createCodeRunEnvironmentHolder,
  CodingAgentRunner,
  type CodeRunToolDescriptor,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * Step 2 — selective verification and revision-bound reuse.
 *
 * The pure selection/fingerprint tests run without a runner; the scenario tests drive the real
 * `CodingAgentRunner` + review coordinator through a scripted engine and an in-memory verification runtime.
 * Nothing here touches a workspace, a sandbox, a provider or a database.
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
  { name: "code.fs.edit", version: 1, status: "active", description: "edit a file", write: true },
  { name: "code.verify.run", version: 1, status: "active", description: "run checks", write: false },
];

const SCHEMAS = TOOLS.map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}));

function nativeCall(name: string, args: Record<string, unknown>, id = `call-${name}`) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

describe("Step 2 — which checks a change set needs", () => {
  it("keeps the build for a stylesheet change and drops only the test command", () => {
    const plan = planVerification({ requestedTools: ["build", "test"], changedPaths: ["assets/styles.css"] });
    expect(plan.tools).toEqual(["build"]);
    expect(plan.skipped).toEqual([{ tool: "test", reason: "presentation_only_change" }]);
    expect(plan.reason).toBe("presentation_only");
  });

  it("keeps typecheck for a stylesheet change when tests are the only other check", () => {
    const plan = planVerification({ requestedTools: ["typecheck", "test"], changedPaths: ["src/app/globals.css"] });
    expect(plan.tools).toEqual(["typecheck"]);
    expect(plan.skipped.map((entry) => entry.tool)).toEqual(["test"]);
  });

  it("never drops the only requested check", () => {
    const plan = planVerification({ requestedTools: ["test"], changedPaths: ["styles.css"] });
    expect(plan.tools).toEqual(["test"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.reason).toBe("significant_change");
  });

  it("treats assets as presentation and source as significant", () => {
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["public/hero.webp"] }).tools).toEqual(["build"]);
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["src/App.tsx"] }).tools).toEqual(["build", "test"]);
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["src/index.ts"] }).tools).toEqual(["build", "test"]);
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["package.json"] }).tools).toEqual(["build", "test"]);
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["pnpm-lock.yaml"] }).tools).toEqual(["build", "test"]);
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["src/App.test.tsx"] }).tools).toEqual(["build", "test"]);
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: ["mystery.file"] }).tools).toEqual(["build", "test"]);
  });

  it("keeps every check when a single significant file is mixed into a stylesheet change", () => {
    const plan = planVerification({ requestedTools: ["build", "test"], changedPaths: ["assets/styles.css", "src/App.tsx"] });
    expect(plan.tools).toEqual(["build", "test"]);
    expect(plan.reason).toBe("significant_change");
  });

  it("keeps every check when nothing changed or nothing was requested", () => {
    expect(planVerification({ requestedTools: ["build", "test"], changedPaths: [] })).toMatchObject({
      tools: ["build", "test"], skipped: [], reason: "no_changes",
    });
    expect(planVerification({ requestedTools: [], changedPaths: ["a.css"] })).toMatchObject({ tools: [], reason: "no_changes" });
  });

  it("classifies dependency, test, style, asset and source paths", () => {
    expect(classifyVerificationChange("package.json")).toBe("dependency");
    expect(classifyVerificationChange("yarn.lock")).toBe("dependency");
    expect(classifyVerificationChange("tests/unit/thing.test.ts")).toBe("test");
    expect(classifyVerificationChange("styles/theme.scss")).toBe("style");
    expect(classifyVerificationChange("public/logo.svg")).toBe("asset");
    expect(classifyVerificationChange("src/component.tsx")).toBe("source");
    expect(classifyVerificationChange("unknown.bin")).toBe("unknown");
  });

  it("binds the reuse fingerprint to revision, checks, image and change signature", () => {
    const base = { revision: "R1", tools: ["typecheck", "test"], sandboxImage: "sha256:img", changeSignature: "a.ts:1" };
    const fingerprint = verificationFingerprint(base);
    expect(verificationFingerprint(base)).toBe(fingerprint);
    expect(verificationFingerprint({ ...base, revision: "R2" })).not.toBe(fingerprint);
    expect(verificationFingerprint({ ...base, tools: ["typecheck"] })).not.toBe(fingerprint);
    expect(verificationFingerprint({ ...base, sandboxImage: "sha256:other" })).not.toBe(fingerprint);
    expect(verificationFingerprint({ ...base, changeSignature: "a.ts:2" })).not.toBe(fingerprint);
    // `code.verify.run` is the same tool for both check sets, so the fingerprint is what keeps them apart.
    expect(verificationFingerprint({ ...base, tools: ["build"] })).not.toBe(
      verificationFingerprint({ ...base, tools: ["test"] }),
    );
  });
});

interface HarnessOptions {
  script: Array<ChatResult | Error>;
  /** Paths reported by the turn summary; they drive the selection plan. */
  changes?: Array<{ path: string; tool: string; status?: string; diff?: string }>;
  verificationTools?: readonly string[];
  revision?: () => string | null;
  limits?: Partial<CodeAgentLimits>;
  /** Called for every verification invocation with the tools the coordinator asked for. */
  onVerify?: (tools: string[]) => CodeToolInvokeResult | CodeToolInvokeFailure;
}

function okVerify(tools: readonly string[]): CodeToolInvokeResult {
  return {
    ok: true,
    tool: "code.verify.run",
    toolVersion: 1,
    schemaVersion: 1,
    result: { checks: tools.map((tool) => ({ tool, passed: true })) },
    truncated: false,
    durationMs: 1,
  } as CodeToolInvokeResult;
}

function failedVerify(tools: readonly string[], message: string): CodeToolInvokeFailure {
  return {
    ok: false,
    error: {
      code: "verify_failed" as CodeToolInvokeFailure["error"]["code"],
      status: 500,
      message,
      tool: "code.verify.run",
      step: "execute",
      retryable: false,
    },
  } as CodeToolInvokeFailure;
}

function createHarness(options: HarnessOptions) {
  const invocations: Array<{ tool: string; toolCallId: string; args: Record<string, unknown> }> = [];
  const engineMessages: Array<Array<{ role: string; content: unknown }>> = [];
  const script = [...options.script];

  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      ...(options.revision ? { verificationRevision: async () => options.revision!() } : {}),
      listTools: () => TOOLS,
      invoke: async (_ctx, input) => {
        const args = (input.args ?? {}) as Record<string, unknown>;
        invocations.push({ tool: input.tool, toolCallId: input.toolCallId, args });
        if (input.tool === "code.verify.run") {
          const tools = Array.isArray(args.tools) ? args.tools.map(String) : [];
          return options.onVerify ? options.onVerify(tools) : okVerify(tools);
        }
        return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 1 } as CodeToolInvokeResult;
      },
      turnSummary: () => ({
        files: (options.changes ?? []).length,
        linesAdded: 1,
        linesRemoved: 1,
        changes: (options.changes ?? [{ path: "src/a.ts", tool: "code.fs.edit", status: "modified" }]).map(change => ({ ...change, diff: change.diff ?? "@@ -1 +1 @@\n-before\n+after\n" })),
      }),
    },
    engine: {
      chat: async (request) => {
        // Review has its own no-tools contract and must not consume the scripted implementation turns.
        if (!request.tools?.length) return { content: JSON.stringify({ status: "clean", findings: [] }) };
        engineMessages.push((request.messages ?? []) as Array<{ role: string; content: unknown }>);
        return script.shift() ?? { content: "done" };
      },
    },
    schemas: SCHEMAS,
    imageAdmission: { admit: async () => ({ reference: "npati/sandbox-node-1@sha256:abc", dev: false }) },
    activity: { record: async () => undefined },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    limits: { maxStepsPerRun: 12, maxRunMinutes: 5, parallelReadOnlyCalls: 8, repairLoopAttempts: 3, maxChangedFiles: 25, ...(options.limits ?? {}) },
    environment: createCodeRunEnvironmentHolder(),
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
  };

  const runner = new CodingAgentRunner(ports);
  return {
    invocations,
    engineMessages,
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({
        ctx,
        session: session(),
        prompt: "change the site",
        turnId: "turn-2",
        ...(options.verificationTools ? { verificationTools: options.verificationTools } : {}),
        ...input,
      }),
  };
}

const editThenFinish: ChatResult[] = [
  { content: "editing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
  { content: "all done" },
];
const verifyCalls = (harness: { invocations: Array<{ tool: string }> }) =>
  harness.invocations.filter((entry) => entry.tool === "code.verify.run");

describe("Step 2 — the eight baseline scenarios", () => {
  it("1. a single CSS change runs the compile gate, not the whole test suite", async () => {
    const harness = createHarness({
      script: [
        { content: "restyle", toolCalls: [nativeCall("code.fs.edit", { path: "assets/styles.css" })] },
        { content: "done" },
      ],
      changes: [{ path: "assets/styles.css", tool: "code.fs.edit", status: "modified" }],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(result.verification?.status).toBe("passed");
    expect(verifyCalls(harness)).toHaveLength(1);
    expect(verifyCalls(harness)[0]?.args.tools).toEqual(["typecheck"]);
    expect(result.verification?.executedTools).toEqual(["typecheck"]);
    expect(result.verification?.skippedChecks).toEqual([{ tool: "test", reason: "presentation_only_change" }]);
    expect(result.verification?.requestedTools).toEqual(["typecheck", "test"]);
  });

  it("2. a React component change keeps every requested check", async () => {
    const harness = createHarness({
      script: [
        { content: "component", toolCalls: [nativeCall("code.fs.edit", { path: "src/components/Button.tsx" })] },
        { content: "done" },
      ],
      changes: [{ path: "src/components/Button.tsx", tool: "code.fs.edit", status: "modified" }],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(verifyCalls(harness)).toHaveLength(1);
    expect(verifyCalls(harness)[0]?.args.tools).toEqual(["typecheck", "test"]);
    expect(result.verification?.skippedChecks).toEqual([]);
  });

  it("3. a TypeScript change keeps every requested check", async () => {
    const harness = createHarness({
      script: [
        { content: "type", toolCalls: [nativeCall("code.fs.edit", { path: "src/lib/money.ts" })] },
        { content: "done" },
      ],
      changes: [{ path: "src/lib/money.ts", tool: "code.fs.edit", status: "modified" }],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(verifyCalls(harness)[0]?.args.tools).toEqual(["typecheck", "test"]);
  });

  it("4. a dependency change forces the full set even when styles also changed", async () => {
    const harness = createHarness({
      script: [
        { content: "deps", toolCalls: [nativeCall("code.fs.edit", { path: "package.json" })] },
        { content: "done" },
      ],
      changes: [
        { path: "package.json", tool: "code.fs.edit", status: "modified" },
        { path: "assets/styles.css", tool: "code.fs.edit", status: "modified" },
      ],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(verifyCalls(harness)[0]?.args.tools).toEqual(["typecheck", "test"]);
    expect(result.verification?.skippedChecks).toEqual([]);
  });

  it("5. re-verifying an unchanged revision reuses the recorded result instead of rebuilding", async () => {
    const harness = createHarness({
      script: [
        { content: "editing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
        { content: "checking", toolCalls: [nativeCall("code.verify.run", { path: ".", tools: ["typecheck", "test"] })] },
        { content: "done" },
      ],
      revision: () => "revision-a",
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run({ forceVerification: true });

    expect(result.status).toBe("completed");
    // The model's own verification is the only execution; the backend decision reuses it.
    expect(verifyCalls(harness)).toHaveLength(1);
    expect(verifyCalls(harness)[0]?.toolCallId).toBe("call-code.verify.run");
    expect(result.verification?.reused).toBe(true);
    expect(result.verification?.verificationRuns).toBe(1);
  });

  it("6. a revision that moves after a successful verification forces a rebuild", async () => {
    let revision = "revision-a";
    const harness = createHarness({
      script: [
        { content: "editing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
        { content: "checking", toolCalls: [nativeCall("code.verify.run", { path: ".", tools: ["typecheck", "test"] })] },
        { content: "more work", toolCalls: [nativeCall("code.fs.edit", { path: "src/b.ts" })] },
        { content: "done" },
      ],
      revision: () => revision,
      verificationTools: ["typecheck", "test"],
      onVerify: (tools) => {
        // The pass is recorded against revision-a; the workspace then moves to revision-b before the decision.
        const result = okVerify(tools);
        revision = "revision-b";
        return result;
      },
    });
    const result = await harness.run({ forceVerification: true });

    expect(result.status).toBe("completed");
    expect(verifyCalls(harness)).toHaveLength(2);
    expect(result.verification?.reused).toBe(false);
  });

  it("7. a failing build keeps the repair cycle and stops only when the budget is spent", async () => {
    let attempt = 0;
    const harness = createHarness({
      script: [
        { content: "editing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
        { content: "done" },
        { content: "repairing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
        { content: "done" },
      ],
      verificationTools: ["typecheck", "test"],
      onVerify: (tools) => {
        attempt += 1;
        return attempt === 1 ? failedVerify(tools, "1 type error") : okVerify(tools);
      },
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(result.verification?.attemptsUsed).toBe(1);
    expect(verifyCalls(harness)).toHaveLength(2);
    // The repair instruction names the failure, and the model is never told the failing check passed.
    const repairTurn = harness.engineMessages[2] ?? [];
    const repairText = repairTurn.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    expect(repairText).toContain("Verification failed (repair attempt 1");
    expect(repairText).toContain("typecheck");
  });

  it("8. a narrowed or partial pass is never reused for the full check set", async () => {
    const harness = createHarness({
      script: [
        { content: "editing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
        { content: "checking", toolCalls: [nativeCall("code.verify.run", { path: ".", tools: ["typecheck"] })] },
        { content: "done" },
      ],
      revision: () => "revision-a",
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run({ forceVerification: true });

    expect(result.status).toBe("completed");
    // The model's partial pass covered only typecheck, so the backend still runs the full set.
    expect(verifyCalls(harness)).toHaveLength(2);
    expect(verifyCalls(harness)[0]?.args.tools).toEqual(["typecheck"]);
    expect(verifyCalls(harness)[1]?.args.tools).toEqual(["typecheck", "test"]);
    expect(result.verification?.requestedTools).toEqual(["typecheck", "test"]);
  });

  it("9. a website build is never dropped, so Live Preview keeps its evidence", async () => {
    const harness = createHarness({
      script: [
        { content: "restyle", toolCalls: [nativeCall("code.fs.edit", { path: "styles/globals.css" })] },
        { content: "done" },
      ],
      changes: [{ path: "styles/globals.css", tool: "code.fs.edit", status: "modified" }],
      verificationTools: ["build"],
    });
    const result = await harness.run({ forceVerification: true });

    expect(result.status).toBe("completed");
    expect(verifyCalls(harness)).toHaveLength(1);
    expect(verifyCalls(harness)[0]?.args.tools).toEqual(["build"]);
    expect(result.verification?.executedTools).toEqual(["build"]);
    expect(result.verification?.requestedTools).toContain("build");
    expect(result.verification?.status).toBe("passed");
  });
});
