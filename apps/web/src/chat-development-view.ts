import { developmentIsActive, type DevelopmentProcess, type ProjectCardData } from "@npati/shared";
import type { chatTimeline } from "./chat-timeline";

/** Preview follows the run's last reply, including commentary restored from replay. */
export function developmentPreviewAnchor(timeline: ReturnType<typeof chatTimeline>, process?: DevelopmentProcess): number {
  const startedAt = Date.parse((process?.runId && process.runStartedAts?.[process.runId]) || process?.createdAt || "");
  // The request can be appended milliseconds after the process is created. Its
  // first tool operation is a reliable boundary for finding the following request.
  const operationTimes = timeline.flatMap(entry => entry.kind === "activity" ? (entry.run?.items ?? [entry.item]).filter(item => item.tool).map(item => Date.parse(item.at)) : []).filter(time => Number.isFinite(time) && time >= startedAt);
  const requestBoundary = operationTimes.length ? Math.min(...operationTimes) : startedAt;
  const nextRequest = Number.isFinite(requestBoundary) ? timeline.findIndex(entry => entry.kind === "message" && entry.message.role === "user" && Date.parse(entry.message.createdAt) > requestBoundary) : -1;
  let anchor = -1;
  for (let index = 0; index < (nextRequest < 0 ? timeline.length : nextRequest); index++) {
    const entry = timeline[index]!;
    if (entry.kind === "message" ? entry.message.role === "assistant" : entry.item.kind === "assistant_message") anchor = index;
  }
  return anchor;
}
type CardMessage = { role?: "user" | "assistant" | "system"; content: string; projectCard?: ProjectCardData };
export function developmentCard(messages: CardMessage[], index: number, processes: DevelopmentProcess[], conversationId: string | null): ProjectCardData | null {
  // Request metadata restores routing; only assistant replies may display project cards.
  const message = messages[index];
  if (message?.role && message.role !== "assistant") return null;
  // A project created in this chat keeps its card with the request; the LAST reply to that request displays it, below the
  // agent's work. A status line written during the run ("Created database: …") used to be the first reply and took the
  // card to the top of the run (V6 step 10).
  let requestIndex = index - 1;
  while (requestIndex >= 0 && messages[requestIndex]?.role && messages[requestIndex]?.role !== "user") requestIndex--;
  const request = messages[requestIndex];
  const nextUser = messages.findIndex((m, i) => i > index && m.role === "user");
  const lastReply = messages.slice(index + 1, nextUser === -1 ? undefined : nextUser).every(m => m.role !== "assistant");
  const requestCard = !message?.projectCard && request?.role === "user" && lastReply ? request.projectCard : undefined;
  const card = message?.projectCard ?? (requestCard && processes.some(p => p.projectId === (requestCard.projectId ?? requestCard.id) && p.conversationId === conversationId) ? requestCard : undefined);
  if (!card || card.kind === "code_project" && card.status === "waiting_for_user") return null;
  const projectId = card.projectId ?? card.id;
  if (messages.slice(index + 1).some(m => (!m.role || m.role === "assistant") && (m.projectCard?.projectId ?? m.projectCard?.id) === projectId)) return null;
  const process = processes.find(p => p.projectId === projectId);
  if (process && process.parentConversationId === conversationId && process.conversationId !== conversationId) return null;
  // The empty project the chat was opened with ("Open in chat") is superseded once this chat built a newer project:
  // its Preview would show the empty workspace (D04).
  if (process?.status === "idle" && process.conversationId === conversationId && processes.some(p => p.conversationId === conversationId
    && p.projectId !== projectId && p.status !== "idle" && p.createdAt > process.createdAt)) return null;
  const verified = ["ready", "success"].includes(card.lastBuildStatus ?? "") && !!card.previewUrl;
  return {
    ...card,
    // A working agent's "running" is not a running Preview: the card reads it as a build in progress. The chat hides
    // the Preview trigger meanwhile (see ChatMessageRow previewBusy), so no unbuilt template is offered.
    status: process && developmentIsActive(process) ? "building" : process?.status ?? (card.status === "ready" && !verified ? "idle" : card.status),
    previewUrl: process?.previewUrl ?? card.previewUrl,
    framework: process?.framework || card.framework,
  };
}
export function hideDevelopmentMessage(messages: CardMessage[], index: number, processes: DevelopmentProcess[]) {
  const message = messages[index];
  if (!message || message.projectCard) return false;
  const process = processes.find(p => p.name === message.content);
  if (!process) return false;
  const placeholder = message.content === process.name || /^(?:Coding Agent session started\.|Агент готує проєкт)/u.test(message.content);
  return placeholder;
}

/** Keep the selected workspace when a reply updates the conversation URL. */
export function projectConversationUrl(conversationId: string, project: { companyId?: string | null; projectId?: string | null } | undefined, search: URLSearchParams) {
  const path = "/c/" + encodeURIComponent(conversationId);
  if (!project?.companyId || !project.projectId) return path;
  const next = new URLSearchParams({ company: project.companyId, project: project.projectId });
  if (search.get("project") === project.projectId && search.get("company") === project.companyId && search.get("developmentRoot")) next.set("developmentRoot", search.get("developmentRoot")!);
  return path + "?" + next.toString();
}
