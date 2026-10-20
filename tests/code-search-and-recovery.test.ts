import { describe, it, expect, vi } from "vitest";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { createProjectWorkspaceReadPort } from "../apps/agent-api/src/code-tool-runtime-workspace";
import { CodingAgentToolWaves, type ToolWavesExecutionHost } from "../apps/agent-api/src/coding-agent-tool-waves";
import { SandboxProviderError } from "../apps/agent-api/src/sandbox-provider";
import { resolveKnownTool, normalizeToolCalls } from "../apps/agent-api/src/code-tool-call-adapter";
import { applyUnifiedDiffToFile } from "../apps/agent-api/src/code-tool-executors-write";
import { safeProjectPath } from "../apps/agent-api/src/project-workspace";
import {
  resolveCodeRunBudget,
  resolveCodeRunDailyBudget,
  DEFAULT_CODE_RUN_BUDGET,
  DEFAULT_CODE_RUN_DAILY_BUDGET,
  CodeRunSharedQuota,
} from "../apps/agent-api/src/code-run-quota";
import { A2AQuotaManager } from "../apps/agent-api/src/a2a-protocol-extensions";
import type { AuthContext } from "@npati/workspace";

const mockCtx: AuthContext = {
  userId: "user-1",
  workspaceId: "ws-1",
  role: "owner",
  permissions: ["*"],
};

