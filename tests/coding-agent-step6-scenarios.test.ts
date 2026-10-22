import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import {
  CodingAgentRunner,
  createCodeRunEnvironmentHolder,
  type CodingAgentRunnerPorts,
  type CodeRunToolDescriptor,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * Step 6 — controlled scenario matrix.
 *
 * The engine is scripted, so these numbers are **orchestration costs** (model turns, tool calls, verification runs,
 * review calls, orchestration time) and not provider latency. They are the only "after" measurements that can be
 * produced without redeploying the isolated stack, and the report says so explicitly.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write", "code:run"] };

function session(id = "session-1", projectId = "project-1"): CodeSession {
  return {
    id, workspaceId: "ws-1", companyId: "company-1", projectId, userId: "user-1",
    mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard",
    revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
  { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
  { name: "code.fs.write", version: 1, status: "active", description: "write", write: true },
  { name: "code.fs.apply_patch", version: 1, status: "active", description: "patch", write: true },
  { name: "code.shell.exec", version: 1, status: "active", description: "shell", write: false },
  { name: "code.verify.run", version: 1, status: "active", description: "verify", write: false },
];
const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { path: { type: "string" } } } }));

interface Change { path: string; tool: string; status?: string; diff?: string }
interface Metrics {
  scenario: string; repeat: number; aiCalls: number; toolCalls: number; verifyRuns: number; reviewCalls: number;
  ms: number; status: string; files: number; message: string; errorCode?: string; approvals: number;
}

function file(path: string, diff = "@@ -1 +1 @@\n-old\n+new\n"): Change {
  return { path, tool: path.endsWith(".css") ? "code.fs.edit" : "code.fs.edit", status: "modified", diff };
}

function call(name: string, args: Record<string, unknown> = {}, id = `call-${Math.random().toString(36).slice(2, 8)}`) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify({ path: "x", ...args }) } };
}

interface HarnessConfig {
  script: ChatResult[];
  changes?: Change[];
  verificationTools?: readonly string[];
  verifyResults?: boolean[];
  shellApproval?: boolean;
  failFirstCall?: boolean;
  durable?: boolean;
}

function createHarness(config: HarnessConfig) {
  const counters = { aiCalls: 0, toolCalls: 0, verifyRuns: 0, reviewCalls: 0 };
  const script = [...config.script];
  const verifyResults = [...(config.verifyResults ?? [])];
  let firstCall = true;
  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => TOOLS,
      invoke: async (_ctx, input) => {
        if (input.tool === "code.verify.run") {
          counters.verifyRuns += 1;
          const passed = verifyResults.length ? verifyResults.shift() !== false : true;
          if (!passed) return { ok: false, error: { code: "verify_failed", status: 500, message: "build failed", tool: input.tool, step: "execute", retryable: false } } as never;
          return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: { checks: (Array.isArray(input.args?.tools) ? input.args.tools : []).map((tool: string) => ({ tool, passed: true })) }, truncated: false, durationMs: 1 } as CodeToolInvokeResult;
        }
        counters.toolCalls += 1;
        if (config.shellApproval && input.tool === "code.shell.exec") {
          return { ok: false, error: { code: "approval_required", status: 403, message: "approval required", tool: input.tool, step: "execute", retryable: false, details: { pauseForApproval: true, approvalId: "approval-1" } } } as never;
        }
        return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 1 } as CodeToolInvokeResult;
      },
      turnSummary: () => ({ files: (config.changes ?? []).length, linesAdded: 3, linesRemoved: 1, changes: config.changes ?? [] }),
    },
    engine: {
      chat: async (request) => {
        if (!request.tools || request.tools.length === 0) {
          counters.reviewCalls += 1;
          return { content: JSON.stringify({ status: "clean", findings: [] }) } as ChatResult;
        }
        counters.aiCalls += 1;
        if (config.failFirstCall && firstCall) {
          firstCall = false;
          throw Object.assign(new Error("OmniRoute chat failed with HTTP 500"), { code: "provider_http_error" });
        }
        firstCall = false;
        return script.shift() ?? { content: "done" } as ChatResult;
      },
      onTextDelta: undefined,
    } as never,
    schemas: SCHEMAS,
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async () => undefined },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    environment: createCodeRunEnvironmentHolder(),
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
    ...(config.durable ? {
      runStateOwner: "test",
      runState: new Proxy({}, { get: (_target, prop) => {
        if (prop === "startRun") return async () => ({ runId: "state-run-1" });
        if (prop === "renewLease") return async () => ({ held: true });
        return async () => undefined;
      } }) as never,
    } : {}),
    limits: { maxStepsPerRun: 20, maxRunMinutes: 5, parallelReadOnlyCalls: 8, repairLoopAttempts: 3, maxChangedFiles: 25 },
  };
  return { ports, counters };
}

