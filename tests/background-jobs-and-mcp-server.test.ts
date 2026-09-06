import { describe, expect, it } from "vitest";
import { BackgroundCompletionReporter } from "../apps/agent-api/src/background-completion-reporter";
import { McpServerEngine, type McpCallerScope } from "../apps/agent-api/src/mcp-server-engine";

describe("Background Completion Reporting (BackgroundCompletionReporter)", () => {
  it("tracks job lifecycle, calculates duration, and generates HMAC signature", () => {
    const reporter = new BackgroundCompletionReporter();
    const companyId = "comp-bg-1";
    const webhookSecret = "whsec_test_secret_key_888";

    const job = reporter.createJob({
      companyId,
      agentId: "agent-worker-1",
      taskType: "data_migration",
      payload: { targetDatabase: "postgres" },
      callbackUrl: "https://example.com/api/webhooks/jobs",
      webhookSecret,
    });

    expect(job.id).toMatch(/^job_/);
    expect(job.status).toBe("queued");
    expect(job.progressPercent).toBe(0);

    // Update progress
    reporter.updateProgress(job.id, 50, "Migrated 50,000 records.");
    const runningJob = reporter.getJob(job.id);
    expect(runningJob?.status).toBe("running");
    expect(runningJob?.progressPercent).toBe(50);
    expect(runningJob?.currentStep).toBe("Migrated 50,000 records.");

    // Complete job
    const completion = reporter.completeJob(job.id, { recordsMigrated: 100_000, success: true });
    expect(completion.job.status).toBe("completed");
    expect(completion.job.progressPercent).toBe(100);
    expect(completion.report.status).toBe("completed");
    expect(completion.signature).toBeDefined();
    expect(completion.signature?.length).toBe(64); // SHA-256 hex string
  });
});

describe("Model Context Protocol - MCP Server Engine (McpServerEngine)", () => {
  const adminScope: McpCallerScope = {
    companyId: "comp-mcp",
    tenantId: "tenant-mcp",
    permissions: ["mcp:tools:execute", "mcp:resources:read", "mcp:prompts:read"],
  };

  const restrictedScope: McpCallerScope = {
    companyId: "comp-mcp",
    tenantId: "tenant-mcp",
    permissions: [], // No permissions
  };

  it("handles initialize and tools/list requests", async () => {
    const server = new McpServerEngine();

    // 1. Initialize
    const initRes = await server.handleRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      adminScope
    );
    expect(initRes.result.serverInfo.name).toBe("npati-mcp-server");

    // 2. Tools list
    const toolsRes = await server.handleRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      adminScope
    );
    expect(toolsRes.result.tools.length).toBeGreaterThan(0);
    expect(toolsRes.result.tools.some((t: any) => t.name === "echo")).toBe(true);
  });

  it("executes tool when authorized and rejects unauthorized callers", async () => {
    const server = new McpServerEngine();

    // Authorized call
    const authRes = await server.handleRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { message: "Hello MCP" } },
      },
      adminScope
    );

    expect(authRes.error).toBeUndefined();
    expect(authRes.result.content[0].text).toContain("Hello MCP");

    // Unauthorized call (forbidden)
    const unauthRes = await server.handleRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { message: "Hello MCP" } },
      },
      restrictedScope
    );

    expect(unauthRes.error).toBeDefined();
    expect(unauthRes.error?.message).toContain("FORBIDDEN");
  });

  it("reads resources with scoped resource permission check", async () => {
    const server = new McpServerEngine();

    const res = await server.handleRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "npati://system/capabilities" },
      },
      adminScope
    );

    expect(res.error).toBeUndefined();
    expect(res.result.contents[0].text).toContain("NPATI Agent Platform");
  });
});
