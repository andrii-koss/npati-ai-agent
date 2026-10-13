import React, { useState, useMemo, useCallback } from "react";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { developmentIsActive } from "@npati/shared";

export interface AgentExecutionTraceProps {
  process?: DevelopmentProcess;
  items?: DevelopmentProcessProgressItem[];
  isUk?: boolean;
  className?: string;
}

export function sanitizeTraceSecrets(text: string): string {
  if (!text) return "";
  return text
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, "[REDACTED_TOKEN]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(?:sk-[A-Za-z0-9]{20,})/g, "[REDACTED_KEY]")
    .replace(/(?:xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/((?:api_key|password|secret|token)\s*[:=]\s*["']?)[^"'\s\n]{8,}(["']?)/gi, "$1[REDACTED]$2");
}

function TerminalIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function FileEditIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function FileReadIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function PackageIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function BuildIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9" />
      <path d="M17.64 15 22 10.64" />
      <path d="m20.91 3.26-1.55-1.55a2 2 0 0 0-2.83 0l-3.1 3.1 4.38 4.38 3.1-3.1a2 2 0 0 0 0-2.83z" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function CompressIcon() {
  return (
    <svg className="research-progress-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function pickToolIcon(stage: string, tool?: string) {
  const t = (tool || "").toLowerCase();
  const s = (stage || "").toLowerCase();
  if (t.includes("shell") || t.includes("exec") || s === "command" || t.includes("run")) return <TerminalIcon />;
  if (t.includes("write") || t.includes("patch") || t.includes("edit") || s === "scaffold" || s === "files") return <FileEditIcon />;
  if (t.includes("read") || t.includes("list") || t.includes("search")) return <FileReadIcon />;
  if (t.includes("deps") || s === "dependencies") return <PackageIcon />;
  if (t.includes("build") || s === "build" || t.includes("verify")) return <BuildIcon />;
  if (t.includes("preview") || s === "preview" || s === "template_ready") return <PreviewIcon />;
  if (s === "compress" || s === "compression") return <CompressIcon />;
  if (s === "project") return <FileEditIcon />;
  return <TerminalIcon />;
}

export function formatProcessTitle(item: DevelopmentProcessProgressItem, isUk: boolean, isActive: boolean): string {
  const stage = (item.stage || "").toLowerCase();
  const tool = (item.tool || "").toLowerCase();
  const command = sanitizeTraceSecrets(item.command?.trim() || "");
  const file = sanitizeTraceSecrets(item.file?.trim() || "");

  if (command) {
    const shortCmd = command.length > 55 ? command.slice(0, 52) + "…" : command;
    if (isActive) return isUk ? `Виконується команда: ${shortCmd}` : `Running command: ${shortCmd}`;
    return isUk ? `Виконана команда: ${shortCmd}` : `Executed command: ${shortCmd}`;
  }

  if (file && (tool.includes("write") || tool.includes("edit") || tool.includes("patch") || stage === "files")) {
    if (isActive) return isUk ? `Редагування файлу: ${file}` : `Editing file: ${file}`;
    return isUk ? `Файл змінено: ${file}` : `Updated file: ${file}`;
  }

  if (file && (tool.includes("read") || tool.includes("search"))) {
    if (isActive) return isUk ? `Читання файлу: ${file}` : `Reading file: ${file}`;
    return isUk ? `Файл прочитано: ${file}` : `Read file: ${file}`;
  }

  if (stage === "dependencies" || tool.includes("deps")) {
    if (isActive) return isUk ? "Встановлення залежностей" : "Installing dependencies";
    return isUk ? "Залежності встановлено" : "Installed dependencies";
  }

  if (stage === "build" || tool.includes("build")) {
    if (isActive) return isUk ? "Збірка проєкту" : "Building project";
    return isUk ? "Збірку завершено" : "Project build complete";
  }

  if (stage === "preview" || stage === "template_ready" || tool.includes("preview")) {
    if (isActive) return isUk ? "Запуск Live Preview" : "Starting Live Preview";
    return isUk ? "Live Preview готовий" : "Live Preview ready";
  }

  if (stage === "scaffold") {
    if (isActive) return isUk ? "Підготовка шаблону проєкту" : "Preparing project template";
    return isUk ? "Шаблон підготовлено" : "Template prepared";
  }

  if (stage === "project") {
    if (isActive) return isUk ? "Підготовка робочого простору" : "Preparing project workspace";
    return isUk ? "Робочий простір готовий" : "Workspace ready";
  }

  if (stage === "compression") {
    return isUk ? "Контекст автоматично стиснуто" : "Context automatically compressed";
  }

  return item.title || (isUk ? "Виконання дії" : "Executing action");
}

function statusPillText(status: string, isUk: boolean): string {
  switch (status) {
    case "active":
    case "running":
      return isUk ? "Виконується" : "Running";
    case "completed":
    case "ok":
      return isUk ? "Готово" : "Completed";
    case "failed":
      return isUk ? "Помилка" : "Failed";
    case "waiting_for_approval":
      return isUk ? "Очікує дозволу" : "Waiting for approval";
    case "cancelled":
      return isUk ? "Скасовано" : "Cancelled";
    default:
      return status;
  }
}

export function AgentExecutionTrace({
  process,
  items: directItems,
  isUk = false,
  className = "",
}: AgentExecutionTraceProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const rawItems = useMemo(() => {
    if (directItems && directItems.length) return directItems;
    return process?.progress ?? [];
  }, [directItems, process?.progress]);

  // Group repeated consecutive file activity to prevent flooding the list (matching C7 test requirement)
  const items = useMemo(() => {
    const list: DevelopmentProcessProgressItem[] = [];
    for (const item of rawItems) {
      const prev = list[list.length - 1];
      const isRepeatedTool = prev && prev.stage === item.stage && prev.title === item.title && (item.stage === "tool" || prev.title.includes("Reading project files"));
      if (isRepeatedTool) {
        // Keep updated timestamp / latest state
        list[list.length - 1] = { ...prev, ...item, id: prev.id };
      } else {
        list.push(item);
      }
    }
    return list;
  }, [rawItems]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const copyToClipboard = useCallback((text: string, id: string) => {
    if (!text) return;
    try {
      void navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1800);
    } catch {}
  }, []);

  if (!items.length) return null;

  const isActiveProcess = process ? developmentIsActive(process) : false;

  return (
    <article className="assistant research-progress" aria-live="polite">
      <div className={`research-page-list codex-trace-list ${className}`.trim()}>
        {items.map((item, index) => {
          const isLastItem = index === items.length - 1;
          const isItemActive = item.status === "active" || item.status === "running" || (isActiveProcess && isLastItem && item.status !== "failed" && item.status !== "cancelled");
          const isItemFailed = item.status === "failed";
          const isItemCancelled = item.status === "cancelled";
          const isWaitingApproval = item.status === "waiting_for_approval";
          const isCompleted = !isItemActive && !isItemFailed && !isItemCancelled && !isWaitingApproval;

          const rowStatusClass = isItemFailed ? "failed" : isItemCancelled ? "cancelled" : isItemActive ? "active" : "completed";
          const isExpanded = expandedIds.has(item.id);
          const title = formatProcessTitle(item, isUk, isItemActive);

          return (
            <div
              key={item.id || `trace-${index}`}
              className={`research-page-row codex-trace-row ${rowStatusClass} ${isExpanded ? "expanded" : ""}`}
              data-status={rowStatusClass}
            >
              {/* Row Header (Clickable) */}
              <div
                className="codex-trace-row-header"
                onClick={() => toggleExpand(item.id)}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpand(item.id);
                  }
                }}
              >
                {/* 1. Red animated pulsing dot */}
                <span className="research-progress-state" aria-hidden="true">
                  {isItemFailed ? "!" : isItemCancelled ? "✕" : isItemActive ? "●" : "✓"}
                </span>

                {/* 2. Process Icon */}
                <div className="codex-trace-icon-box">
                  {pickToolIcon(item.stage, item.tool)}
                </div>

                {/* 3. Title / Description */}
                <div className="codex-trace-title-wrapper codex-trace-title">
                  <span className={isItemActive ? "research-active-text" : undefined}>
                    <strong>{title}</strong>
                    {item.agentId && <span className="codex-trace-agent-badge">{item.agentId}</span>}
                  </span>
                </div>

                {/* 4. Meta & Status Pill & Chevron on Right */}
                <div className="codex-trace-header-right">
                  {item.durationMs !== undefined && (
                    <span className="codex-trace-duration-tag">
                      {(item.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                  <span className={`codex-trace-status-pill ${rowStatusClass}`}>
                    {statusPillText(rowStatusClass, isUk)}
                  </span>
                  <button
                    type="button"
                    className="codex-trace-chevron-btn"
                    aria-label={isExpanded ? (isUk ? "Згорнути деталі" : "Collapse details") : (isUk ? "Розгорнути деталі" : "Expand details")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(item.id);
                    }}
                  >
                    {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  </button>
                </div>
              </div>

              {/* 5. Expanded Detail Panel */}
              {isExpanded && (
                <div className="codex-trace-detail-panel">
                  {item.tool && (
                    <div className="codex-trace-field-row">
                      <span className="codex-trace-field-name">{isUk ? "Інструмент" : "Tool"}:</span>
                      <span className="codex-trace-badge">{item.tool}</span>
                    </div>
                  )}

                  {item.command && (
                    <div className="codex-trace-field">
                      <div className="codex-trace-field-top">
                        <span className="codex-trace-field-name">{isUk ? "Виконана команда" : "Command"}:</span>
                        <button
                          type="button"
                          className="codex-copy-btn"
                          onClick={() => copyToClipboard(item.command!, `cmd-${item.id}`)}
                          title={isUk ? "Копіювати команду" : "Copy command"}
                        >
                          {copiedId === `cmd-${item.id}` ? (
                            <><CheckIcon /> <span>{isUk ? "Скопійовано" : "Copied"}</span></>
                          ) : (
                            <><CopyIcon /> <span>{isUk ? "Копіювати" : "Copy"}</span></>
                          )}
                        </button>
                      </div>
                      <div className="codex-code-box">
                        <code>{sanitizeTraceSecrets(item.command)}</code>
                      </div>
                    </div>
                  )}

                  {(item.cwd || process?.name || process?.projectId) && (
                    <div className="codex-trace-meta-grid">
                      {item.cwd && (
                        <div>
                          <span className="codex-trace-field-name">{isUk ? "Робоча тека" : "Working dir"}:</span>{" "}
                          <span className="codex-meta-val">{item.cwd}</span>
                        </div>
                      )}
                      {(process?.name || process?.projectId) && (
                        <div>
                          <span className="codex-trace-field-name">{isUk ? "Проєкт" : "Project"}:</span>{" "}
                          <span className="codex-meta-val">{process?.name || process?.projectId}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {item.file && (
                    <div className="codex-trace-field-row">
                      <span className="codex-trace-field-name">{isUk ? "Файл" : "File"}:</span>
                      <code className="codex-file-code">{item.file}</code>
                    </div>
                  )}

                  {item.result && (
                    <div className="codex-trace-field">
                      <div className="codex-trace-field-top">
                        <span className="codex-trace-field-name">{isUk ? "Результат / Лог" : "Output / Log"}:</span>
                        <button
                          type="button"
                          className="codex-copy-btn"
                          onClick={() => copyToClipboard(item.result!, `res-${item.id}`)}
                          title={isUk ? "Копіювати лог" : "Copy log"}
                        >
                          {copiedId === `res-${item.id}` ? (
                            <><CheckIcon /> <span>{isUk ? "Скопійовано" : "Copied"}</span></>
                          ) : (
                            <><CopyIcon /> <span>{isUk ? "Копіювати" : "Copy"}</span></>
                          )}
                        </button>
                      </div>
                      <pre className="codex-log-pre">
                        {sanitizeTraceSecrets(item.result)}
                      </pre>
                    </div>
                  )}

                  {(item.durationMs !== undefined || item.exitCode !== undefined || item.error || item.errorCode) && (
                    <div className="codex-trace-meta-grid">
                      {item.durationMs !== undefined && (
                        <div>
                          <span className="codex-trace-field-name">{isUk ? "Тривалість" : "Duration"}:</span>{" "}
                          <span className="codex-meta-val">{(item.durationMs / 1000).toFixed(2)}s</span>
                        </div>
                      )}
                      {item.exitCode !== undefined && (
                        <div>
                          <span className="codex-trace-field-name">Exit code:</span>{" "}
                          <code className="codex-meta-val">{item.exitCode}</code>
                        </div>
                      )}
                      {(item.error || item.errorCode) && (
                        <div className="codex-trace-error-msg">
                          <span className="codex-trace-field-name">{isUk ? "Помилка" : "Error"}:</span>{" "}
                          <span>{item.error || item.errorCode}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}
