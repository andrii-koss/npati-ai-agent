import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import type { Project } from "./ProjectSection";

// --- Types ---
export type FieldType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "json"
  | "uuid"
  | "enum"
  | "file_reference";

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required?: boolean;
  default?: string | number | boolean | null;
  options?: string[];
}

export type SchemaOperation =
  | { kind: "create_collection"; collection: string; fields: FieldDefinition[] }
  | { kind: "drop_collection"; collection: string }
  | { kind: "rename_collection"; collection: string; next: string }
  | { kind: "add_field"; collection: string; field: FieldDefinition }
  | { kind: "alter_field"; collection: string; field: FieldDefinition }
  | { kind: "drop_field"; collection: string; field: string }
  | { kind: "create_relation"; collection: string; target: string; name: string; cardinality: "many-to-one" | "one-to-many" | "many-to-many" }
  | { kind: "drop_relation"; collection: string; name: string; cardinality: "many-to-one" | "one-to-many" | "many-to-many" }
  | { kind: "create_index"; collection: string; fields: string[]; unique?: boolean };

export interface SchemaSnapshot {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; nullable: boolean }>;
    constraints: string[];
    indexes: string[];
    rlsEnabled: boolean;
    rlsForced: boolean;
    policies: string[];
  }>;
}

interface MigrationItem {
  id: string;
  version: number;
  operation: SchemaOperation;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  authorId: string;
  runId?: string | null;
  status: string;
  createdAt: string;
  appliedAt?: string | null;
}

interface OverviewData {
  backend: { id: string; name: string; status: string; provider: string };
  environment: {
    environment: "dev" | "prod";
    status: string;
    syncStatus: "synced" | "drift_detected" | "reconciliation_required";
    schemaFingerprint?: string | null;
  };
  schema: SchemaSnapshot | null;
  expectedSchema: unknown | null;
  drift: {
    actual: string;
    expected: string;
    tables: { added: string[]; removed: string[]; changed: string[] };
  } | null;
  lock: { held: boolean; createdAt?: string; expiresAt?: string; ownerToken?: string };
  migrations: MigrationItem[];
}

interface PreviewDiff {
  operation: string;
  upSql: string;
  downSql?: string;
  reversible: boolean;
  destructive: boolean;
  requiresSnapshot: boolean;
  diff: { operation: SchemaOperation; beforeFingerprint: string; sql: string };
}

// --- API Helpers ---
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch("/api" + path, { ...init, headers });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.error?.message || `HTTP ${response.status}: Request failed`);
  }
  return result as T;
}

