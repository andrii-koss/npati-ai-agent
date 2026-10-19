import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { CodeShellRuntime, ShellRuntimeError, looksInteractive, truncateShellOutput, type CodeShellSandboxPort, type ShellClassifier } from "../apps/agent-api/src/code-shell-runtime";
import { SecretLeaseProvider } from "../apps/agent-api/src/code-secret-lease";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";

const context: AuthContext = { workspaceId: "ws-c4", userId: "user-c4", permissions: ["workspace:read", "workspace:write", "business:manage"] };

const allowAllFlags = { assertEnabled: async () => true, isEnabled: async () => true } as unknown as FeatureFlagService;
const denyShell = {
  assertEnabled: async (_ctx: AuthContext, flagKey: string) => {
    if (flagKey === "code.shell") throw Object.assign(new Error("feature_disabled"), { code: "feature_disabled", status: 403 });
    return true;
  },
} as unknown as FeatureFlagService;

function classifierOf(risk: "safe" | "controlled" | "approval" | "hard_deny"): ShellClassifier {
  return { classify: () => ({ risk, reasons: [`classified_${risk}`], matched: [risk] }) };
}

function sandbox(overrides: Partial<Awaited<ReturnType<CodeShellSandboxPort["execute"]>>> = {}) {
  const calls: Array<Parameters<CodeShellSandboxPort["execute"]>[0]> = [];
  const port: CodeShellSandboxPort = {
    execute: async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 12, status: "completed", sandboxId: "sbx-1", ...overrides };
    },
  };
  return { port, calls };
}

/**
 * C4 owner decision: execution is decided by the server-side PolicyEngine, so these tests inject a
 * policy double that mirrors the classifier's verdicts and the flag gate. The runtime refuses to run
 * without a policy, which is asserted separately in `coding-agent-c4-policy-engine.test.ts`.
 */
let activeClassifier: ((command: string) => { risk: string; reasons?: string[] }) | undefined;
let activeFlags: { assertEnabled(ctx: unknown, key: string, opts: { companyId: string }): Promise<boolean> } | undefined;

const testPolicy = {
  evaluate: async (request: { command?: string; approved?: boolean }) => {
    // Mirror the real engine's fail-closed flag phase: no flag source means deny, never allow.
    if (!activeFlags) {
      return { decision: "deny" as const, phase: "feature_flag" as const, reasons: ["flags not configured"], code: "feature_disabled", status: 503 };
    }
    try {
      await activeFlags.assertEnabled({}, "coding_agent.enabled", { companyId: "c1" });
      await activeFlags.assertEnabled({}, "code.shell", { companyId: "c1" });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "feature_disabled";
      return { decision: "deny" as const, phase: "feature_flag" as const, reasons: [`${code}:${(error as Error).message}`], code, status: 403 };
    }
    // Without an injected classifier the double must reproduce the *real* verdicts, otherwise a
    // hard-denied command would look allowed here while the real engine denies it.
    const risk = (activeClassifier ? activeClassifier(request.command ?? "").risk : classifyShellCommand(request.command ?? "", {}).risk) as
      "safe" | "controlled" | "approval" | "hard_deny";
    if (risk === "hard_deny") {
      return { decision: "deny" as const, phase: "hard_deny" as const, reasons: ["Command is never allowed"], code: "command_hard_denied", status: 403, risk };
    }
    if (risk === "approval" && request.approved !== true) {
      return { decision: "require_approval" as const, phase: "approval" as const, reasons: ["Command requires approval"], code: "approval_required", status: 403, risk };
    }
    return { decision: "allow" as const, phase: "approval" as const, reasons: ["ok"], risk };
  },
};

function makeRuntime(options: ConstructorParameters<typeof CodeShellRuntime>[0] = {}) {
  const withClassifier = options as { classifier?: { classify(command: string): { risk: string; reasons?: string[] } } };
  activeClassifier = withClassifier.classifier ? withClassifier.classifier.classify.bind(withClassifier.classifier) : undefined;
  activeFlags = (options as { flags?: typeof activeFlags }).flags;
  return new CodeShellRuntime({ ...options, policy: testPolicy } as unknown as ConstructorParameters<typeof CodeShellRuntime>[0]);
}

