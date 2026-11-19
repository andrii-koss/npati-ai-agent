import { Trash2 } from "lucide-react";

export function BusinessSelectionBar({ checked, disabled, deleting, selectedCount, selectAllLabel, selectedLabel, deleteLabel, clearLabel,
  onToggleAll, onDelete, onClear }: {
  checked: boolean;
  disabled?: boolean;
  deleting?: boolean;
  selectedCount: number;
  selectAllLabel: string;
  selectedLabel?: string;
  deleteLabel: string;
  clearLabel: string;
  onToggleAll: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onClear: () => void;
}) {
  return (
    <div className="biz-selection-bar">
      <label className="biz-select-all-label">
        <input type="checkbox" checked={checked} onChange={onToggleAll} disabled={disabled} className="biz-checkbox" />
        <span>{selectAllLabel}</span>
      </label>
      {selectedCount > 0 && (
        <div className="biz-selection-actions">
          {selectedLabel && <span className="biz-selection-count" role="status">{selectedLabel}</span>}
          <button type="button" className="biz-batch-delete-btn" disabled={deleting || disabled} onClick={onDelete}>
            <Trash2 size={13} aria-hidden="true" />
            <span>{deleteLabel}</span>
          </button>
          <button type="button" className="biz-batch-clear-btn" disabled={deleting || disabled} onClick={onClear}>{clearLabel}</button>
        </div>
      )}
    </div>
  );
}
