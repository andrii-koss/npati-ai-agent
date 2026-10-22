import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import type { CodeToolInvokeFailure, CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import { assertNoSensitiveRunState } from "../apps/agent-api/src/code-run-state";
import {
  CODE_RUN_START_ACTION,
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodeRunToolDescriptor,
  type CodingAgentChatRequest,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

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
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    // Required on purpose: the argument-correction test needs schema validation to reject a call.
    required: ["path"],
  },
}));

function nativeCall(name: string, args: Record<string, unknown>, id = `call-${name}`) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function okResult(tool: string, result: unknown = { ok: true }): CodeToolInvokeResult {
  return { ok: true, tool, toolVersion: 1, schemaVersion: 1, result, truncated: false, durationMs: 1 } as CodeToolInvokeResult;
}

function failResult(tool: string, code: string, message = "failed"): CodeToolInvokeFailure {
  return {
    ok: false,
    error: { code: code as CodeToolInvokeFailure["error"]["code"], status: 500, message, tool, step: "execute", retryable: false },
  } as CodeToolInvokeFailure;
}

interface ChangeRow {
  path: string;
  tool: string;
  status?: string;
  diff?: string;
}

interface HarnessOptions {
  script?: Array<ChatResult | Error>;
  changes?: ChangeRow[];
  quota?: CodingAgentRunnerPorts["quota"];
  revision?: () => string | null;
  modelRequest?: (request: CodingAgentChatRequest) => void;
  readResult?: unknown;
  verify?: () => CodeToolInvokeResult | CodeToolInvokeFailure;
  limits?: Partial<CodeAgentLimits>;
  verificationTools?: readonly string[];
}

function createHarness(options: HarnessOptions = {}) {
  const engineCalls: CodingAgentChatRequest[] = [];
  const invocations: Array<{ tool: string; toolCallId: string }> = [];
  const activity: Array<Record<string, unknown>> = [];
  const releases: string[] = [];
  const environmentHolder = createCodeRunEnvironmentHolder();
  const script = [...(options.script ?? [{ content: "done" }])];

  const toolRuntime: CodingAgentRunnerPorts["toolRuntime"] = {
    ...(options.revision ? {verificationRevision:async()=>options.revision!()} : {}),
    listTools: () => TOOLS.map((tool) => ({ ...tool })),
    invoke: async (_ctx, input) => {
      invocations.push({ tool: input.tool, toolCallId: input.toolCallId });
      if (input.tool === "code.verify.run") {
        return options.verify ? options.verify() : okResult("code.verify.run", { checks: [{ tool: "typecheck", passed: true }, { tool: "test", passed: true }] });
      }
      return okResult(input.tool,input.tool==="code.fs.read" && options.readResult ? options.readResult : undefined);
    },
    turnSummary: () => ({
      files: (options.changes ?? []).length,
      linesAdded: 1,
      linesRemoved: 1,
      changes: (options.changes ?? [{ path: "src/a.ts", tool: "code.fs.edit", status: "modified" }]).map(change => ({ ...change, diff: change.diff ?? "@@ -1 +1 @@\n-before\n+after\n" })),
    }),
  };

  const ports: CodingAgentRunnerPorts = {
    ...(options.quota ? {quota:options.quota} : {}),
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime,
    engine: {
      chat: async (request) => {
        // Review has its own no-tools contract and must not consume the scripted implementation turns.
        if (!request.tools?.length) return { content: JSON.stringify({ status: "clean", findings: [] }) };
        engineCalls.push(request);options.modelRequest?.(request);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next ?? { content: "done" };
      },
    },
    schemas: SCHEMAS,
    imageAdmission: { admit: async () => ({ reference: "npati/sandbox-node-1@sha256:abc", dev: false }) },
    activity: { record: async (event) => { activity.push(event as unknown as Record<string, unknown>); } },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async (input) => { releases.push(input.reason); } },
    limits: {
      maxStepsPerRun: 12,
      maxRunMinutes: 5,
      parallelReadOnlyCalls: 8,
      repairLoopAttempts: 3,
      maxChangedFiles: 25,
      ...(options.limits ?? {}),
    },
    environment: environmentHolder,
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
  };

  const runner = new CodingAgentRunner(ports);
  return {
    engineCalls,
    invocations,
    activity,
    releases,
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({
        ctx,
        session: session(),
        prompt: "fix the failing test in src/a.ts",
        turnId: "turn-1",
        ...(options.verificationTools ? { verificationTools: options.verificationTools } : {}),
        ...input,
      }),
  };
}

