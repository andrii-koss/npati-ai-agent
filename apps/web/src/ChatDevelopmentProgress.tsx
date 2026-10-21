import React from "react";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { ProjectChatCard } from "./business-workspace-cards";
import { normalizeActivity, codingActivityRuns, chatTimeline, type CodingActivityRun } from "./chat-timeline";
import { ChatMessageContent } from "./ChatMessageContent";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
export function ChatDevelopmentProgress({ process, items, run, isUk }: { process?: DevelopmentProcess; items?: DevelopmentProcessProgressItem[]; run?: CodingActivityRun; isUk?: boolean }) {
  const rows = normalizeActivity(items ?? process?.progress);
  if (!process || !rows.length && !run && !Object.keys(process.runStatuses ?? {}).length && !["preparing", "running", "queued", "stopping"].includes(process.status)) return null;
  if (run) return <AgentExecutionTrace process={process} items={run.items} run={run} isUk={isUk} />;
  if (items && rows.every(item=>item.kind==="assistant_message")) return <>{rows.map(item=><article key={item.id} className="assistant"><ChatMessageContent content={item.title}/></article>)}</>;
  return <>{chatTimeline([],rows,process.conversationId,process).map(entry=>entry.kind!=="activity" ? null : entry.run ? <AgentExecutionTrace key={entry.item.id} process={process} items={entry.run.items} run={entry.run} isUk={isUk}/> : <article key={entry.item.id} className="assistant"><ChatMessageContent content={entry.item.title}/></article>)}</>;
}
/** Reuse the existing preview drawer; keep it mounted while the agent edits this project. */
export function ChatDevelopmentPreview({ process, busy = false }: { process?: DevelopmentProcess; busy?: boolean }) {
  if (!process?.previewUrl || !process.projectId) return null;
  const ready = !busy && process.status === "completed" && !codingActivityRuns(process.progress,process).some(run => ["pending","running","waiting_for_approval"].includes(run.status));
  return <div className="chat-development-preview"><ProjectChatCard previewOnly showPreviewTrigger={ready} card={{ id: process.projectId, projectId: process.projectId, companyId: process.companyId, name: process.name, framework: process.framework, status: process.status, previewUrl: process.previewUrl, kind: "code_project" }} /></div>;
}
