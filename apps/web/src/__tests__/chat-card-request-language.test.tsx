// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ChatProjectPreviewCard } from "../ChatProjectPreviewCard";
import { chatCardLabels } from "../chat-card-i18n";
import { textIn } from "../i18n";

// V6 step 13: a Japanese request in an English interface showed "Thinking" and "Website · Live Preview · Failed · Open".
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("labels the project card in the language of the request", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ isRunning: false }))));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MemoryRouter><ChatProjectPreviewCard language="ja" card={{ id: "p1", projectId: "p1", companyId: "c1", name: "Bakery", status: "stopped", framework: "HTML/CSS", kind: "code_project", projectKind: "website" }} /></MemoryRouter>); });
  const text = host.textContent ?? "";
  expect(text).toContain("ウェブサイト · Live Preview");
  expect(text).toContain("開く");
  expect(text).not.toMatch(/Website ·|\bOpen\b/);
});

it("has every card label and the thinking text in all 16 languages", () => {
  const english = chatCardLabels("en");
  for (const language of ["uk", "ru", "de", "fr", "es", "it", "pl", "pt", "nl", "tr", "zh", "ja", "ko", "ar", "hi"]) {
    const labels = chatCardLabels(language);
    expect(Object.keys(labels)).toEqual(Object.keys(english));
    expect(labels.open, language).not.toBe(english.open);
    expect(textIn(language, "chat.thinking"), language).not.toBe("Thinking");
  }
});
