// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ControlStrip } from "./ControlStrip";
import { SELECTED_COMPANY_ID_KEY } from "./cache";
import type { Company } from "./types";

vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en", t: (key: string) => key }) }));

it("uses searchable company and business menus without All companies and preserves independent business selection", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const companies: Company[] = [
    { id: "alpha", name: "Alpha", languages: [], status: "active", revision: 1, businessId: "bakery" },
    { id: "beta", name: "Beta", languages: [], status: "active", revision: 1 },
  ];
  const selectCompany = vi.fn(), linkBusiness = vi.fn();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  try {
    await act(async () => root.render(<ControlStrip companies={companies} selected={companies[0]!} selectedId="alpha"
      onSelectCompanyId={selectCompany} agents={[]} businesses={[{ id: "bakery", name: "Bakery" }, { id: "studio", name: "Studio" }]} onUpdateBusiness={linkBusiness} />));
    const triggers = host.querySelectorAll<HTMLButtonElement>(".company-strip-select");
    await act(async () => triggers[0]!.click());
    expect(options().map(option => option.textContent)).toEqual(["Alpha", "Beta"]);
    expect(document.querySelector('input[aria-label="Search companies"]')).not.toBeNull();
    await act(async () => options().find(option => option.textContent === "Beta")!.click());
    expect(selectCompany).toHaveBeenCalledWith("beta");
    expect(sessionStorage.getItem(SELECTED_COMPANY_ID_KEY)).toBe("beta");
    expect(localStorage.getItem(SELECTED_COMPANY_ID_KEY)).toBe("beta");
    await act(async () => triggers[1]!.click());
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Select business");
    expect(document.querySelector('input[aria-label="Search businesses"]')).not.toBeNull();
    expect(options().map(option => option.textContent)).toEqual(["companySettings.strip.independent", "Bakery", "Studio"]);
    await act(async () => options()[0]!.click());
    expect(linkBusiness).toHaveBeenCalledWith("");
  } finally {
    await act(async () => root.unmount()); host.remove();
    sessionStorage.removeItem(SELECTED_COMPANY_ID_KEY); localStorage.removeItem(SELECTED_COMPANY_ID_KEY);
  }
});
