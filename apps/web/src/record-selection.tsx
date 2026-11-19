import { useEffect, useRef, useState } from "react";
import { BULK_DELETE_LIMIT, deleteBulkRecords, type BulkRecord, type BulkResource } from "./bulk-records-api";
import { confirmModal } from "./ConfirmDialog";
import { useTranslation } from "./i18n";
import { BusinessSelectionBar } from "./business-selection-bar";
import "./record-selection.css";

type Selection = { key: string; records: ReadonlyMap<string, BulkRecord> };
const emptyRecords = new Map<string, BulkRecord>();

export function useRecordSelection({ resource, scopeKey, ready, loadAll, reload }: {
  resource: BulkResource;
  scopeKey: string;
  ready: boolean;
  loadAll: () => Promise<{ records: BulkRecord[] }>;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<Selection>();
  const selected = selection?.key === scopeKey ? selection.records : emptyRecords;
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ key: string; text: string }>();
  const operation = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    setSelection(undefined);
    setMessage(undefined);
    return () => { generation.current++; };
  }, [scopeKey]);

  const toggle = (record: BulkRecord) => {
    if (operation.current || !ready) return;
    setSelection(previous => {
      const records = new Map(previous?.key === scopeKey ? previous.records : undefined);
      if (records.has(record.id)) records.delete(record.id);
      else records.set(record.id, record);
      return { key: scopeKey, records };
    });
    setMessage(undefined);
  };

  const selectAll = async () => {
    if (operation.current || !ready) return;
    const scope = generation.current;
    operation.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const { records } = await loadAll();
      if (scope === generation.current) setSelection({ key: scopeKey, records: new Map(records.map(record => [record.id, record])) });
    } catch (error) {
      if (scope === generation.current) setMessage({ key: scopeKey, text: error instanceof Error ? error.message : t("common.error") });
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (operation.current || !ready || !selected.size) return;
    const scope = generation.current;
    const records = [...selected.values()];
    operation.current = true;
    setBusy(true);
    try {
      const confirmed = await confirmModal({
        title: t("common.deleteConfirmation"),
        message: t("common.recordSelection.confirmMessage", { count: records.length }),
        confirmText: t("common.delete"),
        cancelText: t("common.cancel"),
        isDanger: true,
      });
      if (!confirmed || scope !== generation.current) return;
      setDeleting(true);
      setMessage(undefined);
      let deleted = 0;
      const failed = new Map<string, BulkRecord>();
      for (let offset = 0; offset < records.length; offset += BULK_DELETE_LIMIT) {
        try {
          const outcome = await deleteBulkRecords(resource, records.slice(offset, offset + BULK_DELETE_LIMIT));
          deleted += outcome.deleted;
          for (const record of outcome.failed) failed.set(record.id, record);
        } catch {
          for (const record of records.slice(offset)) failed.set(record.id, record);
          break;
        }
      }
      await reload();
      if (scope === generation.current) {
        setSelection({ key: scopeKey, records: failed });
        const result = t("common.recordSelection.deleted", { count: deleted });
        const failure = t("common.recordSelection.deleteFailed", { count: failed.size });
        setMessage({ key: scopeKey, text: failed.size ? `${result}. ${failure}` : result });
      }
    } finally {
      operation.current = false;
      setBusy(false);
      setDeleting(false);
    }
  };

  return {
    selected,
    busy,
    deleting,
    ready,
    message: message?.key === scopeKey ? message.text : undefined,
    toggle,
    selectAll,
    remove,
    clear: () => { setSelection(undefined); setMessage(undefined); },
  };
}

export type RecordSelectionControls = ReturnType<typeof useRecordSelection>;

export function RecordSelectionToolbar({ selection, matchingTotal }: { selection: RecordSelectionControls; matchingTotal?: number }) {
  const { t } = useTranslation();
  const { selected, ready, busy, deleting, message } = selection;
  if (matchingTotal === undefined && !message) return null;
  const total = matchingTotal ?? 0;
  const allSelected = total > 0 && selected.size === total;
  return (
    <>
      <BusinessSelectionBar
        checked={allSelected}
        disabled={busy || !ready}
        deleting={deleting}
        selectedCount={selected.size}
        selectAllLabel={t("common.recordSelection.selectAll", { count: total })}
        deleteLabel={deleting ? t("common.recordSelection.deleting") : t("common.recordSelection.deleteSelected", { count: selected.size })}
        clearLabel={t("common.recordSelection.deselectAll")}
        onToggleAll={allSelected ? selection.clear : selection.selectAll}
        onDelete={selection.remove}
        onClear={selection.clear}
      />
      {message && <p className="biz-selection-count" role="status">{message}</p>}
    </>
  );
}

export function RecordCheckbox({ selection, record, name }: {
  selection: RecordSelectionControls;
  record: BulkRecord;
  name: string;
}) {
  const { t } = useTranslation();
  return (
    <input
      type="checkbox"
      className="biz-checkbox"
      aria-label={t("common.recordSelection.selectRecord", { name })}
      checked={selection.selected.has(record.id)}
      disabled={selection.busy || !selection.ready}
      onChange={() => selection.toggle(record)}
    />
  );
}
