import type { DevelopmentProcessProgressItem as Event } from "./chat-development";

/** Legacy rows can say completed after exhausting a limit; the recorded stop reason wins. */
export function normalizeCodeRunStatus<T extends string>(status:T, reason:unknown):T|"failed" {
  return status==="completed" && ["budget_exhausted","step_limit","time_limit","invalid_arguments_exhausted","loop_detected","provider_error","tool_failure"].includes(String(reason)) ? "failed" : status;
}

/** Derived evidence only: heartbeats, reads and successful commands alone are not progress. */
export function monitorCodeRun(events: Event[], run: { status: string; startedAt: string; finishedAt?: string | null }, now = Date.now()) {
  const ordered = [...events].sort((a,b) => Date.parse(a.at)-Date.parse(b.at) || a.id.localeCompare(b.id));
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const started = Date.parse(run.startedAt);
  let lastProgress = started, progressId: string | undefined;
  const evidence = new Set<string>(), repeats = new Map<string, number>();
  const errors=new Map<string,number>();
  const warnings: { label: "Possible Loop" | "No Progress" | "Stalled"; eventId?: string; reason: string }[] = [];
  let retries = ordered.filter(e=>e.stage==="provider_retry").length;
  const failed = ordered.filter(e => e.status === "failed" || (e.exitCode !== undefined && e.exitCode !== 0));
  for (const e of ordered) {
    const success = e.status === "completed" && (e.exitCode === undefined || e.exitCode === 0) && !e.dryRun;
    const changes = [e.fileChange || e.file && /^code\.fs\.(write|edit|apply_patch)$/.test(e.tool ?? "") ? {path:e.file,action:e.fileChange ?? "modified",diff:e.diff,linesAdded:e.linesAdded,linesRemoved:e.linesRemoved} : undefined, ...(e.files ?? [])].filter(Boolean);
    const changed = changes.filter(f => f!.action && (f!.action === "created" || f!.action === "deleted" || !!f!.diff || (f!.linesAdded ?? 0)+(f!.linesRemoved ?? 0)>0));
    // A repeated identical diff/test/preview receipt cannot reset the no-progress clock.
    const proof = changed.length ? JSON.stringify(changed) : e.tests && e.tests.passed > 0 && e.tests.failed === 0 ? "tests:"+JSON.stringify(e.tests)+":"+e.tool : e.stage === "preview" && success ? "preview:"+(e.result ?? e.title) : undefined;
    if (success && proof && !evidence.has(proof)) {
      evidence.add(proof); lastProgress = Math.max(lastProgress, Date.parse(e.at)+(e.durationMs ?? 0)); progressId=e.id; repeats.clear();errors.clear();
    }
    if(e.status==="failed" && (e.errorCode || e.error)) {
      const key=e.errorCode ?? e.error!;
      const failures=(errors.get(key) ?? 0)+1;errors.set(key,failures);
      if(failures===4) warnings.push({label:"Possible Loop",eventId:e.id,reason:"The same error recurred four times without confirmed progress."});
    }
    if (e.kind === "assistant_message" || e.stage === "model_usage" || ["waiting_for_approval","awaiting_approval","pending"].includes(e.status ?? "") || (!e.tool && !e.command)) continue;
    let args=e.arguments;
    try {if(args) {const parsed=JSON.parse(args);args=JSON.stringify(parsed,Object.keys(parsed).sort());}} catch { /* Older recordings may contain non-JSON arguments. */ }
    const key = JSON.stringify([e.agentId,e.tool,e.command,args ?? e.file,e.errorCode,e.status === "failed" ? e.error : undefined]);
    const count = (repeats.get(key) ?? 0)+1; repeats.set(key,count);
    if (count > 1 && e.status === "failed") retries++;
    if (count === 4 && !warnings.some(w=>w.eventId===e.id)) warnings.push({label:"Possible Loop",eventId:e.id,reason:"Four identical operations without new confirmed progress; inspect results and retry intent."});
  }
  const active = run.status === "running";
  const noProgressMs = Math.max(0,end-lastProgress);
  if (active && noProgressMs >= 300_000) warnings.push({label:"No Progress",reason:"No new recorded file changes, passing tests or successful Preview for at least five minutes."});
  const running = ordered.filter(e=>e.status === "running" || e.status === "active");
  const stale = running.find(e=>now-Date.parse(e.at) >= (/\b(?:install|build)\b/.test(e.command ?? "") ? 600_000 : 300_000));
  const latest = ordered.filter(e=>e.stage!=="model_usage").at(-1);
  if (active && (stale || !running.length && now-Date.parse(latest?.at ?? run.startedAt) >= 300_000)) warnings.push({label:"Stalled",eventId:stale?.id,reason:"An operation exceeded the observation window or no new events arrived; inspect its duration and execution lease."});
  const brief=(e:Event|undefined)=>e ? {id:e.id,at:e.at,title:e.command ?? e.file ?? e.title,tool:e.tool,status:e.status,error:e.error,errorCode:e.errorCode,agentId:e.agentId} : undefined;
  return { durationMs:Math.max(0,end-started), toolCalls:ordered.filter(e=>e.tool).length, successful:ordered.filter(e=>e.status === "completed" && (e.exitCode === undefined || e.exitCode === 0)).length, failed:failed.length, retries, lastAction:brief(latest), lastError:brief(failed.at(-1)), activeActions:ordered.filter(e=>["running","active","waiting_for_approval","awaiting_approval"].includes(e.status ?? "")), lastProgressAt:new Date(lastProgress).toISOString(), progressId, noProgressMs, warnings };
}