describe("security-gate: C4 shell runtime gates", () => {
  it("never executes without a sandbox port (code never runs on the host)", async () => {
    const runtime = makeRuntime({ classifier: classifierOf("safe"), flags: allowAllFlags });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "ls" }))
      .rejects.toMatchObject({ code: "sandbox_unavailable", httpStatus: 503 });
  });

  it("uses the shared C4 classifier by default and blocks a hard-denied command without any injection", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, flags: allowAllFlags });
    // The structured runtime error carries `code`/`httpStatus`/`details` and never a result shape
    // (`risk`/`exitCode`): a hard-denied command has to fail, not execute.
    const failure = await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "rm -rf /" })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ShellRuntimeError);
    expect(failure).toMatchObject({ code: expect.stringMatching(/command_hard_denied|approval_required/), httpStatus: 403 });
    expect(failure).not.toHaveProperty("exitCode");
    expect(fake.calls).toHaveLength(0);
  });

  it("gives install/build commands the longer timeout class", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({
      sandbox: fake.port,
      classifier: { classify: () => ({ risk: "controlled" as const, reasons: ["install"], timeoutClass: "install" as const }) },
      flags: allowAllFlags,
      limits: { commandTimeoutMs: 5_000, installBuildTimeoutMs: 600_000 },
    });
    await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm ci" });
    expect(fake.calls[0]!.timeoutMs).toBe(600_000);
  });

  it("never reaches the sandbox for a hard-denied command", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("hard_deny"), flags: allowAllFlags });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "rm -rf /" }))
      .rejects.toMatchObject({ code: "command_hard_denied", httpStatus: 403 });
    expect(fake.calls).toHaveLength(0);
  });

  it("requires an explicit approval for an approval-class command and executes it afterwards", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("approval"), flags: allowAllFlags });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm publish" }))
      .rejects.toMatchObject({ code: "approval_required" });
    expect(fake.calls).toHaveLength(0);
    const approved = await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm publish", approved: true });
    expect(approved.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.approved).toBe(true);
  });

  it("requires the code.shell sub-flag for controlled commands", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("controlled"), flags: denyShell });
    // `status` is the structured-error discriminator ("error"); the HTTP code lives in `httpStatus`.
    // The assertion is unchanged in strength: the flag gate must deny with 403 and run nothing.
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm install" }))
      .rejects.toMatchObject({ code: "feature_disabled", httpStatus: 403 });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses every call when the coding agent flags are not configured", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe") });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "ls" }))
      .rejects.toMatchObject({ code: "feature_disabled" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("security-gate: C4 shell sessions and output", () => {
  it("keeps cwd and non-secret variables between calls and reports them", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags });
    await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "cd src", cwd: "/workspace/src", env: { NODE_ENV: "test" } });
    const second = await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t2", command: "pwd" });
    expect(second.cwd).toBe("/workspace/src");
    expect(fake.calls[1]!.command).toContain("cd '/workspace/src'");
    expect(fake.calls[1]!.command).toContain("export NODE_ENV='test'");
  });

  it("refuses to remember a secret-looking variable in the session", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "env", env: { GITHUB_TOKEN: "ghp_value" } }))
      .rejects.toMatchObject({ code: "invalid_environment" });
    expect(fake.calls).toHaveLength(0);
  });

  it("isolates shell sessions between projects and companies", async () => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags });
    await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "ls" });
    await expect(runtime.exec(context, { companyId: "c2", projectId: "p2", sessionId: "s1", toolCallId: "t2", command: "ls" }))
      .rejects.toMatchObject({ code: "session_mismatch" });
  });

  it("truncates long output with a marker and keeps head and tail", () => {
    const long = `${"a".repeat(5_000)}MIDDLE${"z".repeat(5_000)}`;
    const { text, truncated } = truncateShellOutput(long, 1_000);
    expect(truncated).toBe(true);
    expect(text).toContain("[truncated");
    expect(text.startsWith("a")).toBe(true);
    expect(text.endsWith("z")).toBe(true);
  });

  it("reports an interactive command instead of hanging", async () => {
    const fake = sandbox({ exitCode: 1, status: "timed_out", stdout: "Do you want to continue? (y/n)" });
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags, limits: { commandTimeoutMs: 1_000 } });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm init" }))
      .rejects.toMatchObject({ code: "interactive_command_not_supported", httpStatus: 409 });
    expect(looksInteractive("Do you want to continue? (y/n)", 1)).toBe(true);
    expect(looksInteractive("build finished", 0)).toBe(false);
  });

  it("reports a genuine timeout as command_timeout, not as an interactive command", async () => {
    const fake = sandbox({ exitCode: 124, status: "timed_out", stdout: "building...\n" });
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "make all" }))
      .rejects.toMatchObject({ code: "command_timeout", httpStatus: 504, retryable: false });
    expect(looksInteractive("building...", 124)).toBe(false);
  });

  it("passes the classification through and audits the decision without the command text", async () => {
    const fake = sandbox();
    const records: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    const runtime = makeRuntime({
      sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags,
      audit: { record: async (_ctx, input) => { records.push({ action: input.action, metadata: input.metadata }); return {}; } } as never,
    });
    const result = await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "cat .env" });
    expect(result.risk).toBe("safe");
    expect(result.classification.reasons).toEqual(["classified_safe"]);
    expect(records.map((entry) => entry.action)).toEqual(["shell.command.executed"]);
    expect(JSON.stringify(records)).not.toContain("cat .env");
    expect(JSON.stringify(records)).toContain("fnv:");
  });
});

