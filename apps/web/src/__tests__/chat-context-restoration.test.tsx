// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), userId: "owner" }));
vi.mock("../AuthContext", () => ({ getStoredAuthToken: () => "fixture", useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock("../chat-open", () => ({ isChatPage: () => true, chatOpenData: mocks.open }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, language: "en" }) }));
vi.mock("../BusinessWorkspace", async () => {
  const React = await import("react");
  const context = React.createContext<React.ReactNode>(null);
  return { ChatContextSwitcherContext: context, useWorkspace: () => ({ overview: {} }),
    BusinessChatPage: ({ companyId, neutralChat }: { companyId?: string; neutralChat?: boolean }) => <section data-company={companyId} data-neutral={neutralChat}>{React.useContext(context)}</section>,
    FloatingNotice: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  };
});
import { ConversationalChat } from "../ConversationalChat";
import { ACTIVE_COMPANY_ID_KEY } from "../active-company";
let host: HTMLDivElement, root: Root;
let finish: (data: { company: { id: string; name: string } | null }) => void;
let fail: (error: Error) => void;
const key = "npati_chat_context:owner";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); sessionStorage.clear(); mocks.userId = "owner";
  mocks.open.mockReset().mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  localStorage.setItem(ACTIVE_COMPANY_ID_KEY, "bakery");
  localStorage.setItem(key, "company:bakery");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MemoryRouter><ConversationalChat /></MemoryRouter>));
const trigger = () => host.querySelector(".composer-context-trigger")!;
const select = () => host.querySelector<HTMLSelectElement>("select")!;
const saveName = () => localStorage.setItem(`${key}:company`, JSON.stringify({ id: "bakery", name: "Bakery" }));

it("shows the saved company name and scope before the delayed open response", async () => {
  saveName(); await render();
  expect(trigger().textContent).toBe("Bakery");
  expect(select().value).toBe("company:bakery");
  expect(host.querySelector("section")?.dataset.company).toBe("bakery");
  expect(host.querySelector("section")?.dataset.neutral).toBe("false");
  await act(async () => finish({ company: { id: "bakery", name: "Bakery" } }));
  expect(trigger().textContent).toBe("Bakery");
  expect(mocks.open).toHaveBeenCalledTimes(1);
});
it("keeps the company selected while an uncached name loads instead of showing No company", async () => {
  await render();
  expect(select().value).toBe("company:bakery");
  expect(select().getAttribute("aria-busy")).toBe("true");
  expect(trigger().textContent).not.toContain("chat.noCompany");
  await act(async () => finish({ company: { id: "bakery", name: "Bakery" } }));
  expect(trigger().textContent).toBe("Bakery");
  expect(JSON.parse(localStorage.getItem(`${key}:company`)!)).toEqual({ id: "bakery", name: "Bakery" });
});
it("does not restore a pending company after the user chooses No company", async () => {
  saveName(); await render();
  await act(async () => { select().value = "none"; select().dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => finish({ company: { id: "bakery", name: "Bakery" } }));
  expect(select().value).toBe("none");
  expect(trigger().textContent).toBe("chat.noCompany"); // the label is translated; this test renders without a language provider
  expect(localStorage.getItem(`${key}:company`)).toBeNull();
});
it("keeps the saved selection on a temporary open failure", async () => {
  saveName(); await render(); await act(async () => fail(new Error("Temporarily unavailable")));
  expect(trigger().textContent).toBe("Bakery");
  expect(select().value).toBe("company:bakery");
});
it("clears a selection when the server confirms the company is unavailable", async () => {
  saveName(); await render(); await act(async () => finish({ company: null }));
  expect(select().value).toBe("none");
  expect(localStorage.getItem(ACTIVE_COMPANY_ID_KEY)).toBeNull();
  expect(localStorage.getItem(`${key}:company`)).toBeNull();
});
it("does not display another user's saved company name", async () => {
  saveName(); mocks.userId = "other"; await render();
  expect(trigger().textContent).not.toContain("Bakery");
  expect(select().getAttribute("aria-busy")).toBe("true");
});
