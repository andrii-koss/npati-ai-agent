import React from "react";
import { developmentIsActive, type DevelopmentProcess } from "@npati/shared";
export function ChatDevelopmentProgress({ process }: { process?: DevelopmentProcess }) {
  if (!process) return null;
  const active = developmentIsActive(process);
  return <section className="chat-development-progress" aria-label="Project deployment progress">
    <div className="chat-development-progress-heading"><span className={active ? "chat-development-dot active" : "chat-development-dot"} aria-hidden="true" /><strong>{process.name} · {process.framework}</strong></div>
    {process.previewUrl?.startsWith("/api/companies/") && <a href={process.previewUrl} target="_blank" rel="noopener noreferrer">{process.status === "completed" ? "Live Preview" : "Live Preview · template"}</a>}
    <ol>{(process.progress ?? []).map((event, index, events) => <li key={event.id} className={active && index === events.length - 1 ? "active" : ""}><span className="chat-development-dot" aria-hidden="true" /><span>{event.title}</span></li>)}</ol>
    {process.detail && !active && <p role={process.status === "failed" ? "alert" : undefined}>{process.detail}</p>}
  </section>;
}
