import { sanitizeExecutionTrace, type DevelopmentProcess, type DevelopmentProcessProgressItem } from "@npati/shared";
import type { AuthContext, WorkspaceStore, CodeRunStateRecord } from "@npati/workspace";
import type { ProjectTerminalEventsRepository } from "./project-terminal-events";

export function sanitizeProgress(item: DevelopmentProcessProgressItem): DevelopmentProcessProgressItem {
  const safe = { ...item };
  for (const field of ["title", "tool", "command", "file", "cwd", "result", "stdout", "stderr", "error", "errorCode", "agentId", "diff"] as const) {
    if (typeof safe[field] === "string") safe[field] = sanitizeExecutionTrace(safe[field]!);
  }
  if (safe.files) safe.files = safe.files.slice(0,200).map(file => ({ ...file, path: sanitizeExecutionTrace(file.path), diff: file.diff ? sanitizeExecutionTrace(file.diff).slice(0,128_000) : undefined }));
  if (safe.result && safe.result.length > 128_000) { safe.result = safe.result.slice(0, 128_000); safe.resultTruncated = true; }
  return safe;
}
/** Include only the session's roots and their explicitly linked children in this tenant/project. */
export function selectDevelopmentTraceRuns(runs: CodeRunStateRecord[], ctx: AuthContext, process: DevelopmentProcess) {
  const scoped = runs.filter(run => run.workspaceId === ctx.workspaceId && run.companyId === process.companyId && run.projectId === process.projectId);
  const roots = scoped.filter(run => run.sessionId === process.sessionId && typeof run.details.parentRunId !== "string");
  const allowed = new Set(roots.map(run => run.runId));
  for (let i = 0; i < scoped.length; i++) {
    let changed = false;
    for (const run of scoped) if (!allowed.has(run.runId) && typeof run.details.parentRunId === "string" && allowed.has(run.details.parentRunId)) { allowed.add(run.runId); changed = true; }
    if (!changed) break;
  }
  return { roots, children: scoped.filter(run => allowed.has(run.runId) && !roots.includes(run)) };
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
/** The same factual tool-result fields serve live updates and recorded replay. */
export function executionResultDetails(value: unknown): Partial<DevelopmentProcessProgressItem> {
  const data = object(value);
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const actions: Record<string,string> = { add: "created", update: "modified", delete: "deleted", created: "created", modified: "modified", deleted: "deleted" };
  const files = Array.isArray(data.files) ? data.files.slice(0,200).flatMap(raw => { const file = object(raw); if (typeof file.path !== "string") return []; return [{path:file.path,action:actions[String(file.action)] as "created" | "modified" | "deleted" | undefined,diff:string(file.diff),linesAdded:numeric(file.linesAdded),linesRemoved:numeric(file.linesRemoved)}]; }) : undefined;
  const counts = object(data.tests);
  const tests = ["passed","failed","skipped","total"].every(key => numeric(counts[key]) !== undefined && Number(counts[key]) >= 0) ? counts as {passed:number;failed:number;skipped:number;total:number} : undefined;
  return Object.fromEntries(Object.entries({status: typeof data.exitCode === "number" && data.exitCode !== 0 || typeof object(data.stats).failed === "number" && Number(object(data.stats).failed) > 0 ? "failed" : undefined, file:string(data.path),stdout:string(data.stdout),stderr:string(data.stderr),exitCode:numeric(data.exitCode),diff:string(data.diff),linesAdded:numeric(data.linesAdded),linesRemoved:numeric(data.linesRemoved),fileChange:actions[String(data.status)],files,tests}).filter(([,value]) => value !== undefined)) as Partial<DevelopmentProcessProgressItem>;
}
/** JSONB serializes nested Date values as ISO strings; pg does not revive them. */
export function executionTimestamp(value: unknown): number | undefined {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}
function executionIso(value: unknown, fallback: string): string {
  const time = executionTimestamp(value);
  return time === undefined ? fallback : new Date(time).toISOString();
}
const string = (value: unknown) => typeof value === "string" ? value : undefined;
/** Projection of existing write-ahead calls, replay results and terminal logs. Writes no execution ledger. */
export async function developmentTrace(store: WorkspaceStore, ctx: AuthContext, process: DevelopmentProcess, terminal?: ProjectTerminalEventsRepository): Promise<DevelopmentProcessProgressItem[]> {
  const progress = (process.progress ?? []).map(sanitizeProgress);
  const run = process.runId ? await store.getCodeRunState(process.companyId, process.runId) : null;
  if (run && (run.workspaceId !== ctx.workspaceId || run.projectId !== process.projectId || run.sessionId !== process.sessionId)) return progress;
  const calls = new Map<string, DevelopmentProcessProgressItem>();
  if (run) {
    const turns = await store.listCodeRunTurns(process.companyId, run.runId);
    const bundle = await store.getReplayBundle(process.companyId, run.runId);
    const steps = bundle ? await store.listReplayBundleSteps(process.companyId, bundle.id) : [];
    const args = new Map<string, Record<string, unknown>>();
    const results = new Map<string, Record<string, unknown>>();
    for (const step of steps) {
      const payload = object(step.payload);
      if (step.kind === "model_step") {
        const requested = object(payload.response).toolCalls;
        if (Array.isArray(requested)) for (const call of requested) {
          const c = object(call); if (typeof c.id === "string") args.set(c.id, object(c.arguments));
        }
      } else if (step.kind === "tool_call" && step.toolCallId) results.set(step.toolCallId, payload);
    }
    for (const turn of turns) for (const call of turn.toolCalls) {
      const replay = results.get(call.toolCallId);
      const result = object(replay?.settledResult);
      const data = object(result.data ?? result.result ?? result);
      const input = args.get(call.toolCallId) ?? {};
      const live = progress.find(item => item.id === run.runId + ":" + call.toolCallId);
      const started = executionTimestamp(call.startedAt);
      const finished = executionTimestamp(call.finishedAt);
      const unfinished = !call.finishedAt;
      const status = call.errorCode === "approval_required" ? "waiting_for_approval" : run.status === "cancelled" && (unfinished || call.outcome !== "ok" || live?.status === "cancelled" || typeof data.exitCode === "number" && data.exitCode !== 0) ? "cancelled" : unfinished ? run.status === "waiting_for_user" ? "waiting_for_approval"
        : run.status === "cancelled" ? "cancelled" : run.status === "running" ? "running" : "failed"
        : call.outcome === "ok" ? "completed" : "failed";
      const output = string(replay?.settledResult);
      calls.set(call.toolCallId, sanitizeProgress({
        ...live, ...executionResultDetails(data),
        id: run.runId + ":" + call.toolCallId, runId: run.runId, stage: "tool", title: call.tool,
        at: executionIso(call.startedAt, executionIso(turn.startedAt, executionIso(run.startedAt, process.createdAt))), status: status === "completed" && (executionResultDetails(data).status === "failed" || live?.status === "failed") ? "failed" : status, tool: call.tool,
        command: string(input.command) ?? live?.command, file: string(input.path ?? input.file) ?? executionResultDetails(data).file ?? live?.file, cwd: string(input.cwd) ?? live?.cwd,
        result: output ?? live?.result, resultTruncated: replay?.truncated === true || live?.resultTruncated,
        durationMs: started !== undefined && finished !== undefined && finished >= started ? finished - started : undefined,
        error: string(data.error) ?? string(object(result.error).message), errorCode: call.errorCode ?? string(replay?.errorCode),
        agentId: string(input.agentId) ?? string(run.details.agentId) ?? (typeof run.details.agentType === "string" ? run.details.agentType + " " + run.runId.slice(0, 8) : "NPATI Coding Agent"),
      }));
    }
    // Some older runs only have Activity metadata, not write-ahead call records.
    const activity = await store.listCodeActivityEvents({ companyId: process.companyId, runId: run.runId, limit: 200 });
    for (const event of activity) {
      const p = event.payload, id = String(p.toolCallId ?? event.id);
      if (typeof p.tool !== "string" || calls.has(id)) continue;
      calls.set(id, sanitizeProgress({ id: run.runId + ":" + id, runId: run.runId, stage: "tool", title: p.tool,
        tool: p.tool, at: executionIso(event.createdAt, process.createdAt), status: p.ok === false ? "failed" : "completed",
        durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined, errorCode: string(p.errorCode), agentId: string(p.agentId) }));
    }
  }
  if (terminal && process.projectId) {
    const logs = await terminal.list(ctx, process.companyId, process.projectId, 200);
    for (const log of logs) {
      const at = Date.parse(log.createdAt);
      const setupEnd = process.progress?.find(event => event.stage === "agent")?.at;
      if (log.runId ? log.runId !== process.runId : at < Date.parse(process.createdAt) || (setupEnd && at > Date.parse(setupEnd))) continue;
      // Shell calls already have their result in replay; avoid rendering the same command twice.
      const existing = [...progress, ...calls.values()].find(call => call.command === sanitizeExecutionTrace(log.commandSummary) && Math.abs(Date.parse(call.at) - Date.parse(log.createdAt)) <= log.durationMs + 2000);
      const details = { command: log.commandSummary, result: log.output, exitCode: log.exitCode ?? undefined,
        durationMs: log.durationMs, errorCode: log.errorCode, agentId: log.agentId };
      if (existing) { Object.assign(existing, sanitizeProgress({ ...existing, ...details })); continue; }
      progress.push(sanitizeProgress({ id: "terminal:" + log.id, stage: "command", title: "Running command", at: log.createdAt,
        status: log.status === "failed" || log.status === "timed_out" ? "failed" : log.status === "stopped" ? "cancelled" : "completed",
        ...details }));
    }
  }
  if (run && run.status !== "running") for (const event of progress) {
    if ((!event.runId || event.runId === run.runId) && (event.status === "running" || event.status === "active")) event.status = run.status === "waiting_for_user" ? "waiting_for_approval" : run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed";
  }
  return Array.from(new Map([...progress, ...calls.values()].map(item => [item.id, item])).values()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
}
