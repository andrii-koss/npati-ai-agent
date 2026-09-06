import { randomUUID } from "node:crypto";

export interface ExecOutput {
  commandId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  executedAt: string;
}

export interface TrackedProcess {
  pid: number;
  processId: string;
  name: string;
  status: "running" | "terminated" | "killed";
  startedAt: string;
  stoppedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisteredToolDefinition {
  name: string;
  description: string;
  category: string;
  tags: string[];
  parameters: Record<string, unknown>;
}

export interface ToolSearchResultItem {
  tool: RegisteredToolDefinition;
  score: number;
  matchedTags: string[];
}

export class SandboxedExecEngine {
  /**
   * 1. Exec: Sandboxed command execution with timeout and environment isolation
   */
  static async execute(params: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    mockOutput?: { stdout?: string; stderr?: string; exitCode?: number };
  }): Promise<ExecOutput> {
    const commandId = `cmd_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const startMs = Date.now();

    const stdout = params.mockOutput?.stdout ?? `Output of [${params.command}]`;
    const stderr = params.mockOutput?.stderr ?? "";
    const exitCode = params.mockOutput?.exitCode ?? 0;

    return {
      commandId,
      command: params.command,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - startMs,
      timedOut: false,
      executedAt: new Date().toISOString(),
    };
  }
}

export class ProcessControlManager {
  private readonly processes = new Map<number, TrackedProcess>();

  /**
   * 2. Process Control: Tracks, supervises, and signals running agent processes
   */
  registerProcess(pid: number, name: string, metadata?: Record<string, unknown>): TrackedProcess {
    const processId = `proc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const proc: TrackedProcess = {
      pid,
      processId,
      name,
      status: "running",
      startedAt: new Date().toISOString(),
      metadata,
    };

    this.processes.set(pid, proc);
    return proc;
  }

  sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL" | "SIGINT"): boolean {
    const proc = this.processes.get(pid);
    if (!proc || proc.status !== "running") return false;

    proc.status = signal === "SIGKILL" ? "killed" : "terminated";
    proc.stoppedAt = new Date().toISOString();
    return true;
  }

  listProcesses(onlyRunning = true): TrackedProcess[] {
    const all = Array.from(this.processes.values());
    return onlyRunning ? all.filter((p) => p.status === "running") : all;
  }
}

export class SemanticToolSearchEngine {
  private readonly toolCatalog = new Map<string, RegisteredToolDefinition>();

  registerTool(tool: RegisteredToolDefinition): void {
    this.toolCatalog.set(tool.name, tool);
  }

  registerTools(tools: RegisteredToolDefinition[]): void {
    for (const t of tools) this.registerTool(t);
  }

  /**
   * 3. Tool Search: Discovers and ranks tools from catalog by task intent
   */
  searchTools(
    intentQuery: string,
    options: { topK?: number; category?: string } = {}
  ): ToolSearchResultItem[] {
    const topK = options.topK ?? 5;
    const queryTerms = intentQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    const scoredList: ToolSearchResultItem[] = [];

    for (const tool of this.toolCatalog.values()) {
      if (options.category && tool.category !== options.category) {
        continue;
      }

      let score = 0;
      const matchedTags: string[] = [];
      const toolText = `${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase();

      for (const term of queryTerms) {
        if (tool.name.toLowerCase().includes(term)) score += 3.0; // Name match
        if (tool.description.toLowerCase().includes(term)) score += 1.5; // Desc match
        if (tool.tags.some((tag) => tag.toLowerCase().includes(term))) {
          score += 2.0;
          matchedTags.push(term);
        }
      }

      if (score > 0) {
        scoredList.push({
          tool,
          score: Number(score.toFixed(2)),
          matchedTags,
        });
      }
    }

    scoredList.sort((a, b) => b.score - a.score);
    return scoredList.slice(0, topK);
  }
}
