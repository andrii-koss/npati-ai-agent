import React from "react";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { ProjectChatCard } from "./business-workspace-cards";
import { normalizeActivity } from "./chat-timeline";
import { ChatMessageContent } from "./ChatMessageContent";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
export function ChatDevelopmentProgress({ process, items, isUk }: { process?: DevelopmentProcess; items?: DevelopmentProcessProgressItem[]; isUk?: boolean }) {
  const rows = normalizeActivity(items ?? process?.progress);
  if (!process || !rows.length) return null;
  return <>{rows.map(item => item.kind === "assistant_message" ? <article key={item.id} className="assistant"><ChatMessageContent content={item.title} /></article> : <AgentExecutionTrace key={item.id} process={process} items={[item]} isUk={isUk} />)}</>;
}
/** Reuse the existing preview drawer; keep it mounted while the agent edits this project. */
export function ChatDevelopmentPreview({ process }: { process?: DevelopmentProcess }) {
  if (!process?.previewUrl || !process.projectId) return null;
  return <div className="chat-development-preview"><ProjectChatCard previewOnly card={{ id: process.projectId, projectId: process.projectId, companyId: process.companyId, name: process.name, framework: process.framework, status: process.status, previewUrl: process.previewUrl, kind: "code_project" }} /></div>;
}
