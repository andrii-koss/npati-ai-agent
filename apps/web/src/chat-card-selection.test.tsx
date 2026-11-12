// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatMessageContent } from "./ChatMessageContent";
import { useCardChangeDraft } from "./chat-card-draft";

let host: HTMLDivElement, root: Root;
const content = "```card:Company: Demo\nA selected passage with text.\n```";
function Draft() {
  const [input, setInput] = useState("Existing draft"); const version = useRef(0);
  useCardChangeDraft(input, setInput, false, version);
  return <form className="onboarding-live-composer"><textarea aria-label="Chat message" value={input} onChange={event => setInput(event.target.value)} /><output>{version.current}</output></form>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Object.defineProperty(document, "queryCommandState", { configurable: true, value: vi.fn(() => false) });
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => true) });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const render = () => act(async () => root.render(<><ChatMessageContent content={content} /><Draft /><p data-outside>Outside text</p></>));
async function select(element: Element) {
  await act(async () => { const range = document.createRange(); range.selectNodeContents(element); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
}
const bar = () => document.body.querySelector<HTMLElement>('[role="toolbar"]');
async function click(label: string) { await act(async () => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()); }

it("shows the floating toolbar for card text only and restores the selected range for formatting", async () => {
  await render(); await select(host.querySelector('[data-outside]')!); expect(bar()).toBeNull();
  const body = host.querySelector(".editable-card-body")!;
  await select(body.querySelector("p")!);
  expect(bar()?.parentElement).toBe(document.body);
  for (const label of ["Bold", "Italic", "Link"]) expect(bar()?.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
  await click("Bold"); expect(document.execCommand).toHaveBeenCalledWith("bold", false, undefined);
  expect(window.getSelection()?.toString()).toBe("A selected passage with text.");
  await click("Italic"); expect(document.execCommand).toHaveBeenCalledWith("italic", false, undefined);
  await click("Text style");
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === "Numbered list")!.click());
  expect(document.execCommand).toHaveBeenCalledWith("insertOrderedList", false, undefined);
  await select(host.querySelector('[data-outside]')!); expect(bar()).toBeNull();
});

it.each([1, 2, 3])("applies Heading %i, recognizes its selected style, and switches back to text", async level => {
  await render();
  const body = host.querySelector(".editable-card-body")!;
  await select(body.querySelector("p")!); await click("Text style");
  expect([...bar()!.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent)).toEqual(["Text", "Heading 1", "Heading 2", "Heading 3", "Numbered list", "Bulleted list"]);
  await act(async () => [...bar()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === `Heading ${level}`)!.click());
  expect(document.execCommand).toHaveBeenCalledWith("formatBlock", false, `h${level}`);
  // Supply the browser's native editing result; jsdom does not implement execCommand.
  body.innerHTML = `<h${level}>A selected passage with text.</h${level}>`;
  await select(body.firstElementChild!);
  expect(bar()!.querySelector('button[aria-label="Text style"]')!.textContent).toBe(`Heading ${level}`);
  await click("Text style");
  const active = bar()!.querySelector('[role="menuitemradio"][aria-checked="true"]')!;
  expect(active.textContent).toBe(`Heading ${level}`); expect(active.querySelector("svg")).not.toBeNull();
  await act(async () => [...bar()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === "Text")!.click());
  expect(document.execCommand).toHaveBeenLastCalledWith("formatBlock", false, "p");
});

it("rejects unsafe links and applies a validated URL to the saved text selection", async () => {
  await render(); await select(host.querySelector(".editable-card-body p")!); await click("Link");
  const input = bar()!.querySelector<HTMLInputElement>("input")!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(input, "javascript:alert(1)"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => bar()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(bar()?.querySelector('[role="alert"]')).not.toBeNull(); expect(document.execCommand).not.toHaveBeenCalled();
  await act(async () => { set.call(input, "example.com/page"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => bar()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(document.execCommand).toHaveBeenCalledWith("createLink", false, "https://example.com/page");
  expect(window.getSelection()?.toString()).toBe("A selected passage with text.");
});

it("adds a selected fullscreen passage to the existing chat draft without sending it", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await render(); await click("Expand to fullscreen");
  await select(document.body.querySelector(".editable-card-modal .editable-card-body p")!);
  await act(async () => [...bar()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Ask for changes")!.click());
  const draft = host.querySelector<HTMLTextAreaElement>("textarea")!.value;
  expect(draft).toContain("Existing draft\n\n"); expect(draft).toContain("Company: Demo");
  expect(draft).toContain("> A selected passage with text."); expect(draft).toContain("Requested changes: ");
  expect(host.querySelector("output")?.textContent).toBe("1");
  expect(document.body.querySelector(".editable-card-modal-backdrop")).toBeNull(); expect(bar()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
