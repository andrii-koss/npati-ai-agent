// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProjectPreviewCard } from "../ChatProjectPreviewCard";
import type { ProjectCardData } from "@npati/shared";
import { I18nProvider } from "../i18n";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ChatProjectPreviewCard", () => {
  it("renders Website project card matching design specifications", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/preview/status")) return new Response(JSON.stringify({ isRunning: true, previewUrl: "/preview/test" }));
        if (url.endsWith("/qa/thumbnail")) return new Response(JSON.stringify({ thumbnail: null }));
        return new Response(JSON.stringify({}));
      })
    );

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const card: ProjectCardData = {
      id: "p1",
      projectId: "p1",
      companyId: "c1",
      name: "React + Vite",
      framework: "React + Vite",
      kind: "website_project",
      status: "ready",
    };

    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ChatProjectPreviewCard card={card} />
        </MemoryRouter>
      );
    });

    const cardEl = host.querySelector('[data-testid="chat-project-preview-card"]')!;
    expect(cardEl).not.toBeNull();

    // Check title, subtitle, and status
    expect(host.querySelector(".chat-preview-card-title")?.textContent).toBe("React + Vite");
    expect(host.querySelector(".chat-preview-card-subtitle")?.textContent).toBe("Website · Live Preview");
    expect(host.querySelector(".chat-preview-card-status")?.textContent).toContain("Running");

    // Check Open button and chevron dropdown button
    const openBtn = host.querySelector<HTMLButtonElement>(".chat-preview-open-btn");
    expect(openBtn).not.toBeNull();
    expect(openBtn?.textContent).toContain("Open");
    expect(openBtn?.classList.contains("coding-preview-trigger")).toBe(true);

    const dropdownBtn = host.querySelector<HTMLButtonElement>(".chat-preview-dropdown-btn");
    expect(dropdownBtn).not.toBeNull();

    // SVG Thumbnail
    const thumbnail = host.querySelector(".chat-preview-card-thumbnail");
    expect(thumbnail).not.toBeNull();
    expect(thumbnail?.getAttribute("data-type")).toBe("website");
    expect(thumbnail?.querySelector("svg")).not.toBeNull();
  });

  it("renders Mobile App project card with Expo/Flutter", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ isRunning: true })))
    );

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const card: ProjectCardData = {
      id: "m1",
      projectId: "m1",
      companyId: "c1",
      name: "Fitness Tracker",
      framework: "Expo",
      kind: "code_project",
      status: "ready",
    };

    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ChatProjectPreviewCard card={card} />
        </MemoryRouter>
      );
    });

    expect(host.querySelector(".chat-preview-card-title")?.textContent).toBe("Expo");
    expect(host.querySelector(".chat-preview-card-subtitle")?.textContent).toBe("Mobile app · Live Preview");
    expect(host.querySelector(".chat-preview-card-thumbnail")?.getAttribute("data-type")).toBe("mobile_app");
  });

  it("renders Game project card with Phaser engine", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ isRunning: false })))
    );

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const card: ProjectCardData = {
      id: "g1",
      projectId: "g1",
      companyId: "c1",
      name: "Space Arcade",
      framework: "Phaser",
      kind: "code_project",
      status: "stopped",
    };

    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ChatProjectPreviewCard card={card} />
        </MemoryRouter>
      );
    });

    expect(host.querySelector(".chat-preview-card-title")?.textContent).toBe("Phaser");
    expect(host.querySelector(".chat-preview-card-subtitle")?.textContent).toBe("Game · Live Preview");
    expect(host.querySelector(".chat-preview-card-thumbnail")?.getAttribute("data-type")).toBe("game");
    expect(host.querySelector(".chat-preview-card-status")?.textContent).toContain("Stopped");
  });

  it("shows real screenshot when available from qa/thumbnail", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const fakeDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/qa/thumbnail")) return new Response(JSON.stringify({ thumbnail: { dataUrl: fakeDataUrl } }));
        if (url.endsWith("/preview/status")) return new Response(JSON.stringify({ isRunning: true }));
        return new Response(JSON.stringify({}));
      })
    );

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const card: ProjectCardData = {
      id: "p1",
      projectId: "p1",
      companyId: "c1",
      name: "My Site",
      framework: "Next.js",
      kind: "website_project",
      status: "ready",
    };

    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ChatProjectPreviewCard card={card} />
        </MemoryRouter>
      );
    });

    const img = host.querySelector<HTMLImageElement>(".chat-preview-card-thumbnail-img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(fakeDataUrl);
  });

  it("opens dropdown menu and handles actions", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const onActivate = vi.fn();

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const card: ProjectCardData = {
      id: "p1",
      projectId: "p1",
      companyId: "c1",
      name: "Novashop",
      framework: "React + Vite",
      kind: "code_project",
      sessionId: "sess1",
      status: "ready",
      changesCount: 3,
      runId: "run123",
      previewUrl: "/api/preview/proxy",
    };

    await act(async () => {
      root!.render(
        <MemoryRouter>
          <ChatProjectPreviewCard card={card} onActivate={onActivate} />
        </MemoryRouter>
      );
    });

    expect(host.querySelector(".chat-preview-dropdown-menu")).toBeNull();

    // Click dropdown button
    const dropdownBtn = host.querySelector<HTMLButtonElement>(".chat-preview-dropdown-btn")!;
    await act(async () => {
      dropdownBtn.click();
    });

    // The menu floats in document.body (V6 step 15: inside the chat it was cut off and covered).
    const menu = document.querySelector(".chat-preview-dropdown-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Open in new tab");
    expect(menu.textContent).toContain("Edit in chat");
    expect(menu.textContent).toContain("Changes (3)");
    expect(menu.textContent).toContain("Code Workspace");
    expect(menu.textContent).toContain("Restart preview");
    expect(menu.textContent).toContain("View Run");

    // Click edit in chat
    const editBtn = [...menu.querySelectorAll("button")].find(b => b.textContent?.includes("Edit in chat"))!;
    await act(async () => {
      editBtn.click();
    });
    expect(onActivate).toHaveBeenCalledWith(card);
    expect(host.querySelector(".chat-preview-dropdown-menu")).toBeNull();
  });

  it("supports Ukrainian localization", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.setItem("npati_language", "uk");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ isRunning: true })))
    );

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const card: ProjectCardData = {
      id: "p1",
      projectId: "p1",
      companyId: "c1",
      name: "React + Vite",
      framework: "React + Vite",
      kind: "website_project",
      status: "ready",
    };

    await act(async () => {
      root!.render(
        <MemoryRouter>
          <I18nProvider>
            <ChatProjectPreviewCard card={card} />
          </I18nProvider>
        </MemoryRouter>
      );
    });

    expect(host.querySelector(".chat-preview-card-subtitle")?.textContent).toBe("Вебсайт · Live Preview");
    expect(host.querySelector(".chat-preview-card-status")?.textContent).toContain("Працює");
  });
});

// V6 D02-07: right after an edit the preview server restarts and /preview/status answers 502 for a few seconds; the
// card said "Failed" until the next event. A transient 5xx is "starting" and is checked again.
it("shows a restarting preview as starting and becomes Running after the retry, never Failed", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  try {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/preview/status")) { calls += 1; return calls === 1 ? new Response("Bad gateway", { status: 502 }) : new Response(JSON.stringify({ isRunning: true, previewUrl: "/preview/test" })); }
      return new Response(JSON.stringify({}));
    }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const card: ProjectCardData = { id: "p2", projectId: "p2", companyId: "c1", name: "Cafe", framework: "React + Vite", kind: "website_project", status: "ready" };
    await act(async () => { root!.render(<MemoryRouter><ChatProjectPreviewCard card={card} /></MemoryRouter>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(".chat-preview-card-status")?.textContent ?? "").not.toContain("Failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(host.querySelector(".chat-preview-card-status")?.textContent).toContain("Running");
  } finally { vi.useRealTimers(); }
});
