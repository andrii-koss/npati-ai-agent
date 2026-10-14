import React, { useState, useCallback, useEffect } from "react";
import { confirmModal } from "../ConfirmDialog";
import { apiFetch } from "./api";
import type { FilterItem, OverviewData } from "./types";

export interface UseDataStudioRowsOptions {
  basePath: string;
  selectedCollection: string;
  currentTable: { columns: { name: string; type: string }[] } | null | undefined;
  overview: OverviewData | null;
  activeTab: string;
  isUk: boolean;
  notify: (message: string, type?: "success" | "info" | "error") => void;
}

export function useDataStudioRows({
  basePath,
  selectedCollection,
  currentTable,
  overview,
  activeTab,
  isUk,
  notify,
}: UseDataStudioRowsOptions) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<FilterItem[]>([]);
  const [sortField, setSortField] = useState<string>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [pageLimit, setPageLimit] = useState<number>(25);
  const [pageOffset, setPageOffset] = useState<number>(0);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  const [rowDrawerOpen, setRowDrawerOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
  const [rowFormData, setRowFormData] = useState<Record<string, unknown>>({});

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importFormat, setImportFormat] = useState<"csv" | "json">("csv");
  const [importContent, setImportContent] = useState("");
  const [importing, setImporting] = useState(false);

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
  }, [selectedCollection, overview, activeTab, basePath, pageLimit, pageOffset, sortField, sortDir, searchQuery, filters, notify]);

  useEffect(() => {
    if (activeTab === "data") {
      void loadRows();
    }
  }, [loadRows, activeTab]);

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

  return {
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
    setEditingRow,
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
  };
}
