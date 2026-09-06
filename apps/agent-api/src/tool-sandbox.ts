import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface SandboxExecutionOptions {
  timeoutMs?: number;
  maxMemoryMb?: number;
  maxBufferBytes?: number;
  allowedPaths?: string[];
  blockedKeywords?: string[];
  customEnv?: Record<string, string>;
}

export interface SandboxExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTimeMs: number;
  timedOut: boolean;
  sandboxViolations: string[];
}

export class ToolSandboxRunner {
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxMemoryMb: number;

  constructor(options: { defaultTimeoutMs?: number; defaultMaxMemoryMb?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.defaultMaxMemoryMb = options.defaultMaxMemoryMb ?? 256;
  }

  /**
   * Sanitize host environment variables: strips all sensitive server keys, passwords, and tokens
   */
  static sanitizeEnvironment(customEnv: Record<string, string> = {}): Record<string, string> {
    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH || "",
      NODE_ENV: "production",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    };

    // Filter host environment for secrets
    const sensitivePattern = /key|secret|password|token|auth|credential|conn|db_|database|postgres|redis|minio|s3/i;
    for (const [key, value] of Object.entries(process.env)) {
      if (value && !sensitivePattern.test(key) && !key.startsWith("NPATI_")) {
        safeEnv[key] = value;
      }
    }

    // Append explicitly permitted custom variables
    for (const [key, value] of Object.entries(customEnv)) {
      safeEnv[key] = value;
    }

    return safeEnv;
  }

  /**
   * Verify if a requested command or path violates host isolation
   */
  static validateSafety(command: string, args: string[] = []): { safe: boolean; violations: string[] } {
    const violations: string[] = [];
    const fullCommand = `${command} ${args.join(" ")}`.toLowerCase();

    // Check for dangerous system destructive operations
    const forbiddenPatterns = [
      /\brm\s+-rf\s+\//,
      /\bformat\s+[c-z]:/i,
      /\bdel\s+\/f\s+\/s\s+\/q\s+c:\\/i,
      /\bshutdown\b/,
      /\breboot\b/,
      /\bmkfs\b/,
      /\bdd\s+if=/,
      /\.env\b/,
      /id_rsa\b/,
      /id_ed25519\b/,
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(fullCommand)) {
        violations.push(`Forbidden destructive pattern detected: ${pattern.toString()}`);
      }
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }

  /**
   * Execute code or script within an isolated temporary sandbox directory with resource and time caps
   */
  async executeInSandbox(
    command: string,
    args: string[] = [],
    options: SandboxExecutionOptions = {}
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBuffer = options.maxBufferBytes ?? 1024 * 1024; // 1MB stdout cap

    // 1. Static security validation
    const validation = ToolSandboxRunner.validateSafety(command, args);
    if (!validation.safe) {
      return {
        success: false,
        stdout: "",
        stderr: `SANDBOX_SECURITY_VIOLATION: ${validation.violations.join(", ")}`,
        exitCode: 1,
        executionTimeMs: Date.now() - startTime,
        timedOut: false,
        sandboxViolations: validation.violations,
      };
    }

    // 2. Create isolated sandbox directory
    const sandboxId = randomUUID();
    const sandboxDir = resolve(tmpdir(), `npati_sandbox_${sandboxId}`);
    mkdirSync(sandboxDir, { recursive: true });

    const safeEnv = ToolSandboxRunner.sanitizeEnvironment(options.customEnv);

    return new Promise((res) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killed = false;

      const child = spawn(command, args, {
        cwd: sandboxDir,
        env: safeEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBuffer) {
          stdout += chunk.toString("utf8");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBuffer) {
          stderr += chunk.toString("utf8");
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
        res({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: 1,
          executionTimeMs: Date.now() - startTime,
          timedOut,
          sandboxViolations: [],
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
        const executionTimeMs = Date.now() - startTime;

        res({
          success: code === 0 && !timedOut,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          executionTimeMs,
          timedOut,
          sandboxViolations: [],
        });
      });
    });
  }
}
