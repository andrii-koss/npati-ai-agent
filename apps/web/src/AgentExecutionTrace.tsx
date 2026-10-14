import React, { useCallback, useContext, useState } from "react";
import { Terminal, FilePenLine, FileText, Package, Hammer, Monitor, Search, FlaskConical, Globe, Brain, ChevronDown, ChevronRight, Copy, Check, X, AlertCircle } from "lucide-react";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { sanitizeExecutionTrace } from "@npati/shared";
import { I18nContextRef, executionTraceText } from "./i18n";
import { en } from "./i18n/locales/en";
import { uk } from "./i18n/locales/uk";
import { normalizeActivity, type CodingActivityRun } from "./chat-timeline";
export interface AgentExecutionTraceProps { process?: DevelopmentProcess; items?: DevelopmentProcessProgressItem[]; isUk?: boolean; className?: string; run?: CodingActivityRun; nested?: boolean; language?: string }
export const sanitizeTraceSecrets = sanitizeExecutionTrace;
type Labels = (key: string) => string;
function operation(item: DevelopmentProcessProgressItem) {
  const tool = (item.tool ?? item.stage).toLowerCase();
  if (/search|grep|repo_map/.test(tool)) return ["searching", Search] as const;
  if (/read|list/.test(tool)) return ["reading", FileText] as const;
  if (/write|edit|patch|scaffold|files/.test(tool)) return ["editing", FilePenLine] as const;
  if (/deps|dependencies/.test(tool)) return ["dependencies", Package] as const;
  if (/test/.test(tool)) return ["testing", FlaskConical] as const;
  if (/build|verify/.test(tool)) return ["building", Hammer] as const;
  if (/browser/.test(tool)) return ["browser", Globe] as const;
  if (/preview/.test(tool)) return ["preview", Monitor] as const;
  if (/coding_agent|^agent$/.test(tool)) return ["working", Brain] as const;
  if (/planning|thinking/.test(tool)) return ["planning", Brain] as const;
  if (/sandbox|workspace/.test(tool)) return ["sandbox", Monitor] as const;
  return ["command", Terminal] as const;
}
function title(item: DevelopmentProcessProgressItem, t: Labels, active: boolean) {
  if (!item.status) return sanitizeExecutionTrace(item.command ? item.tool + ": " + item.command : item.title);
  if (item.command) { const command = sanitizeExecutionTrace(item.command).slice(0,100); return active ? t("runningCommand").replace("{{command}}",command) : t("executed") + ": " + command; }
  if (item.dryRun) return t("dryRun");
  const [kind] = operation(item);
  if (item.files && item.files.length > 1) return t(kind) + ": " + item.files.length;
  if (item.file) return t(active ? kind : kind === "reading" ? "read" : kind === "editing" ? "updated" : kind) + ": " + sanitizeExecutionTrace(item.file);
  return kind === "command" ? sanitizeExecutionTrace(item.title) : t(kind);
}
export function formatProcessTitle(item: DevelopmentProcessProgressItem, isUk: boolean, active: boolean) { return title(item, key => (isUk ? uk : en).executionTrace[key] ?? key, active); }
export function AgentExecutionTrace({ process, items: directItems, run, nested = false, language, isUk = false, className = "" }: AgentExecutionTraceProps) {
  const i18n = useContext(I18nContextRef);
  const t: Labels = key => executionTraceText(run?.language ?? language ?? (isUk ? "uk" : i18n?.language ?? "en"),key);
  const [runOpen, setRunOpen] = useState(false);
  const [historyMounted, setHistoryMounted] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [fullLogs, setFullLogs] = useState(new Set<string>());
  const [copied, setCopied] = useState<string>();
  const toggle = (setter: typeof setExpanded, id: string) => setter(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const copy = useCallback(async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(sanitizeExecutionTrace(text)); setCopied(id); setTimeout(() => setCopied(current => current === id ? undefined : current), 1800); } catch { /* Clipboard denial does not stop the run. */ }
  }, []);
  const usageView = (usage: NonNullable<DevelopmentProcessProgressItem["modelUsage"]>) => <div className="codex-trace-usage" key={usage.id}><strong>{t("usage")} / #{usage.turn}</strong>{usage.model && <code>{sanitizeExecutionTrace(usage.model)}</code>}<span>{t("inputTokens")}: {usage.inputTokens ?? t("unavailableTokens")} / {t("outputTokens")}: {usage.outputTokens ?? t("unavailableTokens")} / {t("totalTokens")}: {usage.totalTokens ?? t("unavailableTokens")}</span>{usage.costUsd !== undefined && <span>${usage.costUsd.toFixed(6)}</span>}{usage.toolCallIds.length>1 && <small>{t("sharedTurn").replace("{{count}}",String(usage.toolCallIds.length))}</small>}</div>;
  const items = normalizeActivity(directItems ?? process?.progress);
  if (!items.length && !run) return null;
  if (run) {
    const running = run.status === "running" || run.status === "pending" && items.some(item=>["running","active"].includes(item.status??""));
    const current = [...items].reverse().find(item=>["running","active","awaiting_approval","waiting_for_approval"].includes(item.status??"")) ?? (running ? {id:run.id,stage:"agent",title:"",at:run.at,status:"running" as const} : items.at(-1) ?? {id:run.id,stage:"agent",title:"",at:run.at,status:"pending" as const});
    const [, Icon] = operation(current);
    const label = run.status === "completed" ? t("operationsDone").replace("{{count}}",String(items.filter(item=>item.stage!=="agent").length)) : running ? title(current,t,true) : t(run.status === "waiting_for_approval" ? "awaiting_approval" : run.status);
    return <article className="assistant research-progress coding-run-activity" aria-live="polite"><div className={"research-page-row codex-trace-row " + (running ? "active" : run.status) + (runOpen ? " expanded" : "")} data-run-id={run.runId ?? run.id}><button type="button" className="codex-trace-row-header coding-run-header" aria-expanded={runOpen} aria-controls={"run-detail-" + run.id} onClick={()=>{setHistoryMounted(true);setRunOpen(previous=>!previous);}}><span className="research-progress-state" aria-hidden="true">{run.status === "completed" ? <Check size={12}/> : run.status === "failed" ? <AlertCircle size={12}/> : run.status === "cancelled" ? <X size={12}/> : "\u25cf"}</span><Icon className="research-progress-globe" size={16} aria-hidden="true"/><span dir="auto" className={running ? "research-active-text" : undefined}>{label}</span><span className="codex-trace-chevron-btn" aria-hidden="true">{runOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span></button><div className="codex-trace-collapse" aria-hidden={!runOpen} inert={!runOpen} onTransitionEnd={event=>{if(!runOpen && event.target===event.currentTarget)setHistoryMounted(false);}}> <div className="codex-trace-collapse-inner"><div id={"run-detail-" + run.id} className="coding-run-history">{runOpen && run.runId && <a href={"/activity?runId="+encodeURIComponent(run.runId)}>{t("viewRun")}</a>}{runOpen && run.usage?.map(usageView)}{historyMounted && <AgentExecutionTrace process={process ? {...process,runId:run.runId} : undefined} items={items} isUk={isUk} language={run.language} nested />}</div></div></div></div></article>;
  }
  return <article className={nested ? "coding-operation-history" : "assistant research-progress"} aria-live="polite"><div className={"research-page-list codex-trace-list " + className}>
    {items.map(item => {
      const active = item.status === "active" || item.status === "running";
      const status = active ? "active" : item.status === "awaiting_approval" ? "waiting_for_approval" : item.status ?? "unknown";
      const open = expanded.has(item.id);
      const [, Icon] = operation(item);
      const safe = (text: string) => sanitizeExecutionTrace(text);
      const copyButton = (text: string, id: string, label: string) => <button type="button" className="codex-copy-btn" title={t(label)} onClick={() => void copy(text,id)}>{copied === id ? <Check size={12} /> : <Copy size={12} />}<span>{t(copied === id ? "copied" : "copy")}</span></button>;
      const log = (text: string, label: string) => <div className="codex-trace-field"><div className="codex-trace-field-top"><span className="codex-trace-field-name">{label}</span>{copyButton(text,label + item.id,"copyLog")}</div>{text.length > 4000 && <button type="button" className="codex-copy-btn" onClick={() => toggle(setFullLogs,label + item.id)}>{t(fullLogs.has(label + item.id) ? "less" : "fullLog")}</button>}<pre className="codex-log-pre">{safe(fullLogs.has(label + item.id) ? text : text.slice(0,4000))}</pre></div>;
      return <div key={item.id} className={"research-page-row codex-trace-row " + status + (open ? " expanded" : "")} data-status={status}>
        <button type="button" className="codex-trace-row-header" onClick={() => toggle(setExpanded,item.id)} aria-expanded={open} aria-controls={"trace-detail-" + item.id}>
          <span className="research-progress-state" aria-hidden="true">{status === "failed" ? <AlertCircle size={12}/> : status === "cancelled" ? <X size={12}/> : status === "completed" ? <Check size={12}/> : "\u25cf"}</span>
          <span className="codex-trace-icon-box"><Icon className="research-progress-globe" size={16} aria-hidden="true"/></span>
          <span className="codex-trace-title-wrapper codex-trace-title"><span className={active ? "research-active-text" : undefined}><strong>{title(item,t,active)}</strong></span></span>
          <span className="codex-trace-header-right">{item.durationMs !== undefined && <span className="codex-trace-duration-tag">{(item.durationMs/1000).toFixed(1)}s</span>}<span className="codex-trace-chevron-btn" aria-hidden="true">{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span></span>
        </button>
        <div className="codex-trace-collapse" aria-hidden={!open} inert={!open}><div className="codex-trace-collapse-inner"><div id={"trace-detail-" + item.id} className="codex-trace-detail-panel">
          {(item.runId || process?.runId) && <a href={"/activity?runId=" + encodeURIComponent(item.runId ?? process?.runId ?? "")}>{t("viewRun")}</a>}
          <div>{t("operationStatus")}: {t(status === "active" ? "running" : status === "waiting_for_approval" ? "awaiting_approval" : status)}</div>
          {item.dryRun && <div>{t("dryRun")}</div>}
          {item.modelUsage ? usageView(item.modelUsage) : <div>{t("usage")}: {t("unavailableTokens")}</div>}
          {item.tool && <div>{t("tool")}: <code>{safe(item.tool)}</code></div>}
          {item.command && <div className="codex-trace-field"><div className="codex-trace-field-top"><span>{t("command")}</span>{copyButton(item.command,"cmd-" + item.id,"copyCommand")}</div><div className="codex-code-box"><code>{safe(item.command)}</code></div></div>}
          {item.arguments && !item.command && <div className="codex-trace-field"><div className="codex-trace-field-top"><span>{t("tool")}: {safe(item.tool ?? "")}</span>{copyButton(item.arguments,"args-" + item.id,"copyLog")}</div><pre className="codex-log-pre">{safe(item.arguments)}</pre></div>}
          {item.cwd && <div>{t("workingDir")}: <code>{safe(item.cwd)}</code></div>}
          {process?.name && <div>{t("project")}: {safe(process.name)}</div>}
          {item.file && <div>{t("file")}: <code className="codex-file-code">{safe(item.file)}</code>{item.fileChange && <span> {t(item.fileChange)}</span>}{item.linesAdded !== undefined && <span> +{item.linesAdded}</span>}{item.linesRemoved !== undefined && <span> -{item.linesRemoved}</span>}</div>}
          {item.files?.map((file,index) => <div key={file.path + index}><code className="codex-file-code">{file.path}</code>{file.action && <span> {t(file.action)}</span>}{file.linesAdded !== undefined && <span> +{file.linesAdded}</span>}{file.linesRemoved !== undefined && <span> -{file.linesRemoved}</span>}{file.diff && log(file.diff,"diff " + file.path)}</div>)}
          {item.diff && !item.files?.some(file => file.diff) && log(item.diff,"diff")}
          {item.tests && <div>{t("testing")}: {item.tests.passed}/{item.tests.total} {t("testsPassed")}, {item.tests.failed} {t("failed")}, {item.tests.skipped} {t("skipped")}</div>}
          {item.fileContent !== undefined && log(item.fileContent,t("output"))}
          {item.stdout !== undefined && log(item.stdout,"stdout")}{item.stderr !== undefined && log(item.stderr,"stderr")}
          {item.result && item.fileContent === undefined && item.stdout === undefined && item.stderr === undefined && !item.diff && !item.files?.some(file => file.diff) && !item.tests && log(item.result,t("output"))}{item.resultTruncated && <span>{t("limited")}</span>}
          {item.durationMs !== undefined && <div>{t("duration")}: {(item.durationMs/1000).toFixed(2)}s</div>}
          {item.exitCode !== undefined && <div>{t("exitCode")}: {item.exitCode}</div>}
          {(item.error || item.errorCode) && <div className="codex-trace-error-msg">{t(item.errorCode === "approval_required" ? "awaiting_approval" : "error")}: {safe(item.error ?? (item.errorCode === "approval_required" ? t("awaiting_approval") : item.errorCode ?? ""))}</div>}
        </div></div></div>
      </div>;
    })}
  </div></article>;
}