export function DataStudioPage() {
  const { companyId = "", projectId = "" } = useParams();
  const { language } = useTranslation();
  const isUk = language === "uk";

  // Navigation & environment
  const [environment, setEnvironment] = useState<"dev" | "prod">("dev");
  const [project, setProject] = useState<Project | null>(null);
  const [backends, setBackends] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; type: "success" | "info" | "error" } | null>(null);

  // Tab & collection selection
  const [selectedCollection, setSelectedCollection] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"data" | "schema" | "migrations">("data");

  // Data view state (rows)
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<Array<{ field: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: string }>>([]);
  const [sortField, setSortField] = useState<string>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [pageLimit, setPageLimit] = useState<number>(25);
  const [pageOffset, setPageOffset] = useState<number>(0);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  // Modals & drawers
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState<FieldType>("string");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [newFieldDefault, setNewFieldDefault] = useState("");
  const [newFieldEnumOptions, setNewFieldEnumOptions] = useState("");

  const [addRelationOpen, setAddRelationOpen] = useState(false);
  const [relationTarget, setRelationTarget] = useState("");
  const [relationName, setRelationName] = useState("");
  const [relationCardinality, setRelationCardinality] = useState<"many-to-one" | "one-to-many" | "many-to-many">("many-to-one");

  const [rowDrawerOpen, setRowDrawerOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
  const [rowFormData, setRowFormData] = useState<Record<string, unknown>>({});

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importFormat, setImportFormat] = useState<"csv" | "json">("csv");
  const [importContent, setImportContent] = useState("");
  const [importing, setImporting] = useState(false);

  // Staged schema change for diff preview & apply
  const [pendingDiff, setPendingDiff] = useState<PreviewDiff | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [applyingSchema, setApplyingSchema] = useState(false);

  // Drift inspection modal
  const [showDriftModal, setShowDriftModal] = useState(false);

  // Attach / Create Backend for empty state
  const [selectedBackendToAttach, setSelectedBackendToAttach] = useState("");
  const [newBackendName, setNewBackendName] = useState("");
  const [attachingBackend, setAttachingBackend] = useState(false);

  const basePath = `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-studio/${environment}`;

  // Notify feedback helper
  const notify = (message: string, type: "success" | "info" | "error" = "success") => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 5000);
  };

  // Load project & DataBackends list
  const loadProjectAndBackends = useCallback(async () => {
    try {
      const proj = await apiFetch<Project>(`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}`);
      setProject(proj);
      const backendsData = await apiFetch<{ backends: Array<{ id: string; name: string; status: string }> }>(
        `/companies/${encodeURIComponent(companyId)}/data-backends`
      ).catch(() => ({ backends: [] }));
      setBackends(backendsData.backends);
    } catch (err: any) {
      setError(err.message || "Failed to load project details");
    }
  }, [companyId, projectId]);

  // Load overview for environment
  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<OverviewData>(basePath);
      setOverview(data);
      // Auto-select first collection if none selected or no longer exists
      const tableNames = (data.schema?.tables ?? []).map((t) => t.name);
      if (tableNames.length > 0) {
        setSelectedCollection((curr) => (tableNames.includes(curr) ? curr : tableNames[0]!));
      } else {
        setSelectedCollection("");
      }
    } catch (err: any) {
      if (err.message && err.message.includes("Project has no DataBackend")) {
        setOverview(null);
      } else {
        setError(err.message || "Data Studio is unavailable");
      }
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  useEffect(() => {
    void loadProjectAndBackends();
  }, [loadProjectAndBackends]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  // Filter out system tables (_npati_) from user view
  const userCollections = useMemo(() => {
    if (!overview?.schema?.tables) return [];
    return overview.schema.tables.filter((t) => !t.name.startsWith("_npati_"));
  }, [overview?.schema?.tables]);

  const currentTable = useMemo(() => {
    return userCollections.find((t) => t.name === selectedCollection) || null;
  }, [userCollections, selectedCollection]);

  // Load rows when collection, search, filters, sorting, or pagination change
  const loadRows = useCallback(async () => {
    if (!selectedCollection || !overview || activeTab !== "data") return;
    setRowsLoading(true);
    try {
      const validFilters = filters
        .filter((f) => f.field && f.value.trim() !== "")
        .map((f) => ({
          field: f.field,
          operator: f.operator,
          value: f.value,
        }));

      const body: Record<string, unknown> = {
        limit: pageLimit,
        offset: pageOffset,
        sort: { field: sortField, direction: sortDir },
      };
      if (searchQuery.trim()) {
        body.search = searchQuery.trim();
      }
      if (validFilters.length > 0) {
        body.filters = validFilters;
      }

      const res = await apiFetch<{ rows: Record<string, unknown>[] }>(
        `${basePath}/collections/${encodeURIComponent(selectedCollection)}/rows/query`,
        { method: "POST", body: JSON.stringify(body) }
      );
      setRows(res.rows || []);
      setSelectedRowIds(new Set());
    } catch (err: any) {
      notify(err.message || "Failed to load rows", "error");
    } finally {
      setRowsLoading(false);
    }
  }, [selectedCollection, overview, activeTab, basePath, pageLimit, pageOffset, sortField, sortDir, searchQuery, filters]);

  useEffect(() => {
    if (activeTab === "data") {
      void loadRows();
    }
  }, [loadRows, activeTab]);

  // --- Attach / Create Backend Actions ---
  const handleAttachBackend = async (backendId: string) => {
    if (!backendId) return;
    setAttachingBackend(true);
    try {
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-backend`, {
        method: "PUT",
        body: JSON.stringify({ dataBackendId: backendId }),
      });
      notify(isUk ? "DataBackend прикріплено" : "DataBackend attached successfully");
      await loadProjectAndBackends();
      await loadOverview();
    } catch (err: any) {
      notify(err.message || "Failed to attach DataBackend", "error");
    } finally {
      setAttachingBackend(false);
    }
  };

  const handleCreateAndAttachBackend = async () => {
    if (!newBackendName.trim()) return;
    setAttachingBackend(true);
    try {
      const created = await apiFetch<{ backend: { id: string } }>(
        `/companies/${encodeURIComponent(companyId)}/data-backends`,
        { method: "POST", body: JSON.stringify({ name: newBackendName.trim() }) }
      );
      await apiFetch(`/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/data-backend`, {
        method: "PUT",
        body: JSON.stringify({ dataBackendId: created.backend.id }),
      });
      setNewBackendName("");
      notify(isUk ? "DataBackend створено та прикріплено" : "DataBackend created and attached");
      await loadProjectAndBackends();
      await loadOverview();
    } catch (err: any) {
      notify(err.message || "Failed to create DataBackend", "error");
    } finally {
      setAttachingBackend(false);
    }
  };

  // --- Schema Operations via Preview Diff ---
  const stageSchemaOperation = async (operation: SchemaOperation) => {
    if (environment === "prod") {
      notify(isUk ? "Зміни схеми prod дозволені лише через Promote" : "Production schema changes require Promote (D7)", "error");
      return;
    }
    if (overview?.environment.syncStatus === "drift_detected") {
      notify(isUk ? "Виявлено розбіжність схеми (drift). Застосування заблоковано." : "Schema drift detected! Apply is blocked.", "error");
      return;
    }
    try {
      const preview = await apiFetch<PreviewDiff>(`${basePath}/schema/preview`, {
        method: "POST",
        body: JSON.stringify({ operation }),
      });
      setPendingDiff(preview);
      setConfirmDestructive(false);
    } catch (err: any) {
      notify(err.message || "Failed to preview schema change", "error");
    }
  };

  const applyPendingDiff = async () => {
    if (!pendingDiff || !overview) return;
    if ((pendingDiff.destructive || pendingDiff.requiresSnapshot) && !confirmDestructive) {
      notify(isUk ? "Підтвердіть деструктивну зміну" : "Please confirm the destructive change", "error");
      return;
    }
    setApplyingSchema(true);
    try {
      await apiFetch(`${basePath}/schema/apply`, {
        method: "POST",
        body: JSON.stringify({
          operation: pendingDiff.diff.operation,
          expectedFingerprint: pendingDiff.diff.beforeFingerprint,
          confirmDestructive: true,
        }),
      });
      notify(isUk ? "Зміни схеми успішно застосовано" : "Schema changes applied successfully");
      setPendingDiff(null);
      setCreateCollectionOpen(false);
      setAddFieldOpen(false);
      setAddRelationOpen(false);
      await loadOverview();
    } catch (err: any) {
      notify(err.message || "Failed to apply schema change", "error");
    } finally {
      setApplyingSchema(false);
    }
  };

  // --- Collection Actions ---
  const handleCreateCollection = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newCollectionName.trim().toLowerCase();
    if (!name) return;
    void stageSchemaOperation({
      kind: "create_collection",
      collection: name,
      fields: [],
    });
  };

  const handleRenameCollection = async () => {
    if (!selectedCollection) return;
    const nextName = await promptModal({
      message: isUk ? `Нова назва для колекції "${selectedCollection}":` : `New name for collection "${selectedCollection}":`,
      defaultValue: selectedCollection,
    });
    if (!nextName || !nextName.trim() || nextName.trim() === selectedCollection) return;
    void stageSchemaOperation({
      kind: "rename_collection",
      collection: selectedCollection,
      next: nextName.trim().toLowerCase(),
    });
  };

  const handleDeleteCollection = async () => {
    if (!selectedCollection) return;
    const confirmed = await confirmModal({
      message: isUk
        ? `Ви впевнені, що хочете видалити колекцію "${selectedCollection}"? Це призведе до видалення таблиці та всіх її даних!`
        : `Are you sure you want to delete collection "${selectedCollection}"? This will drop the table and all its data!`,
      isDanger: true,
    });
    if (!confirmed) return;
    void stageSchemaOperation({
      kind: "drop_collection",
      collection: selectedCollection,
    });
  };

  // --- Field Actions ---
  const handleAddField = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCollection || !newFieldName.trim()) return;
    const fieldDef: FieldDefinition = {
      name: newFieldName.trim().toLowerCase(),
      type: newFieldType,
      required: newFieldRequired,
      default: newFieldDefault.trim() ? newFieldDefault.trim() : null,
      options: newFieldType === "enum" && newFieldEnumOptions.trim()
        ? newFieldEnumOptions.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    };
    void stageSchemaOperation({
      kind: "add_field",
      collection: selectedCollection,
      field: fieldDef,
    });
  };

  const handleDeleteField = async (fieldName: string) => {
    if (!selectedCollection || fieldName === "id") return;
    const confirmed = await confirmModal({
      message: isUk
        ? `Видалити поле "${fieldName}" з колекції "${selectedCollection}"? Усі збережені значення в цій колонці будуть видалені.`
        : `Delete field "${fieldName}" from "${selectedCollection}"? All stored values in this column will be lost.`,
      isDanger: true,
    });
    if (!confirmed) return;
    void stageSchemaOperation({
      kind: "drop_field",
      collection: selectedCollection,
      field: fieldName,
    });
  };

  // --- Relation Actions ---
  const handleAddRelation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCollection || !relationTarget || !relationName.trim()) return;
    void stageSchemaOperation({
      kind: "create_relation",
      collection: selectedCollection,
      target: relationTarget,
      name: relationName.trim().toLowerCase(),
      cardinality: relationCardinality,
    });
  };

  // --- Migration Revert ---
  const handleRevertMigration = async (migrationId: string, version: number) => {
    const confirmed = await confirmModal({
      message: isUk
        ? `Відкотити міграцію v${version}? Структура схеми повернеться до попереднього стану.`
        : `Revert migration v${version}? Schema will be rolled back to previous state.`,
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      await apiFetch(`${basePath}/schema/revert`, {
        method: "POST",
        body: JSON.stringify({ migrationId }),
      });
      notify(isUk ? `Міграцію v${version} успішно відкочено` : `Migration v${version} reverted`);
      await loadOverview();
    } catch (err: any) {
      notify(err.message || "Failed to revert migration", "error");
    }
  };

  // --- Row CRUD Actions ---
  const openCreateRowDrawer = () => {
    if (!currentTable) return;
    const initial: Record<string, unknown> = {};
    for (const col of currentTable.columns) {
      if (col.name === "id") continue;
      initial[col.name] = "";
    }
    setRowFormData(initial);
    setEditingRow(null);
    setRowDrawerOpen(true);
  };

  const openEditRowDrawer = (row: Record<string, unknown>) => {
    setEditingRow(row);
    setRowFormData({ ...row });
    setRowDrawerOpen(true);
  };

  const handleSaveRow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCollection || !currentTable) return;
    try {
      const payload: Record<string, unknown> = {};
      for (const col of currentTable.columns) {
        if (col.name === "id") continue;
        const val = rowFormData[col.name];
        if (val === "" || val === undefined) {
          payload[col.name] = null;
        } else if (col.type === "boolean") {
          payload[col.name] = val === true || val === "true";
        } else if (col.type.includes("int") || col.type.includes("numeric")) {
          payload[col.name] = val === null ? null : Number(val);
        } else if (col.type === "jsonb") {
          try {
            payload[col.name] = typeof val === "string" ? JSON.parse(val) : val;
          } catch {
            throw new Error(`Invalid JSON in field "${col.name}"`);
          }
        } else {
          payload[col.name] = val;
        }
      }

      if (editingRow?.id) {
        await apiFetch(
          `${basePath}/collections/${encodeURIComponent(selectedCollection)}/rows/${encodeURIComponent(String(editingRow.id))}`,
          { method: "PATCH", body: JSON.stringify({ row: payload }) }
        );
        notify(isUk ? "Рядок оновлено" : "Row updated");
      } else {
        await apiFetch(
          `${basePath}/collections/${encodeURIComponent(selectedCollection)}/rows`,
          { method: "POST", body: JSON.stringify({ row: payload }) }
        );
        notify(isUk ? "Рядок створено" : "Row created");
      }
      setRowDrawerOpen(false);
      await loadRows();
    } catch (err: any) {
      notify(err.message || "Failed to save row", "error");
    }
  };

  const handleDeleteRow = async (rowId: string) => {
    const confirmed = await confirmModal({
      message: isUk ? "Видалити цей рядок?" : "Delete this row?",
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      await apiFetch(`${basePath}/collections/${encodeURIComponent(selectedCollection)}/rows/delete`, {
        method: "POST",
        body: JSON.stringify({ ids: [rowId], confirmed: true }),
      });
      notify(isUk ? "Рядок видалено" : "Row deleted");
      await loadRows();
    } catch (err: any) {
      notify(err.message || "Failed to delete row", "error");
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedRowIds);
    if (!ids.length) return;
    const confirmed = await confirmModal({
      message: isUk
        ? `Видалити обрані рядки (${ids.length} шт.)? Ця дія незворотна.`
        : `Delete selected rows (${ids.length})? This cannot be undone.`,
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      const res = await apiFetch<{ deleted: number }>(
        `${basePath}/collections/${encodeURIComponent(selectedCollection)}/rows/delete`,
        { method: "POST", body: JSON.stringify({ ids, confirmed: true }) }
      );
      notify(isUk ? `Видалено рядків: ${res.deleted}` : `Deleted ${res.deleted} rows`);
      setSelectedRowIds(new Set());
      await loadRows();
    } catch (err: any) {
      notify(err.message || "Failed to delete rows", "error");
    }
  };

  // --- Import & Export Actions ---
  const handleExport = async (format: "csv" | "json") => {
    if (!selectedCollection) return;
    try {
      const res = await apiFetch<{ filename: string; mimeType: string; content: string }>(
        `${basePath}/collections/${encodeURIComponent(selectedCollection)}/export`,
        { method: "POST", body: JSON.stringify({ format }) }
      );
      const blob = new Blob([res.content], { type: res.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify(isUk ? `Експортовано у ${res.filename}` : `Exported to ${res.filename}`);
    } catch (err: any) {
      notify(err.message || "Export failed", "error");
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCollection || !importContent.trim()) return;
    if (new Blob([importContent]).size > 1_000_000) {
      notify(isUk ? "Розмір файлу перевищує 1 МБ" : "Import exceeds 1 MB limit", "error");
      return;
    }
    setImporting(true);
    try {
      const res = await apiFetch<{ imported: number }>(
        `${basePath}/collections/${encodeURIComponent(selectedCollection)}/import`,
        { method: "POST", body: JSON.stringify({ format: importFormat, content: importContent }) }
      );
      notify(isUk ? `Успішно імпортовано: ${res.imported} рядків` : `Successfully imported ${res.imported} rows`);
      setImportModalOpen(false);
      setImportContent("");
      await loadRows();
    } catch (err: any) {
      notify(err.message || "Import failed", "error");
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) {
      notify(isUk ? "Файл більший ніж 1 МБ" : "File exceeds 1 MB limit", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setImportContent(text || "");
      if (file.name.endsWith(".json")) setImportFormat("json");
      else if (file.name.endsWith(".csv")) setImportFormat("csv");
    };
    reader.readAsText(file);
  };

  // --- Render Empty Project without DataBackend ---
  if (!loading && (!overview || !project?.dataBackendId)) {
    return (
      <div className="data-studio-container">
        <header className="data-studio-header">
          <div className="data-studio-breadcrumbs">
            <Link to="/company">{isUk ? "← Компанія" : "← Company"}</Link>
            <span>/</span>
            <span>{project?.name || "Project"}</span>
            <span>/</span>
            <strong>Data Studio</strong>
          </div>
        </header>

        <section className="data-studio-empty-card" aria-label="No DataBackend Attached">
          <div className="empty-icon">🗄️</div>
          <h2>{isUk ? "До проєкту не підключено DataBackend" : "No DataBackend attached to this project"}</h2>
          <p>
            {isUk
              ? "Data Studio використовує окрему ізольовану базу даних (DataBackend) для збереження колекцій, зв'язків та записів вашого сайту."
              : "Data Studio uses an isolated project database (DataBackend) to store and manage your website's collections, schema, and records."}
          </p>

          {error && <div className="data-studio-alert error" role="alert">{error}</div>}

          <div className="data-studio-attach-options">
            {backends.filter((b) => b.status === "ready").length > 0 && (
              <div className="attach-existing-box">
                <h3>{isUk ? "Прикріпити існуючий DataBackend" : "Attach existing DataBackend"}</h3>
                <div className="form-row">
                  <select
                    value={selectedBackendToAttach}
                    onChange={(e) => setSelectedBackendToAttach(e.target.value)}
                    disabled={attachingBackend}
                    aria-label="Select DataBackend"
                  >
                    <option value="">{isUk ? "-- Оберіть DataBackend --" : "-- Select DataBackend --"}</option>
                    {backends
                      .filter((b) => b.status === "ready")
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.status})
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="button-primary"
                    disabled={!selectedBackendToAttach || attachingBackend}
                    onClick={() => void handleAttachBackend(selectedBackendToAttach)}
                  >
                    {attachingBackend ? (isUk ? "Підключення…" : "Attaching…") : isUk ? "Підключити" : "Attach"}
                  </button>
                </div>
              </div>
            )}

            <div className="create-new-backend-box">
              <h3>{isUk ? "Створити новий DataBackend для цього проєкту" : "Create new DataBackend for this project"}</h3>
              <div className="form-row">
                <input
                  type="text"
                  placeholder={isUk ? "Назва бази (напр. Store DB)" : "Backend name (e.g. Store DB)"}
                  value={newBackendName}
                  onChange={(e) => setNewBackendName(e.target.value)}
                  maxLength={100}
                  disabled={attachingBackend}
                  aria-label="New DataBackend name"
                />
                <button
                  type="button"
                  className="button-primary"
                  disabled={!newBackendName.trim() || attachingBackend}
                  onClick={() => void handleCreateAndAttachBackend()}
                >
                  {attachingBackend ? (isUk ? "Створення…" : "Creating…") : isUk ? "Створити й підключити" : "Create & Attach"}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // --- Main Data Studio UI ---
  const syncStatus = overview?.environment.syncStatus || "synced";
  const migrationLock = overview?.lock;
  const isDrift = syncStatus === "drift_detected" || syncStatus === "reconciliation_required";

  return (
    <div className="data-studio-container">
      {/* Toast Feedback */}
      {feedback && (
        <div className={`data-studio-toast toast-${feedback.type}`} role="status">
          {feedback.message}
        </div>
      )}

      {/* Header */}
      <header className="data-studio-header">
        <div className="data-studio-header-left">
          <div className="data-studio-breadcrumbs">
            <Link to="/company">{isUk ? "Компанія" : "Company"}</Link>
            <span>/</span>
            <Link to={`/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`}>
              {project?.name || "Project"}
            </Link>
            <span>/</span>
            <strong>Data Studio</strong>
          </div>
          <div className="data-studio-title-row">
            <h1>{overview?.backend.name || "Data Studio"}</h1>
            <span className={`status-pill status-${overview?.backend.status}`}>{overview?.backend.status}</span>
          </div>
        </div>

        <div className="data-studio-header-right">
          {/* Environment Switcher */}
          <div className="env-switcher" role="radiogroup" aria-label="Environment">
            <button
              type="button"
              className={`env-btn ${environment === "dev" ? "active" : ""}`}
              onClick={() => setEnvironment("dev")}
            >
              dev
            </button>
            <button
              type="button"
              className={`env-btn ${environment === "prod" ? "active" : ""}`}
              onClick={() => setEnvironment("prod")}
            >
              prod
            </button>
          </div>

          {/* Sync Status Badge */}
          <div
            className={`sync-badge sync-${syncStatus} ${isDrift ? "clickable" : ""}`}
            onClick={() => isDrift && setShowDriftModal(true)}
            title={isDrift ? (isUk ? "Натисніть для перегляду розбіжностей" : "Click to view drift details") : ""}
            role={isDrift ? "button" : undefined}
          >
            <span className="dot" />
            <span>
              {syncStatus === "synced"
                ? isUk ? "Синхронізовано" : "Synced"
                : syncStatus === "drift_detected"
                ? isUk ? "⚠️ Розбіжність (Drift)" : "⚠️ Drift Detected"
                : isUk ? "⛔ Потрібна реконсиляція" : "⛔ Reconciliation"}
            </span>
          </div>

          {/* Migration Lock Indicator */}
          {migrationLock?.held && (
            <div className="migration-lock-pill" title={`Expires: ${migrationLock.expiresAt || "soon"}`}>
              🔒 {isUk ? "Міграція виконується" : "Locked"}
            </div>
          )}

          <Link
            to={`/projects/${encodeURIComponent(companyId)}/${encodeURIComponent(projectId)}`}
            className="button-secondary back-project-btn"
          >
            {isUk ? "До редактора сайту ↗" : "Website Editor ↗"}
          </Link>
        </div>
      </header>

      {/* Production Warning Banner */}
      {environment === "prod" && (
        <div className="data-studio-alert info">
          <span>🛡️ {isUk ? "Режим Production: зміни схеми дозволені лише через Promote (D7). Дані доступні лише для читання/перегляду." : "Production Mode: Schema modifications require Promote (D7). Data is read-only here."}</span>
        </div>
      )}

      {/* Drift Warning Banner */}
      {isDrift && (
        <div className="data-studio-alert warning">
          <div className="alert-content">
            <strong>⚠️ {isUk ? "Виявлено розбіжність схеми бази даних (Schema Drift)" : "Database Schema Drift Detected"}</strong>
            <p>
              {isUk
                ? "Фактична структура бази даних відрізняється від історії міграцій NPATI. Застосування нових змін заблоковано для безпеки."
                : "The live project database schema has diverged from NPATI migrations history. New schema changes are blocked."}
            </p>
          </div>
          <button type="button" className="button-secondary" onClick={() => setShowDriftModal(true)}>
            {isUk ? "Переглянути різницю" : "View Drift Diff"}
          </button>
        </div>
      )}

      {/* Main Studio Body: Sidebar + Main Panel */}
      <div className="data-studio-body">
        {/* Left Sidebar: Collections List */}
        <aside className="data-studio-sidebar" aria-label="Collections Sidebar">
          <div className="sidebar-header">
            <h3>{isUk ? "Колекції" : "Collections"}</h3>
            {environment === "dev" && !isDrift && (
              <button
                type="button"
                className="button-primary new-collection-btn"
                onClick={() => {
                  setNewCollectionName("");
                  setCreateCollectionOpen(true);
                }}
                title={isUk ? "Створити колекцію" : "New Collection"}
              >
                +
              </button>
            )}
          </div>

          <div className="collections-list">
            {userCollections.length === 0 ? (
              <div className="no-collections-hint">
                <p>{isUk ? "Колекцій ще немає." : "No collections yet."}</p>
                {environment === "dev" && (
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => {
                      setNewCollectionName("");
                      setCreateCollectionOpen(true);
                    }}
                  >
                    {isUk ? "+ Створити першу" : "+ Create first"}
                  </button>
                )}
              </div>
            ) : (
              userCollections.map((col) => {
                const isSelected = col.name === selectedCollection;
                return (
                  <button
                    key={col.name}
                    type="button"
                    className={`collection-item ${isSelected ? "active" : ""}`}
                    onClick={() => {
                      setSelectedCollection(col.name);
                      setPageOffset(0);
                    }}
                  >
                    <span className="col-icon">📁</span>
                    <span className="col-name">{col.name}</span>
                    <span className="col-count">{col.columns.length}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="sidebar-footer">
            <button
              type="button"
              className={`sidebar-nav-item ${activeTab === "migrations" ? "active" : ""}`}
              onClick={() => setActiveTab("migrations")}
            >
              📜 {isUk ? "Історія міграцій" : "Migrations"} ({overview?.migrations.length || 0})
            </button>
          </div>
        </aside>

        {/* Right Content Area */}
        <main className="data-studio-main">
          {activeTab === "migrations" ? (
            /* --- Migrations History View --- */
            <div className="data-studio-pane migrations-pane">
              <div className="pane-header">
                <div>
                  <h2>{isUk ? "Історія міграцій схеми" : "Schema Migration History"}</h2>
                  <p>{isUk ? "Версії та зміни структури бази даних проєкту" : "Track all schema version migrations applied to this database"}</p>
                </div>
              </div>

              <div className="migrations-table-container">
                <table className="data-studio-table">
                  <thead>
                    <tr>
                      <th>v#</th>
                      <th>{isUk ? "Операція" : "Operation"}</th>
                      <th>{isUk ? "Автор" : "Author"}</th>
                      <th>{isUk ? "Властивості" : "Flags"}</th>
                      <th>{isUk ? "Статус" : "Status"}</th>
                      <th>{isUk ? "Дата" : "Date"}</th>
                      {environment === "dev" && <th>{isUk ? "Дії" : "Actions"}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(overview?.migrations ?? []).map((m) => {
                      const isAgent = m.authorId.startsWith("agent:") || Boolean(m.runId);
                      return (
                        <tr key={m.id}>
                          <td><strong>#{m.version}</strong></td>
                          <td>
                            <code>{m.operation?.kind || "custom"}</code>
                            {m.operation && "collection" in m.operation && (
                              <span className="muted-table-text"> ({m.operation.collection})</span>
                            )}
                          </td>
                          <td>
                            {isAgent ? (
                              <span className="author-agent-badge">
                                🤖 Agent
                                {m.runId && (
                                  <Link to={`/activity?runId=${encodeURIComponent(m.runId)}`} className="run-link">
                                    View Run ↗
                                  </Link>
                                )}
                              </span>
                            ) : (
                              <span className="author-user-badge">👤 User</span>
                            )}
                          </td>
                          <td>
                            <div className="flags-row">
                              {m.reversible ? (
                                <span className="flag-pill reversible">reversible</span>
                              ) : (
                                <span className="flag-pill not-reversible">irreversible</span>
                              )}
                              {m.destructive && <span className="flag-pill destructive">destructive</span>}
                              {m.requiresSnapshot && <span className="flag-pill snapshot">snapshot</span>}
                            </div>
                          </td>
                          <td>
                            <span className={`status-pill status-${m.status}`}>{m.status}</span>
                          </td>
                          <td><small>{new Date(m.createdAt).toLocaleString()}</small></td>
                          {environment === "dev" && (
                            <td>
                              {m.reversible && m.status === "applied" && (
                                <button
                                  type="button"
                                  className="button-secondary table-action-btn danger"
                                  onClick={() => void handleRevertMigration(m.id, m.version)}
                                  title={isUk ? "Відкотити міграцію" : "Rollback migration"}
                                >
                                  {isUk ? "Відкотити" : "Revert"}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : !currentTable ? (
            /* --- No Collection Selected State --- */
            <div className="empty-collection-state">
              <p>{isUk ? "Оберіть колекцію ліворуч або створіть нову." : "Select a collection from the sidebar or create a new one."}</p>
            </div>
          ) : (
            /* --- Collection View (Data or Schema Tab) --- */
            <div className="collection-view-pane">
              {/* Collection Header & Tabs */}
              <div className="collection-view-header">
                <div className="collection-header-meta">
                  <h2>{currentTable.name}</h2>
                  <div className="collection-actions-inline">
                    {environment === "dev" && !isDrift && (
                      <>
                        <button type="button" className="button-secondary" onClick={() => void handleRenameCollection()}>
                          {isUk ? "Перейменувати" : "Rename"}
                        </button>
                        <button type="button" className="danger-button" onClick={() => void handleDeleteCollection()}>
                          {isUk ? "Видалити" : "Delete"}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="collection-tabs-nav" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "data"}
                    className={`col-tab-btn ${activeTab === "data" ? "active" : ""}`}
                    onClick={() => setActiveTab("data")}
                  >
                    📊 {isUk ? "Дані (Рядки)" : "Data View"}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "schema"}
                    className={`col-tab-btn ${activeTab === "schema" ? "active" : ""}`}
                    onClick={() => setActiveTab("schema")}
                  >
                    ⚙️ {isUk ? "Схема & Поля" : "Schema Editor"} ({currentTable.columns.length})
                  </button>
                </div>
              </div>

              {activeTab === "data" ? (
                /* --- DATA VIEW TAB --- */
                <div className="data-view-content">
                  {/* Data Toolbar: Search, Filters, Add Row, Import, Export, Bulk Delete */}
                  <div className="data-view-toolbar">
                    <div className="toolbar-search-filter">
                      <div className="search-input-box">
                        <input
                          type="search"
                          placeholder={isUk ? "Пошук по рядках…" : "Search rows…"}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void loadRows()}
                        />
                        <button type="button" className="button-secondary" onClick={() => void loadRows()}>
                          🔍
                        </button>
                      </div>

                      {/* Add filter button */}
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() =>
                          setFilters((prev) => [
                            ...prev,
                            { field: currentTable.columns[1]?.name || "id", operator: "eq", value: "" },
                          ])
                        }
                      >
                        + {isUk ? "Фільтр" : "Filter"}
                      </button>
                    </div>

                    <div className="toolbar-actions">
                      {selectedRowIds.size > 0 && environment === "dev" && (
                        <button type="button" className="danger-button" onClick={() => void handleBulkDelete()}>
                          {isUk ? `Видалити (${selectedRowIds.size})` : `Delete (${selectedRowIds.size})`}
                        </button>
                      )}

                      <button type="button" className="button-secondary" onClick={() => void handleExport("csv")}>
                        📥 CSV
                      </button>
                      <button type="button" className="button-secondary" onClick={() => void handleExport("json")}>
                        📥 JSON
                      </button>

                      {environment === "dev" && (
                        <>
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => {
                              setImportContent("");
                              setImportModalOpen(true);
                            }}
                          >
                            📤 {isUk ? "Імпорт" : "Import"}
                          </button>
                          <button type="button" className="button-primary" onClick={openCreateRowDrawer}>
                            + {isUk ? "Додати рядок" : "New Row"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Filter builders if any */}
                  {filters.length > 0 && (
                    <div className="filter-chips-row">
                      {filters.map((f, idx) => (
                        <div key={idx} className="filter-chip">
                          <select
                            value={f.field}
                            onChange={(e) => {
                              const next = [...filters];
                              next[idx]!.field = e.target.value;
                              setFilters(next);
                            }}
                          >
                            {currentTable.columns.map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <select
                            value={f.operator}
                            onChange={(e) => {
                              const next = [...filters];
                              next[idx]!.operator = e.target.value as any;
                              setFilters(next);
                            }}
                          >
                            <option value="eq">=</option>
                            <option value="ne">≠</option>
                            <option value="gt">&gt;</option>
                            <option value="gte">&gt;=</option>
                            <option value="lt">&lt;</option>
                            <option value="lte">&lt;=</option>
                          </select>
                          <input
                            type="text"
                            placeholder="value"
                            value={f.value}
                            onChange={(e) => {
                              const next = [...filters];
                              next[idx]!.value = e.target.value;
                              setFilters(next);
                            }}
                            onKeyDown={(e) => e.key === "Enter" && void loadRows()}
                          />
                          <button
                            type="button"
                            className="remove-chip-btn"
                            onClick={() => setFilters((prev) => prev.filter((_, i) => i !== idx))}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button type="button" className="button-secondary apply-filters-btn" onClick={() => void loadRows()}>
                        {isUk ? "Застосувати фільтри" : "Apply"}
                      </button>
                    </div>
                  )}

                  {/* Rows Table */}
                  <div className="data-table-container">
                    {rowsLoading ? (
                      <div className="table-loading-spinner">{isUk ? "Завантаження рядків…" : "Loading rows…"}</div>
                    ) : rows.length === 0 ? (
                      <div className="empty-rows-hint">
                        <p>{isUk ? "Рядків у цій колекції ще немає." : "No rows found in this collection."}</p>
                      </div>
                    ) : (
                      <table className="data-studio-table data-rows-table">
                        <thead>
                          <tr>
                            {environment === "dev" && (
                              <th style={{ width: 40 }}>
                                <input
                                  type="checkbox"
                                  checked={rows.length > 0 && selectedRowIds.size === rows.length}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedRowIds(new Set(rows.map((r) => String(r.id))));
                                    } else {
                                      setSelectedRowIds(new Set());
                                    }
                                  }}
                                  aria-label="Select all rows"
                                />
                              </th>
                            )}
                            {currentTable.columns.map((col) => (
                              <th
                                key={col.name}
                                className="sortable-header"
                                onClick={() => {
                                  if (sortField === col.name) {
                                    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                                  } else {
                                    setSortField(col.name);
                                    setSortDir("asc");
                                  }
                                }}
                              >
                                {col.name}
                                {sortField === col.name && (sortDir === "asc" ? " ▲" : " ▼")}
                              </th>
                            ))}
                            <th style={{ width: 120 }}>{isUk ? "Дії" : "Actions"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, rIdx) => {
                            const rowId = String(row.id ?? rIdx);
                            const isSelected = selectedRowIds.has(rowId);
                            return (
                              <tr key={rowId} className={isSelected ? "selected-row" : ""}>
                                {environment === "dev" && (
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={(e) => {
                                        const next = new Set(selectedRowIds);
                                        if (e.target.checked) next.add(rowId);
                                        else next.delete(rowId);
                                        setSelectedRowIds(next);
                                      }}
                                    />
                                  </td>
                                )}
                                {currentTable.columns.map((col) => {
                                  const val = row[col.name];
                                  return (
                                    <td key={col.name} className="cell-content">
                                      {val === null || val === undefined ? (
                                        <span className="null-val">null</span>
                                      ) : typeof val === "boolean" ? (
                                        <span className={`bool-val ${val ? "true" : "false"}`}>{String(val)}</span>
                                      ) : typeof val === "object" ? (
                                        <code>{JSON.stringify(val)}</code>
                                      ) : (
                                        <span>{String(val)}</span>
                                      )}
                                    </td>
                                  );
                                })}
                                <td>
                                  <div className="table-row-actions">
                                    <button
                                      type="button"
                                      className="button-secondary table-action-btn"
                                      onClick={() => openEditRowDrawer(row)}
                                    >
                                      {isUk ? "Змінити" : "Edit"}
                                    </button>
                                    {environment === "dev" && (
                                      <button
                                        type="button"
                                        className="button-secondary table-action-btn danger"
                                        onClick={() => void handleDeleteRow(rowId)}
                                      >
                                        ×
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Pagination Controls */}
                  <div className="data-table-pagination">
                    <div className="page-size-selector">
                      <span>{isUk ? "Рядків на сторінці:" : "Rows per page:"}</span>
                      <select
                        value={pageLimit}
                        onChange={(e) => {
                          setPageLimit(Number(e.target.value));
                          setPageOffset(0);
                        }}
                      >
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                    </div>

                    <div className="pagination-buttons">
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={pageOffset === 0 || rowsLoading}
                        onClick={() => setPageOffset((prev) => Math.max(0, prev - pageLimit))}
                      >
                        ← {isUk ? "Попередня" : "Prev"}
                      </button>
                      <span className="page-info">
                        {isUk
                          ? `Рядки ${pageOffset + 1}–${pageOffset + rows.length}`
                          : `Rows ${pageOffset + 1}–${pageOffset + rows.length}`}
                      </span>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={rows.length < pageLimit || rowsLoading}
                        onClick={() => setPageOffset((prev) => prev + pageLimit)}
                      >
                        {isUk ? "Наступна" : "Next"} →
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* --- SCHEMA EDITOR TAB --- */
                <div className="schema-editor-content">
                  <div className="schema-section">
                    <div className="schema-section-header">
                      <h3>{isUk ? "Поля колекції" : "Fields & Columns"}</h3>
                      {environment === "dev" && !isDrift && (
                        <button
                          type="button"
                          className="button-primary"
                          onClick={() => {
                            setNewFieldName("");
                            setNewFieldType("string");
                            setNewFieldRequired(false);
                            setNewFieldDefault("");
                            setNewFieldEnumOptions("");
                            setAddFieldOpen(true);
                          }}
                        >
                          + {isUk ? "Додати поле" : "Add Field"}
                        </button>
                      )}
                    </div>

                    <table className="data-studio-table schema-table">
                      <thead>
                        <tr>
                          <th>{isUk ? "Назва" : "Name"}</th>
                          <th>{isUk ? "Тип" : "Type"}</th>
                          <th>{isUk ? "Обов'язкове" : "Required"}</th>
                          {environment === "dev" && <th>{isUk ? "Дії" : "Actions"}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {currentTable.columns.map((col) => {
                          const isPk = col.name === "id";
                          return (
                            <tr key={col.name}>
                              <td>
                                <strong>{col.name}</strong>
                                {isPk && <span className="pk-badge">PRIMARY KEY</span>}
                              </td>
                              <td><code>{col.type}</code></td>
                              <td>{col.nullable ? isUk ? "Ні" : "No" : <strong>{isUk ? "Так" : "Yes"}</strong>}</td>
                              {environment === "dev" && (
                                <td>
                                  {!isPk && !isDrift && (
                                    <button
                                      type="button"
                                      className="button-secondary table-action-btn danger"
                                      onClick={() => void handleDeleteField(col.name)}
                                    >
                                      {isUk ? "Видалити" : "Delete"}
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Relations Section */}
                  <div className="schema-section relations-section">
                    <div className="schema-section-header">
                      <h3>{isUk ? "Зв'язки між колекціями" : "Relations"}</h3>
                      {environment === "dev" && !isDrift && (
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => {
                            setRelationTarget(userCollections.find((c) => c.name !== selectedCollection)?.name || "");
                            setRelationName("");
                            setRelationCardinality("many-to-one");
                            setAddRelationOpen(true);
                          }}
                        >
                          + {isUk ? "Додати зв'язок" : "Add Relation"}
                        </button>
                      )}
                    </div>

                    {currentTable.constraints.filter((c) => c.includes("FOREIGN KEY") || c.includes("REFERENCES")).length === 0 ? (
                      <p className="muted-text">
                        {isUk ? "Прямих зовнішніх ключів для цієї таблиці немає." : "No explicit foreign key relations defined for this table."}
                      </p>
                    ) : (
                      <ul className="relations-list">
                        {currentTable.constraints
                          .filter((c) => c.includes("FOREIGN KEY") || c.includes("REFERENCES"))
                          .map((c, i) => (
                            <li key={i} className="relation-item">
                              <code>{c}</code>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* --- MODAL: Create Collection --- */}
      {createCollectionOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setCreateCollectionOpen(false)}>
          <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>{isUk ? "Створити нову колекцію" : "Create Collection"}</h2>
              <button type="button" className="company-drawer-close" onClick={() => setCreateCollectionOpen(false)}>×</button>
            </header>
            <form onSubmit={handleCreateCollection}>
              <label>
                <span>{isUk ? "Назва колекції (таблиці):" : "Collection name (table):"}</span>
                <input
                  type="text"
                  required
                  pattern="^[a-z][a-z0-9_]{0,62}$"
                  placeholder="e.g. products, categories, orders"
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  maxLength={63}
                />
                <small>{isUk ? "Лише малі літери, цифри та підкреслення (напр. products)" : "Lowercase letters, numbers, and underscores only"}</small>
              </label>

              <footer>
                <button type="button" className="button-secondary" onClick={() => setCreateCollectionOpen(false)}>
                  {isUk ? "Скасувати" : "Cancel"}
                </button>
                <button type="submit" className="button-primary">
                  {isUk ? "Переглянути зміну →" : "Preview Diff →"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* --- MODAL: Add Field --- */}
      {addFieldOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setAddFieldOpen(false)}>
          <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>{isUk ? `Додати поле до "${selectedCollection}"` : `Add Field to "${selectedCollection}"`}</h2>
              <button type="button" className="company-drawer-close" onClick={() => setAddFieldOpen(false)}>×</button>
            </header>
            <form onSubmit={handleAddField}>
              <label>
                <span>{isUk ? "Назва поля (колонки):" : "Field name:"}</span>
                <input
                  type="text"
                  required
                  pattern="^[a-z][a-z0-9_]{0,62}$"
                  placeholder="e.g. price, title, is_active"
                  value={newFieldName}
                  onChange={(e) => setNewFieldName(e.target.value)}
                  maxLength={63}
                />
              </label>

              <label>
                <span>{isUk ? "Тип поля:" : "Field type:"}</span>
                <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value as FieldType)}>
                  <option value="string">String (varchar 255)</option>
                  <option value="text">Text (multiline)</option>
                  <option value="integer">Integer (bigint)</option>
                  <option value="decimal">Decimal (numeric 20,6)</option>
                  <option value="boolean">Boolean (true/false)</option>
                  <option value="date">Date</option>
                  <option value="datetime">Datetime (timestamptz)</option>
                  <option value="json">JSON (jsonb)</option>
                  <option value="uuid">UUID</option>
                  <option value="enum">Enum (choice)</option>
                  <option value="file_reference">File Reference (uuid)</option>
                </select>
              </label>

              {newFieldType === "enum" && (
                <label>
                  <span>{isUk ? "Варіанти Enum (через кому):" : "Enum options (comma-separated):"}</span>
                  <input
                    type="text"
                    required
                    placeholder="active, draft, archived"
                    value={newFieldEnumOptions}
                    onChange={(e) => setNewFieldEnumOptions(e.target.value)}
                  />
                </label>
              )}

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={newFieldRequired}
                  onChange={(e) => setNewFieldRequired(e.target.checked)}
                />
                <span>{isUk ? "Обов'язкове поле (NOT NULL)" : "Required field (NOT NULL)"}</span>
              </label>

              <label>
                <span>{isUk ? "Значення за замовчуванням (опційно):" : "Default value (optional):"}</span>
                <input
                  type="text"
                  placeholder="e.g. 0, active, true"
                  value={newFieldDefault}
                  onChange={(e) => setNewFieldDefault(e.target.value)}
                />
              </label>

              <footer>
                <button type="button" className="button-secondary" onClick={() => setAddFieldOpen(false)}>
                  {isUk ? "Скасувати" : "Cancel"}
                </button>
                <button type="submit" className="button-primary">
                  {isUk ? "Переглянути зміну →" : "Preview Diff →"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* --- MODAL: Add Relation --- */}
      {addRelationOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setAddRelationOpen(false)}>
          <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>{isUk ? "Створити зв'язок між колекціями" : "Create Collection Relation"}</h2>
              <button type="button" className="company-drawer-close" onClick={() => setAddRelationOpen(false)}>×</button>
            </header>
            <form onSubmit={handleAddRelation}>
              <label>
                <span>{isUk ? "Тип зв'язку (кардинальність):" : "Cardinality:"}</span>
                <select
                  value={relationCardinality}
                  onChange={(e) => setRelationCardinality(e.target.value as any)}
                >
                  <option value="many-to-one">Many-to-One (N:1, e.g. products → category)</option>
                  <option value="one-to-many">One-to-Many (1:N, e.g. category → products)</option>
                  <option value="many-to-many">Many-to-Many (M:N, via join table)</option>
                </select>
              </label>

              <label>
                <span>{isUk ? "Цільова колекція:" : "Target collection:"}</span>
                <select value={relationTarget} onChange={(e) => setRelationTarget(e.target.value)} required>
                  <option value="">{isUk ? "-- Оберіть колекцію --" : "-- Select target collection --"}</option>
                  {userCollections
                    .filter((c) => c.name !== selectedCollection)
                    .map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>

              <label>
                <span>
                  {relationCardinality === "many-to-many"
                    ? isUk ? "Назва Join таблиці:" : "Join table name:"
                    : isUk ? "Назва колонки зв'язку:" : "Relation column name:"}
                </span>
                <input
                  type="text"
                  required
                  pattern="^[a-z][a-z0-9_]{0,62}$"
                  placeholder={relationCardinality === "many-to-many" ? "e.g. product_categories" : "e.g. category_id"}
                  value={relationName}
                  onChange={(e) => setRelationName(e.target.value)}
                  maxLength={63}
                />
              </label>

              <footer>
                <button type="button" className="button-secondary" onClick={() => setAddRelationOpen(false)}>
                  {isUk ? "Скасувати" : "Cancel"}
                </button>
                <button type="submit" className="button-primary">
                  {isUk ? "Переглянути зміну →" : "Preview Diff →"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* --- MODAL: Schema Diff & Dry-run Apply --- */}
      {pendingDiff && (
        <div className="company-drawer-backdrop" onMouseDown={() => setPendingDiff(null)}>
          <aside className="company-drawer modal-drawer diff-preview-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>🔍 {isUk ? "Перевірка змін схеми (Dry Run Diff)" : "Schema Diff Preview (Dry Run)"}</h2>
              <button type="button" className="company-drawer-close" onClick={() => setPendingDiff(null)}>×</button>
            </header>

            <div className="diff-preview-content">
              <div className="diff-flags-row">
                <span className={`diff-pill ${pendingDiff.reversible ? "green" : "gray"}`}>
                  {pendingDiff.reversible ? "✓ Reversible" : "✗ Irreversible"}
                </span>
                {pendingDiff.destructive && <span className="diff-pill red">⚠️ Destructive</span>}
                {pendingDiff.requiresSnapshot && <span className="diff-pill blue">📸 Requires Snapshot</span>}
              </div>

              {pendingDiff.destructive && (
                <div className="data-studio-alert warning">
                  <p>
                    <strong>{isUk ? "Увага: це деструктивна операція!" : "Caution: This operation is destructive!"}</strong>{" "}
                    {isUk
                      ? "Дані можуть бути частково або повністю втрачені. Перед застосуванням автоматично створиться snapshot бази даних."
                      : "Existing data in affected columns or tables may be permanently lost. A snapshot will be captured before executing."}
                  </p>
                  <label className="checkbox-label" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={confirmDestructive}
                      onChange={(e) => setConfirmDestructive(e.target.checked)}
                    />
                    <span>{isUk ? "Я розумію ризики і підтверджую застосування" : "I understand and confirm this destructive change"}</span>
                  </label>
                </div>
              )}

              <div className="sql-preview-box">
                <p><strong>{isUk ? "Згенерований SQL (виконується роль migrator):" : "Generated SQL (applied by migrator role):"}</strong></p>
                <pre><code>{pendingDiff.upSql}</code></pre>
              </div>

              {pendingDiff.downSql && (
                <div className="sql-preview-box">
                  <p><small>{isUk ? "SQL відкату (down):" : "Rollback SQL (down):"}</small></p>
                  <pre><code>{pendingDiff.downSql}</code></pre>
                </div>
              )}
            </div>

            <footer>
              <button type="button" className="button-secondary" onClick={() => setPendingDiff(null)}>
                {isUk ? "Скасувати" : "Cancel"}
              </button>
              <button
                type="button"
                className="button-primary apply-btn"
                disabled={applyingSchema || ((pendingDiff.destructive || pendingDiff.requiresSnapshot) && !confirmDestructive)}
                onClick={() => void applyPendingDiff()}
              >
                {applyingSchema ? (isUk ? "Застосування…" : "Applying…") : isUk ? "Застосувати зміни (Apply)" : "Apply Changes"}
              </button>
            </footer>
          </aside>
        </div>
      )}

      {/* --- DRAWER: Create / Edit Row --- */}
      {rowDrawerOpen && currentTable && (
        <div className="company-drawer-backdrop" onMouseDown={() => setRowDrawerOpen(false)}>
          <aside className="company-drawer row-edit-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>
                {editingRow
                  ? isUk ? `Редагувати рядок у "${selectedCollection}"` : `Edit Row in "${selectedCollection}"`
                  : isUk ? `Додати рядок до "${selectedCollection}"` : `Create Row in "${selectedCollection}"`}
              </h2>
              <button type="button" className="company-drawer-close" onClick={() => setRowDrawerOpen(false)}>×</button>
            </header>

            <form onSubmit={handleSaveRow}>
              {currentTable.columns.map((col) => {
                if (col.name === "id") return null;
                const val = rowFormData[col.name];
                return (
                  <label key={col.name} className="row-field-label">
                    <span>
                      {col.name} <small className="muted-text">({col.type})</small>
                      {!col.nullable && <span className="req">*</span>}
                    </span>

                    {col.type === "boolean" ? (
                      <select
                        value={val === true || val === "true" ? "true" : val === false || val === "false" ? "false" : ""}
                        onChange={(e) =>
                          setRowFormData((prev) => ({
                            ...prev,
                            [col.name]: e.target.value === "true" ? true : e.target.value === "false" ? false : null,
                          }))
                        }
                      >
                        <option value="">null</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : col.type === "text" || col.type === "jsonb" ? (
                      <textarea
                        rows={col.type === "jsonb" ? 4 : 2}
                        value={typeof val === "object" && val !== null ? JSON.stringify(val, null, 2) : String(val ?? "")}
                        onChange={(e) =>
                          setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                        }
                        placeholder={col.type === "jsonb" ? "{ ... }" : ""}
                      />
                    ) : col.type.includes("int") || col.type.includes("numeric") ? (
                      <input
                        type="number"
                        step={col.type.includes("int") ? "1" : "any"}
                        value={val == null ? "" : String(val)}
                        onChange={(e) =>
                          setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                        }
                      />
                    ) : col.type === "date" ? (
                      <input
                        type="date"
                        value={val ? String(val).slice(0, 10) : ""}
                        onChange={(e) =>
                          setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                        }
                      />
                    ) : (
                      <input
                        type="text"
                        value={val == null ? "" : String(val)}
                        onChange={(e) =>
                          setRowFormData((prev) => ({ ...prev, [col.name]: e.target.value }))
                        }
                      />
                    )}
                  </label>
                );
              })}

              <footer>
                <button type="button" className="button-secondary" onClick={() => setRowDrawerOpen(false)}>
                  {isUk ? "Скасувати" : "Cancel"}
                </button>
                <button type="submit" className="button-primary">
                  {editingRow ? (isUk ? "Зберегти зміни" : "Save Changes") : isUk ? "Створити рядок" : "Create Row"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* --- MODAL: Import Rows --- */}
      {importModalOpen && (
        <div className="company-drawer-backdrop" onMouseDown={() => setImportModalOpen(false)}>
          <aside className="company-drawer modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>📤 {isUk ? `Імпорт у "${selectedCollection}"` : `Import into "${selectedCollection}"`}</h2>
              <button type="button" className="company-drawer-close" onClick={() => setImportModalOpen(false)}>×</button>
            </header>

            <form onSubmit={handleImportSubmit}>
              <div className="import-format-toggle">
                <label>
                  <span>{isUk ? "Формат даних:" : "Data format:"}</span>
                  <select value={importFormat} onChange={(e) => setImportFormat(e.target.value as any)}>
                    <option value="csv">CSV (Comma-separated)</option>
                    <option value="json">JSON Array</option>
                  </select>
                </label>

                <label>
                  <span>{isUk ? "Завантажити файл (< 1 МБ):" : "Upload file (< 1 MB):"}</span>
                  <input type="file" accept=".csv,.json" onChange={handleFileUpload} />
                </label>
              </div>

              <label>
                <span>{isUk ? "Або вставте вміст:" : "Or paste content directly:"}</span>
                <textarea
                  rows={8}
                  placeholder={importFormat === "csv" ? "title,price,is_active\nProduct A,100,true" : '[{"title": "Product A", "price": 100}]'}
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                  required
                />
              </label>

              <footer>
                <button type="button" className="button-secondary" onClick={() => setImportModalOpen(false)}>
                  {isUk ? "Скасувати" : "Cancel"}
                </button>
                <button type="submit" className="button-primary" disabled={importing || !importContent.trim()}>
                  {importing ? (isUk ? "Імпортування…" : "Importing…") : isUk ? "Імпортувати" : "Import Rows"}
                </button>
              </footer>
            </form>
          </aside>
        </div>
      )}

      {/* --- MODAL: Drift Inspection --- */}
      {showDriftModal && overview?.drift && (
        <div className="company-drawer-backdrop" onMouseDown={() => setShowDriftModal(false)}>
          <aside className="company-drawer modal-drawer drift-modal-drawer" onMouseDown={(e) => e.stopPropagation()}>
            <header>
              <h2>⚠️ {isUk ? "Деталі розбіжності схеми (Schema Drift)" : "Schema Drift Inspection"}</h2>
              <button type="button" className="company-drawer-close" onClick={() => setShowDriftModal(false)}>×</button>
            </header>

            <div className="drift-modal-content">
              <p>
                {isUk
                  ? "Схема реальної бази даних не збігається з очікуваною історією міграцій. Авто-застосування заблоковано."
                  : "The live database schema fingerprint differs from expected migrations. Schema migrations are paused."}
              </p>

              <div className="drift-fingerprints">
                <div>
                  <small>{isUk ? "Очікуваний Fingerprint (Core):" : "Expected Fingerprint (Core):"}</small>
                  <code>{overview.drift.expected || "none"}</code>
                </div>
                <div>
                  <small>{isUk ? "Фактичний Fingerprint (Live DB):" : "Actual Fingerprint (Live DB):"}</small>
                  <code>{overview.drift.actual || "none"}</code>
                </div>
              </div>

              <div className="drift-tables-diff">
                <h4>{isUk ? "Розбіжності по таблицях:" : "Tables Diff:"}</h4>
                {overview.drift.tables.added.length > 0 && (
                  <div className="diff-item added">
                    <strong>+ Added outside migrations:</strong> {overview.drift.tables.added.join(", ")}
                  </div>
                )}
                {overview.drift.tables.removed.length > 0 && (
                  <div className="diff-item removed">
                    <strong>- Removed outside migrations:</strong> {overview.drift.tables.removed.join(", ")}
                  </div>
                )}
                {overview.drift.tables.changed.length > 0 && (
                  <div className="diff-item changed">
                    <strong>~ Changed outside migrations:</strong> {overview.drift.tables.changed.join(", ")}
                  </div>
                )}
                {overview.drift.tables.added.length === 0 &&
                  overview.drift.tables.removed.length === 0 &&
                  overview.drift.tables.changed.length === 0 && (
                    <p className="muted-text">{isUk ? "Зміни стосуються внутрішніх обмежень, типів або індексів." : "Differences are in internal constraints, types, or indexes."}</p>
                  )}
              </div>
            </div>

            <footer>
              <button type="button" className="button-secondary" onClick={() => setShowDriftModal(false)}>
                {isUk ? "Закрити" : "Close"}
              </button>
            </footer>
          </aside>
        </div>
      )}
    </div>
  );
}
