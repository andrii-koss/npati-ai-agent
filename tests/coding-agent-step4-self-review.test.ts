import { describe, expect, it } from "vitest";
import type { ChatResult } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import type { CodeToolInvokeResult } from "../apps/agent-api/src/code-tool-runtime";
import { decideSelfReview, isSecuritySensitivePath } from "../apps/agent-api/src/code-self-review-risk";
import {
  createCodeRunEnvironmentHolder,
  CodingAgentRunner,
  type CodeRunToolDescriptor,
  type CodingAgentRunnerPorts,
} from "../apps/agent-api/src/coding-agent-runner";

/**
 * Step 4 — adaptive self-review.
 *
 * The decision tests are pure. The runner tests drive the real coordinator through a scripted engine: a request
 * **without tools** is the self-review call, so `reviewCalls` is an exact count of LLM reviews in the run.
 */

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "session-1", workspaceId: "ws-1", companyId: "company-1", projectId: "project-1", userId: "user-1",
    mode: "auto", status: "active", dataClassification: "confidential", retentionClass: "standard",
    revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function file(path: string, diff = "@@ -1 +1 @@\n-old\n+new\n") {
  return { path, tool: "code.fs.edit", status: "modified", diff };
}

const reviewFile = (path: string) => decideSelfReview({
  changedFiles: [file(path)],
  verificationStatus: "passed",
  hadRepair: false,
});

describe("Step 4 — what may skip the review", () => {
  it("skips a verified CSS-only change", () => {
    const decision = reviewFile("assets/styles.css");
    expect(decision.decision).toBe("skip");
    expect(decision.risk).toBe("low");
    expect(decision.reason).toBe("presentation_only_verified");
  });

  it("skips a verified asset-only change", () => {
    expect(reviewFile("public/hero.webp").decision).toBe("skip");
  });

  it("never skips when the verification did not pass", () => {
    const decision = decideSelfReview({ changedFiles: [file("assets/styles.css")], verificationStatus: "failed", hadRepair: false });
    expect(decision.decision).toBe("run");
  });

  it("never skips after a repair round", () => {
    const decision = decideSelfReview({ changedFiles: [file("assets/styles.css")], verificationStatus: "passed", hadRepair: true });
    expect(decision.decision).toBe("run");
    expect(decision.risk).toBe("elevated");
  });

  it("never skips when test integrity is flagged", () => {
    const decision = decideSelfReview({
      changedFiles: [file("assets/styles.css")], verificationStatus: "passed", hadRepair: false,
      testIntegrity: { flagged: true, requiresJustification: true },
    });
    expect(decision.decision).toBe("run");
  });

  it("never skips when the scope guard was exceeded", () => {
    const decision = decideSelfReview({
      changedFiles: [file("assets/styles.css")], verificationStatus: "passed", hadRepair: false, scopeExceeded: true,
    });
    expect(decision.decision).toBe("run");
    expect(decision.risk).toBe("high");
  });

  it("never skips too many files or an oversized diff", () => {
    const many = decideSelfReview({
      changedFiles: ["a.css", "b.css", "c.css", "d.css"].map((path) => file(path)),
      verificationStatus: "passed", hadRepair: false,
    });
    expect(many.decision).toBe("run");
    expect(many.risk).toBe("high");
    const big = decideSelfReview({
      changedFiles: [file("assets/styles.css", "x".repeat(25_000))],
      verificationStatus: "passed", hadRepair: false,
    });
    expect(big.decision).toBe("run");
  });

  it("treats a component text change as a source change and reviews it", () => {
    expect(reviewFile("src/components/Hero.tsx").decision).toBe("run");
  });

  it("reviews ordinary bug fixes, API changes and dependency changes", () => {
    expect(reviewFile("src/lib/money.ts").decision).toBe("run");
    expect(reviewFile("src/api/routes.ts").decision).toBe("run");
    expect(reviewFile("package.json").decision).toBe("run");
  });

  it("reviews test-file changes", () => {
    expect(reviewFile("tests/checkout.test.ts").decision).toBe("run");
  });

  it("does not use line count as the criterion: one sensitive line is high risk", () => {
    const oneLine = decideSelfReview({
      changedFiles: [file("src/auth/session.ts", "@@ -10 +10 @@\n-if (admin) {\n+if (true) {\n")],
      verificationStatus: "passed", hadRepair: false, totalLinesChanged: 2,
    });
    expect(oneLine.decision).toBe("run");
    expect(oneLine.risk).toBe("high");
    expect(oneLine.signals).toContain("security_sensitive:1");
  });

  it("classifies secrets and policy paths as sensitive", () => {
    for (const path of ["src/auth/session.ts", "src/permissions/check.ts", ".env.local", "migrations/001_init.sql", ".github/workflows/ci.yml", "src/keys.ts"]) {
      expect(isSecuritySensitivePath(path)).toBe(true);
    }
    for (const path of ["src/components/Keyboard.tsx", "assets/app.css", "src/lib/money.ts"]) {
      expect(isSecuritySensitivePath(path)).toBe(false);
    }
  });

  it("honours the operator switch", () => {
    const decision = decideSelfReview({
      changedFiles: [file("assets/styles.css")], verificationStatus: "passed", hadRepair: false, adaptiveEnabled: false,
    });
    expect(decision.decision).toBe("run");
    expect(decision.reason).toMatch(/^risk_/);
  });

  it("never skips an empty change set decision (the state itself reports no_changes)", () => {
    const decision = decideSelfReview({ changedFiles: [], verificationStatus: "passed", hadRepair: false });
    expect(decision.decision).toBe("run");
    expect(decision.reason).toBe("no_changes");
  });
});

