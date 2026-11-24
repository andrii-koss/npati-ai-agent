import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { technologySelectionTitle } from "./technology-selection-i18n";
import { Terminal, Blocks, FilePenLine, FileText, Package, Box, Monitor, Search, FlaskConical, Globe, Brain, ChevronDown, ChevronRight, Copy, Check, X, AlertCircle } from "lucide-react";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { sanitizeExecutionTrace } from "@npati/shared";
import { I18nContextRef, executionTraceText } from "./i18n";
import { en } from "./i18n/locales/en";
import { uk } from "./i18n/locales/uk";
import { isVisibleChatOperation, normalizeActivity, type CodingActivityRun } from "./chat-timeline";
import { codingStopCopy } from "./coding-stop-copy";
import { authFetch } from "./shell/auth-helpers";
import { ChatFileViewerContext, preloadChatFile } from "./ChatFileViewer";
import { CodeView } from "./code-highlight";
export interface AgentExecutionTraceProps { process?: DevelopmentProcess; items?: DevelopmentProcessProgressItem[]; isUk?: boolean; className?: string; run?: CodingActivityRun; nested?: boolean; language?: string; showIdentity?:boolean; animatePending?: boolean }
export const sanitizeTraceSecrets = sanitizeExecutionTrace;
type Labels = (key: string) => string;
/** Steps that run a command in the project, whether or not the step names it yet. */
const runsCommand = (item: DevelopmentProcessProgressItem) => Boolean(item.command) || /code\.verify|code\.deps|code\.shell/.test(item.tool ?? "");
/** Follows what the project's running command prints, only while a command is running in a visible tab. */
function useLiveCommandOutput(companyId: string | undefined, projectId: string | undefined, active: boolean) {
  const [line, setLine] = useState("");
  const [cpu, setCpu] = useState<number>();
  useEffect(() => {
    if (!active || !companyId || !projectId) { setLine(""); setCpu(undefined); return; }
    let closed = false;
    let seen: string[] = [];
    const queue: string[] = [];
    const url = "/api/companies/" + encodeURIComponent(companyId) + "/projects/" + encodeURIComponent(projectId) + "/terminal/live";
    const read = async () => {
      if (document.hidden) return;
      try {
        const response = await authFetch(url);
        if (!response.ok || closed) return;
        const data = await response.json() as { lines?: string[]; cpu?: number };
        if (closed || !Array.isArray(data.lines)) return;
        setCpu(data.cpu);
        // Everything printed since the last read is shown in turn, so a fast command visibly runs.
        const last = seen.at(-1);
        const from = last === undefined ? -1 : data.lines.lastIndexOf(last);
        queue.push(...data.lines.slice(from + 1));
        seen = data.lines;
      } catch { /* The next read recovers; the row keeps the last output. */ }
    };
    void read();
    const reader = window.setInterval(() => { void read(); }, 700);
    const player = window.setInterval(() => {
      if (!queue.length) return;
      // A long backlog is played faster, so the row never falls behind the command.
      const step = Math.max(1, Math.ceil(queue.length / 10));
      const next = queue.splice(0, step).at(-1);
      if (next) setLine(next);
    }, 70);
    return () => { closed = true; window.clearInterval(reader); window.clearInterval(player); };
  }, [companyId, projectId, active]);
  // While the command prints nothing, its real CPU use shows whether it is working.
  return cpu === undefined ? line : (line ? line + " · " : "") + "CPU " + cpu + "%";
}
const clock = (ms: number) => { const seconds = Math.max(0, Math.round(ms / 1000)); return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0"); };
/** From the first step to the end of the last one, as m:ss. */
export function runDuration(items: DevelopmentProcessProgressItem[]): string | undefined {
  const starts = items.map(item => Date.parse(item.at)).filter(Number.isFinite);
  if (!starts.length) return undefined;
  const ends = items.map(item => Date.parse(item.at) + (item.durationMs ?? 0)).filter(Number.isFinite);
  return clock(Math.max(...ends) - Math.min(...starts));
}
/** Time of the whole process. A pause over five minutes is the user away between requests, not work. */
export function processDuration(items: DevelopmentProcessProgressItem[]): string | undefined {
  const spans = items.map(item => ({ start: Date.parse(item.at), end: Date.parse(item.at) + (item.durationMs ?? 0) })).filter(span => Number.isFinite(span.start)).sort((a, b) => a.start - b.start);
  if (!spans.length) return undefined;
  let total = 0, start = spans[0]!.start, end = spans[0]!.end;
  for (const span of spans) {
    if (span.start - end > 300_000) { total += end - start; start = span.start; end = span.end; }
    else end = Math.max(end, span.end);
  }
  return clock(total + end - start);
}
/**
 * Not failures of the work: a question such as "is this package installed?" answered "no", and the guard that makes the
 * agent read a file again after it changed. The agent acts on both and carries on.
 */
export function isNegativeAnswer(item: DevelopmentProcessProgressItem): boolean {
  if (item.status === "failed" && ["read_before_write_required", "unchanged"].includes(item.errorCode ?? "")) return true;
  return item.status === "failed" && /^(?:npm ls|grep|rg|test|which|diff|ls)\b/.test(item.command ?? "") && (item.exitCode === 1 || item.exitCode === 2 || /"exitCode":\s*[12]\b/.test(item.result ?? ""));
}
/** A log shows the message itself, with its line breaks, not the envelope around it. */
export function plainResult(result: string): string {
  try {
    const parsed = JSON.parse(result) as { message?: unknown; details?: { exitCode?: unknown } };
    if (typeof parsed?.message !== "string") return result;
    const message = parsed.message.replace(/^Sandbox command failed:\s*/, "");
    return (typeof parsed.details?.exitCode === "number" ? "exit code " + parsed.details.exitCode + "\n\n" : "") + message;
  } catch { return result; }
}
/** A whole-file write shown as the code it wrote, not as escaped JSON. */
function writtenFile(raw: string | undefined): { path: string; content: string } | null {
  if (!raw) return null;
  try { const value = JSON.parse(raw) as { path?: unknown; content?: unknown }; return typeof value.path === "string" && typeof value.content === "string" ? { path: value.path, content: value.content } : null; } catch { return null; }
}
/** The model's reply was corrupted before it became a call; nothing in the project or the agent caused it. */
const isModelCallFailure = (item: DevelopmentProcessProgressItem) => item.errorCode === "malformed_native_tool_call" || item.error === "malformed_native_tool_call";
function readableFailure(item: DevelopmentProcessProgressItem): string | undefined {
  if (item.status !== "failed") return undefined;
  const raw = item.error || item.result || "";
  let message = raw;
  try { const parsed = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } }; message = String(parsed.message ?? parsed.error?.message ?? raw); } catch { /* plain text */ }
  const line = message.replace(/^Sandbox command failed:?\s*/, "").split(/\r?\n/).map(part => part.trim()).filter(part => part && !/^npm (?:warn|notice)/.test(part)).join(" ");
  return line ? sanitizeExecutionTrace(line).slice(0, 140) : undefined;
}
/** The last meaningful line a command printed, so its row says what happened. */
export function commandOutcome(item: DevelopmentProcessProgressItem): string | undefined {
  const failure = readableFailure(item);
  if (failure) return failure;
  if (/code\.verify/.test(item.tool ?? "")) return undefined;
  const text = item.stdout || (item.result && !/^\s*[{\[]/.test(item.result) ? item.result : "");
  const line = String(text ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map(part => part.trim())
    .filter(part => part && !/^(?:sent tapfd|received tapfd|npm (?:warn|notice)|> )/.test(part)).at(-1);
  return line ? sanitizeExecutionTrace(line).slice(0, 90) : undefined;
}
function operation(item: DevelopmentProcessProgressItem) {
  const tool = (item.tool ?? item.stage).toLowerCase();
  if (item.stage === "technology_selection" || /scaffold/.test(tool) || item.stage === "project" && tool === "code.workspace") return ["creatingProject", Blocks] as const;
  if (/search|grep|repo_map/.test(tool)) return ["searching", Search] as const;
  if (/read|list/.test(tool)) return ["reading", FileText] as const;
  if (/write|edit|patch|scaffold|files/.test(tool)) return ["editing", FilePenLine] as const;
  if (/deps|dependencies/.test(tool)) return ["dependencies", Package] as const;
  if (/test/.test(tool)) return ["testing", FlaskConical] as const;
  if (/build|verify/.test(tool)) return ["building", Box] as const;
  if (/browser/.test(tool)) return ["browser", Globe] as const;
  if (/preview/.test(tool)) return ["preview", Monitor] as const;
  if (/coding_agent|^agent$/.test(tool)) return ["working", Brain] as const;
  if (item.stage === "model_generation") return ["generatingCode", FilePenLine] as const;
  if (item.stage === "model_output") return ["modelResponding", Brain] as const;
  if (item.stage === "model_response") return ["working", Brain] as const;
  if (/planning|thinking/.test(tool)) return ["planning", Brain] as const;
  if (/sandbox|workspace/.test(tool)) return ["sandbox", Monitor] as const;
  return ["command", Terminal] as const;
}
function title(item: DevelopmentProcessProgressItem, t: Labels, active: boolean) {
  if (isModelCallFailure(item)) return t("modelCallFailed");
  if (item.errorCode === "read_before_write_required") return t("fileChangedReadAgain") + (item.file ? ": " + sanitizeExecutionTrace(item.file) : "");
  if (item.errorCode === "unchanged") return t("fileUnchanged") + (item.file ? ": " + sanitizeExecutionTrace(item.file) : "");
  if (item.status === "failed" && item.file && !item.command) return t("fileNotChanged") + ": " + sanitizeExecutionTrace(item.file) + (readableFailure(item) ? " — " + readableFailure(item) : "");
  if (item.command && ["waiting_for_approval", "awaiting_approval"].includes(item.status ?? "")) return t("awaiting_approval") + ": " + sanitizeExecutionTrace(item.command).slice(0, 100);
  if (/code\.finish/.test(item.tool ?? "")) return t("agentFinished");
  if (item.stage === "technology_selection") { const language = t("__language"); return language === "__language" ? sanitizeExecutionTrace(item.title) : technologySelectionTitle(language, item); }
  if (operation(item)[0] === "working") return t(item.status === "waiting_for_approval" ? "awaiting_approval" : item.status ?? "running");
  if (!item.status) return sanitizeExecutionTrace(item.command ? item.tool + ": " + item.command : item.title);
  if (item.command) { const command = sanitizeExecutionTrace(item.command).slice(0,100); if (active) return t("runningCommand").replace("{{command}}",command); const outcome = commandOutcome(item); return t("executed") + ": " + command + (outcome ? " — " + outcome : ""); }
  if (item.dryRun) return t("dryRun");
  const [kind] = operation(item);
  if (/fs\.list/.test(item.tool ?? "") && !item.file) return t(kind) + ": .";
  if (/code\.deps\.add/.test(item.tool ?? "") && item.arguments) {
    try { const spec = JSON.parse(item.arguments) as { name?: unknown; version?: unknown }; if (typeof spec.name === "string") return t(kind) + ": " + sanitizeExecutionTrace(spec.name) + (typeof spec.version === "string" ? "@" + sanitizeExecutionTrace(spec.version) : ""); } catch { /* plain label */ }
  }
  if (item.files && item.files.length > 1 && item.stage !== "model_generation") return t(kind) + ": " + item.files.length;
  if (item.file) return t(active ? kind : kind === "reading" ? "read" : kind === "editing" ? "updated" : kind) + ": " + sanitizeExecutionTrace(item.file);
  return kind === "command" ? sanitizeExecutionTrace(item.title) : t(kind);
}
export function formatProcessTitle(item: DevelopmentProcessProgressItem, isUk: boolean, active: boolean) { return title(item, key => (isUk ? uk : en).executionTrace[key] ?? key, active); }
export function AgentExecutionTrace({ process, items: directItems, run, nested = false, language, isUk = false, className = "",showIdentity=false, animatePending = true }: AgentExecutionTraceProps) {
  const i18n = useContext(I18nContextRef);
  const openFile = useContext(ChatFileViewerContext);
  const t: Labels = key => executionTraceText(run?.language ?? language ?? (isUk ? "uk" : i18n?.language ?? "en"),key);
  const [runOpen, setRunOpen] = useState(false);
  const [historyMounted, setHistoryMounted] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [fullLogs, setFullLogs] = useState(new Set<string>());
  const [copied, setCopied] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const toggle = (setter: typeof setExpanded, id: string) => setter(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const copy = useCallback(async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(sanitizeExecutionTrace(text)); setCopied(id); setTimeout(() => setCopied(current => current === id ? undefined : current), 1800); } catch { /* Clipboard denial does not stop the run. */ }
  }, []);
  const usageView = (usage: NonNullable<DevelopmentProcessProgressItem["modelUsage"]>) => <div className="codex-trace-usage" key={usage.id}><strong>{t("usage")} / #{usage.turn}</strong>{usage.model && <code>{sanitizeExecutionTrace(usage.model)}</code>}<span>{t("inputTokens")}: {usage.inputTokens ?? t("unavailableTokens")} / {t("outputTokens")}: {usage.outputTokens ?? t("unavailableTokens")} / {t("totalTokens")}: {usage.totalTokens ?? t("unavailableTokens")}</span>{usage.costUsd !== undefined && <span>${usage.costUsd.toFixed(6)}</span>}{usage.toolCallIds.length>1 && <small>{t("sharedTurn").replace("{{count}}",String(usage.toolCallIds.length))}</small>}</div>;
  const recordedItems = normalizeActivity(directItems ?? process?.progress);
  const items = recordedItems.filter(isVisibleChatOperation);
  // An open group shows the output in the command's own row, a closed one in its header. One reader either way.
  const commandRunning = (nested || !runOpen) && items.some(item => runsCommand(item) && ["running", "active"].includes(item.status ?? ""));
  const liveLine = useLiveCommandOutput(process?.companyId, process?.projectId, commandRunning);
  const latestOperation = useMemo(() => {
    const progress = process?.progress;
    if (!Array.isArray(progress)) return undefined;
    for (let index = progress.length - 1; index >= 0; index--) {
      const item = progress[index];
      if (item && typeof item.id === "string" && typeof item.stage === "string" && isVisibleChatOperation(item)) return item;
    }
    return undefined;
  }, [process?.progress]);
  const processActive = Boolean(process && ["preparing", "running"].includes(process.status));
  // Model calls are not separate chat steps: keep the latest visible workflow step active
  // until another operation takes over or the overall work ends. Never reactivate it for a new prompt.
  const carryActive = Boolean(animatePending && !nested && processActive && latestOperation &&
    !["cancelled", "awaiting_approval", "waiting_for_approval"].includes(latestOperation.status ?? "") &&
    !["cancelled", "queued", "waiting_for_approval"].includes(run?.status ?? "") &&
    (items.some(item => item.id === latestOperation.id) || !items.length && run?.status === "failed" && latestOperation.runId && latestOperation.runId === run.runId));
  useEffect(() => {
    if (!run || !carryActive && !["running", "pending", "preparing"].includes(run.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status, carryActive]);
  if (!items.length && !run) return null;
  if (run) {
    const running = (!process || processActive) && (run.status === "running" || run.status === "preparing" || run.status === "pending" && items.some(item=>["running","active"].includes(item.status??"")));
    // A long model turn writes the code inside its tool call. It stays out of the rows, but the header must say so
    // instead of leaving the last finished step ("Creating project") on screen for the whole turn.
    const generating = processActive && !nested && (carryActive || running) ? normalizeActivity(process?.progress).filter(item => item.stage === "model_generation" && item.status === "running" && (Date.parse(item.at) || 0) >= (Date.parse(latestOperation?.at ?? "") || 0)).at(-1) : undefined;
    if (!items.length && !carryActive && !generating && ["running", "pending", "preparing", "completed"].includes(run.status)) return null;
    const current = generating ?? [...items].reverse().find(item=>["running","active","awaiting_approval","waiting_for_approval"].includes(item.status??"")) ?? items.at(-1) ?? {id:run.id,stage:"agent",title:"",at:run.at,status:"pending" as const};
    const stepActive = running || carryActive;
    const operations = items.filter(item=>!["agent","planning","model_response","model_generation","model_output","provider_retry"].includes(item.stage));
    const setupOnly = !generating && operations.length > 0 && operations.every(item => operation(item)[0] === "creatingProject");
    const [, Icon] = operation(setupOnly ? operations[0] ?? current : current);
    const recovered = run.status === "failed" && process?.status === "completed";
    const label = run.status === "failed" && !recovered ? t("failed") : stepActive ? setupOnly ? t("creatingProject") : title(current,t,["running", "active"].includes(current.status ?? "")) : run.status === "completed" || recovered ? setupOnly ? t("creatingProject") : t("operationsDone").replace("{{count}}",String(operations.length)) : t(run.status === "waiting_for_approval" ? "awaiting_approval" : run.status);
    const files = new Map<string, {path: string; linesAdded?: number; linesRemoved?: number; status?: string; pending?: boolean}>();
    for (const item of items) {
      if (!/write|edit|patch|move|delete/.test(item.tool ?? "")) continue;
      if (item.file) files.set(item.file, {path:item.file, linesAdded:item.linesAdded, linesRemoved:item.linesRemoved, status:item.status});
      for (const file of item.files ?? []) files.set(file.path, {...file, status:item.status});
    }
    // Files of a turn are saved when the turn ends, so one still being generated cannot be opened yet.
    for (const file of generating?.files ?? []) files.set(file.path, {...file, pending: true, status: file.path === generating?.file ? "running" : "completed"});
    const visibleFiles = [...files.values()].slice(-6);
    // Setup ends where the model starts; the first model turn belongs to the code it writes, not to creating the project.
    const modelStart = Math.min(...recordedItems.filter(item => item.stage.startsWith("model_")).map(item => Date.parse(item.at)).filter(Number.isFinite));
    const setupMs = setupOnly && process && Number.isFinite(modelStart) ? modelStart - Date.parse(process.createdAt) : NaN;
    const spent = stepActive ? undefined : setupMs >= 0 ? clock(setupMs) : runDuration(recordedItems);
    const total = spent;
    const elapsed = stepActive && Number.isFinite(Date.parse(current.at)) ? Math.max(0, Math.floor((now - Date.parse(current.at)) / 1000)) : undefined;
    return <article className="assistant research-progress coding-run-activity" aria-live="polite"><div className={"research-page-row codex-trace-row " + (stepActive ? "active" : recovered ? "completed" : run.status) + (runOpen ? " expanded" : "")} data-run-id={run.runId ?? run.id}><button type="button" className="codex-trace-row-header coding-run-header" aria-expanded={runOpen} aria-controls={"run-detail-" + run.id} onClick={()=>{setHistoryMounted(true);setRunOpen(previous=>!previous);}}><span className="research-progress-state" aria-hidden="true">{stepActive ? "\u25cf" : run.status === "completed" || recovered ? <Check size={12}/> : run.status === "failed" ? <AlertCircle size={12}/> : run.status === "cancelled" ? <X size={12}/> : "\u25cf"}</span><Icon className="research-progress-globe" size={16} aria-hidden="true"/><span dir="auto" className={stepActive ? "research-active-text" : undefined}>{label}{total ? " · " + total : ""}</span>{commandRunning && liveLine && <code dir="auto" className="codex-trace-live-output" style={{ flex: 1, minWidth: 0, marginLeft: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.75, fontSize: "0.85em" }}>{sanitizeExecutionTrace(liveLine)}</code>}{elapsed !== undefined && <span className="codex-trace-duration-tag">{elapsed}s</span>}<span className="codex-trace-chevron-btn" aria-hidden="true">{runOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span></button>
      {visibleFiles.length > 0 && <ul className="coding-changed-files" aria-label={t("file")}>{visibleFiles.map(file => <li key={file.path}><button type="button" className="coding-file-chip" disabled={file.pending || !openFile || !process?.projectId} onPointerEnter={() => { if (!file.pending && openFile && process?.projectId) preloadChatFile({ companyId: process.companyId, projectId: process.projectId, path: file.path }); }} onClick={() => openFile?.({ companyId: process!.companyId, projectId: process!.projectId!, path: file.path, runId: run.runId })}><code>{file.path}</code>{file.linesAdded !== undefined && <span className="coding-file-added">+{file.linesAdded}</span>}{file.linesRemoved !== undefined && <span className="coding-file-removed">-{file.linesRemoved}</span>}</button>{file.status === "running" && <span>{t("editing")}</span>}</li>)}</ul>}
      {run.status === "failed" && process?.status === "failed" && run.runId === process.runId && process.detail && <p className="codex-trace-error-msg">{sanitizeExecutionTrace(codingStopCopy(process.detail,run.language ?? process.responseLanguage ?? language ?? i18n?.language))}</p>}
      <div className="codex-trace-collapse" aria-hidden={!runOpen} inert={!runOpen} onTransitionEnd={event=>{if(!runOpen && event.target===event.currentTarget)setHistoryMounted(false);}}> <div className="codex-trace-collapse-inner"><div id={"run-detail-" + run.id} className="coding-run-history">{historyMounted && <AgentExecutionTrace process={process ? {...process,runId:run.runId} : undefined} items={items} isUk={isUk} language={run.language} nested />}</div></div></div></div></article>;
  }
  return <article className={nested ? "coding-operation-history" : "assistant research-progress"} aria-live="polite"><div className={"research-page-list codex-trace-list " + className}>
    {items.map(item => {
      const active = item.status === "active" || item.status === "running";
      const status = active ? "active" : isNegativeAnswer(item) ? "completed" : item.status === "awaiting_approval" ? "waiting_for_approval" : item.status ?? "unknown";
      const open = expanded.has(item.id);
      const [, Icon] = operation(item);
      const safe = (text: string) => sanitizeExecutionTrace(text);
      const copyButton = (text: string, id: string, label: string) => <button type="button" className="codex-copy-btn" title={t(label)} onClick={() => void copy(text,id)}>{copied === id ? <Check size={12} /> : <Copy size={12} />}<span>{t(copied === id ? "copied" : "copy")}</span></button>;
      const written = writtenFile(item.arguments);
      const log = (text: string, label: string, path?: string) => <div className="codex-trace-field"><div className="codex-trace-field-top"><span className="codex-trace-field-name">{label}</span>{copyButton(text,label + item.id,"copyLog")}</div>{text.length > 4000 && <button type="button" className="codex-copy-btn" onClick={() => toggle(setFullLogs,label + item.id)}>{t(fullLogs.has(label + item.id) ? "less" : "fullLog")}</button>}<CodeView text={safe(fullLogs.has(label + item.id) ? text : text.slice(0,4000))} path={path} /></div>;
      return <div key={item.id} className={"research-page-row codex-trace-row " + status + (open ? " expanded" : "")} data-status={status}>
        <button type="button" className="codex-trace-row-header" onClick={() => toggle(setExpanded,item.id)} aria-expanded={open} aria-controls={"trace-detail-" + item.id}>
          <span className="research-progress-state" aria-hidden="true">{status === "failed" ? <AlertCircle size={12}/> : status === "cancelled" ? <X size={12}/> : status === "completed" ? <Check size={12}/> : "\u25cf"}</span>
          <span className="codex-trace-icon-box"><Icon className="research-progress-globe" size={16} aria-hidden="true"/></span>
          <span className="codex-trace-title-wrapper codex-trace-title"><span className={active ? "research-active-text" : undefined}><strong>{title(item,t,active)}</strong></span>{active && runsCommand(item) && liveLine && <code dir="auto" className="codex-trace-live-output" style={{ flex: 1, minWidth: 0, marginLeft: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.75, fontSize: "0.85em" }}>{sanitizeExecutionTrace(liveLine)}</code>}</span>
          <span className="codex-trace-header-right">{item.durationMs !== undefined && <span className="codex-trace-duration-tag">{(item.durationMs/1000).toFixed(1)}s</span>}<span className="codex-trace-chevron-btn" aria-hidden="true">{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span></span>
        </button>
        <div className="codex-trace-collapse" aria-hidden={!open} inert={!open}><div className="codex-trace-collapse-inner">{open && <div id={"trace-detail-" + item.id} className="codex-trace-detail-panel">
          <div className="codex-trace-status-line"><span className={`codex-trace-status-dot ${status}`} aria-hidden="true" />{t(status === "active" ? "running" : status === "waiting_for_approval" ? "awaiting_approval" : status)}</div>
          {item.stage==="provider_retry" && <div>{isUk?"Заплановано спробу з наступною моделлю":"Retry scheduled with the next configured model"}</div>}
          {showIdentity && item.agentId && <div>{safe(item.agentId)}</div>}
          {item.dryRun && <div>{t("dryRun")}</div>}
          {item.modelUsage && (item.modelUsage.totalTokens || item.modelUsage.inputTokens || item.modelUsage.outputTokens || item.modelUsage.costUsd !== undefined) ? usageView(item.modelUsage) : null}
          {item.tool && <div>{t("tool")}: <code className="codex-tool-name">{safe(item.tool)}</code></div>}
          {item.command && <div className="codex-trace-field"><div className="codex-trace-field-top"><span>{t("command")}</span>{copyButton(item.command,"cmd-" + item.id,"copyCommand")}</div><div className="codex-code-box"><code>{safe(item.command)}</code></div></div>}
          {item.arguments && !item.command && (written ? <><div>{t("tool")}: <code className="codex-tool-name">{safe(item.tool ?? "")}</code></div>{log(written.content, "", written.path)}</> : <div className="codex-trace-field"><div className="codex-trace-field-top"><span>{t("tool")}: <code className="codex-tool-name">{safe(item.tool ?? "")}</code></span>{copyButton(item.arguments,"args-" + item.id,"copyLog")}</div><CodeView text={safe(item.arguments)} /></div>)}
          {item.cwd && <div>{t("workingDir")}: <code>{safe(item.cwd)}</code></div>}
          
          {item.file && <div>{t("file")}: <code className="codex-file-code">{safe(item.file)}</code>{item.fileChange && <span> {t(item.fileChange)}</span>}{item.linesAdded !== undefined && <span> +{item.linesAdded}</span>}{item.linesRemoved !== undefined && <span> -{item.linesRemoved}</span>}</div>}
          {item.files?.map((file,index) => <div key={file.path + index}><code className="codex-file-code">{file.path}</code>{file.action && <span> {t(file.action)}</span>}{file.linesAdded !== undefined && <span> +{file.linesAdded}</span>}{file.linesRemoved !== undefined && <span> -{file.linesRemoved}</span>}{file.diff && log(file.diff,"diff " + file.path)}</div>)}
          {item.diff && !item.files?.some(file => file.diff) && log(item.diff,"diff")}
          {item.tests && <div>{t("testing")}: {item.tests.passed}/{item.tests.total} {t("testsPassed")}, {item.tests.failed} {t("failed")}, {item.tests.skipped} {t("skipped")}</div>}
          {item.fileContent !== undefined && log(item.fileContent,"",item.file)}
          {item.stdout !== undefined && log(item.stdout,"stdout")}{item.stderr !== undefined && log(item.stderr,"stderr")}
          {item.result && !(item.result === "skipped" && active) && item.fileContent === undefined && item.stdout === undefined && item.stderr === undefined && !item.diff && !item.files?.some(file => file.diff) && !item.tests && log(plainResult(item.result),"")}{item.resultTruncated && <span>{t("limited")}</span>}
          {item.durationMs !== undefined && <div>{t("duration")}: {(item.durationMs/1000).toFixed(2)}s</div>}
          {item.exitCode !== undefined && <div>{t("exitCode")}: {item.exitCode}</div>}
          {(item.error || item.errorCode) && !isNegativeAnswer(item) && <div className="codex-trace-error-msg">{t(item.errorCode === "approval_required" ? "awaiting_approval" : "error")}: {safe(isModelCallFailure(item) ? t("modelCallFailed") : item.error ?? (item.errorCode === "approval_required" ? t("awaiting_approval") : item.errorCode ?? ""))}</div>}
        </div>}</div></div>
      </div>;
    })}
  </div></article>;
}