const editThenFinish: Array<ChatResult> = [
  { content: "editing", toolCalls: [nativeCall("code.fs.edit", { path: "src/a.ts" })] },
  { content: "all done" },
];

it("finishes and verifies beyond the obsolete 16-turn chat override within the configured budget", async () => {
  const reads: ChatResult[] = Array.from({ length: 16 }, (_, index) => ({ content: "", toolCalls: [nativeCall("code.fs.read", { path: `src/file-${index}.ts` }, `read-${index}`)] }));
  const harness = createHarness({ script: [...reads, ...editThenFinish], limits: { maxStepsPerRun: 40 } });
  const result = await harness.run();
  expect(result.status).toBe("completed");
  expect(result.verification?.status).toBe("passed");
  expect(harness.invocations.filter(entry => entry.tool === "code.verify.run")).toHaveLength(1);
  expect(harness.engineCalls).toHaveLength(18);
});

describe("security-gate: C9 runner — verification runs after a change and can repair", () => {
  it("verifies the change and reports a clean pass", async () => {
    const harness = createHarness({ script: editThenFinish });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(result.reason).toBe("completed");
    expect(result.verification?.status).toBe("passed");
    expect(result.verification?.verificationRuns).toBe(1);
    expect(result.verification?.attemptsUsed).toBe(0);
    expect(result.verification?.requestedTools).toEqual(["typecheck", "test"]);
    // The canonical tool runtime is what ran the check — not a private path inside the runner.
    expect(harness.invocations.filter((entry) => entry.tool === "code.verify.run")).toHaveLength(1);
  });

  it("sends the failure back to the model, then stops after the repair limit", async () => {
    const harness = createHarness({
      script: editThenFinish,
      limits: { repairLoopAttempts: 2 },
      verify: () => failResult("code.verify.run", "verify_failed", "2 tests failed"),
    });
    const result = await harness.run();

    // Two repair rounds happened, each one a real extra model call, and then the run stopped.
    expect(result.status).toBe("stopped");
    expect(result.reason).toBe("verification_failed");
    expect(result.verification?.attemptsUsed).toBe(2);
    expect(result.verification?.status).toBe("failed");
    expect(result.verification?.failedChecks.map((check) => check.tool).sort()).toEqual(["test", "typecheck"]);
    // Four model calls: the turn that made the edit, the turn that stopped calling tools (which triggered the
    // first verification) and one call per repair round. The repair count is what the limit governs — 2 here.
    expect(harness.engineCalls.length).toBe(4);
    expect(harness.engineCalls.length - 2).toBe(result.verification?.attemptsUsed);
    // The repair instruction reached the model's conversation and names the failing check.
    const repairTurn = harness.engineCalls[3];
    const instruction = (repairTurn?.messages ?? []).map((message) => String(message.content)).join("\n");
    expect(instruction).toContain("Verification failed");
    expect(instruction).toContain("Do not delete, skip or weaken a test");
    expect(result.reason).toBe("verification_failed");
  });

  it("stops without repairing when verification needs a human approval", async () => {
    const harness = createHarness({
      script: editThenFinish,
      verify: () => failResult("code.verify.run", "approval_required", "approval required"),
    });
    const result = await harness.run();

    expect(result.status).toBe("stopped");
    expect(result.verification?.status).toBe("approval_required");
    expect(result.verification?.attemptsUsed).toBe(0);
    // No repair turn: the runner must not work around a decision that belongs to a human.
    expect(harness.engineCalls.length).toBe(2);
  });

  it("does not claim a verification that could not run", async () => {
    const harness = createHarness({
      script: editThenFinish,
      verify: () => failResult("code.verify.run", "tool_not_configured", "no verification runner"),
    });
    const result = await harness.run();

    expect(result.status).toBe("stopped");
    expect(result.verification?.status).toBe("unavailable");
    expect(result.summary.remaining).toBe("verification_unavailable");
    expect(harness.engineCalls.length).toBe(2);
  });

  it("does not verify at all when the caller opted out", async () => {
    const harness = createHarness({ script: editThenFinish, verificationTools: [] });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(result.verification).toBeUndefined();
    expect(harness.invocations.filter((entry) => entry.tool === "code.verify.run")).toHaveLength(0);
  });

  it("does not verify when the run changed nothing", async () => {
    const harness = createHarness({ script: [{ content: "nothing to do" }], changes: [] });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(harness.invocations.filter((entry) => entry.tool === "code.verify.run")).toHaveLength(0);
  });
});