interface HarnessOptions {
  script: ChatResult[];
  changes?: Array<{ path: string; tool: string; status?: string; diff?: string }>;
  verificationTools?: readonly string[];
  /** One entry per verification call: `true` passes, `false` fails. Defaults to always passing. */
  verifyResults?: boolean[];
  selfReviewAdaptive?: boolean;
  limits?: Partial<CodeAgentLimits>;
}

function createHarness(options: HarnessOptions) {
  const reviewCalls: string[] = [];
  const engineCalls: number[] = [];
  const script = [...options.script];
  const verifyResults = [...(options.verifyResults ?? [])];

  const ports: CodingAgentRunnerPorts = {
    flags: { assertEnabled: async () => true },
    rbac: { authorize: async () => ({ allowed: true }) },
    toolRuntime: {
      listTools: () => TOOLS,
      invoke: async (_ctx, input) => {
        if (input.tool === "code.verify.run") {
          const passed = verifyResults.length ? verifyResults.shift() !== false : true;
          if (!passed) {
            return {
              ok: false,
              error: { code: "verify_failed", status: 500, message: "1 test failed", tool: input.tool, step: "execute", retryable: false },
            } as never;
          }
          return {
            ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1,
            result: { checks: (Array.isArray(input.args?.tools) ? input.args.tools : []).map((tool: string) => ({ tool, passed: true })) },
            truncated: false, durationMs: 1,
          } as CodeToolInvokeResult;
        }
        return { ok: true, tool: input.tool, toolVersion: 1, schemaVersion: 1, result: {}, truncated: false, durationMs: 1 } as CodeToolInvokeResult;
      },
      turnSummary: () => ({
        files: (options.changes ?? []).length,
        linesAdded: 2,
        linesRemoved: 1,
        changes: options.changes ?? [file("src/a.ts")],
      }),
    },
    engine: {
      chat: async (request) => {
        engineCalls.push(1);
        // A request with no tools is the self-review call: it must never reach the model on a skipped run.
        if (!request.tools || request.tools.length === 0) {
          reviewCalls.push(String(request.messages?.[0]?.content ?? "").slice(0, 40));
          return { content: JSON.stringify({ status: "clean", findings: [] }) };
        }
        return script.shift() ?? { content: "done" };
      },
    },
    schemas: SCHEMAS,
    quota: { checkQuota: () => ({ allowed: true }), recordUsage: () => undefined },
    activity: { record: async () => undefined },
    runEvents: { append: async (entry) => entry },
    sandbox: { release: async () => undefined },
    environment: createCodeRunEnvironmentHolder(),
    snapshot: { create: async () => ({ snapshotId: "snap-1" }) },
    ...(options.selfReviewAdaptive === undefined ? {} : { selfReview: { adaptive: options.selfReviewAdaptive } }),
    limits: { maxStepsPerRun: 12, maxRunMinutes: 5, parallelReadOnlyCalls: 8, repairLoopAttempts: 3, maxChangedFiles: 25, ...(options.limits ?? {}) },
  };

  const runner = new CodingAgentRunner(ports);
  return {
    reviewCalls,
    engineCalls,
    run: (input: Partial<Parameters<CodingAgentRunner["run"]>[0]> = {}) =>
      runner.run({
        ctx, session: session(), prompt: "change the site", turnId: "turn-4",
        ...(options.verificationTools ? { verificationTools: options.verificationTools } : {}),
        ...input,
      }),
  };
}

const TOOLS: CodeRunToolDescriptor[] = [
  { name: "code.fs.read", version: 1, status: "active", description: "read", write: false },
  { name: "code.fs.edit", version: 1, status: "active", description: "edit", write: true },
  { name: "code.verify.run", version: 1, status: "active", description: "verify", write: false },
];
const SCHEMAS = TOOLS.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { path: { type: "string" } } } }));

