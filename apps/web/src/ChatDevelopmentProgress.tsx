import React from "react";
import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { ProjectChatCard } from "./business-workspace-cards";
import { normalizeActivity, codingActivityRuns, type CodingActivityRun } from "./chat-timeline";
import { ChatMessageContent } from "./ChatMessageContent";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
export function ChatDevelopmentProgress({ process, items, run, isUk }: { process?: DevelopmentProcess; items?: DevelopmentProcessProgressItem[]; run?: CodingActivityRun; isUk?: boolean }) {
  const rows = normalizeActivity(items ?? process?.progress);
  if (!process || !rows.length && !run && !Object.keys(process.runStatuses ?? {}).length) return null;
  if (run) return <AgentExecutionTrace process={process} items={run.items} run={run} isUk={isUk} />;
  return <>{rows.filter(item=>item.kind==="assistant_message").map(item=><article key={item.id} className="assistant"><ChatMessageContent content={item.title} /></article>)}{codingActivityRuns(rows,process).map(group=><AgentExecutionTrace key={group.id} process={process} items={group.items} run={group} isUk={isUk} />)}</>;
}
/** Reuse the existing preview drawer; keep it mounted while the agent edits this project. */
export function ChatDevelopmentPreview({ process }: { process?: DevelopmentProcess }) {
  if (!process?.previewUrl || !process.projectId) return null;
  return <div className="chat-development-preview"><ProjectChatCard previewOnly card={{ id: process.projectId, projectId: process.projectId, companyId: process.companyId, name: process.name, framework: process.framework, status: process.status, previewUrl: process.previewUrl, kind: "code_project" }} /></div>;
}
