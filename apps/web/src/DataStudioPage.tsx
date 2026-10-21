import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { getStoredAuthToken } from "./AuthContext";
import { confirmModal, promptModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import type { Project } from "./ProjectSection";
import { DataStudioAuthSection } from "./DataStudioAuthSection";
import { DataStudioApiSection } from "./DataStudioApiSection";
import { DataStudioBackupsSection } from "./DataStudioBackupsSection";
import { DataStudioOperationsSection } from "./DataStudioOperationsSection";

export * from "./data-studio/types";
import type {
  FieldType,
  FieldDefinition,
  SchemaOperation,
  OverviewData,
  PreviewDiff,
  FilterItem,
  RelationCardinality,
} from "./data-studio/types";
import { CreateCollectionModal } from "./data-studio/CreateCollectionModal";
import { AddFieldModal } from "./data-studio/AddFieldModal";
import { AddRelationModal } from "./data-studio/AddRelationModal";
import { SchemaDiffModal } from "./data-studio/SchemaDiffModal";
import { RowDrawer } from "./data-studio/RowDrawer";
import { ImportRowsModal } from "./data-studio/ImportRowsModal";
import { DriftModal } from "./data-studio/DriftModal";
import { DataStudioHeader } from "./data-studio/DataStudioHeader";
import { DataStudioEmptyBackend } from "./data-studio/DataStudioEmptyBackend";
import { CollectionsSidebar } from "./data-studio/CollectionsSidebar";
import { DataStudioRowsView } from "./data-studio/DataStudioRowsView";
import { DataStudioSchemaView } from "./data-studio/DataStudioSchemaView";
import { MigrationsPane } from "./data-studio/MigrationsPane";
import { apiFetch } from "./data-studio/api";
import { useDataStudioRows } from "./data-studio/useDataStudioRows";

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
  const [activeTab, setActiveTab] = useState<"data" | "schema" | "migrations" | "auth" | "api" | "backups" | "operations">("data");

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
  const [relationCardinality, setRelationCardinality] = useState<RelationCardinality>("many-to-one");

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
  const notify = useCallback((message: string, type: "success" | "info" | "error" = "success") => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 5000);
  }, []);

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

  const {
    rows,
    rowsLoading,
    searchQuery,
    setSearchQuery,
    filters,
    setFilters,
    sortField,
    setSortField,
    sortDir,
    setSortDir,
    pageLimit,
    setPageLimit,
    pageOffset,
    setPageOffset,
    selectedRowIds,
    setSelectedRowIds,
    rowDrawerOpen,
    setRowDrawerOpen,
    editingRow,
    rowFormData,
    setRowFormData,
    importModalOpen,
    setImportModalOpen,
    importFormat,
    setImportFormat,
    importContent,
    setImportContent,
    importing,
    loadRows,
    openCreateRowDrawer,
    openEditRowDrawer,
    handleSaveRow,
    handleDeleteRow,
    handleBulkDelete,
    handleExport,
    handleImportSubmit,
    handleFileUpload,
  } = useDataStudioRows({
    basePath,
    selectedCollection,
    currentTable,
    overview,
    activeTab,
    isUk,
    notify,
  });

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

  // --- Render Empty Project without DataBackend ---
  if (!loading && (!overview || !project?.dataBackendId)) {
    return (
      <DataStudioEmptyBackend
        project={project}
        backends={backends}
        isUk={isUk}
        error={error}
        selectedBackendToAttach={selectedBackendToAttach}
        setSelectedBackendToAttach={setSelectedBackendToAttach}
        attachingBackend={attachingBackend}
        handleAttachBackend={handleAttachBackend}
        newBackendName={newBackendName}
        setNewBackendName={setNewBackendName}
        handleCreateAndAttachBackend={handleCreateAndAttachBackend}
      />
    );
  }

  // --- Main Data Studio UI ---
  const syncStatus = overview?.environment.syncStatus || "synced";
  const isDrift = syncStatus === "drift_detected" || syncStatus === "reconciliation_required";

  return (
    <main className="automations-container data-studio-container">
      <DataStudioHeader
        project={project}
        overview={overview}
        environment={environment}
        setEnvironment={setEnvironment}
        isUk={isUk}
        companyId={companyId}
        projectId={projectId}
        feedback={feedback}
        setShowDriftModal={setShowDriftModal}
      />

      {/* Main Studio Body: Sidebar + Main Panel */}
      <div className="data-studio-body">
        <CollectionsSidebar
          isUk={isUk}
          environment={environment}
          isDrift={isDrift}
          userCollections={userCollections}
          selectedCollection={selectedCollection}
          setSelectedCollection={setSelectedCollection}
          setPageOffset={setPageOffset}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          migrationsCount={overview?.migrations.length || 0}
          onOpenCreateCollection={() => {
            setNewCollectionName("");
            setCreateCollectionOpen(true);
          }}
        />

        {/* Right Content Area */}
        <main className="data-studio-main">
          {activeTab === "api" ? (
            <DataStudioApiSection companyId={companyId} projectId={projectId} environment={environment} isUk={isUk} />
          ) : activeTab === "auth" ? (
            <DataStudioAuthSection
              companyId={companyId}
              projectId={projectId}
              environment={environment}
              collections={userCollections.map((c) => c.name)}
              isUk={isUk}
              notify={notify}
            />
          ) : activeTab === "migrations" ? (
            <MigrationsPane
              isUk={isUk}
              environment={environment}
              migrations={overview?.migrations ?? []}
              onRevertMigration={handleRevertMigration}
            />
          ) : activeTab === "backups" ? (
            overview?.backend?.id ? (
              <DataStudioBackupsSection
                companyId={companyId}
                backendId={overview.backend.id}
                environment={environment}
                isUk={isUk}
                notify={notify}
              />
            ) : (
              <div className="data-studio-pane">
                <div className="data-studio-empty-card">
                  <h2>{isUk ? "Data не підключено" : "No Data attached"}</h2>
                  <p>{isUk ? "Прикріпіть DataBackend до проєкту, щоб працювати з бекапами." : "Attach a DataBackend to this project to manage backups."}</p>
                </div>
              </div>
            )
          ) : activeTab === "operations" ? (
            overview?.backend?.id ? (
              <DataStudioOperationsSection
                companyId={companyId}
                backendId={overview.backend.id}
                environment={environment}
                isUk={isUk}
                notify={notify}
                syncStatus={overview.environment.syncStatus}
              />
            ) : (
              <div className="data-studio-pane">
                <div className="data-studio-empty-card">
                  <h2>{isUk ? "Data не підключено" : "No Data attached"}</h2>
                  <p>{isUk ? "Прикріпіть DataBackend до проєкту, щоб керувати promote та квотами." : "Attach a DataBackend to this project to manage promotions and quotas."}</p>
                </div>
              </div>
            )
          ) : !currentTable ? (
            <div className="empty-collection-state">
              <p>{isUk ? "Оберіть колекцію ліворуч або створіть нову." : "Select a collection from the sidebar or create a new one."}</p>
            </div>
          ) : (
            <div className="collection-view-pane">
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
                    style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" />
                      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
                    </svg>
                    <span>{isUk ? "Дані (Рядки)" : "Data View"}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "schema"}
                    className={`col-tab-btn ${activeTab === "schema" ? "active" : ""}`}
                    onClick={() => setActiveTab("schema")}
                    style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    <span>{isUk ? "Схема & Поля" : "Schema Editor"}</span>
                    <span className="col-tab-count" style={{ fontSize: "11px", background: "#f1f5f9", padding: "1px 6px", borderRadius: "10px", color: "#64748b" }}>
                      {currentTable.columns.length}
                    </span>
                  </button>
                </div>
              </div>

              {activeTab === "data" ? (
                <DataStudioRowsView
                  isUk={isUk}
                  environment={environment}
                  currentTable={currentTable}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  loadRows={loadRows}
                  filters={filters}
                  setFilters={setFilters}
                  selectedRowIds={selectedRowIds}
                  setSelectedRowIds={setSelectedRowIds}
                  handleBulkDelete={handleBulkDelete}
                  handleExport={handleExport}
                  openCreateRowDrawer={openCreateRowDrawer}
                  openEditRowDrawer={openEditRowDrawer}
                  handleDeleteRow={handleDeleteRow}
                  onOpenImportModal={() => {
                    setImportContent("");
                    setImportModalOpen(true);
                  }}
                  rowsLoading={rowsLoading}
                  rows={rows}
                  sortField={sortField}
                  setSortField={setSortField}
                  sortDir={sortDir}
                  setSortDir={setSortDir}
                  pageLimit={pageLimit}
                  setPageLimit={setPageLimit}
                  pageOffset={pageOffset}
                  setPageOffset={setPageOffset}
                />
              ) : (
                <DataStudioSchemaView
                  isUk={isUk}
                  environment={environment}
                  isDrift={isDrift}
                  currentTable={currentTable}
                  onOpenAddField={() => {
                    setNewFieldName("");
                    setNewFieldType("string");
                    setNewFieldRequired(false);
                    setNewFieldDefault("");
                    setNewFieldEnumOptions("");
                    setAddFieldOpen(true);
                  }}
                  onOpenAddRelation={() => {
                    setRelationTarget(userCollections.find((c) => c.name !== selectedCollection)?.name || "");
                    setRelationName("");
                    setRelationCardinality("many-to-one");
                    setAddRelationOpen(true);
                  }}
                  handleDeleteField={handleDeleteField}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <CreateCollectionModal
        isOpen={createCollectionOpen}
        onClose={() => setCreateCollectionOpen(false)}
        onSubmit={handleCreateCollection}
        isUk={isUk}
        newCollectionName={newCollectionName}
        setNewCollectionName={setNewCollectionName}
      />

      <AddFieldModal
        isOpen={addFieldOpen}
        onClose={() => setAddFieldOpen(false)}
        onSubmit={handleAddField}
        isUk={isUk}
        selectedCollection={selectedCollection}
        newFieldName={newFieldName}
        setNewFieldName={setNewFieldName}
        newFieldType={newFieldType}
        setNewFieldType={setNewFieldType}
        newFieldRequired={newFieldRequired}
        setNewFieldRequired={setNewFieldRequired}
        newFieldDefault={newFieldDefault}
        setNewFieldDefault={setNewFieldDefault}
        newFieldEnumOptions={newFieldEnumOptions}
        setNewFieldEnumOptions={setNewFieldEnumOptions}
      />

      <AddRelationModal
        isOpen={addRelationOpen}
        onClose={() => setAddRelationOpen(false)}
        onSubmit={handleAddRelation}
        isUk={isUk}
        relationCardinality={relationCardinality}
        setRelationCardinality={setRelationCardinality}
        relationTarget={relationTarget}
        setRelationTarget={setRelationTarget}
        relationName={relationName}
        setRelationName={setRelationName}
        userCollections={userCollections}
        selectedCollection={selectedCollection}
      />

      <SchemaDiffModal
        pendingDiff={pendingDiff}
        onClose={() => setPendingDiff(null)}
        isUk={isUk}
        confirmDestructive={confirmDestructive}
        setConfirmDestructive={setConfirmDestructive}
        applyingSchema={applyingSchema}
        onApply={applyPendingDiff}
      />

      <RowDrawer
        isOpen={rowDrawerOpen}
        onClose={() => setRowDrawerOpen(false)}
        onSubmit={handleSaveRow}
        isUk={isUk}
        currentTable={currentTable}
        selectedCollection={selectedCollection}
        editingRow={editingRow}
        rowFormData={rowFormData}
        setRowFormData={setRowFormData}
      />

      <ImportRowsModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSubmit={handleImportSubmit}
        isUk={isUk}
        selectedCollection={selectedCollection}
        importFormat={importFormat}
        setImportFormat={setImportFormat}
        handleFileUpload={handleFileUpload}
        importContent={importContent}
        setImportContent={setImportContent}
        importing={importing}
      />

      <DriftModal
        isOpen={showDriftModal}
        onClose={() => setShowDriftModal(false)}
        isUk={isUk}
        drift={overview?.drift}
      />
    </main>
  );
}
