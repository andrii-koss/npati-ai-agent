import { memo, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import type { ProjectCardData } from "@npati/shared";
import { ChatMessageContent, projectChatText } from "./ChatMessageContent";
import { UserPromptMessage } from "./UserPromptMessage";
import { PendingMessageAttachments } from "./ChatAttachments";
import { AssistantMessageToolbar, ProjectChatCard, ChatProjectPreviewCard, type Message } from "./business-workspace-cards";

export function messageHasImage(message: Message) {
  return message.attachments?.some((attachment) => attachment.kind === "image")
    || message.content.includes("[[npati-attachment:image:");
}

/** Stable callbacks of the chat page; their identity never changes, so a finished row is not re-rendered. */
export interface ChatRowActions {
  edit(prompt: string): void;
  regenerate(messageId: string): void;
  activateCard(card: ProjectCardData): void;
  registerArticle(messageId: string, element: HTMLElement | null): void;
}

interface ChatMessageRowProps {
  message: Message;
  card: ProjectCardData | null | undefined;
  showToolbar: boolean;
  /** The agent is working in this chat: an open Preview stays, but a new one is not offered for the old state. */
  previewBusy?: boolean;
  responseLanguage: string;
  actions: ChatRowActions;
}

const sameCard = (left: ProjectCardData | null | undefined, right: ProjectCardData | null | undefined) =>
  left === right || Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));

/**
 * One chat message. A finished message (and its Markdown) renders again only when its own text, attachments or card
 * change: typing in the composer or the streamed reply of another message leaves it as it is.
 */
export const ChatMessageRow = memo(function ChatMessageRow({ message, card, showToolbar, previewBusy = false, responseLanguage, actions }: ChatMessageRowProps) {
  const assistantText = message.role === "user" ? "" : projectChatText(message.content, message.projectCard, responseLanguage);
  // The opening note of a project chat only names the project. With nothing to show there is nothing to copy or rate.
  if (message.role !== "user" && !assistantText.trim() && !card && !message.attachments?.length) return null;
  return (
    <article
      ref={(element) => actions.registerArticle(message.id, element)}
      className={`${message.role}${message.role === "user" && messageHasImage(message) ? " image-message" : ""}`}
      data-message-id={message.id}
      aria-label={message.role === "user" ? "Your message" : "NPATI Agent message"}
    >
      {message.role === "user" ? (
        <UserPromptMessage content={message.content} onEdit={actions.edit}>
          <PendingMessageAttachments value={message.attachments ?? []} />
        </UserPromptMessage>
      ) : (
        <>
          <PendingMessageAttachments value={message.attachments ?? []} />
          <ChatMessageContent content={assistantText} />
        </>
      )}
      {card && <ChatProjectPreviewCard card={card} showPreviewTrigger={!previewBusy} onActivate={actions.activateCard} />}
      {showToolbar && Boolean(assistantText.trim()) && <AssistantMessageToolbar content={message.content} onRegenerate={() => actions.regenerate(message.id)} />}
    </article>
  );
}, (previous, next) => previous.message.id === next.message.id && previous.message.content === next.message.content
  && previous.message.attachments === next.message.attachments && previous.message.projectCard === next.message.projectCard
  && sameCard(previous.card, next.card) && previous.showToolbar === next.showToolbar && previous.previewBusy === next.previewBusy
  && previous.responseLanguage === next.responseLanguage && previous.actions === next.actions);

/**
 * The chat page's row callbacks with one identity for the page's lifetime. They read the latest render through
 * `rowStateRef`, which the page updates on every render.
 */
export function useChatRowActions(page: {
  setInput(value: string): void;
  setSelectedProject(value: { companyId: string; projectId: string; conversationId: string | null }): void;
  selectedRef: MutableRefObject<string | null>;
  latestMessageRef: RefObject<HTMLElement | null>;
  activeTurnRef: RefObject<HTMLElement | null>;
}) {
  const rowStateRef = useRef<{ displayMessages: Message[]; activeTurn: string }>({ displayMessages: [], activeTurn: "" });
  const pageRef = useRef(page); pageRef.current = page;
  const rowActions = useMemo<ChatRowActions>(() => ({
    edit: (prompt) => {
      pageRef.current.setInput(prompt);
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".onboarding-live-composer textarea")?.focus());
    },
    regenerate: (messageId) => {
      const list = rowStateRef.current.displayMessages;
      for (let k = list.findIndex((item) => item.id === messageId) - 1; k >= 0; k--) {
        if (list[k]?.role === "user") { pageRef.current.setInput(list[k]!.content); break; }
      }
    },
    activateCard: (card) => pageRef.current.setSelectedProject({ companyId: card.companyId, projectId: card.projectId ?? card.id, conversationId: pageRef.current.selectedRef.current }),
    registerArticle: (messageId, element) => {
      if (!element) return;
      const { displayMessages: list, activeTurn: turn } = rowStateRef.current;
      const index = list.findIndex((item) => item.id === messageId);
      if (index === list.length - 1) (pageRef.current.latestMessageRef as MutableRefObject<HTMLElement | null>).current = element;
      const item = list[index];
      if (item?.role === "user" && item.content === turn && !list.slice(index + 1).some((next) => next.role === "user" && next.content === turn)) {
        (pageRef.current.activeTurnRef as MutableRefObject<HTMLElement | null>).current = element;
      }
    },
  }), []);
  return { rowActions, rowStateRef };
}
