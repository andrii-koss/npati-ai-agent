import { getStoredAuthToken } from "./AuthContext";

export interface WebsiteProject {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  type: "website" | "web_app" | "landing_page" | "mobile_app" | "code_project";
  kind?: "website" | "web_app" | "game" | "mobile_app" | "api";
  status: string;
  framework?: string;
  repositoryBranch?: string;
  sandboxId?: string;
  previewUrl?: string;
  previewPort?: number;
  lastBuildStatus?: string;
  deploymentStatus?: string;
  deploymentUrl?: string;
  lastDeployedAt?: string;
  revision: number;
  createdAt?: string;
  updatedAt: string;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getStoredAuthToken();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch("/api" + path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string }; message?: string }) | null;
  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || `Request failed with status ${res.status}`);
  }
  return json as T;
}

export const WEBSITES_CACHE_PREFIX = "npati_websites_cache_v1_";
export const WEBSITES_LATEST_CACHE_KEY = "npati_websites_cache_latest_v1";

/** Projects remain company-scoped; fetch every company page so the selector does not hide older projects. */
export async function listProjectCompanies(): Promise<Array<{ id: string; name: string }>> {
  const companies = new Map<string, { id: string; name: string }>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await apiFetch<{ companies: Array<{ id: string; name: string }>; pagination?: { nextCursor?: string | null } }>(
      `/companies?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const company of page.companies ?? []) companies.set(company.id, company);
    cursor = page.pagination?.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Company pagination did not advance");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...companies.values()];
}

export async function listCompanyProjects(companyIds: string[]): Promise<WebsiteProject[]> {
  const projects: WebsiteProject[] = [];
  // Bound parallel reads when the catalogue covers many companies.
  for (let offset = 0; offset < companyIds.length; offset += 4) {
    const pages = await Promise.all(companyIds.slice(offset, offset + 4).map(async companyId => {
      const page = await apiFetch<{ projects: WebsiteProject[] }>(`/companies/${encodeURIComponent(companyId)}/projects?includeArchived=true`);
      return { companyId, projects: page.projects ?? [] };
    }));
    for (const page of pages) {
      updateCachedWebsites(page.companyId, page.projects);
      projects.push(...page.projects);
    }
  }
  return projects;
}

export function getCachedWebsites(companyId?: string): WebsiteProject[] | null {
  try {
    if (companyId) {
      const raw = sessionStorage.getItem(WEBSITES_CACHE_PREFIX + companyId)
        || localStorage.getItem(WEBSITES_CACHE_PREFIX + companyId);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
      return null;
    }
    const latest = sessionStorage.getItem(WEBSITES_LATEST_CACHE_KEY)
      || localStorage.getItem(WEBSITES_LATEST_CACHE_KEY);
    if (latest) {
      const parsed = JSON.parse(latest);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return null;
}

export function updateCachedWebsites(companyId: string, items: WebsiteProject[]) {
  try {
    const serialized = JSON.stringify(items);
    if (companyId) {
      sessionStorage.setItem(WEBSITES_CACHE_PREFIX + companyId, serialized);
      localStorage.setItem(WEBSITES_CACHE_PREFIX + companyId, serialized);
    }
    sessionStorage.setItem(WEBSITES_LATEST_CACHE_KEY, serialized);
    localStorage.setItem(WEBSITES_LATEST_CACHE_KEY, serialized);
  } catch {}
}
