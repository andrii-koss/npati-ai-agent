// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ChatProjectPreviewCard, desktopCardView } from "../ChatProjectPreviewCard";

// V6 step 08 (D08-02): a Pygame game card said "Game · Live Preview · Stopped"; Open asked the server for a Preview, which it
// refuses for a desktop game (409), and nothing visible happened. The card now says what it is and opens the files.
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("describes a desktop game without a Preview, in both languages", () => {
  expect(desktopCardView("Pygame", true)).toMatchObject({ mode: "Десктоп", status: expect.stringContaining("Без Preview") });
  expect(desktopCardView("Pygame", false)).toMatchObject({ mode: "Desktop", status: expect.stringContaining("No Preview") });
  for (const framework of ["HTML/CSS", "React + Vite", "Expo", undefined]) expect(desktopCardView(framework, false)).toBeNull();
});

it("Open goes to the project's files and terminal and never starts a Preview", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetchMock = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter initialEntries={["/c/chat"]}><Routes><Route path="*" element={<>
    <ChatProjectPreviewCard card={{ id: "p1", projectId: "p1", companyId: "c1", name: "V6TEST_S8_Catcher", status: "stopped", framework: "Pygame", kind: "code_project", projectKind: "game" }} />
    <Where />
  </>} /></Routes></MemoryRouter>); });
  const card = host.querySelector('[data-testid="chat-project-preview-card"]')!;
  expect(card.textContent).toContain("Desktop");
  expect(card.textContent).not.toContain("Live Preview");
  expect(card.textContent).toContain("No Preview");
  const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open the project\'s files and terminal"]')!;
  expect(open.disabled).toBe(false);
  await act(async () => { open.click(); });
  expect(host.querySelector('[data-testid="where"]')!.textContent).toBe("/settings/code/c1/p1");
  expect(fetchMock.mock.calls.some(call => String((call as unknown[])[0]).includes("/preview/start"))).toBe(false);
});
