import type { CodeToolExecutionContext } from "./code-tool-runtime";

/**
 * C3 post-write hook: runs a deployment-configured command (formatter, syntax check) in the sandbox over
 * the files a change touched. It returns warnings only — the hook never blocks a write, never rewrites a
 * file behind the caller's back and never runs when no command is configured.
 */
export async function runSandboxPostWriteHook(
  sandbox: { execute(ctx: CodeToolExecutionContext["ctx"], companyId: string, request: { projectId: string; command: string; timeoutMs?: number }): Promise<{ stdout?: string; output?: string; exitCode?: number }> },
  ctx: CodeToolExecutionContext["ctx"],
  companyId: string,
  projectId: string,
  command: string | undefined,
  paths: string[],
): Promise<string[] | undefined> {
  if (!command || !paths.length) return undefined;
  const quoted = paths.map((path) => `'${path.replace(/'/g, "'\\''")}'`).join(" ");
  const result = await sandbox.execute(ctx, companyId, { projectId, command: `${command} ${quoted}`, timeoutMs: 120_000 });
  const output = (result.stdout ?? result.output ?? "").trim();
  const lines = output ? output.split("\n").slice(0, 20) : [];
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return lines.length ? lines : [`command exited with code ${result.exitCode}`];
  }
  return lines.length ? lines : undefined;
}
