import { developmentIsActive, type DevelopmentProcess, type ProjectCardData } from "@npati/shared";
type CardMessage = { role?: "user" | "assistant" | "system"; content: string; projectCard?: ProjectCardData };
export function developmentCard(messages: CardMessage[], index: number, processes: DevelopmentProcess[], conversationId: string | null): ProjectCardData | null {
  // Request metadata restores routing; only assistant replies may display project cards.
  const message = messages[index];
  if (message?.role && message.role !== "assistant") return null;
  const card = message?.projectCard;
  if (!card || card.kind === "code_project" && card.status === "waiting_for_user") return null;
  const projectId = card.projectId ?? card.id;
  if (messages.slice(index + 1).some(m => (!m.role || m.role === "assistant") && (m.projectCard?.projectId ?? m.projectCard?.id) === projectId)) return null;
  const process = processes.find(p => p.projectId === projectId);
  if (process?.conversationId === conversationId) return null;
  if (process && (developmentIsActive(process) || process.parentConversationId === conversationId && process.conversationId !== conversationId)) return null;
  const verified = ["ready", "success"].includes(card.lastBuildStatus ?? "") && !!card.previewUrl;
  return { ...card, status: process?.status ?? (card.status === "ready" && !verified ? "idle" : card.status) };
}
export function hideDevelopmentMessage(messages: CardMessage[], index: number, processes: DevelopmentProcess[]) {
  const message = messages[index]; if (!message?.projectCard || message.role && message.role !== "assistant") return false;
  const projectId = message.projectCard.projectId ?? message.projectCard.id;
  const process = processes.find(p => p.projectId === projectId); if (!process) return false;
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
