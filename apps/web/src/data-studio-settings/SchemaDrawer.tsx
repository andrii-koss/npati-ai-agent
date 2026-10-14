import React, { useEffect, useRef, useState } from "react";
import { confirmModal } from "../ConfirmDialog";
import {
  FIELD_TYPES,
  IDENTIFIER_PATTERN,
  type Feedback,
  type FieldDefinition,
  type FieldType,
  type PreviewResult,
  type SchemaOperation,
  type TableSummary,
  type TemplateSummary,
} from "./types";
import { apiFetch, errorCode } from "./helpers";

export interface SchemaDrawerProps {
  isUk: boolean;
  basePath: string;
  readOnly: boolean;
  table: TableSummary | null;
  busy: boolean;
  onClose: () => void;
  onPreview: (operation: SchemaOperation) => Promise<PreviewResult>;
  onApply: (operation: SchemaOperation, preview: PreviewResult) => Promise<void>;
  onNotify: (message: string, type?: Feedback["type"]) => void;
}

export function SchemaDrawer({ isUk, basePath, readOnly, table, busy, onClose, onPreview, onApply, onNotify }: SchemaDrawerProps) {
  const editing = Boolean(table);
  const [mode, setMode] = useState<"template" | "manual">(editing ? "manual" : "template");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSummary | null>(null);
  const [seedDemoData, setSeedDemoData] = useState(false);
  const [collectionName, setCollectionName] = useState(table?.name ?? "");
  const [renameTo, setRenameTo] = useState("");
  const [fields, setFields] = useState<FieldDefinition[]>([{ name: "", type: "string", required: false }]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [pendingOperation, setPendingOperation] = useState<SchemaOperation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [mode, editing]);

  useEffect(() => {
    if (mode !== "template" || templates.length || templatesLoading) return;
    setTemplatesLoading(true);
    void apiFetch<{ templates: TemplateSummary[] }>(`${basePath}/templates`)
      .then((result) => setTemplates(result.templates ?? []))
      .catch((cause) => setTemplatesError(cause instanceof Error ? cause.message : "Could not load templates"))
      .finally(() => setTemplatesLoading(false));
  }, [basePath, mode, templates.length, templatesLoading]);

  const resetPreview = () => { setPreview(null); setPendingOperation(null); setLocalError(null); };

  const describeOperation = (operation: SchemaOperation): string => {
    switch (operation.kind) {
      case "create_collection": return isUk ? `Створити таблицю ${operation.collection}` : `Create table ${operation.collection}`;
      case "drop_collection": return isUk ? `Видалити таблицю ${operation.collection}` : `Drop table ${operation.collection}`;
      case "rename_collection": return isUk ? `Перейменувати ${operation.collection} → ${operation.next}` : `Rename ${operation.collection} → ${operation.next}`;
      case "add_field": return isUk ? `Додати поле ${operation.field.name}` : `Add field ${operation.field.name}`;
      case "alter_field": return isUk ? `Змінити поле ${operation.field.name}` : `Alter field ${operation.field.name}`;
      case "drop_field": return isUk ? `Видалити поле ${operation.field}` : `Drop field ${operation.field}`;
      default: return operation.kind;
    }
  };

  const runPreview = async (operation: SchemaOperation) => {
    setWorking(true);
    setLocalError(null);
    try {
      const result = await onPreview(operation);
      setPreview(result);
      setPendingOperation(operation);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "Preview failed");
    } finally {
      setWorking(false);
    }
  };

  const runApply = async () => {
    if (!pendingOperation || !preview) return;
    if (preview.destructive || preview.requiresSnapshot) {
      const confirmed = await confirmModal({
        title: isUk ? "Підтвердіть зміну" : "Confirm change",
        message: isUk
          ? `${describeOperation(pendingOperation)} — руйнівна зміна. Перед застосуванням автоматично створюється snapshot.`
          : `${describeOperation(pendingOperation)} is destructive. A snapshot is taken automatically before applying.`,
        isDanger: true,
        confirmText: isUk ? "Застосувати" : "Apply",
      });
      if (!confirmed) return;
    }
    setWorking(true);
    try {
      await onApply(pendingOperation, preview);
      resetPreview();
      if (!editing) {
        setCollectionName("");
        setFields([{ name: "", type: "string", required: false }]);
        setSelectedTemplate(null);
        setSeedDemoData(false);
      }
    } catch {
      // the page reports the failure
    } finally {
      setWorking(false);
    }
  };

  const applyTemplate = async (template: TemplateSummary) => {
    const confirmed = await confirmModal({
      title: isUk ? "Застосувати схему" : "Apply schema",
      message: isUk
        ? `Схему «${template.name}» буде застосовано до dev: ${template.collections.length} таблиць. Продовжити?`
        : `Template “${template.name}” will be applied to dev: ${template.collections.length} tables. Continue?`,
      confirmText: isUk ? "Застосувати" : "Apply",
    });
    if (!confirmed) return;
    setWorking(true);
    setLocalError(null);
    try {
      const result = await apiFetch<{ collections: string[]; seededRows?: number }>(`${basePath}/templates/apply`, {
        method: "POST",
        body: JSON.stringify({ templateId: template.id, seedDemoData, approved: true }),
      });
      onNotify(
        isUk
          ? `Схему застосовано: ${result.collections?.length ?? 0} таблиць${result.seededRows ? `, демо-рядків: ${result.seededRows}` : ""}`
          : `Schema applied: ${result.collections?.length ?? 0} tables${result.seededRows ? `, demo rows: ${result.seededRows}` : ""}`,
      );
      onClose();
    } catch (cause) {
      const code = errorCode(cause);
      setLocalError(
        code === "PROMOTE_REQUIRED"
          ? (isUk ? "Шаблони застосовуються лише до dev." : "Templates can only be applied to dev.")
          : code === "APPROVAL_REQUIRED"
            ? (isUk ? "Потрібне підтвердження застосування схеми." : "Applying a schema needs confirmation.")
            : cause instanceof Error ? cause.message : "Template apply failed",
      );
    } finally {
      setWorking(false);
    }
  };

  const manualFieldsValid = fields.length > 0 && fields.every((field) => IDENTIFIER_PATTERN.test(field.name));
  const collectionValid = IDENTIFIER_PATTERN.test(collectionName);

  const buildManualOperations = (): SchemaOperation[] => {
    if (editing && table) {
      const operations: SchemaOperation[] = [];
      if (renameTo.trim() && renameTo.trim() !== table.name && IDENTIFIER_PATTERN.test(renameTo.trim())) {
        operations.push({ kind: "rename_collection", collection: table.name, next: renameTo.trim() });
      }
      for (const field of fields) {
        if (!IDENTIFIER_PATTERN.test(field.name)) continue;
        const existing = table.columns.find((column) => column.name === field.name);
        operations.push(existing
          ? { kind: "alter_field", collection: table.name, field }
          : { kind: "add_field", collection: table.name, field });
      }
      return operations;
    }
    return [{ kind: "create_collection", collection: collectionName, fields }];
  };

  return (
    <div className="data-studio-drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="data-studio-drawer" role="dialog" aria-modal="true" aria-label={editing ? (isUk ? "Редагування таблиці" : "Edit table") : isUk ? "Нова таблиця" : "New table"}>
        <header className="data-studio-drawer-header">
          <h3>{editing ? (isUk ? `Таблиця ${table!.name}` : `Table ${table!.name}`) : isUk ? "Нова таблиця" : "New table"}</h3>
          <button type="button" className="data-studio-drawer-close" aria-label={isUk ? "Закрити" : "Close"} onClick={onClose}>×</button>
        </header>

        {!editing && (
          <div className="ds-segmented" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "template"} className={mode === "template" ? "active" : ""} onClick={() => { setMode("template"); resetPreview(); }}>
              {isUk ? "Зі схеми" : "From template"}
            </button>
            <button type="button" role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "active" : ""} onClick={() => { setMode("manual"); resetPreview(); }}>
              {isUk ? "Вручну" : "Manual"}
            </button>
          </div>
        )}

        <div className="data-studio-drawer-body">
          {localError && <div className="data-studio-alert error" role="alert">{localError}</div>}

          {mode === "template" && !editing && (
            <>
              {templatesLoading && <p>{isUk ? "Завантаження схем…" : "Loading templates…"}</p>}
              {templatesError && <div className="data-studio-alert error" role="alert">{templatesError}</div>}
              <div className="ds-template-list">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`ds-template-card ${selectedTemplate?.id === template.id ? "active" : ""}`}
                    onClick={() => setSelectedTemplate(template)}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                    <div className="data-studio-chip-row">
                      {template.collections.slice(0, 6).map((collection) => (
                        <span key={collection.name} className="data-studio-chip">{collection.name} · {collection.fields}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
              {selectedTemplate && (
                <>
                  <div className="ds-drawer-summary">
                    <strong>{isUk ? "Буде створено" : "Will be created"}:</strong>
                    <ul>{selectedTemplate.collections.map((collection) => <li key={collection.name}>{collection.name} — {collection.fields} {isUk ? "полів" : "fields"}</li>)}</ul>
                  </div>
                  <label className="ds-checkbox">
                    <input type="checkbox" checked={seedDemoData} onChange={(event) => setSeedDemoData(event.target.checked)} />
                    <span>{isUk ? "Додати демо-дані (тільки dev)" : "Add demo data (dev only)"}</span>
                  </label>
                  <button type="button" className="button-primary" disabled={working || busy} onClick={() => void applyTemplate(selectedTemplate)}>
                    {working ? (isUk ? "Застосування…" : "Applying…") : isUk ? "Застосувати схему" : "Apply schema"}
                  </button>
                </>
              )}
            </>
          )}

          {mode === "manual" && (
            <>
              {!editing && (
                <label className="ds-field-block">
                  <span>{isUk ? "Назва таблиці" : "Table name"}</span>
                  <input
                    ref={firstFieldRef}
                    value={collectionName}
                    onChange={(event) => { setCollectionName(event.target.value.trim().toLowerCase()); resetPreview(); }}
                    placeholder="products"
                    pattern="[a-z][a-z0-9_]*"
                  />
                  {collectionName && !collectionValid && <small className="ds-hint-error">{isUk ? "Лише a-z, 0-9 та _; починається з літери" : "Only a-z, 0-9 and _; must start with a letter"}</small>}
                </label>
              )}

              {editing && (
                <label className="ds-field-block">
                  <span>{isUk ? "Перейменувати таблицю (необовʼязково)" : "Rename table (optional)"}</span>
                  <input value={renameTo} onChange={(event) => { setRenameTo(event.target.value.trim().toLowerCase()); resetPreview(); }} placeholder={table!.name} />
                </label>
              )}

              <div className="ds-fields">
                <strong>{isUk ? "Поля" : "Fields"}</strong>
                {fields.map((field, index) => (
                  <div key={index} className="ds-field-row">
                    <input
                      value={field.name}
                      placeholder={isUk ? "назва" : "name"}
                      onChange={(event) => {
                        const value = event.target.value.trim().toLowerCase();
                        setFields((current) => current.map((item, position) => position === index ? { ...item, name: value } : item));
                        resetPreview();
                      }}
                    />
                    <select
                      value={field.type}
                      onChange={(event) => {
                        const value = event.target.value as FieldType;
                        setFields((current) => current.map((item, position) => position === index ? { ...item, type: value } : item));
                        resetPreview();
                      }}
                    >
                      {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <label className="ds-checkbox">
                      <input
                        type="checkbox"
                        checked={field.required === true}
                        onChange={(event) => {
                          const value = event.target.checked;
                          setFields((current) => current.map((item, position) => position === index ? { ...item, required: value } : item));
                          resetPreview();
                        }}
                      />
                      <span>{isUk ? "Обовʼязкове" : "Required"}</span>
                    </label>
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={isUk ? "Видалити поле" : "Remove field"}
                      disabled={editing && Boolean(table!.columns.find((column) => column.name === field.name))}
                      onClick={() => { setFields((current) => current.filter((_item, position) => position !== index)); resetPreview(); }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="button-secondary" onClick={() => { setFields((current) => [...current, { name: "", type: "string", required: false }]); resetPreview(); }}>
                  + {isUk ? "Додати поле" : "Add field"}
                </button>
              </div>

              {editing && (
                <div className="ds-fields">
                  <strong>{isUk ? "Видалити поле" : "Drop field"}</strong>
                  {table!.columns.map((column) => (
                    <div key={column.name} className="ds-field-row">
                      <code>{column.name}</code>
                      <span>{column.type}</span>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={working || busy}
                        onClick={() => void runPreview({ kind: "drop_field", collection: table!.name, field: column.name })}
                      >
                        {isUk ? "Видалити" : "Drop"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="ds-drawer-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={working || busy || (editing ? false : !(collectionValid && manualFieldsValid))}
                  onClick={() => {
                    const operations = buildManualOperations();
                    if (!operations.length) { setLocalError(isUk ? "Немає змін для застосування" : "Nothing to apply"); return; }
                    void runPreview(operations[0]!);
                  }}
                >
                  {isUk ? "Переглянути" : "Preview"}
                </button>
              </div>
            </>
          )}

          {preview && pendingOperation && (
            <div className="ds-preview">
              <div className="preview-flags">
                <span className={`status-pill ${preview.reversible ? "allowed" : "denied"}`}>{preview.reversible ? "reversible" : "not reversible"}</span>
                <span className={`status-pill ${preview.destructive ? "denied" : "allowed"}`}>{preview.destructive ? "destructive" : "safe"}</span>
                {preview.requiresSnapshot && <span className="status-pill requires-approval">snapshot</span>}
              </div>
              <p><strong>{describeOperation(pendingOperation)}</strong></p>
              <pre className="ds-sql"><code>{preview.upSql}</code></pre>
              <button type="button" className="button-primary" disabled={working || busy} onClick={() => void runApply()}>
                {working ? (isUk ? "Застосування…" : "Applying…") : isUk ? "Застосувати" : "Apply"}
              </button>
            </div>
          )}

          {readOnly && <div className="data-studio-alert info" role="status">{isUk ? "prod — лише перегляд" : "prod is read-only"}</div>}
        </div>
      </aside>
    </div>
  );
}
