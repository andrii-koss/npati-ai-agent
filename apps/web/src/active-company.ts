export const ACTIVE_COMPANY_ID_KEY = "npati_selected_company_id_v1";
export const CACHED_COMPANIES_KEY = "npati_cached_companies_v1";

export function readActiveCompanyId(): string {
  try {
    return sessionStorage.getItem(ACTIVE_COMPANY_ID_KEY)
      || localStorage.getItem(ACTIVE_COMPANY_ID_KEY)
      || "";
  } catch {
    return "";
  }
}

export function writeActiveCompanyId(companyId: string): void {
  const value = companyId.trim();
  try {
    if (value && value !== "personal") {
      sessionStorage.setItem(ACTIVE_COMPANY_ID_KEY, value);
      localStorage.setItem(ACTIVE_COMPANY_ID_KEY, value);
    } else {
      sessionStorage.removeItem(ACTIVE_COMPANY_ID_KEY);
      localStorage.removeItem(ACTIVE_COMPANY_ID_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  window.dispatchEvent(new CustomEvent("npati:active-company-changed", {
    detail: { companyId: value && value !== "personal" ? value : null },
  }));
}

export function readCachedCompanies<T = { id: string; name: string }>(): T[] {
  try {
    const raw = sessionStorage.getItem(CACHED_COMPANIES_KEY)
      || localStorage.getItem(CACHED_COMPANIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeCachedCompanies<T = { id: string; name: string }>(companies: T[]): void {
  try {
    if (companies && Array.isArray(companies) && companies.length > 0) {
      const serialized = JSON.stringify(companies);
      sessionStorage.setItem(CACHED_COMPANIES_KEY, serialized);
      localStorage.setItem(CACHED_COMPANIES_KEY, serialized);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function chooseAvailableCompanyId(
  companies: Array<{ id: string }>,
  options: { requested?: string | null; fallback?: string } = {},
): string {
  const requested = options.requested?.trim();
  if (requested === "personal") return "personal";
  if (requested && companies.some((company) => company.id === requested)) return requested;
  const stored = readActiveCompanyId();
  if (stored && stored !== "personal") {
    if (companies.length === 0 || companies.some((company) => company.id === stored)) {
      return stored;
    }
  }
  if (requested && !stored) return requested;
  return options.fallback ?? companies[0]?.id ?? "";
}

export function getInitialCompanyScope(requested?: string | null): string {
  const req = requested?.trim();
  if (req === "personal") return "personal";
  const cached = readCachedCompanies<{ id: string }>();
  if (req && (cached.length === 0 || cached.some((c) => c.id === req))) return req;
  const stored = readActiveCompanyId();
  if (stored && stored !== "personal") {
    if (cached.length === 0 || cached.some((c) => c.id === stored)) {
      return stored;
    }
  }
  return req || "personal";
}
