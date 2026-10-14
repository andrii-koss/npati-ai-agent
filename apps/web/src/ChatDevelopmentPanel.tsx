import React from "react";
import { developmentIsActive, type DevelopmentProcess } from "@npati/shared";
const labels = {
  stopping: ["Stopping", "Зупиняється"],
  idle: ["Ready to edit", "Можна редагувати"],
  queued: ["Queued", "У черзі"], preparing: ["Preparing sandbox", "Підготовка sandbox"], running: ["Coding ? build ? preview", "Розробка ? build ? preview"],
  completed: ["Ready", "Готово"], failed: ["Failed", "Помилка"], cancelled: ["Stopped", "Зупинено"], interrupted: ["Interrupted", "Перервано"], awaiting_approval: ["Approval required", "Потрібне підтвердження"],
} as const;
export function ChatDevelopmentPanel({ processes, projectId, isUk = false, busyId, onOpen, onStop, onHide, onBack }: {
  processes: DevelopmentProcess[]; projectId?: string; isUk?: boolean; busyId?: string;
  onOpen(id: string): void; onStop(id: string): void; onHide(id: string): void; onBack(): void;
}) {
  const tiles = processes.filter(p => !p.hidden || p.projectId === projectId).sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId)).slice(0, 4);
  if (!tiles.length) return null;
  return <section className="chat-development-panel" aria-label={isUk ? "Процеси розробки" : "Development processes"}>
    {tiles.map(process => {
      const current = !!projectId && process.projectId === projectId;
      const working = developmentIsActive(process);
      const disabled = busyId === process.id;
      return <div key={process.id} className={"chat-development-tile research-page-row " + (working ? "active" : process.status === "completed" ? "completed" : process.status === "failed" ? "failed" : "") + (current ? " current" : "")} data-status={process.status}>
        {current ? <button type="button" className="chat-development-icon" onClick={onBack} aria-label={isUk ? "Назад до основного чату" : "Back to main chat"}>←</button>
          : <span className="research-progress-state" aria-hidden="true">{working ? "●" : process.status === "completed" ? "✓" : "·"}</span>}
        <button type="button" className="chat-development-label" disabled={!process.projectId || disabled} onClick={() => onOpen(process.id)} title={process.detail}>
          <strong className={working ? "research-active-text" : undefined}>{process.name}</strong><span>{(labels[process.status] ?? [process.status, process.status])[isUk ? 1 : 0]} {"\u00b7"} {process.framework}</span>
        </button>
        <div className="chat-development-actions">
          <button type="button" className="chat-development-icon" disabled={!process.projectId || disabled} onClick={() => onOpen(process.id)} aria-label={(isUk ? "Редагувати: " : "Edit in chat: ") + process.name} title={isUk ? "Редагувати в чаті" : "Edit in chat"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg></button>
          <button type="button" className="chat-development-icon" disabled={!working || disabled || process.status === "stopping"} onClick={() => onStop(process.id)} aria-label={(isUk ? "Зупинити: " : "Stop: ") + process.name} title={isUk ? "Зупинити" : "Stop"}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
          <button type="button" className="chat-development-icon" disabled={disabled} onClick={() => onHide(process.id)} aria-label={(isUk ? "Прибрати з панелі: " : "Hide from panel: ") + process.name} title={isUk ? "Прибрати з панелі" : "Hide from panel"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>
        </div>
      </div>;
    })}
  </section>;
}
