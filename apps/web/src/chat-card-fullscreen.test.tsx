// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatMessageContent } from "./ChatMessageContent";

it("opens the table outside the contained chat message, syncs edits while open, and closes normally", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    const content = "```card:Компанія: V6TEST_Bakery2\n| Name | Value |\n| --- | --- |\n| Bakery | 2 |\n```";
    await act(async () => root.render(<article style={{ contentVisibility: "auto", transform: "translateZ(0)" }}><ChatMessageContent content={content} /></article>));
    const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Expand to fullscreen"]')!;
    const inline = host.querySelector<HTMLDivElement>(".editable-card-body")!;
    await act(async () => { inline.innerHTML = "<table><tbody><tr><td>Bakery</td><td>2</td></tr></tbody></table>"; inline.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => expand.click());
    const backdrop = document.body.querySelector<HTMLElement>(".editable-card-modal-backdrop")!;
    expect(backdrop.parentElement).toBe(document.body);
    expect(host.querySelector(".editable-card-modal-backdrop")).toBeNull();
    expect(backdrop.querySelector("table")?.textContent).toContain("Bakery");
    const body = backdrop.querySelector<HTMLDivElement>(".editable-card-body")!;
    await act(async () => { body.querySelector("td")!.textContent = "Updated bakery"; body.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelector("table")?.textContent).toContain("Updated bakery");
    await act(async () => backdrop.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')!.click());
    expect(document.body.querySelector(".editable-card-modal-backdrop")).toBeNull();
    await act(async () => expand.click());
    expect(document.body.querySelector(".editable-card-modal-backdrop")?.parentElement).toBe(document.body);
    expect(document.body.querySelector(".editable-card-modal table")?.textContent).toContain("Updated bakery");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector(".editable-card-modal-backdrop")).toBeNull();
    await act(async () => expand.click());
    await act(async () => document.body.querySelector<HTMLElement>(".editable-card-modal-backdrop")!.click());
    expect(document.body.querySelector(".editable-card-modal-backdrop")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
