import { developmentIsActive, type DevelopmentProcess, type ProjectCardData } from "@npati/shared";
type CardMessage = { role?: "user" | "assistant" | "system"; content: string; projectCard?: ProjectCardData };
export function developmentCard(messages: CardMessage[], index: number, processes: DevelopmentProcess[], conversationId: string | null): ProjectCardData | null {
  // Request metadata restores routing; only assistant replies may display project cards.
  const message = messages[index];
  if (message?.role && message.role !== "assistant") return null;
  // A project created in this chat keeps its card with the request; the reply to that request displays it.
  const request = messages[index - 1];
  const requestCard = !message?.projectCard && request?.role === "user" ? request.projectCard : undefined;
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