describe("security-gate: C4 shell + secret leases", () => {
  it("delivers a leased secret through the sandbox references, revokes it after the call and never returns the value", async () => {
    const fake = sandbox({ stdout: "using secret\n" });
    const leases = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await leases.issue(context, {
      companyId: "c1", projectId: "p1", sessionId: "s1", purpose: "run tests", toolCallId: "t1",
      variableName: "NPM_TOKEN", credentialId: "2f1a7b8c-1111-4222-8333-444455556666", field: "token",
      credential: { id: "2f1a7b8c-1111-4222-8333-444455556666", label: "dev-key", environment: "development" },
    });
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags, leases });
    const result = await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm test", secretLeaseIds: [lease.leaseId] });
    expect(fake.calls[0]!.environmentReferences).toEqual({ NPM_TOKEN: { id: "2f1a7b8c-1111-4222-8333-444455556666", field: "token" } });
    expect(JSON.stringify(result)).not.toContain("ghp_");
    expect(result.leaseIds).toEqual([lease.leaseId]);
    // Revoked after the call: the next call cannot reuse it.
    expect(leases.list().every((item) => item.state !== "active")).toBe(true);
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t2", command: "npm test", secretLeaseIds: [lease.leaseId] }))
      .rejects.toMatchObject({ code: expect.stringMatching(/secret_lease_(expired|inherited)/) });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses a lease issued for another tool call", async () => {
    const fake = sandbox();
    const leases = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await leases.issue(context, {
      companyId: "c1", projectId: "p1", sessionId: "s1", purpose: "x", toolCallId: "t1",
      variableName: "NPM_TOKEN", credentialId: "2f1a7b8c-1111-4222-8333-444455556666", field: "token",
      credential: { label: "dev-key", environment: "development" },
    });
    const runtime = makeRuntime({ sandbox: fake.port, classifier: classifierOf("safe"), flags: allowAllFlags, leases });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "other", command: "npm test", secretLeaseIds: [lease.leaseId] }))
      .rejects.toMatchObject({ code: "secret_lease_inherited" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("security-gate: C4 environment-name shell boundary", () => {
  it.each(["X; printf injected #", "X$(printf injected)", "X\nY", "1INVALID", "X=Y", "X/Y"])("rejects shell syntax in environment name %s before sandbox execution", async name => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, flags: allowAllFlags, classifier: classifierOf("safe") });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1",
      toolCallId: "environment-name", command: "pwd", env: { [name]: "value" } }))
      .rejects.toMatchObject({ code: "invalid_environment" });
    expect(fake.calls).toHaveLength(0);
    expect(runtime.session("s1")?.env).toEqual({});
  });
});

