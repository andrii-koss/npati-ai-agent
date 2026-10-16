import { describe, it, expect, vi } from "vitest";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { createProjectWorkspaceReadPort } from "../apps/agent-api/src/code-tool-runtime-workspace";
import { CodingAgentToolWaves, type ToolWavesExecutionHost } from "../apps/agent-api/src/coding-agent-tool-waves";
import { SandboxProviderError } from "../apps/agent-api/src/sandbox-provider";
import { resolveKnownTool, normalizeToolCalls } from "../apps/agent-api/src/code-tool-call-adapter";
import { applyUnifiedDiffToFile } from "../apps/agent-api/src/code-tool-executors-write";
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
    expect(executedCommands[0]).toContain("rg --line-number --no-heading --color=never --max-count 10 -e \"$QUERY\" ./index.html");
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
});
