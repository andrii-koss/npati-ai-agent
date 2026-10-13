import React from "react";
import { developmentIsActive, type DevelopmentProcess, type ProjectProgressEvent } from "@npati/shared";
import { ResearchProgressPanel, type ChatProgressEvent } from "./ResearchProgress";
const stages: Record<string, ProjectProgressEvent["stage"]> = { project: "project", scaffold: "files", dependencies: "dependencies", build: "build", preview: "preview", template_ready: "preview", agent: "agent", tool: "agent", completed: "ready" };
/** Translate real deployment events for the chat's existing presentation and animations. */
export function developmentProgressEvents(process: DevelopmentProcess): ChatProgressEvent[] {
  const active = developmentIsActive(process);
  let previousStage: ProjectProgressEvent["stage"] = "project";
  return (process.progress ?? []).map((event, index, events) => {
    previousStage = stages[event.stage] ?? previousStage;
    const terminalFailure = ["failed", "cancelled", "interrupted"].includes(event.stage);
    return { type: "project_progress", stage: previousStage, title: event.title, timestamp: event.at, framework: process.framework,
      status: terminalFailure ? "failed" : active && index === events.length - 1 ? "active" : "completed" };
  });
}
export function ChatDevelopmentProgress({ process }: { process?: DevelopmentProcess }) {
  if (!process || !process.progress?.length) return null;
  const events = developmentProgressEvents(process);
  return <ResearchProgressPanel key={process.runId ?? process.id} events={events} visibleCount={events.length}
    completed={!developmentIsActive(process)} failed={["failed", "cancelled", "interrupted"].includes(process.status)} />;
}