describe("code.fs.grep secure execution & terminal approval isolation", () => {
  it("executes search via internal search method without triggering approval_required", async () => {
    const executedCommands: string[] = [];
    const mockProvider = {
      getStatus: vi.fn().mockResolvedValue({ state: "running" }),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockImplementation(async (_scope, _sandboxId, command) => {
        executedCommands.push(command);
        return {
          status: "completed",
          stdout: "index.html:12:  <button id=\"clickMe\">Click Me</button>\nindex.html:25:  <button id=\"reset\">Reset</button>",
          stderr: "",
          exitCode: 0,
          durationMs: 15,
        };
      }),
    };

    const mockProject = {
      id: "proj-1",
      companyId: "comp-1",
      sandboxId: "sb-1",
      runtime: "nodejs",
    };

    const mockProjects = {
      get: vi.fn().mockResolvedValue(mockProject),
    };
    const mockStore = {
      getCompanyAgent: vi.fn().mockResolvedValue({ id: "agent-1", isActive: true, tools: ["project.terminal.exec"] }),
      setProjectSandbox: vi.fn(),
    };
    const mockWorkspace = {
      listFiles: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(),
      createFile: vi.fn(),
      writeFile: vi.fn(),
    };
    const mockEvents = { append: vi.fn() };

    const service = new ProjectSandboxService(
      mockProjects as any,
      mockStore as any,
      mockWorkspace as any,
      mockProvider as any,
      mockEvents as any,
    );

    const result = await service.search(mockCtx, "comp-1", {
      projectId: "proj-1",
      query: "button",
      path: "index.html",
      maxResults: 10,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({
      path: "index.html",
      line: 12,
      text: '  <button id="clickMe">Click Me</button>',
    });
    expect(result.matches[1]).toEqual({
      path: "index.html",
      line: 25,
      text: '  <button id="reset">Reset</button>',
    });
    expect(executedCommands).toHaveLength(1);
    expect(executedCommands[0]).toContain("QUERY=");
    expect(executedCommands[0]).toContain("rg --json --line-number --no-heading --color=never --no-require-git --max-count 10 -e \"$QUERY\" -- './index.html'");
  });

  it("safely encodes complex patterns with quotes and shell characters without shell injection", async () => {
    let capturedCommand = "";
    const mockProvider = {
      getStatus: vi.fn().mockResolvedValue({ state: "running" }),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockImplementation(async (_scope, _sandboxId, command) => {
        capturedCommand = command;
        return { status: "completed", stdout: "", stderr: "", exitCode: 0, durationMs: 5 };
      }),
    };

    const mockProjects = {
      get: vi.fn().mockResolvedValue({ id: "proj-1", companyId: "comp-1", sandboxId: "sb-1" }),
    };
    const mockStore = {
      getCompanyAgent: vi.fn().mockResolvedValue({ id: "agent-1", isActive: true, tools: ["project.terminal.exec"] }),
      setProjectSandbox: vi.fn(),
    };
    const mockWorkspace = {
      listFiles: vi.fn().mockResolvedValue([]),
    };
    const mockEvents = { append: vi.fn() };

    const service = new ProjectSandboxService(
      mockProjects as any,
      mockStore as any,
      mockWorkspace as any,
      mockProvider as any,
      mockEvents as any,
    );

    const injectionPayload = "'; rm -rf /; $(whoami); `touch hacked` \" || true";
    await service.search(mockCtx, "comp-1", {
      projectId: "proj-1",
      query: injectionPayload,
    });

    // The raw injection payload must NOT appear unencoded in the command script
    expect(capturedCommand).not.toContain("rm -rf");
    expect(capturedCommand).not.toContain("$(whoami)");
    expect(capturedCommand).not.toContain("`touch hacked`");

    // The base64 representation must be present
    const expectedB64 = Buffer.from(injectionPayload, "utf8").toString("base64");
    expect(capturedCommand).toContain(expectedB64);
    expect(capturedCommand).toContain(`QUERY="$(printf '%s' "${expectedB64}" | base64 -d)"`);
  });

  it("arbitrary terminal command 'rg' executed via regular execute still requires approval", async () => {
    const mockProjects = {
      get: vi.fn().mockResolvedValue({ id: "proj-1", companyId: "comp-1", sandboxId: "sb-1" }),
    };
    const mockStore = {
      getCompanyAgent: vi.fn().mockResolvedValue({ id: "agent-1", isActive: true, tools: ["project.terminal.exec"] }),
      setProjectSandbox: vi.fn(),
    };
    const mockWorkspace = { listFiles: vi.fn().mockResolvedValue([]) };
    const mockEvents = { append: vi.fn() };

    const service = new ProjectSandboxService(
      mockProjects as any,
      mockStore as any,
      mockWorkspace as any,
      { executeCommand: vi.fn() } as any,
      mockEvents as any,
    );

    // Normal terminal execution of rg without approved: true must be rejected
    await expect(
      service.execute(mockCtx, "comp-1", {
        projectId: "proj-1",
        command: "rg 'test' .",
        agentId: "system",
      }),
    ).rejects.toThrowError(SandboxProviderError);

    try {
      await service.execute(mockCtx, "comp-1", {
        projectId: "proj-1",
        command: "rg 'test' .",
        agentId: "system",
      });
    } catch (err: any) {
      expect(err.code).toBe("approval_required");
      expect(err.status).toBe(403);
    }
  });

  it("blocks path traversal attempts in search target path", async () => {
    const mockProjects = {
      get: vi.fn().mockResolvedValue({ id: "proj-1", companyId: "comp-1", sandboxId: "sb-1" }),
    };
    const mockStore = {
      getCompanyAgent: vi.fn().mockResolvedValue({ id: "agent-1", isActive: true, tools: ["project.terminal.exec"] }),
      setProjectSandbox: vi.fn(),
    };
    const mockWorkspace = { listFiles: vi.fn().mockResolvedValue([]) };
    const mockEvents = { append: vi.fn() };

    const service = new ProjectSandboxService(
      mockProjects as any,
      mockStore as any,
      mockWorkspace as any,
      { executeCommand: vi.fn() } as any,
      mockEvents as any,
    );

    await expect(
      service.search(mockCtx, "comp-1", {
        projectId: "proj-1",
        query: "secret",
        path: "../../etc/passwd",
      }),
    ).rejects.toThrow();
  });

  it("createProjectWorkspaceReadPort delegates runSearch to sandbox.search", async () => {
    const mockSearch = vi.fn().mockResolvedValue({
      matches: [{ path: "app.ts", line: 5, text: "console.log" }],
      truncated: false,
    });

    const readPort = createProjectWorkspaceReadPort(
      {
        getFileTree: vi.fn(),
        readFile: vi.fn(),
      },
      {
        execute: vi.fn(),
        search: mockSearch,
      },
    );

    const result = await readPort.runSearch({
      ctx: mockCtx,
      companyId: "comp-1",
      projectId: "proj-1",
      query: "console.log",
      path: "app.ts",
      maxResults: 50,
      timeoutMs: 10_000,
      ignoreCase: true,
      fixedStrings: true,
      contextLines: 2,
    });

    expect(mockSearch).toHaveBeenCalledWith(mockCtx, "comp-1", {
      projectId: "proj-1",
      query: "console.log",
      path: "app.ts",
      maxResults: 50,
      timeoutMs: 10_000,
      ignoreCase: true,
      fixedStrings: true,
      contextLines: 2,
      glob: undefined,
      type: undefined,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].path).toBe("app.ts");
  });
});

describe("CodingAgentToolWaves argument error recovery semantics", () => {
  function createMockHost(): ToolWavesExecutionHost {
    return {
      ports: {
        toolRuntime: {
          invoke: vi.fn().mockResolvedValue({ ok: true, result: { done: true } }),
        } as any,
      } as any,
      limits: { parallelReadOnlyCalls: 4 } as any,
      now: () => Date.now(),
      input: { runId: "run-test" } as any,
      ctx: mockCtx,
      session: {} as any,
      companyId: "comp-1",
      projectId: "proj-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      stepTurnKey: (i) => `turn-${i}`,
      stateRunId: undefined,
      stateOwner: "owner",
      toolSteps: [],
      capabilityScopeFields: {},
      summary: { toolCalls: 0, checksRun: [] } as any,
      messages: [],
      runtimeToolByName: new Map(),
      toolVersionByName: new Map(),
      completionArtifacts: [],
      replayRecorder: undefined,
      pendingApprovals: [],
      reviewCoordinator: {
        readVerificationRevision: vi.fn(),
        onVerifyToolExecuted: vi.fn(),
      } as any,
      record: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      writeState: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(async (status, reason, message) => ({
        status,
        reason,
        message,
        summary: {} as any,
      })),
      pauseForUser: vi.fn(),
    };
  }

  it("resets argument error counter for a tool after that tool executes successfully", async () => {
    const host = createMockHost();
    const waves = new CodingAgentToolWaves(host);

    const profile = { maxParallelToolCalls: 1 } as any;

    // Step 1: Tool call rejected due to invalid arguments (Attempt 1)
    const turn1 = await waves.executeTurnTools({
      steps: 1,
      normalized: {
        calls: [],
        rejected: [
          {
            name: "code.fs.read",
            code: "invalid_tool_arguments",
            message: "Argument limit exceeds maximum 2000",
            mode: "native",
          },
        ],
        warnings: [],
      },
      callsToRun: [],
      profile,
    });
    expect(turn1.action).toBe("continue");
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0].content).toContain("attempt 1 of 2");

    // Step 2: Model successfully calls code.fs.read
    const turn2 = await waves.executeTurnTools({
      steps: 2,
      normalized: { calls: [], rejected: [], warnings: [] },
      callsToRun: [
        {
          id: "call-1",
          name: "code.fs.read",
          arguments: { path: "index.html", limit: 2000 },
          mode: "native",
        },
      ],
      profile,
    });
    expect(turn2.action).toBe("continue");

    // Step 3: Many turns later, another single invalid argument on code.fs.read
    // Because step 2 succeeded, this should be treated as attempt 1 (fresh), NOT attempt 2 or 3!
    const turn3 = await waves.executeTurnTools({
      steps: 15,
      normalized: {
        calls: [],
        rejected: [
          {
            name: "code.fs.read",
            code: "invalid_tool_arguments",
            message: "Argument limit exceeds maximum 2000",
            mode: "native",
          },
        ],
        warnings: [],
      },
      callsToRun: [],
      profile,
    });
    // It should NOT stop the run!
    expect(turn3.action).toBe("continue");
    expect(host.messages[host.messages.length - 1].content).toContain("attempt 1 of 2");
  });

  it("terminates run if same tool fails consecutively > MAX_ARGUMENT_CORRECTIONS (2) times without success", async () => {
    const host = createMockHost();
    const waves = new CodingAgentToolWaves(host);
    const profile = { maxParallelToolCalls: 1 } as any;

    const rejection = {
      name: "code.fs.read",
      code: "invalid_tool_arguments",
      message: "Argument limit exceeds maximum 2000",
      mode: "native" as const,
    };

    // Attempt 1
    const t1 = await waves.executeTurnTools({
      steps: 1,
      normalized: { calls: [], rejected: [rejection], warnings: [] },
      callsToRun: [],
      profile,
    });
    expect(t1.action).toBe("continue");

    // Attempt 2
    const t2 = await waves.executeTurnTools({
      steps: 2,
      normalized: { calls: [], rejected: [rejection], warnings: [] },
      callsToRun: [],
      profile,
    });
    expect(t2.action).toBe("continue");

    // Attempt 3 (exceeds max of 2 consecutive corrections)
    const t3 = await waves.executeTurnTools({
      steps: 3,
      normalized: { calls: [], rejected: [rejection], warnings: [] },
      callsToRun: [],
      profile,
    });
    expect(t3.action).toBe("stopped");
    if (t3.action === "stopped") {
      expect(t3.result.reason).toBe("invalid_arguments_exhausted");
    }
  });

  it("normalizes underscore tool names and provider schema hex hashes to canonical tools", () => {
    const knownTools = [
      { name: "code.fs.tree", inputSchema: { type: "object" } },
      { name: "code.fs.write", inputSchema: { type: "object" } },
      { name: "code.fs.edit", inputSchema: { type: "object" } },
    ];

    // 1. Direct match
    expect(resolveKnownTool(knownTools, "code.fs.tree")?.name).toBe("code.fs.tree");

    // 2. Underscore substitution
    expect(resolveKnownTool(knownTools, "code_fs_tree")?.name).toBe("code.fs.tree");
    expect(resolveKnownTool(knownTools, "code_fs_write")?.name).toBe("code.fs.write");

    // 3. Provider schema hash suffix stripping & prefixes
    expect(resolveKnownTool(knownTools, "code_fs_tree_6436360368b7e6bb")?.name).toBe("code.fs.tree");
    expect(resolveKnownTool(knownTools, "code_fs_write_7ff42833bd2b5577")?.name).toBe("code.fs.write");
    expect(resolveKnownTool(knownTools, "code_fs_edit_9c1e2c01607a8380")?.name).toBe("code.fs.edit");
    expect(resolveKnownTool(knownTools, "npati_code_write_7ff42833bd2b557")?.name).toBe("code.fs.write");
    expect(resolveKnownTool(knownTools, "npati_code_fs_write_7ff42833bd2b557")?.name).toBe("code.fs.write");
    expect(resolveKnownTool(knownTools, "code_write")?.name).toBe("code.fs.write");

    // 4. Truly unknown tool remains undefined
    expect(resolveKnownTool(knownTools, "code.evil.exec")).toBeUndefined();
    expect(resolveKnownTool(knownTools, "unknown_tool")).toBeUndefined();
  });

  it("normalizeToolCalls maps native provider hash calls to canonical tool calls without unknown_tool rejection", () => {
    const knownTools = [
      { name: "code.fs.tree", inputSchema: { type: "object" } },
      { name: "code.fs.write", inputSchema: { type: "object" } },
    ];

    const result = normalizeToolCalls({
      payload: {
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "code_fs_tree_6436360368b7e6bb",
              arguments: JSON.stringify({ dir: ".", maxDepth: 2 }),
            },
          },
        ],
      },
      profile: { toolCallingMode: "native" } as any,
      knownTools,
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe("code.fs.tree");
    expect(result.calls[0].arguments).toEqual({ dir: ".", maxDepth: 2 });
  });

  it("applyUnifiedDiffToFile resolves hunks with bare @@ headers via content matching", () => {
    const before = [
      "<html>",
      "<body>",
      "  <h1>NPATI Test</h1>",
      "  <p>Old content</p>",
      "</body>",
      "</html>",
    ].join("\n");

    const patch = [
      "--- a/index.html",
      "+++ b/index.html",
      "@@",
      "-  <p>Old content</p>",
      "+  <p>New content</p>",
      "+  <button id=\"clickBtn\">Click Me</button>",
    ].join("\n");

    const after = applyUnifiedDiffToFile("index.html", before, patch);
    expect(after).toContain("<p>New content</p>");
    expect(after).toContain("<button id=\"clickBtn\">Click Me</button>");
    expect(after).not.toContain("Old content");
  });

  it("safeProjectPath strictly rejects path traversal, alternative encodings, and protected paths", () => {
    // 1. Path traversal attempts
    expect(() => safeProjectPath("../etc/passwd")).toThrow();
    expect(() => safeProjectPath("../../secret")).toThrow();
    expect(() => safeProjectPath("sub/../../escape")).toThrow();
    expect(() => safeProjectPath("./../escape")).toThrow();

    // 2. Windows drive letters and absolute paths
    expect(() => safeProjectPath("C:/Windows/System32")).toThrow();
    expect(() => safeProjectPath("/etc/hosts")).toThrow();
    expect(() => safeProjectPath("\\windows\\system32")).toThrow();

    // 3. Null bytes and special characters rejected by safeProjectPath
    expect(() => safeProjectPath("file\0.txt")).toThrow();
    expect(() => safeProjectPath("file|pipe.txt")).toThrow();
    expect(() => safeProjectPath("file?glob.txt")).toThrow();
    expect(() => safeProjectPath("file*glob.txt")).toThrow();
    expect(() => safeProjectPath("file>redirect.txt")).toThrow();
    expect(() => safeProjectPath("file<in.txt")).toThrow();
    expect(() => safeProjectPath("file\"quote.txt")).toThrow();

    // 4. Protected secret paths
    expect(() => safeProjectPath(".env")).toThrow();
    expect(() => safeProjectPath(".env.local")).toThrow();
    expect(() => safeProjectPath(".git/config")).toThrow();
    expect(() => safeProjectPath(".ssh/id_rsa")).toThrow();
    expect(() => safeProjectPath(".npati-runtime")).toThrow();

    // 5. Valid paths pass cleanly
    expect(safeProjectPath("src/App.tsx")).toBe("src/App.tsx");
    expect(safeProjectPath("index.html")).toBe("index.html");
    expect(safeProjectPath("components/Button.vue")).toBe("components/Button.vue");
  });

  it("ProjectSandboxService.search includes '--' and does NOT follow symlinks", async () => {
    let capturedCmd = "";
    const mockProvider = {
      getStatus: vi.fn().mockResolvedValue({ state: "running" }),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockImplementation(async (_s, _id, cmd) => {
        capturedCmd = cmd;
        return { status: "completed", stdout: "", stderr: "", exitCode: 0, durationMs: 2 };
      }),
    };
    const mockProjects = { get: vi.fn().mockResolvedValue({ id: "p1", companyId: "c1", sandboxId: "s1" }) };
    const mockStore = { getCompanyAgent: vi.fn().mockResolvedValue({ id: "a1", isActive: true, tools: ["project.terminal.exec"] }), setProjectSandbox: vi.fn() };
    const mockWorkspace = { listFiles: vi.fn().mockResolvedValue([]) };
    const service = new ProjectSandboxService(mockProjects as any, mockStore as any, mockWorkspace as any, mockProvider as any, {} as any);

    await service.search(mockCtx, "c1", {
      projectId: "p1",
      query: "hello",
      path: "src/main.js",
    });

    // Explicit '--' delimiter must separate options from target
    expect(capturedCmd).toContain("-e \"$QUERY\" -- './src/main.js'");

    // ripgrep command must NOT have -L or --follow
    expect(capturedCmd).not.toContain("-L");
    expect(capturedCmd).not.toContain("--follow");
  });

  it("token budget semantics: independent local session cap (1M) vs daily user limit (2M)", () => {
    // 1. In local / self-hosted mode: session limit is 1,000,000 (50% of user daily budget)
    const localSessionBudget = resolveCodeRunBudget({ NPATI_SANDBOX_RUNNER_MODE: "local" } as any);
    expect(localSessionBudget.maxTokens).toBe(1_000_000);

    const selfHostedSessionBudget = resolveCodeRunBudget({ NPATI_DEPLOYMENT_TYPE: "self_hosted" } as any);
    expect(selfHostedSessionBudget.maxTokens).toBe(1_000_000);

    // 2. In production (default): session limit is strictly 100,000 (DEFAULT_CODE_RUN_BUDGET)
    const prodSessionBudget = resolveCodeRunBudget({});
    expect(prodSessionBudget.maxTokens).toBe(100_000);
    expect(DEFAULT_CODE_RUN_BUDGET.maxTokens).toBe(100_000);

    // 3. Daily user limit remains 2,000,000 across all environments
    const dailyBudget = resolveCodeRunDailyBudget({});
    expect(dailyBudget.maxTokensPerUserPerDay).toBe(2_000_000);
    expect(DEFAULT_CODE_RUN_DAILY_BUDGET.maxTokensPerUserPerDay).toBe(2_000_000);

    // 4. Enforce quota: CodeRunSharedQuota checkQuota rejects when session token limit exceeded
    const quotaManager = new A2AQuotaManager();
    const quota = new CodeRunSharedQuota(quotaManager, {
      limits: { maxTokens: 10_000, maxCostUsd: 1, maxDepth: 1 },
    });

    // Within budget -> allowed
    const pass = quota.checkQuota("sess-1", 5_000, 0.05, 1);
    expect(pass.allowed).toBe(true);

    // Record usage
    quota.recordUsage("sess-1", 9_000, 0.09);

    // Exceeds remaining budget (9000 + 2000 > 10000) -> rejected
    const fail = quota.checkQuota("sess-1", 2_000, 0.02, 1);
    expect(fail.allowed).toBe(false);
    expect(fail.error).toContain("A2A_TOKEN_QUOTA_EXCEEDED");
  });

  it("argument recovery alternation: alternating invalid -> valid -> invalid cannot loop indefinitely", async () => {
    let stoppedResult: any = null;
    const host = createMockHost();
    host.stop = vi.fn().mockImplementation(async (status, reason, message) => {
      stoppedResult = { status, reason, message };
      return { status, reason, message, summary: {} as any };
    });

    const waves = new CodingAgentToolWaves(host);
    const profile = { maxParallelToolCalls: 4 } as any;

    // Simulation: Turn 1: Invalid A
    const t1 = await waves.executeTurnTools({
      steps: 1,
      normalized: {
        calls: [],
        rejected: [{ name: "code.fs.read", code: "invalid_arguments", message: "Bad args", source: "native" }],
        warnings: [],
      },
      callsToRun: [],
      profile,
    });
    expect(t1.action).toBe("continue"); // Attempt 1

    // Turn 2: Valid A (success -> clears code.fs.read error counter)
    const t2 = await waves.executeTurnTools({
      steps: 2,
      normalized: { calls: [{ id: "c1", name: "code.fs.read", arguments: { path: "index.html" }, source: "native" }], rejected: [], warnings: [] },
      callsToRun: [{ id: "c1", name: "code.fs.read", arguments: { path: "index.html" }, source: "native" }],
      profile,
    });
    expect(t2.action).toBe("continue");
    expect(host.ports.toolRuntime.invoke).toHaveBeenCalled();

    // Turn 3: Invalid A again
    const t3 = await waves.executeTurnTools({
      steps: 3,
      normalized: {
        calls: [],
        rejected: [{ name: "code.fs.read", code: "invalid_arguments", message: "Bad args again", source: "native" }],
        warnings: [],
      },
      callsToRun: [],
      profile,
    });
    expect(t3.action).toBe("continue"); // Attempt 1 after reset

    // Turn 4: Consecutive Invalid A without valid success (Attempt 2 of 2)
    const t4 = await waves.executeTurnTools({
      steps: 4,
      normalized: {
        calls: [],
        rejected: [{ name: "code.fs.read", code: "invalid_arguments", message: "Bad args 2", source: "native" }],
        warnings: [],
      },
      callsToRun: [],
      profile,
    });
    expect(t4.action).toBe("continue"); // Attempt 2 of 2

    // Turn 5: 3rd Consecutive Invalid A (count = 3 > MAX_ARGUMENT_CORRECTIONS(2) -> stops the run)
    const t5 = await waves.executeTurnTools({
      steps: 5,
      normalized: {
        calls: [],
        rejected: [{ name: "code.fs.read", code: "invalid_arguments", message: "Bad args 3", source: "native" }],
        warnings: [],
      },
      callsToRun: [],
      profile,
    });
    expect(t5.action).toBe("stopped");
    expect(stoppedResult?.reason).toBe("invalid_arguments_exhausted");
  });

  it("tool name canonicalization negative tests: spoofing, aliases, collisions, forbidden tools", () => {
    // Restricted toolset (e.g. read-only subagent)
    const readOnlyKnownTools = [
      { name: "code.fs.read", inputSchema: { type: "object" } },
      { name: "code.fs.tree", inputSchema: { type: "object" } },
    ];

    // 1. Truly unknown tool
    expect(resolveKnownTool(readOnlyKnownTools, "completely_unknown_tool")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "exec_bash")).toBeUndefined();

    // 2. Namespace spoofing
    expect(resolveKnownTool(readOnlyKnownTools, "npati_system_admin_exec")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "npati.admin.delete_all")).toBeUndefined();

    // 3. Ambiguous or nonexistent tool alias with hash suffix
    expect(resolveKnownTool(readOnlyKnownTools, "code_fake_9c1e2c01607a8380")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "unknown_tool_6436360368b7e6bb")).toBeUndefined();

    // 4. Forbidden write tool passed via alternative name (must NOT grant access)
    expect(resolveKnownTool(readOnlyKnownTools, "code.fs.write")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "code_fs_write")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "code_write")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "npati_code_write_7ff42833bd2b557")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "code.fs.edit")).toBeUndefined();
    expect(resolveKnownTool(readOnlyKnownTools, "code_edit")).toBeUndefined();

    // 5. normalizeToolCalls rejects unauthorized/spoofed tools with unknown_tool
    const normalized = normalizeToolCalls({
      payload: {
        toolCalls: [
          {
            id: "call-spoof",
            type: "function",
            function: {
              name: "npati_code_write_7ff42833bd2b557",
              arguments: JSON.stringify({ path: "test.txt", content: "hacked" }),
            },
          },
        ],
      },
      profile: { toolCallingMode: "native" } as any,
      knownTools: readOnlyKnownTools,
    });

    expect(normalized.calls).toHaveLength(0);
    expect(normalized.rejected).toHaveLength(1);
    expect(normalized.rejected[0].code).toBe("unknown_tool");
  });
});

