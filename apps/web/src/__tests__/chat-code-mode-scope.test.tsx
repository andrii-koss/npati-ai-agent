// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
import { I18nProvider } from "../i18n";
import { BusinessChatPage } from "../BusinessWorkspace";
let root: Root | undefined;

it("preserves explicit Code mode without a project and shows the project requirement", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  mocks.api.mockImplementation(async (url: string) => url.includes("/plan") ? { targets: [] }
    : url.includes("/processes") ? { processes: [] } : url === "/conversations" ? [] : {});
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/chat/stream") {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { code: "CODE_PROJECT_REQUIRED", message: "Choose a code project first." } }), { status: 409 });
    }
    return new Response(JSON.stringify({}));
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={["/chat"]}><I18nProvider><BusinessChatPage neutralChat /></I18nProvider></MemoryRouter>));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Code"]')!.click());
  expect(host.querySelector('a[href="/settings/code?agent=npati"]')).not.toBeNull();
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Create e2e-smoke/hello.txt containing Hello");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ mode: "code", contextType: "none" });
  expect(requests[0]?.projectId).toBeUndefined();
  expect(host.textContent).toContain("Choose a code project first.");
  expect(textarea.value).toBe("Create e2e-smoke/hello.txt containing Hello");
  sessionStorage.clear();
});
afterEach(async () => { if(root) await act(async () => root!.unmount()); document.body.innerHTML="";vi.unstubAllGlobals();vi.restoreAllMocks(); });
