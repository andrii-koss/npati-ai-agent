import React, { useEffect, useState } from "react";
import { Drawer } from "./Drawer";
import {
  CLASSIFICATIONS,
  RETENTIONS,
  type CodeProject,
  type DataClassification,
  type RetentionClass,
  type VerifyCommands,
} from "./types";
import {
  classificationLabel,
  codeErrorMessage,
  formatDate,
  projectStatusClass,
  retentionLabel,
} from "./labels";

export interface ProjectDetailsDrawerProps {
  isUk: boolean;
  project: CodeProject;
  busy: boolean;
  /** C1a: when the master flag is off, editing is disabled (History read-only) but details stay visible. */
  readOnly?: boolean;
  readOnlyTitle?: string;
  onClose: () => void;
  onDetect: () => void;
  onArchive: () => void;
  onSave: (input: {
    verifyCommands: VerifyCommands;
    defaultBranch?: string;
    dataClassification: DataClassification;
    retentionClass: RetentionClass;
  }) => Promise<void>;
}

export function ProjectDetailsDrawer({
  isUk,
  project,
  busy,
  readOnly,
  readOnlyTitle,
  onClose,
  onDetect,
  onArchive,
  onSave,
}: ProjectDetailsDrawerProps) {
  const [verifyTest, setVerifyTest] = useState(project.toolchain?.verifyCommands?.test ?? "");
  const [verifyLint, setVerifyLint] = useState(project.toolchain?.verifyCommands?.lint ?? "");
  const [verifyTypecheck, setVerifyTypecheck] = useState(
    project.toolchain?.verifyCommands?.typecheck ?? "",
  );
  const [verifyBuild, setVerifyBuild] = useState(project.toolchain?.verifyCommands?.build ?? "");
  const [defaultBranch, setDefaultBranch] = useState(
    project.defaultBranch ?? project.repositoryBranch ?? "",
  );
  const [dataClassification, setDataClassification] = useState<DataClassification>(
    project.dataClassification ?? "confidential",
  );
  const [retentionClass, setRetentionClass] = useState<RetentionClass>(
    project.retentionClass ?? "standard",
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVerifyTest(project.toolchain?.verifyCommands?.test ?? "");
    setVerifyLint(project.toolchain?.verifyCommands?.lint ?? "");
    setVerifyTypecheck(project.toolchain?.verifyCommands?.typecheck ?? "");
    setVerifyBuild(project.toolchain?.verifyCommands?.build ?? "");
    setDefaultBranch(project.defaultBranch ?? project.repositoryBranch ?? "");
    setDataClassification(project.dataClassification ?? "confidential");
    setRetentionClass(project.retentionClass ?? "standard");
  }, [project]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await onSave({
        verifyCommands: {
          test: verifyTest,
          lint: verifyLint,
          typecheck: verifyTypecheck,
          build: verifyBuild,
        },
        defaultBranch: defaultBranch.trim() || undefined,
        dataClassification,
        retentionClass,
      });
    } catch (cause) {
      setLocalError(codeErrorMessage(cause, isUk));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={project.name}
      subtitle={isUk ? "Code · проєкт" : "Code · project"}
      closeLabel={isUk ? "Закрити" : "Close"}
      isUk={isUk}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <section>
          <h3>{isUk ? "Стан" : "State"}</h3>
          <div className="code-detail-row">
            <span>{isUk ? "Статус" : "Status"}</span>
            <span className={`status-pill ${projectStatusClass(project.status)}`}>
              {project.status ?? "—"}
            </span>
          </div>
          <div className="code-detail-row">
            <span>{isUk ? "Тип" : "Type"}</span>
            <code>{project.type ?? "code_project"}</code>
          </div>
          <div className="code-detail-row">
            <span>ID</span>
            <code>{project.id}</code>
          </div>
          <div className="code-detail-row">
            <span>{isUk ? "Ревізія" : "Revision"}</span>
            <code>{project.revision}</code>
          </div>
          <div className="code-detail-row">
            <span>{isUk ? "Оновлено" : "Updated"}</span>
            <span className="ds-muted">{formatDate(project.updatedAt, isUk)}</span>
          </div>
          <div className="code-detail-row">
            <span>{isUk ? "Репозиторій" : "Repository"}</span>
            <span className="ds-muted">{project.repositoryUrl ?? "—"}</span>
          </div>
        </section>

        <section>
          <h3>Toolchain</h3>
          {project.toolchain ? (
            <>
              <div className="code-detail-row">
                <span>{isUk ? "Джерело" : "Source"}</span>
                <span className="ds-muted">{project.toolchain.source ?? "detected"}</span>
              </div>
              <div className="code-detail-row">
                <span>{isUk ? "Визначено" : "Detected at"}</span>
                <span className="ds-muted">{formatDate(project.toolchain.detectedAt, isUk)}</span>
              </div>
              <div className="code-detail-row">
                <span>{isUk ? "Мови" : "Languages"}</span>
                <span className="code-toolchain">
                  {(project.toolchain.languages ?? []).map((value) => (
                    <span className="data-studio-badge" key={value}>
                      {value}
                    </span>
                  ))}
                  {(project.toolchain.languages ?? []).length === 0 && (
                    <span className="ds-muted">—</span>
                  )}
                </span>
              </div>
              <div className="code-detail-row">
                <span>{isUk ? "Менеджери" : "Package managers"}</span>
                <span className="code-toolchain">
                  {(project.toolchain.packageManagers ?? []).map((value) => (
                    <span className="data-studio-badge" key={value}>
                      {value}
                    </span>
                  ))}
                  {(project.toolchain.packageManagers ?? []).length === 0 && (
                    <span className="ds-muted">—</span>
                  )}
                </span>
              </div>
              {(project.toolchain.evidence ?? []).length > 0 && (
                <div className="code-detail-row">
                  <span>{isUk ? "Ознаки" : "Evidence"}</span>
                  <span className="ds-muted">{(project.toolchain.evidence ?? []).join(", ")}</span>
                </div>
              )}
            </>
          ) : (
            <p className="ds-muted">
              {isUk ? "Toolchain ще не визначено." : "Toolchain is not detected yet."}
            </p>
          )}
          <button
            type="button"
            className="button-secondary"
            disabled={busy || readOnly}
            title={readOnly ? readOnlyTitle : undefined}
            onClick={onDetect}
          >
            {busy ? "…" : isUk ? "Визначити повторно" : "Detect again"}
          </button>
        </section>

        <section>
          <h3>{isUk ? "Verify-команди" : "Verify commands"}</h3>
          <label className="browser-form-field">
            <span>test</span>
            <input
              value={verifyTest}
              placeholder="npm test"
              onChange={(event) => setVerifyTest(event.target.value)}
            />
          </label>
          <label className="browser-form-field">
            <span>lint</span>
            <input
              value={verifyLint}
              placeholder="npm run lint"
              onChange={(event) => setVerifyLint(event.target.value)}
            />
          </label>
          <label className="browser-form-field">
            <span>typecheck</span>
            <input
              value={verifyTypecheck}
              placeholder="npm run typecheck"
              onChange={(event) => setVerifyTypecheck(event.target.value)}
            />
          </label>
          <label className="browser-form-field">
            <span>build</span>
            <input
              value={verifyBuild}
              placeholder="npm run build"
              onChange={(event) => setVerifyBuild(event.target.value)}
            />
          </label>
          <p className="ds-muted">
            {isUk
              ? "Порожнє поле означає, що команда не задана (агент не запускатиме її як перевірку)."
              : "An empty field means the command is unset (the agent will not run it as a check)."}
          </p>
        </section>

        <section>
          <h3>{isUk ? "Гілка та політика даних" : "Branch and data policy"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "Гілка за замовчуванням" : "Default branch"}</span>
            <input
              value={defaultBranch}
              placeholder="main"
              onChange={(event) => setDefaultBranch(event.target.value)}
            />
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Класифікація даних" : "Data classification"}</span>
            <select
              value={dataClassification}
              onChange={(event) =>
                setDataClassification(event.target.value as DataClassification)
              }
            >
              {CLASSIFICATIONS.map((value) => (
                <option key={value} value={value}>
                  {classificationLabel(value, isUk)}
                </option>
              ))}
            </select>
            <small>
              {isUk
                ? "Підвищувати можна; зниження відхиляється сервером."
                : "Raising is allowed; lowering is refused by the server."}
            </small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Клас зберігання" : "Retention class"}</span>
            <select
              value={retentionClass}
              onChange={(event) => setRetentionClass(event.target.value as RetentionClass)}
            >
              {RETENTIONS.map((value) => (
                <option key={value} value={value}>
                  {retentionLabel(value, isUk)}
                </option>
              ))}
            </select>
          </label>
        </section>

        {localError && (
          <div className="data-studio-alert error" role="alert">
            {localError}
          </div>
        )}

        <div className="browser-form-footer">
          <div className="browser-form-footer-hint">
            {readOnly
              ? (readOnlyTitle ??
                (isUk
                  ? "Coding Agent вимкнено (History read-only)"
                  : "Coding Agent is disabled (History read-only)"))
              : isUk
                ? "Зміни зберігаються з перевіркою revision."
                : "Changes are saved with a revision check."}
          </div>
          <div className="code-detail-actions">
            {project.status !== "archived" && (
              <button
                type="button"
                className="automation-action-btn danger"
                disabled={busy || readOnly}
                title={readOnly ? readOnlyTitle : undefined}
                onClick={onArchive}
              >
                {isUk ? "Архівувати" : "Archive"}
              </button>
            )}
            <button
              type="submit"
              className="button-primary automations-action-primary browser-submit-btn"
              disabled={saving || readOnly}
              title={readOnly ? readOnlyTitle : undefined}
            >
              {saving ? (isUk ? "Збереження…" : "Saving…") : isUk ? "Зберегти" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
