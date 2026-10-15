import React from "react";
import type { ChatMessage } from "../types";

interface AgentChatColumnProps {
  language: string;
  chatBusy: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  setChatInput: (v: string) => void;
  handleSendPrompt: (e: React.FormEvent) => void;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
}

export function AgentChatColumn({
  language,
  chatBusy,
  chatMessages,
  chatInput,
  setChatInput,
  handleSendPrompt,
  chatScrollRef,
}: AgentChatColumnProps) {
  return (
    <section className="project-col project-col-chat" aria-label="Agent chat">
      <div className="col-header">
        <h3>{language === "uk" ? "Чат з Агентом" : "Developer Agent"}</h3>
        {chatBusy && <span className="agent-typing-pill">🤖 Working…</span>}
      </div>

      <div className="project-chat-messages">
        {chatMessages.length === 0 ? (
          <div className="chat-empty-state">
            <p>
              💡{" "}
              {language === "uk"
                ? "Введіть запит для генерації або редагування сайту:"
                : "Prompt your Developer Agent to create or update the website:"}
            </p>
            <button
              type="button"
              className="button-secondary sample-prompt-btn"
              onClick={() =>
                setChatInput("Create a simple landing page with modern hero section, features grid and contact footer")
              }
            >
              "Create a simple landing page"
            </button>
          </div>
        ) : (
          chatMessages.map((msg) => (
            <div key={msg.id} className={`chat-bubble chat-bubble-${msg.role}`}>
              <div className="bubble-header">
                <strong>{msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}</strong>
                <span className="bubble-time">{msg.timestamp}</span>
              </div>
              <div className="bubble-content">{msg.content}</div>
            </div>
          ))
        )}
        {chatBusy && (
          <div className="chat-bubble chat-bubble-assistant working-bubble">
            <p>
              ⏳{" "}
              {language === "uk"
                ? "Агент виконує зміни у sandbox..."
                : "Agent is updating files & building sandbox..."}
            </p>
          </div>
        )}
        <div ref={chatScrollRef} />
      </div>

      <form onSubmit={handleSendPrompt} className="project-chat-form">
        <textarea
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          placeholder={
            language === "uk"
              ? "Опишіть завдання (наприклад: Додай навігацію та кнопку CTA)..."
              : "Describe changes or ask the agent to build..."
          }
          rows={3}
          disabled={chatBusy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSendPrompt(e);
            }
          }}
        />
        <button type="submit" className="button-primary send-chat-btn" disabled={chatBusy || !chatInput.trim()}>
          {language === "uk" ? "Надіслати" : "Send"}
        </button>
      </form>
    </section>
  );
}
