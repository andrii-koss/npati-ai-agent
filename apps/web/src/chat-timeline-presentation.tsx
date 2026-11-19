import { developmentIsActive, type ProjectCardData } from "@npati/shared";
import { useCodeInbox } from "./use-code-inbox";
import { inboxActive } from "./code-inbox-client";
import { developmentPreviewAnchor } from "./chat-development-view";
import { chatTimeline, mergeConversationMessages, normalizeActivity } from "./chat-timeline";
import { processDuration } from "./AgentExecutionTrace";
import { useChatDevelopment } from "./use-chat-development";
import { ChatProjectPreviewCard, Message } from "./business-workspace-cards";
import type { Dispatch, SetStateAction } from "react";
type SelectedProject = {
    companyId: string;
    projectId: string;
    conversationId: string | null;
} | null;
/** Compute card anchors and per-project busy state once for a chat render. */
export function chatTimelinePresentation(input: {
    messages: Message[];
    development: ReturnType<typeof useChatDevelopment>;
    selected: string | null;
    sending: boolean;
    codeInbox: ReturnType<typeof useCodeInbox>;
    earlierMessages: number;
    entryProjectCard: ProjectCardData | null;
    setSelectedProject: Dispatch<SetStateAction<SelectedProject>>;
}) {
    const { messages, development, selected, sending, codeInbox, earlierMessages, entryProjectCard, setSelectedProject } = input;
    const displayMessages = mergeConversationMessages(messages, development.project?.conversationMessages);
    const timeline = chatTimeline(displayMessages, development.project?.progress, selected, development.project, earlierMessages > 0, development.conversationProcesses);
    // While the agent works in this chat, an open Preview stays but none is offered for the state it is changing.
    const agentWorking = sending || inboxActive(codeInbox.snapshot) || Boolean(development.project && developmentIsActive(development.project));
    // Only the project the agent is changing loses its Open block meanwhile. Every project's block vanished while one
    // site's database run waited 15 minutes for a confirmation (V6 step 14). When the changed project is not known yet
    // (a request just sent), all blocks wait as before.
    const workingProjectId = agentWorking ? (development.activeProject && developmentIsActive(development.activeProject) ? development.activeProject.projectId
        : development.project && developmentIsActive(development.project) ? development.project.projectId : undefined) : undefined;
    const previewBusyFor = (card: {
        projectId?: string | null;
        id: string;
    } | null | undefined) => agentWorking && (!workingProjectId || !card || (card.projectId ?? card.id) === workingProjectId);
    // Resolve the card once, then anchor it to the closing reply below.
    // A project deleted later has nothing to open: its replies say it was deleted instead of offering its old block.
    const deletedProcessOf = (card: {
        projectId?: string | null;
        id: string;
    } | null | undefined) => card
        ? development.conversationProcesses.find(process => process.projectDeleted && process.projectId === (card.projectId ?? card.id)) : undefined;
    const timelineCards = timeline.flatMap((entry, timelineIndex) => {
        if (entry.kind !== "message")
            return [];
        const card = development.card(displayMessages, entry.index);
        return card && !deletedProcessOf(card) ? [{ card, timelineIndex }] : [];
    });
    const timelineCard = timelineCards.at(-1)?.card;
    const lastCardEntry = timelineCards.at(-1)?.timelineIndex ?? -1;
    const fallbackCard = entryProjectCard || (development.project?.projectId && development.project.companyId ? {
        id: development.project.projectId,
        projectId: development.project.projectId,
        companyId: development.project.companyId,
        name: development.project.name,
        status: development.project.status,
        framework: development.project.framework,
        previewUrl: development.project.previewUrl,
        kind: "code_project" as const
    } : null);
    // The whole run's time belongs under the reply that closes it, not under an unrelated later answer.
    const runActivity = development.project && !agentWorking ? normalizeActivity(development.project.progress) : [];
    const runEndedAt = Math.max(0, ...runActivity.map(item => (Date.parse(item.at) || 0) + (item.durationMs ?? 0)));
    const latestReplyAt = Date.parse(displayMessages.at(-1)?.createdAt ?? "") || 0;
    const runTotal = runEndedAt && Math.abs(latestReplyAt - runEndedAt) < 120000 ? processDuration(runActivity) : undefined;
    const bottomCard = timelineCard ?? fallbackCard;
    // A run older than the loaded part of a long chat has its reply further up: its block waits there, not under the
    // first loaded reply (V6 step 14).
    const firstLoadedAt = Date.parse(displayMessages[0]?.createdAt ?? "") || 0;
    const runStartedAt = Date.parse((development.project?.runId && development.project.runStartedAts?.[development.project.runId]) || development.project?.createdAt || "") || 0;
    const previewAnchor = earlierMessages > 0 && runStartedAt && runStartedAt < firstLoadedAt ? -1 : developmentPreviewAnchor(timeline, development.project);
    const projectPreview = bottomCard && !agentWorking ? (<ChatProjectPreviewCard card={bottomCard} showPreviewTrigger onActivate={(card) => setSelectedProject({ companyId: card.companyId, projectId: card.projectId ?? card.id, conversationId: selected })}/>) : null;
    return { displayMessages, timeline, agentWorking, previewBusyFor, deletedProcessOf, lastCardEntry, runTotal, previewAnchor, projectPreview, bottomCard };
}
