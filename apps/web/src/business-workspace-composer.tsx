import React, { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { SPEECH_VOICES } from "./speech-voices";
import { ChatAttachments, type ChatAttachmentInput } from "./ChatAttachments";
import { AutoResizeChatTextarea } from "./AutoResizeChatTextarea";
import { cancelChatStream } from "./chat-stream";
import type { Business } from "./business-workspace-shared";

export interface BusinessChatComposerProps {
  input: string;
  setInput: (value: string) => void;
  attachments: ChatAttachmentInput[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentInput[]>>;
  draftVersion: React.MutableRefObject<number>;
  sending: boolean;
  codeInbox: any;
  inboxSubmitting: boolean;
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
  developmentActive?: boolean;
  onStopDevelopment?: () => void | Promise<void>;
}

export function BusinessChatComposer({
  input,
  setInput,
  attachments,
  setAttachments,
  draftVersion,
  sending,
  codeInbox,
  inboxSubmitting,
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
  developmentActive = false,
  onStopDevelopment,
}: BusinessChatComposerProps) {
  return (
    <form className="onboarding-live-composer" onSubmit={(event) => void submit(event)}>
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
      <div>
        {((sending || developmentActive) && !(codeInbox.active && input.trim())) ? (
          <button
            type="button"
            className="chat-stop-btn"
            onClick={() => {
              if (developmentActive && onStopDevelopment) {
                void onStopDevelopment();
                return;
              }
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
        ) : (
          <button
            type="submit"
            className="chat-send-btn"
            disabled={inboxSubmitting || (!input.trim() && attachments.length === 0)}
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
        )}
      </div>
    </form>
  );
}

/** Chat: the router decides what the message is. Code: work on the selected project without a routing call. */
export function ChatWorkModeSwitch({ mode, onChange, projectSelected, disabled, t }: {
  mode: "chat" | "code";
  onChange: (mode: "chat" | "code") => void;
  projectSelected: boolean;
  disabled: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="chat-work-mode">
      <div className="chat-work-mode-switch" role="radiogroup" aria-label={t("chat.workModeLabel")}>
        {(["chat", "code"] as const).map((option) => (
          <button key={option} type="button" role="radio" aria-checked={mode === option}
            className={mode === option ? "chat-work-mode-option active" : "chat-work-mode-option"}
            disabled={disabled} onClick={() => onChange(option)}>
            {t(option === "chat" ? "chat.workModeChat" : "chat.workModeCode")}
          </button>
        ))}
      </div>
      {mode === "code" && !projectSelected && <p className="chat-work-mode-hint">{t("chat.codeModeNeedsProject")}</p>}
    </div>
  );
}
