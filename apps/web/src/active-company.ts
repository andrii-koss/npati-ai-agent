export const ACTIVE_COMPANY_ID_KEY = "npati_selected_company_id_v1";

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
    if (value) {
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
    detail: { companyId: value || null },
  }));
}

export function chooseAvailableCompanyId(
  companies: Array<{ id: string }>,
  options: { requested?: string | null; fallback?: string } = {},
): string {
  const requested = options.requested?.trim();
  if (requested && companies.some((company) => company.id === requested)) return requested;
  const stored = readActiveCompanyId();
  if (stored && companies.some((company) => company.id === stored)) return stored;
  return options.fallback ?? companies[0]?.id ?? "";
}