describe("security-gate: C9 runner — a green build over a weakened suite is not a clean pass", () => {
  it("flags a deleted test even though verification passed", async () => {
    const harness = createHarness({
      script: editThenFinish,
      changes: [
        { path: "src/a.ts", tool: "code.fs.edit", status: "modified" },
        { path: "tests/a.test.ts", tool: "code.fs.delete", status: "deleted" },
      ],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    // The checks passed, so `verification.status` would be "passed" — except that the change removed a test.
    expect(result.verification?.status).toBe("passed_with_unjustified_test_changes");
    expect(result.verification?.testIntegrity?.flagged).toBe(true);
    expect(result.verification?.testIntegrity?.justificationProvided).toBe(false);
    expect(result.verification?.testIntegrity?.testFilesDeleted).toEqual(["tests/a.test.ts"]);
    expect(result.verification?.testIntegrity?.findings.map((finding) => finding.kind)).toContain("test_file_deleted");
    // The finding is in Activity too, where a reviewer will see it.
    expect(harness.activity.some((event) => event.reason === "test_integrity_flagged")).toBe(true);
  });

  it("flags a skipped test introduced to make the suite pass", async () => {
    const harness = createHarness({
      script: editThenFinish,
      changes: [
        {
          path: "tests/a.test.ts",
          tool: "code.fs.edit",
          status: "modified",
          diff: [
            "--- a/tests/a.test.ts",
            "+++ b/tests/a.test.ts",
            '@@ -1,3 +1,3 @@',
            '-  it("works", () => { expect(a).toBe(1); });',
            '+  it.skip("works", () => { expect(a).toBe(1); });',
          ].join("\n"),
        },
      ],
    });
    const result = await harness.run();

    expect(result.verification?.status).toBe("passed_with_unjustified_test_changes");
    expect(result.verification?.testIntegrity?.findings.map((finding) => finding.kind)).toContain("test_skipped");
  });

  it("reports a clean pass when the change set does not touch tests", async () => {
    const harness = createHarness({ script: editThenFinish });
    const result = await harness.run();
    expect(result.verification?.status).toBe("passed");
    expect(result.verification?.testIntegrity?.flagged).toBe(false);
  });

  it("keeps the persisted verification record metadata-only", async () => {
    // The verification outcome is stamped into the run state alongside the estimate, so it must survive the
    // run-state guard: tool names, codes and paths are metadata, and a verifier's message must not ride along.
    const harness = createHarness({
      script: editThenFinish,
      verify: () => failResult("code.verify.run", "verify_failed", "FAIL src/a.test.ts > adds: expected 1 to be 2"),
      limits: { repairLoopAttempts: 1 },
    });
    const result = await harness.run();

    const persisted = { estimate: { tokenCount: 0, costUsd: null, turns: 1, toolCalls: 1, filesChanged: 1, diffStats: { files: 1, linesAdded: 1, linesRemoved: 1 }, verification: result.verification, scope: result.scope } };
    expect(() => assertNoSensitiveRunState(persisted)).not.toThrow();
    // The failing check is identified by name and code...
    expect(JSON.stringify(result.verification)).toContain("verify_failed");
    // ...while the verifier's own message (which can quote file content) stays out of the persisted shape.
    expect(JSON.stringify(result.verification)).not.toContain("expected 1 to be 2");
    // The model still receives it, because that is conversation rather than a metadata record.
    const lastCall = harness.engineCalls[harness.engineCalls.length - 1];
    const instruction = (lastCall?.messages ?? []).map((message) => String(message.content)).join("\n");
    expect(instruction).toContain("expected 1 to be 2");
  });
});

describe("security-gate: C9 runner — scope guard and the separation from argument corrections", () => {
  it("warns in the summary when the change set exceeds the configured limit", async () => {
    const harness = createHarness({
      script: editThenFinish,
      limits: { maxChangedFiles: 1 },
      changes: [
        { path: "src/a.ts", tool: "code.fs.edit", status: "modified" },
        { path: "src/b.ts", tool: "code.fs.edit", status: "modified" },
      ],
    });
    const result = await harness.run();

    expect(result.scope?.exceeded).toBe(true);
    expect(result.scope?.changedFiles).toBe(2);
    expect(result.scope?.warnings.map((warning) => warning.code)).toContain("scope_exceeded");
    // A warning never changes the outcome of the run.
    expect(result.status).toBe("completed");
  });

  it("stays silent when the change set is inside the limit", async () => {
    const harness = createHarness({ script: editThenFinish, limits: { maxChangedFiles: 25 } });
    const result = await harness.run();
    expect(result.scope?.exceeded).toBe(false);
    expect(result.scope?.warnings).toEqual([]);
  });

  it("keeps the argument-correction loop and the repair loop apart", async () => {
    // The model keeps sending arguments that fail schema validation. That is the C6 argument-correction loop,
    // and it must exhaust *itself* — it must not spend the verification budget, and the run must not be
    // reported as a verification failure.
    const harness = createHarness({
      script: [
        { content: "trying", toolCalls: [nativeCall("code.fs.edit", {}, "bad-1")] },
        { content: "trying", toolCalls: [nativeCall("code.fs.edit", {}, "bad-2")] },
        { content: "trying", toolCalls: [nativeCall("code.fs.edit", {}, "bad-3")] },
        { content: "trying", toolCalls: [nativeCall("code.fs.edit", {}, "bad-4")] },
      ],
    });
    const result = await harness.run();

    expect(result.reason).toBe("invalid_arguments_exhausted");
    expect(result.verification).toBeUndefined();
    expect(harness.invocations.filter((entry) => entry.tool === "code.verify.run")).toHaveLength(0);
  });
});

it("reuses a successful model-requested build only for the same canonical workspace revision",async()=>{
 const harness=createHarness({revision:()=>"revision-a",verificationTools:["build"],verify:()=>okResult("code.verify.run",{kind:"tool_result",data:{results:[{tool:"build",ok:true}],stats:{failed:0}}}),script:[{toolCalls:[nativeCall("code.fs.edit",{path:"src/a.ts",find:"old",replacement:"new"})]},{toolCalls:[nativeCall("code.verify.run",{path:".",tools:["build"]})]},{content:"Done"}]});
 const result=await harness.run({forceVerification:true});expect(result.status).toBe("completed");expect(harness.invocations.filter(call=>call.tool==="code.verify.run")).toHaveLength(1);expect(harness.invocations.find(call=>call.tool==="code.verify.run")?.toolCallId).toBe("call-code.verify.run");
});
it("rebuilds when the canonical source changes after model verification",async()=>{
 let reads=0;const harness=createHarness({revision:()=>++reads<=2?"revision-a":"revision-b",verificationTools:["build"],verify:()=>okResult("code.verify.run",{results:[{tool:"build",ok:true}]}),script:[{toolCalls:[nativeCall("code.fs.edit",{path:"src/a.ts",find:"old",replacement:"new"})]},{toolCalls:[nativeCall("code.verify.run",{path:".",tools:["build"]})]},{content:"Done"}]});
 const result=await harness.run({forceVerification:true});expect(result.status).toBe("completed");expect(harness.invocations.filter(call=>call.tool==="code.verify.run"),JSON.stringify({reads,all:harness.invocations})).toHaveLength(2);
});
it("does not reuse a partial check report or a failed build",async()=>{
 let checks=0;const harness=createHarness({revision:()=>"a",verificationTools:["build","test"],verify:()=>okResult("code.verify.run",++checks===1?{results:[{tool:"build",ok:true}]}:{results:[{tool:"build",ok:true},{tool:"test",ok:true}]}),script:[{toolCalls:[nativeCall("code.fs.edit",{path:"src/a.ts",find:"old",replacement:"new"})]},{toolCalls:[nativeCall("code.verify.run",{path:".",tools:["build"]})]},{content:"Done"}]});
 const result=await harness.run({forceVerification:true});expect(result.status).toBe("completed");expect(checks).toBe(2);
});
it("records actual provider usage once per model call and shares it between that call's tools",async()=>{
 const seen:import("@npati/shared").DevelopmentProcessProgressItem[]=[];const harness=createHarness({verificationTools:[],changes:[],script:[{usage:{totalTokens:150,promptTokens:120,completionTokens:30},toolCalls:[nativeCall("code.fs.read",{path:"src/a.ts"},"one"),nativeCall("code.fs.read",{path:"src/b.ts"},"two")]},{usage:{totalTokens:70,promptTokens:60,completionTokens:10},content:"Done"}]});
 await harness.run({onActivity:async event=>{seen.push(event)}});const usage=seen.filter(e=>e.stage==="model_usage");expect(usage.map(e=>e.modelUsage?.totalTokens)).toEqual([150,70]);expect(seen.filter(e=>e.stage==="tool").every(e=>e.modelUsage?.totalTokens===150)).toBe(true);
});

it("compacts old tool output without stripping native call IDs or accumulating summary messages",async()=>{
 const snapshots:import("@npati/omniroute-adapter").ChatMessage[][]=[];const script=Array.from({length:8},(_,i)=>({content:"Read relevant source",toolCalls:[nativeCall("code.fs.read",{path:"src/a"+i+".ts"},"read-"+i)]}));
 const harness=createHarness({changes:[],verificationTools:[],limits:{modelInputTokens:1},readResult:{content:"source line\n".repeat(1000)},modelRequest:request=>snapshots.push(structuredClone(request.messages)),script:[...script,{content:"Done"}]});
 await harness.run();expect(snapshots.at(-1)!.filter(m=>m.role==="system"&&String(m.content).startsWith("Context summary of"))).toHaveLength(1);
 const final=snapshots.at(-1)!;expect(final.filter(m=>m.role==="tool").every(m=>m.tool_call_id)).toBe(true);expect(final.filter(m=>m.role==="assistant"&&m.tool_calls?.length)).toHaveLength(8);expect(final.some(m=>String(m.content).includes("[tool result elided by context compaction]"))).toBe(true);
});

it("checks estimated full request pressure before billing a model call and never charges each tool separately",async()=>{
 const charges:number[]=[];const quota={checkQuota:(_id:string,tokens:number)=>({allowed:tokens<500,remainingTokens:500,error:tokens>=500?"budget exceeded":undefined}),recordUsage:(_id:string,tokens:number)=>{charges.push(tokens)}};
 const blocked=createHarness({quota,script:[{content:"Done",usage:{totalTokens:9999}}]});const stopped=await blocked.run();expect(stopped.reason).toBe("budget_exhausted");expect(blocked.engineCalls).toHaveLength(0);expect(charges).toEqual([]);
 const allowed=createHarness({verificationTools:[],changes:[],quota:{...quota,checkQuota:()=>({allowed:true,remainingTokens:500000})},script:[{usage:{totalTokens:150},toolCalls:[nativeCall("code.fs.read",{path:"a.ts"},"a"),nativeCall("code.fs.read",{path:"b.ts"},"b")]},{content:"Done",usage:{totalTokens:20}}]});
 await allowed.run();expect(charges).toEqual([150,20]);
});
