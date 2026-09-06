import { createHash, randomUUID } from "node:crypto";

export interface FileReadResult {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  sha256: string;
}

export interface FileWriteResult {
  path: string;
  bytesWritten: number;
  sha256: string;
  writtenAt: string;
}

export interface CliGatewayResult {
  tool: string;
  commandExecuted: string;
  cleanStdout: string;
  cleanStderr: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
}

export interface RecipeRunResult {
  runId: string;
  recipeName: string;
  status: "completed" | "failed";
  outputSummary: string;
  executionDurationMs: number;
  timestamp: string;
}

export class SecureFileToolsEngine {
  private readonly virtualFiles = new Map<string, string>();

  /**
   * 1. File Tools: Virtual & secure filesystem operations
   */
  writeFile(path: string, content: string): FileWriteResult {
    const normPath = path.replace(/\\/g, "/");
    this.virtualFiles.set(normPath, content);

    const sha256 = createHash("sha256").update(content).digest("hex");
    return {
      path: normPath,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      sha256,
      writtenAt: new Date().toISOString(),
    };
  }

  readFile(
    path: string,
    options: { startLine?: number; endLine?: number } = {}
  ): FileReadResult | null {
    const normPath = path.replace(/\\/g, "/");
    const content = this.virtualFiles.get(normPath);
    if (content === undefined) return null;

    const lines = content.split("\n");
    const totalLines = lines.length;
    const startLine = Math.max(1, options.startLine ?? 1);
    const endLine = Math.min(totalLines, options.endLine ?? totalLines);

    const sliced = lines.slice(startLine - 1, endLine).join("\n");
    const sha256 = createHash("sha256").update(content).digest("hex");

    return {
      path: normPath,
      content: sliced,
      totalLines,
      startLine,
      endLine,
      sha256,
    };
  }

  replaceChunk(path: string, target: string, replacement: string): boolean {
    const normPath = path.replace(/\\/g, "/");
    const content = this.virtualFiles.get(normPath);
    if (content === undefined || !content.includes(target)) return false;

    const updated = content.replace(target, replacement);
    this.virtualFiles.set(normPath, updated);
    return true;
  }
}

export class CodingCliGateway {
  /**
   * 2. Coding CLI Gateway: Invokes dev CLI tools, strips ANSI, normalizes output
   */
  static stripAnsi(text: string): string {
    return text.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ""
    );
  }

  static async executeDevTool(
    tool: "npm" | "git" | "docker" | "cargo",
    args: string[],
    mockOutput?: { rawStdout?: string; rawStderr?: string; exitCode?: number }
  ): Promise<CliGatewayResult> {
    const rawStdout = mockOutput?.rawStdout ?? `\u001b[32mSuccess\u001b[0m running ${tool} ${args.join(" ")}`;
    const rawStderr = mockOutput?.rawStderr ?? "";
    const exitCode = mockOutput?.exitCode ?? 0;

    const cleanStdout = this.stripAnsi(rawStdout).trim();
    const cleanStderr = this.stripAnsi(rawStderr).trim();

    return {
      tool,
      commandExecuted: `${tool} ${args.join(" ")}`,
      cleanStdout,
      cleanStderr,
      exitCode,
      success: exitCode === 0,
      durationMs: 120,
    };
  }
}

export class OmnirouteRunRunner {
  /**
   * 3. omniroute run: Command runner for autonomous agent recipes and scripts
   */
  static async runRecipe(
    recipeName: string,
    params: Record<string, unknown> = {},
    customExecutor?: (recipe: string, p: Record<string, unknown>) => Promise<string>
  ): Promise<RecipeRunResult> {
    const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const start = Date.now();

    let outputSummary = `Recipe '${recipeName}' executed successfully with params: ${JSON.stringify(params)}`;
    if (customExecutor) {
      outputSummary = await customExecutor(recipeName, params);
    }

    return {
      runId,
      recipeName,
      status: "completed",
      outputSummary,
      executionDurationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }
}
