import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { buildSandboxCreateArgs, DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";
import { defaultTerminalLimits } from "../apps/agent-api/src/project-sandbox-service";
import type { SandboxScope } from "../apps/agent-api/src/sandbox-provider";
import { CodeShellRuntime, truncateShellOutput, type CodeShellSandboxPort } from "../apps/agent-api/src/code-shell-runtime";
import { PolicyEngine } from "../apps/agent-api/src/code-policy-engine";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import { enforceOutputBudget, wrapToolResult } from "../apps/agent-api/src/code-tools-fs";

/**
 * C14 red-team — disk and memory exhaustion (G1 coverage item 2a: "вичерпання диска і пам'яті").
 *
 * There is no Docker in the test environment, so this suite does **not** claim to have filled a disk. It
 * asserts the ceilings that make filling one impossible to reach from a sandbox and bounded on the API side,
 * through the real code paths:
 *
 *  - the container is created with a memory cap, a CPU cap, a process cap, a **bounded tmpfs** as the whole
 *    workspace filesystem and a bounded `/tmp`, with no privileged flag, no host mount and no docker socket;
 *  - a limit that would make any of those decorative is refused by the provider before a container exists;
 *  - what a command prints is bounded twice: by the sandbox process port, and again by the untrusted-data
 *    envelope's output budget, with an explicit truncation marker rather than silent loss;
 *  - a command cannot be arbitrarily long and cannot ask for an arbitrarily long run time.
 *
 * Honest limit (see `security-gate/security-gate-report.md`): the caps are asserted on the argument line
 * and on the provider's validation, not by observing a real kernel OOM. A real-container check is part of the
 * manual G1 checklist, not of this hermetic suite.
 */

const ctx: AuthContext = {
  workspaceId: "ws-c14",
  userId: "user-c14",
  permissions: ["workspace:read", "workspace:write", "owner"],
};

const SCOPE: SandboxScope = { workspaceId: "ws-c14", userId: "user-c14", companyId: "company-c14", projectId: "project-c14" };

/** The shell runtime's flag port: every flag answers "enabled", so the ceiling is the only refusal left. */
const ALLOW_ALL_FLAGS = { assertEnabled: async () => true, isEnabled: async () => true } as unknown as FeatureFlagService;

function createArgs(overrides: { memory?: string; pids?: number; diskBytes?: number; cpus?: string } = {}) {
  return buildSandboxCreateArgs({
    sandboxName: "npati-sb-c14",
    sandboxId: "c14",
    network: "npati-net-c14",
    scope: SCOPE,
    image: "npati/project-sandbox:local",
    cpus: overrides.cpus ?? "1",
    memory: overrides.memory ?? "1536m",
    pids: overrides.pids ?? 128,
    diskBytes: overrides.diskBytes ?? 1536 * 1024 * 1024,
  });
}

function recordingSandbox() {
  const calls: Array<Parameters<CodeShellSandboxPort["execute"]>[0]> = [];
  const port: CodeShellSandboxPort = {
    execute: async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, status: "completed", sandboxId: "sbx" };
    },
  };
  return { port, calls };
}

function engine(): PolicyEngine {
  return new PolicyEngine({
    flags: { assertEnabled: async () => true },
    capabilities: { get: (id) => ({ id, version: 1, status: "active" }) },
    classifier: (command) => classifyShellCommand(command),
    approvals: { requestApproval: async () => ({ id: "approval-1" }), consumeApproved: async () => ({}) },
    sessionMode: async () => "full_auto",
  });
}