describe("security-gate: C4 authenticated shell ownership", () => {
  it.each(["workspaceId", "userId"] as const)("rejects reuse of a shell session by another %s before dispatch", async field => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, flags: allowAllFlags, classifier: classifierOf("safe") });
    const input = { companyId: "c1", projectId: "p1", sessionId: "scoped-session", toolCallId: "first", command: "pwd", env: { NODE_ENV: "test" } };
    await runtime.exec(context, input);
    await expect(runtime.exec({ ...context, [field]: "other" }, { ...input, toolCallId: "other", env: {} }))
      .rejects.toMatchObject({ code: "session_mismatch" });
    expect(fake.calls).toHaveLength(1);
    expect(runtime.session(input.sessionId)?.turnCount).toBe(1);
    await runtime.exec(context, { ...input, toolCallId: "owner", env: {} });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.command).toContain("export NODE_ENV='test'");
  });

  it.each([NaN, Infinity, -Infinity, -1, 0, 1.5])("rejects invalid timeout %s before dispatch", async timeoutMs => {
    const fake = sandbox();
    const runtime = makeRuntime({ sandbox: fake.port, flags: allowAllFlags, classifier: classifierOf("safe") });
    await expect(runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "pwd", timeoutMs }))
      .rejects.toMatchObject({ code: "invalid_timeout" });
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["session", "project", "company"])("refuses a secret lease from another %s without consuming it", async scope => {
    const fake = sandbox();
    const leases = new SecretLeaseProvider({ config: { allowedLabels: ["dev-key"] } });
    const lease = await leases.issue(context, {
      companyId: "c1", projectId: "p1", sessionId: "s1", purpose: "test", toolCallId: "same-call",
      variableName: "NPM_TOKEN", credentialId: "2f1a7b8c-1111-4222-8333-444455556666", field: "token",
      credential: { id: "2f1a7b8c-1111-4222-8333-444455556666", label: "dev-key", environment: "development" },
    });
    const runtime = makeRuntime({ sandbox: fake.port, flags: allowAllFlags, classifier: classifierOf("safe"), leases });
    const input = { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "same-call", command: "npm test", secretLeaseIds: [lease.leaseId] };
    const foreign = { ...input, ...(scope === "session" ? { sessionId: "s2" } : scope === "project" ? { projectId: "p2" } : { companyId: "c2" }) };
    await expect(runtime.exec(context, foreign)).rejects.toMatchObject({ code: "secret_lease_inherited" });
    expect(fake.calls).toHaveLength(0);
    // A refused scope cannot consume or revoke the owner's lease.
    expect(leases.environmentReferences(lease.leaseId, "same-call", "s1")).toEqual({ NPM_TOKEN: { id: "2f1a7b8c-1111-4222-8333-444455556666", field: "token" } });
  });

  it("uses the configured default command timeout and reports real port exit code and duration", async () => {
    const fake = sandbox({ exitCode: 7, durationMs: 43, stdout: "failed test", status: "failed" });
    const runtime = makeRuntime({ sandbox: fake.port, flags: allowAllFlags, classifier: classifierOf("safe") });
    const result = await runtime.exec(context, { companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1", command: "npm test" });
    expect(fake.calls[0]!.timeoutMs).toBe(120000);
    expect(result.exitCode).toBe(7);
    expect(result.durationMs).toBe(43);
  });
});
