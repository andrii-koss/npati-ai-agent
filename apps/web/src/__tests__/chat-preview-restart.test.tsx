// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ChatProjectPreviewCard } from "../ChatProjectPreviewCard";

// V6 step 15: "Restart preview" only opened the old Preview, so a React app whose source was broken by hand still
// showed the previous build as running. Restart rebuilds the files; a failed build is shown under the block.
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("rebuilds on restart and shows a failed build under the block", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push((init?.method ?? "GET") + " " + url);
    if (url.endsWith("/apply-file-changes")) return new Response(JSON.stringify({ error: { message: "Build failed: Unexpected token in src/App.jsx" } }), { status: 500 });
    if (url.endsWith("/preview/status")) return new Response(JSON.stringify({ isRunning: true, previewUrl: "/preview/app" }));
    return new Response("{}");
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter><ChatProjectPreviewCard card={{ id: "p", projectId: "p", companyId: "c", name: "App", framework: "React + Vite", kind: "code_project", status: "ready", previewUrl: "/preview/app" }} language="uk" /></MemoryRouter>));
  await act(async () => host.querySelector<HTMLButtonElement>(".chat-preview-dropdown-btn")!.click());
  const restart = [...document.querySelectorAll<HTMLButtonElement>(".chat-preview-dropdown-item")].find((b) => /restart preview|перезапустити preview/i.test(b.textContent ?? ""))!;
  await act(async () => { restart.click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/apply-file-changes"))).toBe(true);
  expect(host.querySelector(".chat-preview-card-notice")?.textContent).toContain("Збірка не вдалася");
  expect(host.querySelector(".chat-preview-card-notice")?.textContent).toContain("Unexpected token");
  expect(host.querySelector(".chat-preview-card-status")?.className).toContain("status-failed");
});