describe("unified patches use exact context when line numbers drift",()=>{
 it("relocates unique numbered hunks and preserves CRLF",()=>{
  const before=":root {\r\n  --ink: #fff;\r\n}\r\n.header {\r\n  background: white;\r\n}\r\n";
  const patch="@@ -40,3 +40,3 @@\n .header {\n-  background: white;\n+  background: black;\n }\n";
  expect(applyUnifiedDiffToFile("app/store.css",before,patch)).toBe(before.replace("background: white","background: black"));
 });
 it("refuses ambiguous relocation and genuinely stale text",()=>{
  expect(()=>applyUnifiedDiffToFile("a.css","white\nwhite\n","@@ -40,1 +40,1 @@\n-white\n+black")).toThrow(/multiple locations/);
  expect(()=>applyUnifiedDiffToFile("a.css","black\n","@@ -1,1 +1,1 @@\n-white\n+red")).toThrow(/re-read/);
 });
 it("keeps correctly positioned repeated context and supports length-changing hunks",()=>{
  expect(applyUnifiedDiffToFile("a.css","white\nwhite\nend\n","@@ -2,1 +2,2 @@\n-white\n+black\n+new\n@@ -3,1 +4,1 @@\n-end\n+done")).toBe("white\nblack\nnew\ndone\n");
 });
});
