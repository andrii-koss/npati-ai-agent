// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboundWebhooksSection } from "./InboundWebhooksSection";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./types", () => ({ api }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  api.mockReset().mockResolvedValue({ webhooks: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<InboundWebhooksSection companies={[
    { id: "bakery", name: "Sunrise Bakery" }, { id: "studio", name: "Design Studio" },
  ]} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("searches companies with the shared menu and keeps a concrete webhook target", async () => {
  await act(async () => host.querySelector<HTMLButtonElement>(".company-scope-trigger")!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("2 companies");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("All companies");
  const search = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "design");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(host.querySelector(".company-scope-trigger")?.textContent).toBe("Design Studio");
  expect(api).toHaveBeenLastCalledWith("/companies/studio/webhooks");
});

it("submits the labeled name and multiline instruction to the selected company", async () => {
  const form = host.querySelector("form")!;
  expect(form.querySelector("button")!.disabled).toBe(true);
  await act(async () => {
    const name = form.querySelector("input")!;
    const prompt = form.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, " Orders ");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Read order\nNotify the team");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(form.querySelector("button")!.disabled).toBe(false);
  api.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST"
    ? { webhook: { id: "hook", secret: "test-secret" } } : { webhooks: [] });
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(api).toHaveBeenCalledWith("/companies/bakery/webhooks", {
    method: "POST", body: JSON.stringify({ name: "Orders", promptTemplate: "Read order\nNotify the team" }),
  });
});
