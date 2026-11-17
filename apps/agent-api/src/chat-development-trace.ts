import { sanitizeExecutionTrace, normalizeCodeRunStatus, developmentIsActive, type DevelopmentProcess, type DevelopmentProcessProgressItem } from "@npati/shared";
import type { AuthContext, WorkspaceStore, CodeRunStateRecord } from "@npati/workspace";
import { encodeCodeActivityCursor } from "@npati/workspace";
import type { ProjectTerminalEventsRepository } from "./project-terminal-events";

export function sanitizeProgress(item: DevelopmentProcessProgressItem): DevelopmentProcessProgressItem {
  const safe = { ...item };
  for (const field of ["title", "tool", "command", "arguments", "fileContent", "file", "cwd", "result", "stdout", "stderr", "error", "errorCode", "agentId", "diff"] as const) {
    if (typeof safe[field] === "string") safe[field] = sanitizeExecutionTrace(safe[field]!);
  }
  if(safe.modelUsage) safe.modelUsage={...safe.modelUsage,model:safe.modelUsage.model ? sanitizeExecutionTrace(safe.modelUsage.model) : undefined,provider:safe.modelUsage.provider ? sanitizeExecutionTrace(safe.modelUsage.provider) : undefined};
  if (safe.files) safe.files = safe.files.slice(0,200).map(file => ({ ...file, path: sanitizeExecutionTrace(file.path), diff: file.diff ? sanitizeExecutionTrace(file.diff).slice(0,32_000) : undefined }));
  for (const field of ["arguments", "fileContent", "stdout", "stderr", "diff"] as const) if (safe[field] && safe[field]!.length > 32_000) { safe[field] = safe[field]!.slice(0,32_000); safe.resultTruncated = true; }
  if (safe.result && safe.result.length > 32_000) { safe.result = safe.result.slice(0, 32_000); safe.resultTruncated = true; }
  return safe;
}

/**
 * Bounds the size of the process projection that is persisted on every activity update.
 * Keeping every tool's full file content and diff in a JSONB user setting made each patch a
 * multi-megabyte read/modify/write and starved concurrent projects. Recent events keep their
 * payload; older events keep only the metadata needed for the trace.
 */
export function compactProgress(events: DevelopmentProcessProgressItem[], maxEvents = 50, maxBytes = 384_000): DevelopmentProcessProgressItem[] {
  const recent = new Set(events.filter(event => event.kind !== "assistant_message").slice(-Math.max(1, maxEvents)));
  // Commentary is conversation content, not disposable tool detail. Replay restores it
  // after refresh; retain it while the run is still live as well.
  const kept = events.filter(event => event.kind === "assistant_message" || recent.has(event)).map(event => ({ ...event }));
  const heavy = ["fileContent", "diff", "result", "stdout", "stderr", "files", "arguments"] as const;
  let bytes = Buffer.byteLength(JSON.stringify(kept));
  // The newest 8 events are the useful diff/detail window. Strip older payloads until the
  // persisted projection fits its budget.
  for (let index = 0; index < kept.length && bytes > maxBytes; index++) {
    if (index >= kept.length - 8) continue;
    let changed = false;
    for (const field of heavy) {
      if (kept[index]![field] !== undefined) { delete (kept[index] as Record<string, unknown>)[field]; changed = true; }
    }
    if (changed) {
      kept[index]!.resultTruncated = true;
      bytes = Buffer.byteLength(JSON.stringify(kept));
    }
  }
  return kept;
}

