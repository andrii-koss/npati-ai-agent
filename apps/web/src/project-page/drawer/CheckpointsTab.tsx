import React from "react";
import type { CheckpointItem } from "../types";

interface CheckpointsTabProps {
  language: string;
  checkpoints: CheckpointItem[];
  checkpointFeedback: string;
  isCreatingCheckpoint: boolean;
  setIsCreatingCheckpoint: (v: boolean) => void;
  newCheckpointName: string;
  setNewCheckpointName: (v: string) => void;
  handleCreateCheckpoint: (e: React.FormEvent) => void;
  loadCheckpoints: () => void;
  loadingCheckpoints: boolean;
  restoringCheckpointId: string | null;
  handleRestoreCheckpoint: (cp: CheckpointItem) => void;
}

export function CheckpointsTab({
  language,
  checkpoints,
  checkpointFeedback,
  isCreatingCheckpoint,
  setIsCreatingCheckpoint,
  newCheckpointName,
  setNewCheckpointName,
  handleCreateCheckpoint,
  loadCheckpoints,
  loadingCheckpoints,
  restoringCheckpointId,
  handleRestoreCheckpoint,
}: CheckpointsTabProps) {
  return (
    <div className="checkpoints-tab-pane">
      <div className="checkpoints-toolbar">
        <div className="checkpoints-toolbar-info">
          <p className="checkpoints-hint">
            {language === "uk"
              ? "Точки відновлення дозволяють безпечно повертатися до будь-якої стабільної версії проєкту."
              : "Checkpoints let you roll back project state safely at any point."}
          </p>
          {checkpointFeedback && <span className="checkpoint-success-msg">{checkpointFeedback}</span>}
        </div>
        <div className="checkpoints-toolbar-actions">
          {!isCreatingCheckpoint ? (
            <button
              type="button"
              className="button-primary create-checkpoint-btn"
              onClick={() => setIsCreatingCheckpoint(true)}
            >
              + {language === "uk" ? "Створити Checkpoint" : "Create Checkpoint"}
            </button>
          ) : (
            <form className="create-checkpoint-inline-form" onSubmit={handleCreateCheckpoint}>
              <input
                type="text"
                placeholder={language === "uk" ? "Назва точки (напр. Перед редизайном)" : "Checkpoint name (e.g. Before redesign)"}
                value={newCheckpointName}
                onChange={(e) => setNewCheckpointName(e.target.value)}
                autoFocus
                required
              />
              <button type="submit" className="button-primary">
                {language === "uk" ? "Зберегти" : "Save"}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setIsCreatingCheckpoint(false);
                  setNewCheckpointName("");
                }}
              >
                {language === "uk" ? "Скасувати" : "Cancel"}
              </button>
            </form>
          )}
          <button
            type="button"
            className="button-secondary"
            onClick={loadCheckpoints}
            disabled={loadingCheckpoints}
          >
            {language === "uk" ? "Оновити" : "Refresh"}
          </button>
        </div>
      </div>

      {checkpoints.length === 0 ? (
        <div className="empty-checkpoints-state">
          <p>
            {language === "uk"
              ? "Точок відновлення ще не створено. Створіть вручну або виконайте команду в чаті."
              : "No checkpoints recorded yet. Create one manually or run a task in chat."}
          </p>
        </div>
      ) : (
        <div className="checkpoints-list">
          {checkpoints.map((cp) => (
            <article key={cp.id} className="checkpoint-card">
              <div className="checkpoint-card-header">
                <span className={`trigger-badge trigger-${cp.trigger}`}>
                  {cp.trigger === "manual" && (language === "uk" ? "Вручну" : "Manual")}
                  {cp.trigger === "pre_run" && (language === "uk" ? "Перед запуском" : "Pre-run")}
                  {cp.trigger === "post_run" && (language === "uk" ? "Після запуску" : "Post-run")}
                  {cp.trigger === "pre_restore" && (language === "uk" ? "Авто-бекап" : "Pre-restore")}
                </span>
                {cp.commitHash && (
                  <code className="checkpoint-hash" title={`Git Commit: ${cp.commitHash}`}>
                    {cp.commitHash.slice(0, 7)}
                  </code>
                )}
                <span className="checkpoint-files-count">
                  {cp.fileCount} {language === "uk" ? "файлів" : "files"}
                </span>
                <span className="checkpoint-time">{new Date(cp.createdAt).toLocaleString()}</span>
                <button
                  type="button"
                  className="button-secondary restore-checkpoint-btn"
                  disabled={restoringCheckpointId === cp.id}
                  onClick={() => handleRestoreCheckpoint(cp)}
                >
                  {restoringCheckpointId === cp.id
                    ? language === "uk"
                      ? "Відновлення..."
                      : "Restoring..."
                    : language === "uk"
                    ? "Відновити ↺"
                    : "Restore ↺"}
                </button>
              </div>
              <h4 className="checkpoint-name">{cp.name}</h4>
              {cp.description && <p className="checkpoint-description">{cp.description}</p>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
