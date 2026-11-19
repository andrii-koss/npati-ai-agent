import { getStoredAuthToken } from "./AuthContext";
import { apiFetch, listProjectCompanies } from "./website-builder-cache";
import { writeCachedCompanies } from "./active-company";
import { loadCompanyScopes } from "./company-scope";
import { readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import type { WorkspaceOverview } from "./business-workspace-shared";

type Row = Record<string, unknown>;
const warming = new Map<string, number>();
let identity: string | null | undefined;
export function prefetchSettingsPage(href: string) {
  const path = href.split("?")[0];
  const token = getStoredAuthToken();
  if (!token) return;
  if (identity !== token) { warming.clear(); identity = token; }
  const requestedCompany = new URLSearchParams(href.split("?")[1] ?? "").get("company") || "all";
  const warmKey = `${path}:${requestedCompany}`;
  if (warming.has(warmKey) && Date.now() - warming.get(warmKey)! < 10_000) return;
  const modules: Record<string, () => Promise<unknown>> = {
    "/settings/email": () => import("./EmailSettingsPage"), "/settings/code": () => import("./CodeAgentsPage"),
    "/settings/business": () => import("./business-workspace-page-views"), "/settings/goals": () => import("./GoalsPage"),
    "/settings/memory": () => import("./MemoryPage"), "/settings/automations": () => import("./AutomationsPage"),
    "/settings/content": () => import("./ContentPage"),
    "/settings/activity": () => import("./ActivityPage"),
    "/settings/email/inbox": () => import("./EmailInboxPage"),
  };
  const module = modules[path!]; if (!module) return;
  warming.set(warmKey, Date.now()); void module().catch(() => undefined);
  void (async () => {
    if (path === "/settings/business") {
      if (!readSettingsSnapshot<WorkspaceOverview>("business:overview")) {
        await requestSettingsRead("business:overview", () => apiFetch<WorkspaceOverview>("/workspace/context"));
      }
      return;
    }
    if (path !== "/settings/code") return;
    const companies = await listProjectCompanies();
    if (getStoredAuthToken() !== token) return;
    writeCachedCompanies(companies);
    const ids = companies.slice(0, 4).map(company => company.id);
    if (path === "/settings/code") {
      if (readSettingsSnapshot("code:all")) return;
      await loadCompanyScopes(ids, async id => {
        const [projects, sessions] = await Promise.all([apiFetch<{ projects: Row[] }>(`/companies/${id}/code/projects?includeArchived=true`), apiFetch<{ sessions: Row[] }>(`/companies/${id}/code/sessions`)]);
        const owner = (item: Row) => ({ ...item, companyId: id, companyName: companies.find(company => company.id === id)?.name });
        return { projects: projects.projects.map(owner), sessions: sessions.sessions.map(owner), limits: null };
      }, { key: "code", isActive: () => getStoredAuthToken() === token, onProgress: pages => {
        const previous = readSettingsSnapshot<{ projects: Row[]; sessions: Row[] }>("code:all");
        const combine = (rows: Row[], old: Row[] = []) => [...rows, ...old.filter(item => !rows.some(row => row.id === item.id))];
        writeSettingsSnapshot("code:all", { projects: combine(pages.flatMap(page => page.projects), previous?.projects), sessions: combine(pages.flatMap(page => page.sessions), previous?.sessions) });
      } });
    }
  })().catch(() => undefined);
}