/** Old processes keep an auditable trace but not file contents or diffs. */
export function metadataOnlyProgress(events: DevelopmentProcessProgressItem[], limit = 8): DevelopmentProcessProgressItem[] {
  const heavy = ["fileContent", "diff", "result", "stdout", "stderr", "files", "arguments"] as const;
  const recent = new Set(events.filter(event => event.kind !== "assistant_message").slice(-Math.max(1, limit)));
  return events.filter(event => event.kind === "assistant_message" || recent.has(event)).map(event => {
    const copy = { ...event };
    for (const field of heavy) delete (copy as Record<string, unknown>)[field];
    copy.resultTruncated = true;
    return copy;
  });
}
/** Include only the session's roots and their explicitly linked children in this tenant/project. */
/** `own`: the runs a chat-scoped process started; `claimed`: runs other chats started, left out of this process. */
export function selectDevelopmentTraceRuns(runs: CodeRunStateRecord[], ctx: AuthContext, process: DevelopmentProcess, scope: { own?: ReadonlySet<string>; claimed?: ReadonlySet<string> } = {}) {
  const scoped = runs.filter(run => run.workspaceId === ctx.workspaceId && run.companyId === process.companyId && run.projectId === process.projectId);
  // A chat opened from an existing project has no session of its own yet: its runs are simply this project's runs.
  const roots = scoped.filter(run => (!process.sessionId || run.sessionId === process.sessionId) && typeof run.details.parentRunId !== "string"
    && (scope.own ? scope.own.has(run.runId) : !scope.claimed?.has(run.runId)));
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
  const envelope = object(value);
  const data = object(envelope.data ?? envelope.result ?? envelope);
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const actions: Record<string,string> = { add: "created", update: "modified", delete: "deleted", created: "created", modified: "modified", deleted: "deleted" };
  const files = Array.isArray(data.files) ? data.files.slice(0,200).flatMap(raw => { const file = object(raw); if (typeof file.path !== "string") return []; return [{path:file.path,action:actions[String(file.action)] as "created" | "modified" | "deleted" | undefined,diff:string(file.diff),linesAdded:numeric(file.linesAdded),linesRemoved:numeric(file.linesRemoved)}]; }) : undefined;
  const readLines = Array.isArray(data.lines) && data.lines.every(line => typeof object(line).text === "string") ? data.lines.map(line => String(object(line).text)).join("\n") : undefined;
  const reports = Array.isArray(data.results) ? data.results.map(object) : [];
  // A verification call may contain a successful build and a failed test. Keep
  // its displayed command, output and exit code tied to the same failing check.
  const failedReport = reports.find(report => report.ok === false || report.timedOut === true || typeof report.exitCode === "number" && report.exitCode !== 0);
  const firstReport = failedReport ?? reports[0] ?? {};
  const recordedOutput = string(firstReport.stdout) || string(firstReport.raw) || string(firstReport.summary);
  const timedOut = reports.some(report => report.timedOut === true) || data.timedOut === true;
  const counts = object(data.tests);
  const tests = ["passed","failed","skipped","total"].every(key => numeric(counts[key]) !== undefined && Number(counts[key]) >= 0) ? counts as {passed:number;failed:number;skipped:number;total:number} : undefined;
  return Object.fromEntries(Object.entries({
    status: envelope.ok === false || data.ok === false || data.success === false || (tests?.failed ?? 0) > 0 || failedReport !== undefined || typeof data.exitCode === "number" && data.exitCode !== 0 || typeof object(data.stats).failed === "number" && Number(object(data.stats).failed) > 0 ? "failed" : undefined,
    dryRun: typeof data.dryRun === "boolean" ? data.dryRun : undefined,
    file: string(data.path),
    fileContent: data.binary === true || data.encoding === "base64" ? undefined : string(data.content) ?? readLines,
    stdout: string(data.stdout) ?? recordedOutput,
    stderr: string(data.stderr) ?? string(firstReport.stderr),
    exitCode: numeric(data.exitCode) ?? numeric(firstReport.exitCode),
    command: string(firstReport.command) ?? string(data.command),
    diff: string(data.diff), linesAdded: numeric(data.linesAdded), linesRemoved: numeric(data.linesRemoved),
    fileChange: actions[String(data.status)], files, tests,
    errorCode: timedOut ? "verification_timeout" : undefined,
    error: timedOut ? "Verification timed out" : failedReport ? string(failedReport.summary) : undefined,
  }).filter(([, value]) => value !== undefined)) as Partial<DevelopmentProcessProgressItem>;
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
type CompletedTrace = { terminal: ProjectTerminalEventsRepository | undefined; promise: Promise<DevelopmentProcessProgressItem[]>; bytes: number };
const completedTraceCaches = new WeakMap<WorkspaceStore, { entries: Map<string, CompletedTrace>; bytes: number }>();
async function completedTrace(store: WorkspaceStore, key: string, terminal: ProjectTerminalEventsRepository | undefined, load: () => Promise<DevelopmentProcessProgressItem[]>) {
  let cache = completedTraceCaches.get(store);
  if (!cache) { cache = { entries: new Map(), bytes: 0 }; completedTraceCaches.set(store, cache); }
  const existing = cache.entries.get(key);
  if (existing && existing.terminal === terminal) { cache.entries.delete(key); cache.entries.set(key, existing); return structuredClone(await existing.promise); }
  if (existing) { cache.entries.delete(key); cache.bytes -= existing.bytes; }
  const state = cache;
  const entry: CompletedTrace = { terminal, bytes: 0, promise: Promise.resolve([]) };
  entry.promise = load().then(value => {
    if (state.entries.get(key) === entry) {
      entry.bytes = Buffer.byteLength(JSON.stringify(value)); state.bytes += entry.bytes;
      while (state.entries.size > 128 || state.bytes > 32 * 1024 * 1024) {
        const oldest = state.entries.keys().next().value; if (oldest === undefined) break;
        state.bytes -= state.entries.get(oldest)!.bytes; state.entries.delete(oldest);
      }
    }
    return value;
  }).catch(error => { if (state.entries.get(key) === entry) { state.entries.delete(key); state.bytes -= entry.bytes; } throw error; });
  state.entries.set(key, entry);
  return structuredClone(await entry.promise);
}
/** Reuse immutable terminal transcripts; live runs and changed binding/run revisions stay fresh. */
export async function developmentTrace(store: WorkspaceStore, ctx: AuthContext, process: DevelopmentProcess, terminal?: ProjectTerminalEventsRepository): Promise<DevelopmentProcessProgressItem[]> {
  const recordedRun = process.runId ? await store.getCodeRunState(process.companyId, process.runId) : null;
  const scoped = recordedRun && recordedRun.workspaceId === ctx.workspaceId && recordedRun.projectId === process.projectId && recordedRun.sessionId === process.sessionId;
  const status = recordedRun ? normalizeCodeRunStatus(recordedRun.status, recordedRun.details?.stopReason) : undefined;
  const load = () => readDevelopmentTrace(store, ctx, process, recordedRun, terminal);
  if (!scoped || developmentIsActive(process) || status === "running" || status === "waiting_for_user") return load();
  const last = process.progress?.at(-1);
  const key = JSON.stringify([ctx.workspaceId, ctx.userId, process.companyId, process.projectId, process.sessionId, process.runId, recordedRun.revision, status, process.updatedAt, process.status, process.progress?.length, last?.id, last?.status]);
  return completedTrace(store, key, terminal, load);
}
async function readDevelopmentTrace(store: WorkspaceStore, ctx: AuthContext, process: DevelopmentProcess, recordedRun: CodeRunStateRecord | null, terminal?: ProjectTerminalEventsRepository): Promise<DevelopmentProcessProgressItem[]> {
  const progress = (process.progress ?? []).map(sanitizeProgress);
  const run = recordedRun ? {...recordedRun,status:normalizeCodeRunStatus(recordedRun.status,recordedRun.details?.stopReason)} : null;
  if (run && (run.workspaceId !== ctx.workspaceId || run.projectId !== process.projectId || run.sessionId !== process.sessionId)) return progress;
  const calls = new Map<string, DevelopmentProcessProgressItem>();
  if (run) {
    const activity = await store.listCodeActivityEvents({ companyId: process.companyId, runId: run.runId, limit: 200 });
    // Read all metadata pages rather than silently losing early calls on long runs.
    let page = activity.slice();
    while(page.length===200) {
      const last=page.at(-1)!;
      page=await store.listCodeActivityEvents({companyId:process.companyId,runId:run.runId,limit:200,cursor:encodeCodeActivityCursor({createdAt:new Date(last.createdAt),id:last.id})});
      if(!page.length || page.at(-1)?.id===last.id) break;
      activity.push(...page);
    }
    activity.sort((a,b)=>(executionTimestamp(a.createdAt) ?? 0)-(executionTimestamp(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
    for(const event of activity) {
      const p=event.payload;
      if(event.kind!=="run_activity" || p.eventType!=="model_call" || !["started","completed","failed"].includes(String(p.phase)) || typeof p.turn!=="number") continue;
      const attemptSuffix = typeof p.attempt === "number" && p.attempt > 1 ? ":attempt:" + p.attempt : "";
      const id=p.modelPurpose==="self_review" ? `${run.runId}:self-review:${p.turn}${attemptSuffix}` : `${run.runId}:thinking:${p.turn}${attemptSuffix}`;
      const existing=progress.find(e=>e.id===id);
      const phase=p.phase;
      if(existing && phase==="started" && ["completed","failed"].includes(existing.status ?? "")) continue;
      const at=phase==="started" ? new Date(executionTimestamp(event.createdAt) ?? Date.parse(process.createdAt)).toISOString() : existing?.at ?? new Date((executionTimestamp(event.createdAt) ?? Date.parse(process.createdAt))-(typeof p.durationMs==="number"?p.durationMs:0)).toISOString();
      const item=sanitizeProgress({...existing,id,runId:run.runId,stage:p.retryScheduled===true?"provider_retry":["model_generation","model_output"].includes(existing?.stage ?? "") ? existing!.stage : "model_response",title:typeof p.model==="string"?`Model call · ${p.model}`:"Model call",at,status:phase==="failed"?"failed":phase==="completed"?"completed":"running",durationMs:typeof p.durationMs==="number"?p.durationMs:existing?.durationMs,errorCode:typeof p.errorCode==="string"?p.errorCode:existing?.errorCode,error:phase==="failed" && typeof p.httpStatus==="number"?`AI Provider HTTP ${p.httpStatus}`:existing?.error});
      item.modelUsage={...existing?.modelUsage,id,turn:p.turn,model:typeof p.model==="string"?sanitizeExecutionTrace(p.model):undefined,provider:typeof p.provider==="string"?sanitizeExecutionTrace(p.provider):undefined,toolCallIds:[]};
      if(existing) Object.assign(existing,item); else progress.push(item);
    }
    const usages = new Map(progress.filter(item=>item.modelUsage && !["planning","provider_retry","model_response","model_generation","model_output"].includes(item.stage)).map(item=>[item.modelUsage!.turn,item.modelUsage!]));
    for(const event of activity) { const p=event.payload; if(event.kind==="run_activity" && !p.tool && typeof p.turn==="number" && typeof p.bytes==="number" && p.bytes>0 && !usages.has(p.turn)) usages.set(p.turn,{id:run.runId+":model:"+p.turn,turn:p.turn,totalTokens:p.bytes,toolCallIds:[]}); }
    const turns = await store.listCodeRunTurns(process.companyId, run.runId);
    const bundle = await store.getReplayBundle(process.companyId, run.runId);
    const steps = bundle ? await store.listReplayBundleSteps(process.companyId, bundle.id) : [];
    const args = new Map<string, Record<string, unknown>>();
    const results = new Map<string, Record<string, unknown>>();
    for (const step of steps) {
      const payload = object(step.payload);
      if (step.kind === "model_step") {
        const response=object(payload.response), usage=object(response.usage);
        const text = typeof response.content === "string" ? response.content.trim() : "";
        if (text && Array.isArray(response.toolCalls) && response.toolCalls.length && typeof payload.turnIndex === "number"
            && !/\<\/?(?:think|analysis|tool_call|tool_calls)\b/i.test(text)) {
          const id = run.runId + ":message:" + payload.turnIndex;
          if (!progress.some(item => item.id === id)) progress.push(sanitizeProgress({
            id, runId: run.runId, kind: "assistant_message", stage: "planning", title: text,
            at: executionIso(turns.find(turn => turn.turnIndex === payload.turnIndex)?.startedAt, executionIso(step.createdAt, executionIso(run.startedAt, process.createdAt))),
            sequence: payload.turnIndex * 1000, status: "completed", conversationId: process.conversationId,
          }));
        }
        if(typeof payload.turnIndex==="number" && typeof usage.totalTokens==="number") usages.set(payload.turnIndex,{id:run.runId+":model:"+payload.turnIndex,turn:payload.turnIndex,model:string(response.model),provider:string(response.provider),totalTokens:usage.totalTokens,inputTokens:typeof usage.promptTokens==="number"?usage.promptTokens:undefined,outputTokens:typeof usage.completionTokens==="number"?usage.completionTokens:undefined,toolCallIds:Array.isArray(response.toolCalls)?response.toolCalls.map(raw=>String(object(raw).id)):[]});
        const requested = response.toolCalls;
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
      const resultDetails = executionResultDetails(live?.result ?? data);
      const started = executionTimestamp(call.startedAt);
      const finished = executionTimestamp(call.finishedAt);
      const unfinished = !call.finishedAt;
      // Only a step the cancellation interrupted is "cancelled". A command that ran and exited 1 before the run was stopped
      // failed; showing it as cancelled made the person think the platform had undone work (V6 step 10).
      const status = call.errorCode === "approval_required" ? "waiting_for_approval" : run.status === "cancelled" && (unfinished || live?.status === "cancelled") ? "cancelled" : unfinished ? run.status === "waiting_for_user" ? "waiting_for_approval"
        : run.status === "cancelled" ? "cancelled" : run.status === "running" ? "running" : "failed"
        : call.outcome === "ok" ? "completed" : "failed";
      // Synthetic review replay entries can contain only "skipped". The durable
      // public activity carries the actual verification report in that case.
      const output = live?.result ?? string(replay?.settledResult);
      calls.set(call.toolCallId, sanitizeProgress({
        ...live, ...resultDetails,
        modelUsage: live?.modelUsage ?? usages.get(turn.turnIndex), dryRun: typeof input.dryRun==="boolean" ? input.dryRun : live?.dryRun ?? resultDetails.dryRun,
        id: run.runId + ":" + call.toolCallId, runId: run.runId, stage: "tool", title: call.tool,
        at: executionIso(call.startedAt, executionIso(turn.startedAt, executionIso(run.startedAt, process.createdAt))), status: status === "completed" && (resultDetails.status === "failed" || live?.status === "failed") ? "failed" : status, tool: call.tool,
        arguments: Object.keys(input).length ? JSON.stringify(input, null, 2) : live?.arguments,
        command: string(input.command) ?? live?.command, file: string(input.path ?? input.file) ?? resultDetails.file ?? live?.file, cwd: string(input.cwd) ?? live?.cwd,
        result: output ?? live?.result, resultTruncated: replay?.truncated === true || live?.resultTruncated,
        durationMs: started !== undefined && finished !== undefined && finished >= started ? finished - started : live?.durationMs,
        error: string(data.error) ?? string(object(result.error).message) ?? live?.error, errorCode: call.errorCode ?? string(replay?.errorCode) ?? live?.errorCode,
        agentId: string(input.agentId) ?? string(run.details.agentId) ?? (typeof run.details.agentType === "string" ? run.details.agentType + " " + run.runId.slice(0, 8) : "NPATI Coding Agent"),
      }));
    }
    // Some older runs only have Activity metadata, not write-ahead call records.
    for(const usage of usages.values()) if(!progress.some(item=>item.id===usage.id)) progress.push({id:usage.id,runId:run.runId,stage:"model_usage",title:"Model usage",at:process.createdAt,status:"completed",modelUsage:usage});
    for (const event of activity) {
      const p = event.payload, id = String(p.toolCallId ?? event.id);
      if (typeof p.tool !== "string" || event.kind === "policy_decision") continue;
      const opened = calls.get(id);
      if (opened) { if (!opened.file && string(p.path)) opened.file = string(p.path); continue; }
      const eventAt = executionTimestamp(event.createdAt);
      if (!p.toolCallId && eventAt !== undefined && typeof p.durationMs === "number" && [...progress, ...calls.values()].some(call =>
        call.runId === run.runId && call.tool === p.tool && call.durationMs !== undefined && Math.abs(call.durationMs - Number(p.durationMs)) < 100 &&
        Math.abs(eventAt - Date.parse(call.at) - call.durationMs) < 2000)) continue;
      const live = progress.find(item => item.id === run.runId + ":" + id);
      const recordedResult = live?.result ?? string(p.result);
      calls.set(id, sanitizeProgress({ ...live, ...executionResultDetails(recordedResult), id: run.runId + ":" + id, runId: run.runId, stage: "tool", title: p.tool,
        tool: p.tool, at: live?.at ?? executionIso(event.createdAt, process.createdAt), status: p.errorCode === "approval_required" ? "waiting_for_approval" : p.ok === false ? "failed" : live?.status ?? "completed",
        result: recordedResult, command: string(p.command) ?? live?.command, file: string(p.path) ?? live?.file, cwd: string(p.cwd) ?? live?.cwd,
        durationMs: typeof p.durationMs === "number" ? p.durationMs : live?.durationMs, errorCode: string(p.errorCode) ?? live?.errorCode, agentId: string(p.agentId) ?? live?.agentId }));
    }
  }
  if (terminal && process.projectId) {
    const logs = await terminal.list(ctx, process.companyId, process.projectId, 200);
    for (const log of logs) {
      const at = Date.parse(log.createdAt);
      const setupEnd = process.progress?.find(event => event.stage === "agent")?.at;
      const candidates = [...progress, ...calls.values()];
      // Verification commands are logged without a runId. Attach only when the
      // actual output AND execution interval match this run's recorded tool result.
      const matchedVerification = !log.runId && log.output.trim().length >= 32 && candidates.find(call =>
        call.runId === process.runId && call.tool === "code.verify.run" && call.durationMs !== undefined &&
        at >= Date.parse(call.at) && at <= Date.parse(call.at) + call.durationMs + 2000 &&
        (call.stdout ?? executionResultDetails(call.result).stdout ?? "").includes(sanitizeExecutionTrace(log.output.trim()).slice(0, 1000)));
      if (log.runId ? log.runId !== process.runId : !matchedVerification && (!setupEnd || at < Date.parse(process.createdAt) || (setupEnd && at > Date.parse(setupEnd)))) continue;
      // Shell calls already have their result in replay; avoid rendering the same command twice.
      const dispatched = /^(?:Dispatched|Approved) command \(/.test(log.commandSummary);
      const existing = [...progress, ...calls.values()].find(call => {
        const gap = Math.abs(Date.parse(call.at) - at);
        if (dispatched) return log.runId === call.runId && call.command !== undefined && gap <= (call.durationMs ?? 0) + 30_000;
        if (call.command !== sanitizeExecutionTrace(log.commandSummary)) return false;
        const sameDuration = call.durationMs !== undefined && Math.abs(call.durationMs - log.durationMs) < 1_000;
        return gap <= (call.durationMs ?? 0) + log.durationMs + 5000 || (sameDuration && gap <= 600_000);
      });
      // A failed dispatch only has a hash for its command. Without a call to attach to it says nothing to a user.
      if (dispatched && !existing) continue;
      const details = { command: dispatched ? existing?.command ?? log.commandSummary : log.commandSummary, result: log.output, exitCode: log.exitCode ?? undefined,
        durationMs: log.durationMs, errorCode: log.errorCode, agentId: log.agentId };
      if (existing) { Object.assign(existing, sanitizeProgress({ ...existing, ...details, status:log.exitCode !== null && log.exitCode !== 0 || log.status==="failed" || log.status==="timed_out" ? "failed" : log.status==="running" ? "running" : log.status==="stopped" ? "cancelled" : existing.status === "failed" ? "failed" : "completed" })); continue; }
      progress.push(sanitizeProgress({ id: "terminal:" + log.id, runId: log.runId ?? (matchedVerification ? process.runId : undefined), stage: "command", title: "Running command", at: log.createdAt,
        status: log.status === "failed" || log.status === "timed_out" || log.exitCode !== null && log.exitCode !== 0 ? "failed" : log.status === "running" ? "running" : log.status === "stopped" ? "cancelled" : "completed",
        ...details }));
    }
  }
  if (run && run.status !== "running") for (const event of progress) {
    // Preview finalization runs after the code lease completes; preserve its actual lifecycle.
    if (run.status === "completed" && event.stage === "preview") continue;
    if ((!event.runId || event.runId === run.runId) && (event.status === "running" || event.status === "active")) event.status = run.status === "waiting_for_user" ? "waiting_for_approval" : run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed";
  }
  return Array.from(new Map([...progress, ...calls.values()].map(item => [item.id, item])).values()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
}
