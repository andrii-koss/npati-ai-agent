import React, { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { SPEECH_VOICES } from "./speech-voices";
import { ChatAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { CodePendingMessages } from "./CodePendingMessages";
import { cancelChatStream } from "./chat-stream";
import type { Business } from "./business-workspace-shared";
import type { InboxMessage } from "./code-inbox-client";

export interface BusinessChatComposerProps {
  input: string;
  setInput: (value: string) => void;
  attachments: ChatAttachmentInput[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentInput[]>>;
  draftVersion: React.MutableRefObject<number>;
  sending: boolean;
  codeInbox: any;
  inboxNotice: string;
  inboxSubmitting: boolean;
  submitInbox: (mode: "queue" | "steer") => Promise<void>;
  changeInboxMessage: (message: InboxMessage, text?: string) => Promise<boolean>;
  contextSwitcher: ReactNode;
  noMemory: boolean;
  ttsEnabled: boolean;
  chatMode: "none" | "private" | "tts";
  handleModeChange: (mode: "none" | "private" | "tts") => void;
  ttsVoice: string;
  handleTtsVoiceChange: (voice: string) => void;
  generateSpeechForInput: () => Promise<void>;
  isGeneratingSpeech: boolean;
  sendOnEnter: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  submit: (event: FormEvent) => Promise<void>;
  business: Business | null | undefined;
  t: (key: string, options?: any) => string;
  setNotice: (notice: string) => void;
  streamControllerRef: React.MutableRefObject<{ controller: AbortController; streamId: string } | null>;
}

export function BusinessChatComposer({
  input,
  setInput,
  attachments,
  setAttachments,
  draftVersion,
  sending,
  codeInbox,
  inboxNotice,
  inboxSubmitting,
  submitInbox,
  changeInboxMessage,
  contextSwitcher,
  noMemory,
  ttsEnabled,
  chatMode,
  handleModeChange,
  ttsVoice,
  handleTtsVoiceChange,
  generateSpeechForInput,
  isGeneratingSpeech,
  sendOnEnter,
  submit,
  business,
  t,
  setNotice,
  streamControllerRef,
}: BusinessChatComposerProps) {
  return (
    <form className="onboarding-live-composer" onSubmit={(event) => void submit(event)}>
      {codeInbox.session && (codeInbox.active || codeInbox.error || inboxNotice) && (
        <CodePendingMessages
          key={codeInbox.session.sessionId}
          receiptTarget={codeInbox.receiptTarget}
          snapshot={codeInbox.snapshot}
          error={codeInbox.error || inboxNotice}
          busy={inboxSubmitting}
          t={t}
          onChange={changeInboxMessage}
        />
      )}
      {contextSwitcher}
      {noMemory && (
        <span
          className="composer-private-badge"
          title="Private request active: memory, chat history, and attachments are not saved"
        >
          <span className="composer-private-dot" aria-hidden="true" />
          <span>Private request</span>
        </span>
      )}
      {ttsEnabled && (
        <span
          className="composer-tts-badge"
          title={`Text-to-Speech active (Voice: ${SPEECH_VOICES.find((v) => v.id === ttsVoice)?.label ?? ttsVoice})`}
        >
          <span className="composer-tts-dot" aria-hidden="true" />
          <span>TTS: {SPEECH_VOICES.find((v) => v.id === ttsVoice)?.label ?? ttsVoice}</span>
        </span>
      )}
      <ChatAttachments
        value={attachments}
        onChange={(next) => {
          draftVersion.current++;
          setAttachments(next);
        }}
        onError={setNotice}
        disabled={sending || codeInbox.active}
        privateRequestEnabled={chatMode === "private"}
        onPrivateRequestChange={(enabled) => handleModeChange(enabled ? "private" : "none")}
        ttsEnabled={chatMode === "tts"}
        onTtsEnabledChange={(enabled) => handleModeChange(enabled ? "tts" : "none")}
        ttsVoice={ttsVoice}
        onTtsVoiceChange={handleTtsVoiceChange}
        inputText={input}
        onGenerateSpeech={generateSpeechForInput}
        isGeneratingSpeech={isGeneratingSpeech}
      />
      <AutoResizeChatTextarea
        value={input}
        onChange={(event) => {
          draftVersion.current++;
          setInput(event.target.value);
        }}
        onKeyDown={sendOnEnter}
        placeholder={business ? t("chat.businessPlaceholder") : t("chat.placeholder")}
      />
      <div className={codeInbox.active ? "composer-inbox-actions" : undefined}>
        {codeInbox.active && (
          <>
            <button type="submit" disabled={inboxSubmitting || !input.trim()}>
              {t("codeInbox.queue")}
            </button>
            <button
              type="button"
              disabled={inboxSubmitting || !input.trim()}
              onClick={() => void submitInbox("steer")}
            >
              {t("codeInbox.steer")}
            </button>
          </>
        )}
        {sending ? (
          <button
            type="button"
            className="chat-stop-btn"
            onClick={() => {
              const active = streamControllerRef.current;
              if (active) {
                void cancelChatStream(active.streamId).finally(() =>
                  active.controller.abort(new DOMException("Stopped", "AbortError"))
                );
              }
            }}
            aria-label="Stop generating"
            title="Stop generating"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2.5" />
            </svg>
          </button>
        ) : !codeInbox.active ? (
          <button
            type="submit"
            className="chat-send-btn"
            disabled={!input.trim() && attachments.length === 0}
            aria-label="Send"
            title="Send"
          >
            <svg
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="4" y1="12" x2="20" y2="12" />
              <polyline points="14 6 20 12 14 18" />
            </svg>
          </button>
        ) : null}
      </div>
    </form>
  );
}
