import { api } from "./workspace-api";
import { removeSettingsSnapshot } from "./settings-page-cache";

export type BulkRecord = { id: string; ownerId: string };
export type BulkResource = "goals" | "memory" | "automations" | "activity";
export const BULK_DELETE_LIMIT = 1000;

export function readBulkRecords(resource: BulkResource, params: URLSearchParams) {
  params.set("select", "1");
  return api<{ records: BulkRecord[] }>(`/${resource}/page?${params}`);
}

export async function deleteBulkRecords(resource: BulkResource, records: BulkRecord[]) {
  const outcome = await api<{ deleted: number; failed: BulkRecord[] }>(`/${resource}/bulk-delete`, {
    method: "POST",
    body: JSON.stringify({ records }),
  });
  if (outcome.failed.length < records.length) {
    removeSettingsSnapshot(`${resource}:page:all`);
    for (const ownerId of new Set(records.map(record => record.ownerId))) removeSettingsSnapshot(`${resource}:page:${ownerId}`);
  }
  return outcome;
}
