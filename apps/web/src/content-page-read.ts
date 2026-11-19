import { getDeletedIds, getEditsMap, parseChatContentTask, type ContentItem } from "./content-page-types";
import { readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import { api } from "./workspace-api";

type ContentRun = {
  id: string;
  companyId: string;
  companyName: string;
  task: string;
  result: string;
  createdAt: string;
  override?: Pick<Partial<ContentItem>, "title" | "type" | "content">;
};

const contentSnapshotKey = "content:items";

export function getCachedContentItems() {
  return readSettingsSnapshot<ContentItem[]>(contentSnapshotKey) ?? [];
}

export function updateCachedContentItems(items: ContentItem[]) {
  writeSettingsSnapshot(contentSnapshotKey, items);
}

export function readContentItems() {
  return requestSettingsRead("content:open", async () => {
    const { runs } = await api<{ runs: ContentRun[] }>("/content/open");
    const deletedIds = new Set(getDeletedIds());
    const editsMap = getEditsMap();
    return runs.filter(run => !deletedIds.has(run.id)).map(run => {
      const original = parseChatContentTask(run.task);
      let type: ContentItem["type"] = original.type ?? "article";
      const task = original.task.toLowerCase();
      if (["seo", "keyword", "structure"].some(word => task.includes(word))) type = "seo_structure";
      else if (["social", "post", "tweet", "linkedin"].some(word => task.includes(word))) type = "social_post";
      else if (["brief", "plan", "strategy", "roadmap"].some(word => task.includes(word))) type = "brief";
      const edit = { ...editsMap[run.id], ...run.override };
      return {
        id: run.id,
        title: edit.title || original.title || (original.task.length > 70 ? `${original.task.slice(0, 70)}…` : original.task),
        type: edit.type || type,
        content: edit.content ?? run.result,
        sourceRunId: run.id,
        companyId: run.companyId,
        companyName: run.companyName,
        createdAt: run.createdAt,
      };
    });
  }, false);
}