async function runScenario(name: string, repeat: number, config: HarnessConfig, overrides: Record<string, unknown> = {}): Promise<Metrics> {
  const { ports, counters } = createHarness(config);
  const started = performance.now();
  const result = await new CodingAgentRunner(ports).run({
    ctx, session: session(`session-${name}`, `project-${name}`), prompt: name, turnId: `turn-${repeat}`,
    ...(config.verificationTools ? { verificationTools: config.verificationTools } : {}),
    ...overrides,
  });
  return {
    scenario: name, repeat, ...counters, ms: Math.round(performance.now() - started),
    status: String(result.status), files: result.summary?.filesChanged?.length ?? 0,
    message: String(result.message ?? "").slice(0, 40),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}

const results: Metrics[] = [];
async function measure(name: string, config: HarnessConfig, overrides: Record<string, unknown> = {}) {
  for (let repeat = 1; repeat <= 3; repeat += 1) results.push(await runScenario(name, repeat, config, overrides));
}

describe("Step 6 — scenario matrix (scripted engine)", () => {
  it("runs the twelve controlled scenarios three times each", async () => {
    await measure("01_new_site", {
      script: [{ content: "creating", toolCalls: [call("code.fs.write", { path: "index.html", content: "<h1>hi</h1>" })] }, { content: "created" }],
      changes: [file("index.html")],
      verificationTools: ["build"],
    }, { websiteEdit: true, emptyHtmlWorkspace: true, requireImplementation: true });

    await measure("02_css", {
      script: [{ content: "editing", toolCalls: [call("code.fs.edit", { path: "assets/styles.css" })] }, { content: "done" }],
      changes: [file("assets/styles.css")],
      verificationTools: ["typecheck", "test"],
    }, { websiteEdit: true, allowStylePreview: true });

    await measure("03_component", {
      script: [{ content: "editing", toolCalls: [call("code.fs.edit", { path: "components/Hero.tsx" })] }, { content: "done" }],
      changes: [file("components/Hero.tsx")],
      verificationTools: ["typecheck", "test"],
    }, { websiteEdit: true });

    await measure("04_ts_error", {
      script: [{ content: "fixing", toolCalls: [call("code.fs.edit", { path: "src/lib/money.ts" })] }, { content: "fixed" }],
      changes: [file("src/lib/money.ts")],
      verificationTools: ["typecheck"],
    });

    await measure("05_build_fix", {
      script: [
        { content: "first", toolCalls: [call("code.fs.edit", { path: "src/app/page.tsx" })] }, { content: "try" },
        { content: "repair", toolCalls: [call("code.fs.edit", { path: "src/app/page.tsx" })] }, { content: "done" },
      ],
      changes: [file("src/app/page.tsx")],
      verificationTools: ["typecheck", "build"],
      verifyResults: [false, true],
    });

    await measure("06_add_page", {
      script: [{ content: "adding", toolCalls: [call("code.fs.write", { path: "app/about/page.tsx" })] }, { content: "added" }],
      changes: [file("app/about/page.tsx")],
      verificationTools: ["typecheck", "build"],
    }, { websiteEdit: true });

    await measure("07_repeat_edit", {
      script: [
        { content: "one", toolCalls: [call("code.fs.edit", { path: "app/page.tsx" })] }, { content: "done" },
        { content: "two", toolCalls: [call("code.fs.edit", { path: "app/page.tsx" })] }, { content: "done" },
      ],
      changes: [file("app/page.tsx")],
      verificationTools: ["typecheck", "test"],
    }, { websiteEdit: true });

    const many = Array.from({ length: 6 }, (_value, index) => file(`src/feature-${index}.ts`));
    await measure("08_multi_file", {
      script: [
        { content: "batch", toolCalls: many.slice(0, 2).map((entry) => call("code.fs.edit", { path: entry.path })) },
        { content: "batch", toolCalls: many.slice(2, 4).map((entry) => call("code.fs.edit", { path: entry.path })) },
        { content: "batch", toolCalls: many.slice(4, 6).map((entry) => call("code.fs.edit", { path: entry.path })) },
        { content: "done" },
      ],
      changes: many,
      verificationTools: ["typecheck", "test"],
    });

    await measure("09_bad_tool_call", {
      script: [
        { content: "calling", toolCalls: [call("code.fs.nope", { path: "x" })] },
        { content: "attempting valid", toolCalls: [call("code.fs.read", { path: "src/a.ts" })] },
        { content: "recovered" },
      ],
      changes: [file("src/a.ts")],
      verificationTools: ["typecheck"],
    });

    await measure("10_provider_failure", {
      script: [{ content: "unused" }],
      failFirstCall: true,
      verificationTools: ["typecheck"],
    });

    await measure("11_approval", {
      script: [{ content: "shell", toolCalls: [call("code.shell.exec", { command: "rm -rf build" })] }, { content: "unused" }],
      changes: [file("src/a.ts")],
      shellApproval: true,
      durable: true,
      verificationTools: ["typecheck"],
    });

    await measure("12_parallel", {
      script: [{ content: "one", toolCalls: [call("code.fs.edit", { path: "src/a.ts" })] }, { content: "done" }],
      changes: [file("src/a.ts")],
      verificationTools: ["typecheck"],
    });

    console.log("STEP6_METRICS " + JSON.stringify(results));

    // Assertions: success/failure shape per scenario (the numbers are collected above).
    const byScenario = (name: string) => results.filter((entry) => entry.scenario === name);
    for (const name of ["01_new_site", "02_css", "03_component", "04_ts_error", "05_build_fix", "06_add_page", "07_repeat_edit", "08_multi_file", "09_bad_tool_call"]) {
      expect(byScenario(name).every((entry) => entry.status === "completed"), name).toBe(true);
    }
    expect(byScenario("10_provider_failure").every((entry) => entry.status !== "completed")).toBe(true);
    expect(byScenario("11_approval").every((entry) => entry.status === "waiting_for_user")).toBe(true);
    expect(byScenario("11_approval").every((entry) => entry.toolCalls === 1 && entry.verifyRuns === 0)).toBe(true);
    expect(byScenario("12_parallel")).toHaveLength(3);
    expect(byScenario("02_css").every((entry) => entry.reviewCalls === 0)).toBe(true);
    expect(byScenario("03_component").every((entry) => entry.reviewCalls === 1)).toBe(true);
    expect(byScenario("08_multi_file").every((entry) => entry.reviewCalls === 1)).toBe(true);
    expect(byScenario("05_build_fix").every((entry) => entry.verifyRuns === 2)).toBe(true);

    console.log("STEP6_METRICS " + JSON.stringify(results));
  }, 120_000);

  it("runs two independent projects concurrently without sharing state", async () => {
    const config = (path: string) => ({
      script: [{ content: "edit", toolCalls: [call("code.fs.edit", { path })] }, { content: "done" }] as ChatResult[],
      changes: [file(path)],
      verificationTools: ["typecheck"],
    });
    const started = performance.now();
    const [a, b] = await Promise.all([
      runScenario("12a_parallel", 1, config("src/a.ts")),
      runScenario("12b_parallel", 1, config("src/b.ts")),
    ]);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect(a.aiCalls).toBe(2);
    expect(b.aiCalls).toBe(2);
    expect(a.files).toBe(1);
    expect(b.files).toBe(1);
    // Both finished inside roughly the time of one orchestration, not two.
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);
});
