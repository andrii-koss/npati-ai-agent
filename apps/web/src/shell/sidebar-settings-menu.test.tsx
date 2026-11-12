// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { Sidebar } from "./Sidebar";
import { authFetch } from "./auth-helpers";
import { confirmModal, alertModal } from "../ConfirmDialog";

const { loadAll, removeDeleted } = vi.hoisted(() => ({ loadAll: vi.fn(), removeDeleted: vi.fn() }));
vi.mock("./auth-helpers", () => ({ authFetch: vi.fn() }));
vi.mock("../ConfirmDialog", () => ({ confirmModal: vi.fn(), alertModal: vi.fn() }));
vi.mock("../chat-activity", () => ({ useChatActivity: () => ({}), conversationActivity: () => undefined, stopConversationActivity: vi.fn() }));
vi.mock("../LanguageSwitcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("./use-sidebar-state", async () => {
  const { useState } = await import("react");
  const chat = { id: "first", title: "First chat", businessId: null, businessName: "", updatedAt: "2026-11-12" };
  return { useSidebarState: () => {
    const [menuTarget, setMenuTarget] = useState(null);
    return { location: { pathname: "/chat" }, t: (key: string) => key,
      chatOpen: true, setChatOpen: vi.fn(), openNewChat: vi.fn(), hasSavedChats: true, hasLoaded: true,
      pinnedChats: [], unpinnedChats: [chat], loadMoreConversations: vi.fn(), loadAllConversations: loadAll,
      menuTarget, setMenuTarget, toast: null, togglePinChat: vi.fn(), togglePinBusiness: vi.fn(),
      archiveChat: vi.fn(), archiveBusiness: vi.fn(), shareLink: vi.fn(), renameBusinessItem: vi.fn(),
      openConversation: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn(), removeDeletedConversations: removeDeleted, deleteBusiness: vi.fn() };
  } };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  loadAll.mockResolvedValue([{ id: "first", title: "First chat" }, { id: "second", title: "Second chat" }]);
  vi.mocked(confirmModal).mockResolvedValue(false);
  vi.mocked(alertModal).mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.resetAllMocks(); });

async function selectAll(path = "/chat") {
  await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={[path]}><Sidebar /></MemoryRouter></I18nProvider>));
  await act(async () => host.querySelector<HTMLButtonElement>(".sidebar-settings-row button")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] button')!.click());
}

it("asks once for confirmation with the selected count and sends no delete when cancelled", async () => {
  await selectAll();
  await act(async () => host.querySelector<HTMLButtonElement>(".sidebar-bulk-actions .danger")!.click());
  expect(confirmModal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: expect.stringContaining("2"), isDanger: true }));
  expect(authFetch).not.toHaveBeenCalled();
  expect(removeDeleted).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
});

it("deletes the confirmed selection and leaves selection mode on success", async () => {
  vi.mocked(confirmModal).mockResolvedValue(true);
  vi.mocked(authFetch).mockResolvedValue(new Response(null, { status: 204 }));
  await selectAll();
  await act(async () => host.querySelector<HTMLButtonElement>(".sidebar-bulk-actions .danger")!.click());
  expect(authFetch).toHaveBeenCalledTimes(2);
  expect(removeDeleted).toHaveBeenCalledExactlyOnceWith(["first", "second"]);
  expect(host.querySelector(".sidebar-bulk-actions")).toBeNull();
});

it("keeps failed chats selected for retry after partial deletion", async () => {
  vi.mocked(confirmModal).mockResolvedValue(true);
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  await selectAll();
  await act(async () => host.querySelector<HTMLButtonElement>(".sidebar-bulk-actions .danger")!.click());
  expect(removeDeleted).toHaveBeenCalledExactlyOnceWith(["first"]);
  expect(host.querySelector(".sidebar-bulk-actions")?.textContent).toContain("1");
  expect(alertModal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringMatching(/1.*2/), isDanger: true }));
});

it("deletes the currently open chat last to preserve retry state if an earlier deletion fails", async () => {
  vi.mocked(confirmModal).mockResolvedValue(true);
  vi.mocked(authFetch).mockResolvedValue(new Response(null, { status: 500 }));
  await selectAll("/c/first");
  await act(async () => host.querySelector<HTMLButtonElement>(".sidebar-bulk-actions .danger")!.click());
  expect(authFetch).toHaveBeenCalledExactlyOnceWith("/api/conversations/second", { method: "DELETE" });
  expect(removeDeleted).not.toHaveBeenCalled();
  expect(host.querySelector(".sidebar-bulk-actions")?.textContent).toContain("2");
});

it("opens the Settings menu without following the link and selects every chat returned by the full loader", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(<I18nProvider><MemoryRouter><Sidebar onClose={onClose} /></MemoryRouter></I18nProvider>));
  const trigger = host.querySelector<HTMLButtonElement>(".sidebar-settings-row button")!;
  expect(trigger.querySelector("svg")).not.toBeNull();
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onClose).not.toHaveBeenCalled();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.classList.contains("sidebar-action-menu")).toBe(true);
  expect(menu.querySelectorAll("button")).toHaveLength(3);
  await act(async () => menu.querySelector<HTMLButtonElement>("button")!.click());
  expect(loadAll).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(true);
  expect(host.querySelector(".sidebar-bulk-actions")?.textContent).toContain("2");
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(host.querySelector(".sidebar-bulk-actions")?.textContent).toContain("1");
});
