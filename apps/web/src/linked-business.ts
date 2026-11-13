import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import type { WorkspaceOverview } from "./business-workspace-shared";
type Business = WorkspaceOverview["businesses"][number];

/**
 * A chat card opens Goals or Memory with ?business=<id> (V6 step 11: a goal created for one company opened the page of
 * another, empty). The linked Business is shown at once, becomes the current Business like a pick in the page's own
 * selector, and the parameter is then dropped so that selector keeps working.
 */
export function useLinkedBusiness(overview: WorkspaceOverview | null | undefined, switchBusiness: (id: string) => Promise<void>): Business | undefined {
  const [params, setParams] = useSearchParams();
  const linkedId = params.get("business");
  const linked = linkedId ? overview?.businesses.find(item => item.id === linkedId) : undefined;
  useEffect(() => {
    if (!linkedId || !overview) return;
    const drop = () => setParams(current => { const next = new URLSearchParams(current); next.delete("business"); return next; }, { replace: true });
    if (!linked || overview.currentBusiness?.id === linked.id) { drop(); return; }
    void switchBusiness(linked.id).then(drop, drop);
  }, [linkedId, linked?.id, overview?.currentBusiness?.id]);
  return linked ?? overview?.currentBusiness ?? overview?.businesses?.[0];
}
