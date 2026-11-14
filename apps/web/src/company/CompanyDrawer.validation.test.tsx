// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CompanyDrawer } from "./CompanyDrawer";
import { I18nProvider } from "../i18n";
import { requiredFieldMessage } from "../required-field-i18n";
import type { CompanyDraft } from "./types";

it.each(["uk", "pl", "ja", "ar"] as const)("validates in selected %s locale and allows correcting the value", async language => {
  localStorage.setItem("npati_language", language);
  const save = vi.fn((event: React.FormEvent) => event.preventDefault());
  function Fixture() {
    const [draft, setDraft] = useState({ name: "" } as CompanyDraft);
    return <I18nProvider><CompanyDrawer isOpen onClose={() => {}} editingCompany={null} companyForm={draft} setCompanyForm={setDraft} saveCompany={save} deleteCompany={async () => {}} saving={false} /></I18nProvider>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Fixture />));
    const form = host.querySelector("form")!;
    const input = host.querySelector<HTMLInputElement>("input[required]")!;
    await act(async () => form.requestSubmit());
    expect(input.validationMessage).toBe(requiredFieldMessage[language]);
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "V6TEST corrected");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.validationMessage).toBe("");
    await act(async () => form.requestSubmit());
    expect(save).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.removeItem("npati_language");
  }
});
