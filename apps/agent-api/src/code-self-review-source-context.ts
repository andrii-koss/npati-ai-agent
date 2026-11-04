import { sha256Hex, type CodeToolInvokeResult } from "./code-tool-runtime";
import { CredentialMasker } from "./security-guardrails";
import type { ReviewCoordinatorHost } from "./coding-agent-review-coordinator";

/** Review needs the current unchanged consumers of a fix, not just added/removed lines. */
export class SelfReviewSourceContext {
  private readonly paths = new Set<string>();
  private pass = 0;
  private readonly receipts: string[] = [];

  record(result: CodeToolInvokeResult, args?: Record<string, unknown>): void {
    if (result.tool === "code.fs.read") { this.remember(args?.path); return; }
    let receipt: unknown = result.result;
    if (result.tool === "code.shell.exec") {
      const data = (result.result as { data?: { exitCode?: number; stdout?: string; durationMs?: number; truncated?: boolean } })?.data;
      if (data?.exitCode !== 0) return;
      receipt = { command: CredentialMasker.mask(String(args?.command ?? args?.cmd ?? args?.commandLine ?? "(not recorded)")).slice(0, 500), cwd: CredentialMasker.mask(String(args?.cwd ?? args?.workingDirectory ?? "(session cwd)")).slice(0, 500), exitCode: 0, stdout: CredentialMasker.mask(String(data.stdout ?? "")).slice(-2000), durationMs: data.durationMs, truncated: data.truncated || String(data.stdout ?? "").length > 2000 };
    } else if (result.tool !== "code.data.policies.apply") return;
    this.receipts.push(JSON.stringify({ tool: result.tool, toolVersion: result.toolVersion, schemaVersion: result.schemaVersion, result: receipt }).slice(0, 4000));
    if (this.receipts.length > 8) this.receipts.shift();
  }

  remember(path: unknown): void {
    if (typeof path === "string" && this.paths.size < 12) this.paths.add(path);
  }

  async collect(host: ReviewCoordinatorHost, steps: number): Promise<string[]> {
    const context: string[] = [];
    this.pass += 1;
    const pass = this.pass;
    const paths = [...this.paths].slice(0, 8);
    const results = await Promise.all(paths.map(async (path) => {
      const toolCallId = `review-context:${host.turnId}:${pass}:${sha256Hex(path).slice(0, 16)}`;
      const result = await host.ports.toolRuntime.invoke(host.ctx, {
        companyId: host.companyId, projectId: host.projectId, sessionId: host.sessionId,
        tool: "code.fs.read", args: { path, limit: 120 }, turnId: host.turnId,
        toolCallId,
        ...(host.input.runId ? { runId: host.input.runId } : {}),
        ...host.capabilityScopeFields,
      });
      return { path, toolCallId, result };
    }));
    for (const { path, toolCallId, result } of results) {
      if (result.ok) {
        const text = JSON.stringify(result.result);
        context.push(JSON.stringify({ source: "final_source_context", path, content: text.slice(0, 7000), truncated: text.length > 7000 }));
      }
      await host.record({ kind: "tool_call", companyId: host.companyId, projectId: host.projectId,
        sessionId: host.sessionId, runId: host.input.runId, turn: steps, tool: "code.fs.read", toolCallId, path, ok: result.ok,
        ...(result.ok ? {} : { errorCode: result.error.code }) });
      host.summary.toolCalls += 1;
    }
    return [...this.receipts, ...context];
  }
}
