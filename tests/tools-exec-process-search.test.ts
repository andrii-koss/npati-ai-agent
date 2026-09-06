import { describe, expect, it } from "vitest";
import {
  SandboxedExecEngine,
  ProcessControlManager,
  SemanticToolSearchEngine,
} from "../apps/agent-api/src/tools-exec-process-search";

describe("Sandboxed Exec Engine (SandboxedExecEngine)", () => {
  it("executes sandboxed commands and captures output and status", async () => {
    const output = await SandboxedExecEngine.execute({
      command: "git status",
      mockOutput: { stdout: "On branch main\nnothing to commit", exitCode: 0 },
    });

    expect(output.commandId).toMatch(/^cmd_/);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("On branch main");
  });
});

describe("Process Control Manager (ProcessControlManager)", () => {
  it("tracks processes, issues signals, and updates process states", () => {
    const manager = new ProcessControlManager();

    const proc = manager.registerProcess(4120, "redis-server", { port: 6379 });
    expect(proc.status).toBe("running");
    expect(manager.listProcesses().length).toBe(1);

    // Send kill signal
    const killed = manager.sendSignal(4120, "SIGKILL");
    expect(killed).toBe(true);
    expect(manager.listProcesses().length).toBe(0); // 0 running
    expect(manager.listProcesses(false)[0].status).toBe("killed");
  });
});

describe("Semantic Tool Search Engine (SemanticToolSearchEngine)", () => {
  it("indexes tools and searches top-k tools by task intent", () => {
    const searcher = new SemanticToolSearchEngine();

    searcher.registerTools([
      {
        name: "execute_sql_query",
        description: "Executes read/write SQL queries against Postgres database",
        category: "database",
        tags: ["sql", "postgres", "database"],
        parameters: { query: { type: "string" } },
      },
      {
        name: "send_slack_message",
        description: "Sends a notification message to a Slack channel",
        category: "communication",
        tags: ["slack", "messaging", "notifications"],
        parameters: { channel: { type: "string" }, text: { type: "string" } },
      },
      {
        name: "fetch_web_page",
        description: "Fetches and parses HTML content from a URL",
        category: "web",
        tags: ["http", "scraping", "browser"],
        parameters: { url: { type: "string" } },
      },
    ]);

    const results = searcher.searchTools("run sql select query on postgres", { topK: 1 });
    expect(results.length).toBe(1);
    expect(results[0].tool.name).toBe("execute_sql_query");
    expect(results[0].score).toBeGreaterThan(3.0);
  });
});
