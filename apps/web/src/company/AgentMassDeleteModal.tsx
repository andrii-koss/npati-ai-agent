import { useState, useMemo, useEffect } from "react";
import { Trash2, Search, X, Bot, Loader2 } from "lucide-react";
import { api } from "./cache";
import { confirmModal } from "../ConfirmDialog";
import { useTranslation } from "../i18n";
import type { Agent, AgentPage } from "./types";

export interface AgentMassDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  companyId: string;
  agents?: Agent[];
  onAgentsDeleted: (deletedIds: string[]) => Promise<void>;
}

export function AgentMassDeleteModal({
  isOpen,
  onClose,
  companyId,
  agents = [],
  onAgentsDeleted,
}: AgentMassDeleteModalProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [allAgents, setAllAgents] = useState<Agent[]>(agents);
  const [loadingAgents, setLoadingAgents] = useState(false);

  // Sync initial agents and fetch any remaining pages
  useEffect(() => {
    if (!isOpen || !companyId) return;

    setSearch("");
    setSelectedIds(new Set());
    setDeleting(false);
    setProgress({ current: 0, total: 0 });
    setAllAgents(agents);

    let cancelled = false;
    (async () => {
      try {
        setLoadingAgents(true);
        let accumulated: Agent[] = [...agents];
        let cursor: string | null = null;
        let page = await api<AgentPage>(`/companies/${companyId}/agents?limit=100`);
        accumulated = [...new Map([...accumulated, ...page.agents].map((a) => [a.id, a])).values()];
        cursor = page.pagination.nextCursor;

        while (cursor && !cancelled) {
          page = await api<AgentPage>(
            `/companies/${companyId}/agents?limit=100&cursor=${encodeURIComponent(cursor)}`
          );
          accumulated = [...new Map([...accumulated, ...page.agents].map((a) => [a.id, a])).values()];
          cursor = page.pagination.nextCursor;
        }

        if (!cancelled) {
          setAllAgents(accumulated);
        }
      } catch (err) {
        console.warn("Failed to fetch complete agents list:", err);
      } finally {
        if (!cancelled) setLoadingAgents(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, companyId]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, deleting, onClose]);

  const filteredAgents = useMemo(() => {
    if (!search.trim()) return allAgents;
    const q = search.toLowerCase().trim();
    return allAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.role && a.role.toLowerCase().includes(q)) ||
        (a.description && a.description.toLowerCase().includes(q))
    );
  }, [allAgents, search]);

  const allFilteredSelected =
    filteredAgents.length > 0 &&
    filteredAgents.every((a) => selectedIds.has(a.id));

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const a of filteredAgents) next.delete(a.id);
      } else {
        for (const a of filteredAgents) next.add(a.id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(allAgents.map((a) => a.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const toggleItem = (id: string) => {
    if (deleting) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const executeDelete = async (idsToDelete: string[]) => {
    if (idsToDelete.length === 0 || deleting) return;
    const count = idsToDelete.length;
    const confirmed = await confirmModal({
      title: t("companySettings.massDelete.confirmTitleSelectedAgent"),
      message: t("companySettings.massDelete.confirmMessageSelectedAgent", { count }),
      confirmText: t("companySettings.massDelete.confirmBtn", { count }),
      cancelText: t("companySettings.massDelete.cancel"),
      isDanger: true,
    });
    if (!confirmed) return;

    setDeleting(true);
    setProgress({ current: 0, total: count });

    const agentMap = new Map(allAgents.map((a) => [a.id, a]));
    const concurrency = 8;
    const queue = [...idsToDelete];
    let completed = 0;
    const successfullyDeleted: string[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        const agent = agentMap.get(id);
        const revisionParam = agent ? `?expectedRevision=${agent.revision}` : "";
        try {
          await api(`/companies/${companyId}/agents/${id}${revisionParam}`, { method: "DELETE" });
          successfullyDeleted.push(id);
        } catch (e) {
          console.warn(`Failed to delete agent ${id}:`, e);
        }
        completed++;
        setProgress({ current: completed, total: count });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, count) }, () => worker());
    await Promise.all(workers);

    await onAgentsDeleted(successfullyDeleted);
    setDeleting(false);
    onClose();
  };

  if (!isOpen) return null;

  const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="company-mass-modal-overlay" onClick={() => !deleting && onClose()}>
      <div className="company-mass-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Progress Bar when deleting */}
        {deleting && (
          <div className="company-mass-progress-section">
            <div className="company-mass-progress-bar-bg">
              <div className="company-mass-progress-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="company-mass-progress-status">
              <Loader2 size={14} className="company-mass-spinner" />
              <span>
                {t("companySettings.massDelete.deletingAgentProgress", {
                  current: progress.current,
                  total: progress.total,
                  percent,
                })}
              </span>
            </div>
          </div>
        )}

        {/* Toolbar with Search, Select All, and Close Button on the same row */}
        <div className="company-mass-toolbar">
          <div className="company-mass-search-wrap">
            <Search size={15} className="company-mass-search-icon" />
            <input
              type="text"
              placeholder={t("companySettings.massDelete.searchAgentPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={deleting}
              className="company-mass-search-input"
            />
            {search && (
              <button
                type="button"
                className="company-mass-search-clear"
                onClick={() => setSearch("")}
                disabled={deleting}
              >
                ×
              </button>
            )}
          </div>

          <div className="company-mass-quick-actions">
            <button
              type="button"
              className="company-mass-quick-btn"
              onClick={selectAll}
              disabled={deleting || allAgents.length === 0 || selectedIds.size === allAgents.length}
            >
              {t("companySettings.massDelete.selectAll")}
            </button>
            {selectedIds.size > 0 && (
              <button
                type="button"
                className="company-mass-quick-btn clear"
                onClick={deselectAll}
                disabled={deleting}
              >
                {t("companySettings.massDelete.deselectAll")}
              </button>
            )}
          </div>

          <button
            type="button"
            className="company-mass-modal-close"
            onClick={onClose}
            disabled={deleting}
            title={t("companySettings.massDelete.close")}
            aria-label={t("companySettings.massDelete.close")}
          >
            <X size={18} />
          </button>
        </div>

        {/* Sub-toolbar: Select all filtered */}
        <div className="company-mass-list-header">
          <label className="company-mass-select-all-label">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAllFiltered}
              disabled={deleting || filteredAgents.length === 0}
              className="company-mass-checkbox"
            />
            <span>
              {t("companySettings.massDelete.selectAllFiltered", {
                count: filteredAgents.length,
              })}
            </span>
          </label>
          <span className="company-mass-count-badge">
            {t("companySettings.massDelete.selectedCount", {
              selected: selectedIds.size,
              total: allAgents.length,
            })}
          </span>
        </div>

        {/* Scrollable list */}
        <div className="company-mass-list">
          {filteredAgents.length === 0 ? (
            <div className="company-mass-empty">
              <Bot size={32} opacity={0.3} />
              <p>
                {allAgents.length === 0
                  ? t("companySettings.massDelete.noAgents")
                  : t("companySettings.massDelete.noAgentResults")}
              </p>
            </div>
          ) : (
            filteredAgents.map((a) => {
              const isSelected = selectedIds.has(a.id);
              return (
                <div
                  key={a.id}
                  className={`company-mass-item ${isSelected ? "selected" : ""}`}
                  onClick={() => toggleItem(a.id)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleItem(a.id)}
                    onClick={(e) => e.stopPropagation()}
                    disabled={deleting}
                    className="company-mass-checkbox"
                    aria-label={`Select ${a.name}`}
                  />
                  <div className="company-mass-item-avatar">
                    {a.name.charAt(0).toUpperCase() || "A"}
                  </div>
                  <div className="company-mass-item-info">
                    <span className="company-mass-item-name" title={a.name}>
                      {a.name}
                    </span>
                    <span className="company-mass-item-desc">
                      {a.role || a.description || "Agent"}
                    </span>
                  </div>
                  <span
                    className={`company-mass-status-pill ${a.isActive ? "active" : "inactive"}`}
                  >
                    {a.isActive
                      ? t("companySettings.status.active")
                      : t("companySettings.status.inactive")}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Actions */}
        <div className="company-mass-footer">
          <button
            type="button"
            className="company-mass-btn-cancel"
            onClick={onClose}
            disabled={deleting}
          >
            {t("companySettings.massDelete.cancel")}
          </button>

          <div className="company-mass-footer-actions">
            <button
              type="button"
              className="company-mass-btn-danger"
              disabled={deleting || selectedIds.size === 0}
              onClick={() => executeDelete(Array.from(selectedIds))}
            >
              <Trash2 size={15} />
              <span>
                {t("companySettings.massDelete.deleteSelected", { count: selectedIds.size })}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

