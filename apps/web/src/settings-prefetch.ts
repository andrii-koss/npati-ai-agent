import { getStoredAuthToken } from "./AuthContext";
import { apiFetch, listProjectCompanies } from "./website-builder-cache";
import { writeCachedCompanies } from "./active-company";
import { loadCompanyScopes } from "./company-scope";
import { readSettingsSnapshot, requestSettingsRead, writeSettingsSnapshot } from "./settings-page-cache";
import type { WorkspaceOverview } from "./business-workspace-shared";
import { inboxThreadsKey, readInboxThreads, type InboxFilters } from "./inbox-cache";

type Row = Record<string, unknown>;
const warming = new Map<string, number>();
let identity: string | null | undefined;
function merge(key: string, rows: Row[]) {
  const previous = readSettingsSnapshot<Row[]>(key) ?? [];
  const ids = new Set(rows.map(row => row.id));
  writeSettingsSnapshot(key, [...rows, ...previous.filter(row => !ids.has(row.id))]);
}
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
    "/settings/activity": () => import("./ActivityPage"),
    "/settings/email/inbox": () => import("./EmailInboxPage"),
  };
  const module = modules[path!]; if (!module) return;
  warming.set(warmKey, Date.now()); void module().catch(() => undefined);
  void (async () => {
    if (["/settings/business", "/settings/memory"].includes(path!)) {
      const overview = readSettingsSnapshot<WorkspaceOverview>("business:overview") ?? await requestSettingsRead("business:overview", () => apiFetch<WorkspaceOverview>("/workspace/context"));
      if (path === "/settings/business") return;
      const kind = "memory";
      if (readSettingsSnapshot(`${kind}:all`)) return;
      await loadCompanyScopes(overview.businesses.slice(0, 4).map(business => business.id), async id => ({ id, records: (await apiFetch<Row[]>(`/businesses/${id}/${kind}`)).map(item => ({ ...item, businessId: id })) }),
        { key: kind, isActive: () => getStoredAuthToken() === token, onProgress: pages => merge(`${kind}:all`, pages.flatMap(page => page.records)) });
      return;
    }
    if (path === "/settings/goals") return;
    const companies = await listProjectCompanies();
    if (getStoredAuthToken() !== token) return;
    writeCachedCompanies(companies);
    const ids = companies.slice(0, 4).map(company => company.id);
    if (path === "/settings/email/inbox") {
      const filters: InboxFilters = { companyId: requestedCompany, folder: "inbox", accountId: "all", status: "all", priority: "all", search: "" };
      const key = inboxThreadsKey(filters);
      if (readSettingsSnapshot(key)) return;
      await readInboxThreads(requestedCompany === "all" ? ids : [requestedCompany], filters, {
        isActive: () => getStoredAuthToken() === token, onProgress: threads => merge(key, threads as unknown as Row[]),
      });
    } else if (path === "/settings/code") {
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
    } else if (path === "/settings/automations") {
      if (readSettingsSnapshot("automations:all")) return;
      await loadCompanyScopes(ids, async id => ({ automations: (await apiFetch<{ automations: Row[] }>(`/companies/${id}/automations`)).automations.map(item => ({ ...item, companyId: id })) }),
        { key: "automations", isActive: () => getStoredAuthToken() === token, onProgress: pages => merge("automations:all", pages.flatMap(page => page.automations)) });
    } else if (path === "/settings/email") {
      if (readSettingsSnapshot("email-accounts:all")) return;
      await loadCompanyScopes(ids, async id => (await apiFetch<{ accounts: Row[] }>(`/companies/${id}/email-accounts`)).accounts.map(item => ({ ...item, companyId: id })),
        { key: "email:email-accounts", isActive: () => getStoredAuthToken() === token, onProgress: pages => merge("email-accounts:all", pages.flat()) });
    } else if (path === "/settings/activity") {
      if (readSettingsSnapshot("activity:all")) return;
      await loadCompanyScopes(ids, async id => {
        const [normal, code] = await Promise.all([apiFetch<{ runs: Row[] }>(`/companies/${id}/runs?limit=50`), apiFetch<{ runs: Row[]; nextCursor: string | null }>(`/companies/${id}/code/monitor/runs`)]);
        return { id, items: [...code.runs, ...normal.runs].map(item => ({ ...item, companyId: id })), cursor: code.nextCursor };
      }, { key: "activity:", isActive: () => getStoredAuthToken() === token, onProgress: pages => merge("activity:all", pages.flatMap(page => page.items)) });
    }
  })().catch(() => undefined);
}