describe("security-gate: C14 red-team — disk and memory exhaustion", () => {
  it("caps memory, CPU, processes and the sandbox's whole filesystem, with no host escape to exhaust", () => {
    const args = createArgs();
    const line = args.join(" ");
    expect(line).toContain("--memory 1536m");
    expect(line).toContain("--cpus 1");
    expect(line).toContain("--pids-limit 128");
    // The workspace is a bounded tmpfs, so "fill the disk" is bounded by construction…
    expect(line).toContain(`--tmpfs /workspace:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=${1536 * 1024 * 1024}`);
    // …and /tmp is bounded separately, so the workspace cap cannot be jumped by writing to /tmp.
    expect(line).toContain("--tmpfs /tmp:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=64m");
    // The root filesystem is read-only: a fill attempt cannot reach the image either.
    expect(line).toContain("--read-only");
    // No host path to fill: no privileged container, no bind mount, no docker socket.
    expect(line.includes("--privileged")).toBe(false);
    expect(line.includes("/var/run/docker.sock")).toBe(false);
    expect(args.includes("-v")).toBe(false);
    expect(args.includes("--mount")).toBe(false);
    // The size cap is a real number, not 0/infinity, and it responds to the configured value.
    expect(createArgs({ diskBytes: 32_000_000 }).join(" ")).toContain("size=32000000");
    expect(1536 * 1024 * 1024 > 0).toBe(true);
  });

  it("mounts a confirmed local folder only when one is asked for, and never two workspaces at once", () => {
    // C15 adds exactly one host path to this command line, and only for a project whose folder an owner/admin
    // confirmed. The assertions above describe the input **without** a mount and stay exactly as they were; this
    // is the positive case that shows the mount is what changes the workspace argument, so the C14 ceiling is a
    // property of the input rather than of a line that always looks the same.
    const withMount = buildSandboxCreateArgs({
      ...{
        sandboxName: "npati-sb-c14",
        sandboxId: "c14",
        network: "npati-net-c14",
        scope: SCOPE,
        image: "npati/project-sandbox:local",
        cpus: "1",
        memory: "1536m",
        pids: 128,
        diskBytes: 1536 * 1024 * 1024,
      },
      mount: { source: "/host/repo", target: "/workspace", readOnly: true },
    });
    const line = withMount.join(" ");
    // One bind, at the container's workspace, read-only at the Docker level (the owner decision: an `ro` mount is
    // enforced by the container, not only by the API).
    expect(line).toContain("--mount type=bind,source=/host/repo,target=/workspace,readonly");
    // …and no tmpfs at the same destination: a shadowed bind would silently leave the agent working in a
    // throwaway filesystem while the user's folder stayed untouched.
    expect(line.includes("--tmpfs /workspace:")).toBe(false);
    // The runtime directory stays bounded, which is what keeps the mount from becoming an unbounded disk.
    expect(line).toContain("--tmpfs /workspace/.npati-runtime:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=268435456");
    // The escape hatches C14 pins are still absent with a mount present.
    expect(line.includes("--privileged")).toBe(false);
    expect(line.includes("/var/run/docker.sock")).toBe(false);
    expect(withMount.filter((argument) => argument === "--mount").length).toBe(1);
    expect(withMount.includes("-v")).toBe(false);
  });

  it("refuses a limit that would make the ceilings decorative (fail closed, no container is created)", () => {
    expect(() => new DockerSandboxProvider({ diskBytes: 0 })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ diskBytes: 16_000_000 - 1 })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ diskBytes: 1.5 })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ memory: "0m" })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ memory: "1.5g" })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ cpu: "0" })).toThrow(/resource limits/);
    expect(() => new DockerSandboxProvider({ cpu: "0.05" })).toThrow(/resource limits/);
    // Positive control: valid values are accepted, so the refusals above are about the values.
    expect(() => new DockerSandboxProvider({ diskBytes: 16_000_000, memory: "1536m", cpu: "1", pids: 128 })).not.toThrow();

    // Project size has no ceiling; what a command prints and how long it runs still do.
    expect(defaultTerminalLimits.outputLimitBytes).toBe(64_000);
    expect(defaultTerminalLimits.syncMaxBytes).toBe(Number.POSITIVE_INFINITY);
    expect(defaultTerminalLimits.syncMaxFiles).toBe(Number.POSITIVE_INFINITY);
    expect(defaultTerminalLimits.commandTimeoutMs).toBe(120_000);
    expect(defaultTerminalLimits.installBuildTimeoutMs).toBe(3_600_000);
  });

  it("bounds what a command prints, on the way in and again in the untrusted-data envelope", () => {
    const huge = "x".repeat(5_000_000);
    // First bound: the shell runtime trims output with an explicit marker instead of returning 5 MB.
    const trimmed = truncateShellOutput(huge, 1_000);
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.text.includes("[truncated")).toBe(true);
    expect(trimmed.text.length < huge.length).toBe(true);
    expect(trimmed.text.length < 1_200).toBe(true);

    // Second bound: the envelope's own budget, applied to the payload the tool would return.
    const envelope = wrapToolResult("code.shell.exec", { stdout: huge }, { maxChars: 4_000 }) as {
      truncated?: boolean;
      truncation?: { reason?: string; originalChars?: number };
      data: Record<string, unknown>;
    };
    expect(envelope.truncated).toBe(true);
    expect(envelope.truncation?.reason).toBe("output_budget");
    expect((envelope.truncation?.originalChars ?? 0) >= huge.length).toBe(true);
    expect(JSON.stringify(envelope).length < huge.length).toBe(true);
    expect(Object.keys(envelope.data).includes("truncatedPreview")).toBe(true);

    // The budget is configurable but never absent: the shipped default is a finite number.
    expect(resolveCodeAgentLimits({}).toolOutputChars).toBe(30_000);
    expect(Number.isFinite(resolveCodeAgentLimits({}).toolOutputChars)).toBe(true);
    expect(enforceOutputBudget({ a: 1 }, 30_000).truncated).toBe(false);
  });

  it("refuses an oversized command and clamps the run time to the configured ceiling", async () => {
    const fake = recordingSandbox();
    const runtime = new CodeShellRuntime({
      sandbox: fake.port,
      policy: engine(),
      flags: ALLOW_ALL_FLAGS,
      limits: { commandTimeoutMs: 1_000, installBuildTimeoutMs: 5_000 },
    });

    // An 8 kB+ command line is refused before anything is classified or executed.
    let oversized: unknown = null;
    try {
      await runtime.exec(ctx, {
        companyId: "company-c14",
        projectId: "project-c14",
        sessionId: "session-c14",
        toolCallId: "call-oversized",
        command: `echo ${"x".repeat(9_000)}`,
      });
    } catch (error) {
      oversized = error;
    }
    expect((oversized as { code?: string }).code).toBe("invalid_command");
    expect(fake.calls.length).toBe(0);

    // A caller-supplied timeout cannot outlive the configured ceiling: the sandbox gets the clamped value.
    await runtime.exec(ctx, {
      companyId: "company-c14",
      projectId: "project-c14",
      sessionId: "session-c14",
      toolCallId: "call-timeout",
      command: "echo hello",
      timeoutMs: 10_000_000,
    });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.timeoutMs).toBe(5_000);
  });

  it("negative control: small work is accepted, so the ceilings above are refusals and not a blanket denial", () => {
    // Same functions, same code paths, small input: nothing is trimmed and no limit is refused.
    expect(truncateShellOutput("short output", 1_000).truncated).toBe(false);
    expect(truncateShellOutput("short output", 1_000).text).toBe("short output");
    const envelope = wrapToolResult("code.shell.exec", { stdout: "small" }, { maxChars: 4_000 }) as { truncated?: boolean };
    expect(envelope.truncated).toBeUndefined();
    expect(enforceOutputBudget({ a: 1 }, 30_000).truncated).toBe(false);
    expect(() => new DockerSandboxProvider({ diskBytes: 16_000_000, memory: "1536m", cpu: "1", pids: 128 })).not.toThrow();
    // …while the same provider still refuses a decorative ceiling, so both branches are exercised.
    expect(() => new DockerSandboxProvider({ diskBytes: 0 })).toThrow(/resource limits/);
  });
});