function edit(path: string) {
  return { content: "editing", toolCalls: [{ id: `call-${path}`, type: "function" as const, function: { name: "code.fs.edit", arguments: JSON.stringify({ path }) } }] };
}

describe("Step 4 — the adaptive decision in the real run loop", () => {
  it.each(["index.html", "styles.css", "app.js"])("reviews changed static %s without inventing verification", async (path) => {
    const harness = createHarness({ script: [edit(path), { content: "done" }], changes: [file(path)], verificationTools: [] });
    const result = await harness.run();
    expect(result.status).toBe("completed");
    expect(harness.reviewCalls).toHaveLength(1);
    expect(result.selfReview).toMatchObject({ status: "clean", inputs: { changedFiles: 1 } });
    expect(result.summary.verification).toBeUndefined();
  });
  it("fails closed when changed static files lack a diff", async () => {
    const harness = createHarness({ script: [edit("app.js"), { content: "done" }], changes: [file("app.js", "")], verificationTools: [] });
    const result = await harness.run();
    expect(result.reason).toBe("self_review_unavailable");
    expect(result.selfReview).toMatchObject({ status: "unavailable", reason: "review_diff_unavailable", inputs: { changedFiles: 1 } });
  });
  it("skips the LLM review for a verified CSS-only change", async () => {
    const harness = createHarness({
      script: [edit("assets/styles.css"), { content: "done" }],
      changes: [file("assets/styles.css")],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(harness.reviewCalls).toHaveLength(0);
    expect(result.selfReview).toMatchObject({ status: "not_run", reason: "adaptive_low_risk_skip", adaptiveSkip: true, reviewRuns: 0, ran: false });
    expect(result.selfReview?.risk).toBe("low");
  });

  it("still reviews a component text change", async () => {
    const harness = createHarness({
      script: [edit("src/components/Hero.tsx"), { content: "done" }],
      changes: [file("src/components/Hero.tsx")],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(harness.reviewCalls).toHaveLength(1);
    expect(result.selfReview).toMatchObject({ status: "clean", ran: true, reviewRuns: 1 });
    expect(result.selfReview?.risk).toBe("elevated");
    expect(result.selfReview?.adaptiveSkip).toBeUndefined();
  });

  it("reviews an ordinary bug fix and an API change", async () => {
    for (const path of ["src/lib/money.ts", "src/api/routes.ts"]) {
      const harness = createHarness({ script: [edit(path), { content: "done" }], changes: [file(path)], verificationTools: ["typecheck", "test"] });
      const result = await harness.run();
      expect(harness.reviewCalls).toHaveLength(1);
      expect(result.selfReview?.status).toBe("clean");
    }
  });

  it("reviews a one-line auth change", async () => {
    const harness = createHarness({
      script: [edit("src/auth/session.ts"), { content: "done" }],
      changes: [file("src/auth/session.ts", "@@ -10 +10 @@\n-if (admin)\n+if (true)\n")],
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();
    expect(harness.reviewCalls).toHaveLength(1);
    expect(result.selfReview?.risk).toBe("high");
  });

  it("reviews a mass edit", async () => {
    const paths = Array.from({ length: 10 }, (_value, index) => `src/feature-${index}.ts`);
    const harness = createHarness({
      script: [edit(paths[0]!), { content: "done" }],
      changes: paths.map((path) => file(path)),
      verificationTools: ["typecheck", "test"],
    });
    const result = await harness.run();
    expect(harness.reviewCalls).toHaveLength(1);
    expect(result.selfReview?.risk).toBe("high");
  });

  it("does not skip after a verification failure and repair, even for a CSS change", async () => {
    const harness = createHarness({
      script: [edit("assets/styles.css"), { content: "done" }, edit("assets/styles.css"), { content: "done" }],
      changes: [file("assets/styles.css")],
      verificationTools: ["typecheck", "test"],
      verifyResults: [false, true],
    });
    const result = await harness.run();

    expect(result.status).toBe("completed");
    expect(harness.reviewCalls).toHaveLength(1);
    expect(result.selfReview?.reason).not.toBe("adaptive_low_risk_skip");
    expect(result.selfReview?.risk).toBe("elevated");
    expect(result.verification?.attemptsUsed).toBe(1);
  });

  it("honours the operator switch in the run loop", async () => {
    const harness = createHarness({
      script: [edit("assets/styles.css"), { content: "done" }],
      changes: [file("assets/styles.css")],
      verificationTools: ["typecheck", "test"],
      selfReviewAdaptive: false,
    });
    const result = await harness.run();
    expect(harness.reviewCalls).toHaveLength(1);
    expect(result.selfReview?.reason).not.toBe("adaptive_low_risk_skip");
  });
});
