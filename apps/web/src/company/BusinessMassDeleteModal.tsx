import { useState, useMemo, useEffect } from "react";
import { Trash2, Search, X, Building2, Loader2 } from "lucide-react";
import { api } from "./cache";
import { confirmModal } from "../ConfirmDialog";
import { useTranslation } from "../i18n";

export interface BusinessItem {
  id: string;
  name: string;
  industry?: string;
  activationStatus?: string;
  description?: string;
}

export interface BusinessMassDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  businesses?: BusinessItem[];
  onBusinessesDeleted: (deletedIds: string[]) => Promise<void>;
}

export function BusinessMassDeleteModal({
  isOpen,
  onClose,
  businesses = [],
  onBusinessesDeleted,
}: BusinessMassDeleteModalProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setSelectedIds(new Set());
      setDeleting(false);
      setProgress({ current: 0, total: 0 });
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, deleting, onClose]);

  const filteredBusinesses = useMemo(() => {
    if (!search.trim()) return businesses;
    const q = search.toLowerCase().trim();
    return businesses.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.industry && b.industry.toLowerCase().includes(q)) ||
        (b.description && b.description.toLowerCase().includes(q))
    );
  }, [businesses, search]);

  const allFilteredSelected =
    filteredBusinesses.length > 0 &&
    filteredBusinesses.every((b) => selectedIds.has(b.id));

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const b of filteredBusinesses) next.delete(b.id);
      } else {
        for (const b of filteredBusinesses) next.add(b.id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(businesses.map((b) => b.id)));
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
      title: t("companySettings.massDelete.confirmTitleSelectedBusiness"),
      message: t("companySettings.massDelete.confirmMessageSelectedBusiness", { count }),
      confirmText: t("companySettings.massDelete.confirmBtn", { count }),
      cancelText: t("companySettings.massDelete.cancel"),
      isDanger: true,
    });
    if (!confirmed) return;

    setDeleting(true);
    setProgress({ current: 0, total: count });

    const concurrency = 8;
    const queue = [...idsToDelete];
    let completed = 0;
    const successfullyDeleted: string[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        try {
          await api(`/businesses/${id}`, { method: "DELETE" });
          successfullyDeleted.push(id);
        } catch (e) {
          console.warn(`Failed to delete business idea ${id}:`, e);
        }
        completed++;
        setProgress({ current: completed, total: count });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, count) }, () => worker());
    await Promise.all(workers);

    await onBusinessesDeleted(successfullyDeleted);
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
                {t("companySettings.massDelete.deletingBusinessProgress", {
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
              placeholder={t("companySettings.massDelete.searchBusinessPlaceholder")}
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
              disabled={deleting || businesses.length === 0 || selectedIds.size === businesses.length}
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
              disabled={deleting || filteredBusinesses.length === 0}
              className="company-mass-checkbox"
            />
            <span>
              {t("companySettings.massDelete.selectAllFiltered", {
                count: filteredBusinesses.length,
              })}
            </span>
          </label>
          <span className="company-mass-count-badge">
            {t("companySettings.massDelete.selectedCount", {
              selected: selectedIds.size,
              total: businesses.length,
            })}
          </span>
        </div>

        {/* Scrollable list */}
        <div className="company-mass-list">
          {filteredBusinesses.length === 0 ? (
            <div className="company-mass-empty">
              <Building2 size={32} opacity={0.3} />
              <p>
                {businesses.length === 0
                  ? t("companySettings.massDelete.noBusinessIdeas")
                  : t("companySettings.massDelete.noBusinessResults")}
              </p>
            </div>
          ) : (
            filteredBusinesses.map((b) => {
              const isSelected = selectedIds.has(b.id);
              return (
                <div
                  key={b.id}
                  className={`company-mass-item ${isSelected ? "selected" : ""}`}
                  onClick={() => toggleItem(b.id)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleItem(b.id)}
                    onClick={(e) => e.stopPropagation()}
                    disabled={deleting}
                    className="company-mass-checkbox"
                    aria-label={`Select ${b.name}`}
                  />
                  <div className="company-mass-item-avatar">
                    {b.name.charAt(0).toUpperCase() || "B"}
                  </div>
                  <div className="company-mass-item-info">
                    <span className="company-mass-item-name" title={b.name}>
                      {b.name}
                    </span>
                    <span className="company-mass-item-desc">
                      {b.industry || b.description || "Business Idea"}
                    </span>
                  </div>
                  <span className={`company-mass-status-pill ${b.activationStatus || "active"}`}>
                    {b.activationStatus || "active"}
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

