// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ChatProjectPreviewCard, desktopCardView } from "../ChatProjectPreviewCard";

// V6 step 08: a Pygame game card first said "Live Preview · Stopped" while Open got a 409 (D08-02). Since the owner's decision
// its Live Preview is the game window streamed from the Sandbox: the card names it a desktop window and Open starts it.
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("names a desktop game's Preview a desktop window, in both languages", () => {
  expect(desktopCardView("Pygame", true)).toMatchObject({ mode: "Десктоп-вікно" });
  expect(desktopCardView("Pygame", false)).toMatchObject({ mode: "Desktop window" });
  for (const framework of ["HTML/CSS", "React + Vite", "Expo", undefined]) expect(desktopCardView(framework, false)).toBeNull();
});

it("Open starts the streamed game window as a Live Preview", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/status") ? { isRunning: false } : { status: "running", previewUrl: "/api/x/preview/proxy/?token=t" })));
  vi.stubGlobal("fetch", fetchMock);
  const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={["/c/chat"]}><Routes><Route path="*" element={<>
    <ChatProjectPreviewCard card={{ id: "p1", projectId: "p1", companyId: "c1", name: "V6TEST_S8_Catcher", status: "stopped", framework: "Pygame", kind: "code_project", projectKind: "game" }} />
    <Where />
  </>} /></Routes></MemoryRouter>); });
  const card = host.querySelector('[data-testid="chat-project-preview-card"]')!;
  expect(card.textContent).toContain("Desktop window · Live Preview");
  const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open the game window"]')!;
  expect(open.disabled).toBe(false);
  await act(async () => { open.click(); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(fetchMock.mock.calls.some(call => String((call as unknown[])[0]).endsWith("/projects/p1/preview/start"))).toBe(true);
  expect(host.querySelector('[data-testid="where"]')!.textContent).toBe("/c/chat");
});

// The side panel starts the Preview; the card used to keep its first status ("Stopped") until a reload.
it("follows a Preview started from the card until it runs", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let started = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/status") ? { isRunning: started, status: started ? "previewing" : "ready" } : {}))));
  const opened: unknown[] = [];
  const { ChatPreviewPanelContext } = await import("../ChatPreviewPanel");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter><ChatPreviewPanelContext.Provider value={{ open: card => { opened.push(card); }, warm() {}, leave() {} }}>
    <ChatProjectPreviewCard card={{ id: "p2", projectId: "p2", companyId: "c1", name: "V6TEST_S8_Catcher", status: "ready", framework: "Pygame", kind: "code_project", projectKind: "game" }} />
  </ChatPreviewPanelContext.Provider></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 50)); });
  const card = host.querySelector('[data-testid="chat-project-preview-card"]')!;
  expect(card.textContent).toContain("Stopped");
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Open the game window"]')!.click(); });
  expect(opened).toHaveLength(1);
  expect(card.textContent).toContain("Starting");
  started = true;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
  expect(card.textContent).toContain("Running");
});
