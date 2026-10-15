import React, { useEffect, useRef, useState } from "react";
import { Drawer } from "./Drawer";
import { CLASSIFICATIONS, RETENTIONS, type DataClassification, type RetentionClass } from "./types";
import { classificationLabel, codeErrorMessage, retentionLabel } from "./labels";

export interface CreateProjectDrawerProps {
  isUk: boolean;
  companyName: string;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    description?: string;
    repositoryUrl?: string;
    branch?: string;
    credentialId?: string;
    dataClassification: DataClassification;
    retentionClass: RetentionClass;
  }) => Promise<void>;
}

export function CreateProjectDrawer({
  isUk,
  companyName,
  onClose,
  onSubmit,
}: CreateProjectDrawerProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [dataClassification, setDataClassification] = useState<DataClassification>("confidential");
  const [retentionClass, setRetentionClass] = useState<RetentionClass>("standard");
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const urlValid =
    !repositoryUrl.trim() ||
    /^https:\/\/\S+$/.test(repositoryUrl.trim()) ||
    /^git@\S+:\S+$/.test(repositoryUrl.trim());
  const canSubmit = name.trim().length > 0 && name.trim().length <= 200 && urlValid;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || working) return;
    setWorking(true);
    setLocalError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        repositoryUrl: repositoryUrl.trim() || undefined,
        branch: branch.trim() || undefined,
        credentialId: credentialId.trim() || undefined,
        dataClassification,
        retentionClass,
      });
    } catch (cause) {
      setLocalError(codeErrorMessage(cause, isUk));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Drawer
      title={isUk ? "Новий код-проєкт" : "New code project"}
      subtitle={isUk ? "Code" : "Code"}
      closeLabel={isUk ? "Закрити" : "Close"}
      isUk={isUk}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <section>
          <h3>{isUk ? "Проєкт" : "Project"}</h3>
          <label className="browser-form-field">
            <span>
              {isUk ? "Назва" : "Name"} <i className="required-star">*</i>
            </span>
            <input
              ref={nameRef}
              value={name}
              maxLength={200}
              placeholder={isUk ? "Наприклад: API сервіс" : "For example: API service"}
              onChange={(event) => {
                setName(event.target.value);
                setLocalError(null);
              }}
            />
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Опис" : "Description"}</span>
            <input
              value={description}
              maxLength={5000}
              placeholder={isUk ? "Коротко, що це за проєкт" : "Short summary of the project"}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </section>

        <section>
          <h3>{isUk ? "Репозиторій" : "Repository"}</h3>
          <label className="browser-form-field">
            <span>{isUk ? "URL репозиторію" : "Repository URL"}</span>
            <input
              value={repositoryUrl}
              placeholder="https://github.com/acme/api.git"
              onChange={(event) => {
                setRepositoryUrl(event.target.value);
                setLocalError(null);
              }}
            />
            {!urlValid && (
              <small className="ds-hint-error">
                {isUk
                  ? "Підтримуються https:// та git@host:owner/repo"
                  : "https:// and git@host:owner/repo are supported"}
              </small>
            )}
            <small>
              {isUk
                ? "Залиште порожнім, щоб створити порожній код-проєкт без імпорту."
                : "Leave empty to create an empty code project without importing."}
            </small>
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Гілка" : "Branch"}</span>
            <input
              value={branch}
              placeholder="main"
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <label className="browser-form-field">
            <span>{isUk ? "Credential ID (Company vault)" : "Credential ID (Company vault)"}</span>
            <input
              value={credentialId}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setCredentialId(event.target.value)}
            />
            <small>
              {isUk
                ? "Приватні репозиторії підключаються через Company vault: вкажіть id credential з полем token. Токен ніколи не потрапляє в проєкт."
                : "Private repositories use the Company vault: pass the credential id whose field holds the token. The token never reaches the project."}
            </small>
          </label>
        </section>

        <section>
          <h3>{isUk ? "Дані" : "Data"}</h3>
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
                ? "Визначає, які дані проєкту можна передавати моделі (C5b)."
                : "Decides which project data may reach a model (C5b)."}
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
            {companyName
              ? isUk
                ? `Буде створено в компанії «${companyName}».`
                : `Created in the company “${companyName}”.`
              : isUk
                ? "Буде створено код-проєкт."
                : "A code project will be created."}
          </div>
          <button
            type="submit"
            className="button-primary automations-action-primary browser-submit-btn"
            disabled={!canSubmit || working}
          >
            {working
              ? isUk
                ? "Створення…"
                : "Creating…"
              : isUk
                ? "Створити проєкт"
                : "Create project"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
