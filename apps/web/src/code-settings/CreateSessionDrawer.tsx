import React, { useEffect, useRef, useState } from "react";
import { Drawer } from "./Drawer";
import { SESSION_MODES, type CodeProject, type SessionMode } from "./types";
import { codeErrorMessage, sessionModeLabel } from "./labels";

export interface CreateSessionDrawerProps {
  isUk: boolean;
  projects: CodeProject[];
  initialProjectId: string;
  onClose: () => void;
  onSubmit: (projectId: string, input: { mode: SessionMode; summary?: string }) => Promise<void>;
}

export function CreateSessionDrawer({
  isUk,
  projects,
  initialProjectId,
  onClose,
  onSubmit,
}: CreateSessionDrawerProps) {
  const [projectId, setProjectId] = useState(() =>
    projects.some((project) => project.id === initialProjectId)
      ? initialProjectId
      : (projects[0]?.id ?? ""),
  );
  const [mode, setMode] = useState<SessionMode>("plan");
  const [summary, setSummary] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const projectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    projectRef.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId || working) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onSubmit(projectId, { mode, summary: summary.trim() || undefined });
    } catch (cause) {
      setLocalError(codeErrorMessage(cause, isUk));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Drawer
      title={isUk ? "Нова сесія" : "New session"}
      subtitle={isUk ? "Code · сесія" : "Code · session"}
      closeLabel={isUk ? "Закрити" : "Close"}
      isUk={isUk}
      onClose={onClose}
    >
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "calc(100% - 88px)",
        }}
      >
        <section style={{ flex: 1 }}>
          <h3>{isUk ? "Параметри сесії" : "Session settings"}</h3>
          <label className="browser-form-field">
            <span>
              {isUk ? "Код-проєкт" : "Code project"} <i className="required-star">*</i>
            </span>
            <select
              ref={projectRef}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.length === 0 && (
                <option value="">
                  {isUk ? "Немає активних проєктів" : "No active projects"}
                </option>
              )}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Режим дозволів" : "Permission mode"}</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as SessionMode)}>
              {SESSION_MODES.map((value) => (
                <option key={value} value={value}>
                  {sessionModeLabel(value, isUk)}
                </option>
              ))}
            </select>
            <small
              className="browser-form-hint"
              style={{
                fontSize: "12px",
                lineHeight: 1.45,
                color: "var(--npati-gray-500, #64748b)",
                marginTop: "2px",
              }}
            >
              {isUk
                ? "plan — читання і планування; ask — правки після підтвердження; auto_edit — автоматичні правки, ризикові дії після підтвердження; full_auto_sandbox — автономна робота в sandbox."
                : "plan — read and plan; ask — approve edits; auto_edit — automatic edits with approval for risky actions; full_auto_sandbox — autonomous sandbox work."}
            </small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Короткий опис (необов'язково)" : "Summary (optional)"}</span>
            <input
              value={summary}
              maxLength={500}
              placeholder={
                isUk
                  ? "Наприклад: виправити тести в модулі auth"
                  : "For example: fix the tests in the auth module"
              }
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
        </section>

        {localError && (
          <div className="data-studio-alert error" role="alert" style={{ margin: "14px 26px 0" }}>
            {localError}
          </div>
        )}

        <footer>
          <span
            className="browser-form-footer-hint"
            style={{ fontSize: "12.5px", color: "var(--npati-gray-500, #64748b)", fontWeight: 500, lineHeight: 1.4 }}
          >
            {isUk
              ? "Після створення відкриється Workspace. Введіть завдання, щоб запустити агента."
              : "The workspace opens after creation. Enter a task to start the agent."}
          </span>
          <button
            type="submit"
            className="button-primary automations-action-primary"
            disabled={!projectId || working}
          >
            {working
              ? isUk
                ? "Створення…"
                : "Creating…"
              : isUk
                ? "Створити сесію"
                : "Create session"}
          </button>
        </footer>
      </form>
    </Drawer>
  );
}
