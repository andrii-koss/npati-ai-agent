// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatOpeningPosition } from "../use-chat-opening-position";
import { ChatDevelopmentProgress } from "../ChatDevelopmentProgress";
import { I18nProvider } from "../i18n";
import type { DevelopmentProcess } from "@npati/shared";

let host: HTMLDivElement, root: Root;
let cancel: () => void;
let shift = 0;
let resize: () => void;
let observers: { connected: boolean; callback: () => void }[];
const scroll = vi.fn(function(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; });
function Chat({ request = "a:1", sending = false, onlyUser = false, hidden = false, commentary = false }: { request?: string | null; sending?: boolean; onlyUser?: boolean; hidden?: boolean; commentary?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  cancel = useChatOpeningPosition(ref, request, sending);
  return <div ref={ref} className="message-stream" onWheel={() => cancel()}>
    <article className="assistant" data-message-id="first" data-chat-reply-id="first" />
    <article className="user" data-message-id="user" />
    {commentary && <I18nProvider><ChatDevelopmentProgress process={{ id: "fixture", status: "completed" } as DevelopmentProcess}
      items={[{ id: "commentary", stage: "model_response", kind: "assistant_message", title: "I will create a professional, modern website for you with a clean layout and responsive design.", at: "2026-11-09T09:12:29.845Z" }]} /></I18nProvider>}
    {!onlyUser && <article className="assistant" data-message-id="last" data-chat-reply-id="last" />}
    {hidden && <article className="assistant" />}
    <div className="chat-scroll-spacer" />
  </div>;
}
const render = (props: Parameters<typeof Chat>[0] = {}) => act(async () => root.render(<Chat {...props} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  shift = 0; observers = []; scroll.mockClear();
  vi.stubGlobal("ResizeObserver", class {
    item: { connected: boolean; callback: () => void };
    constructor(callback: () => void) { this.item = { connected: true, callback }; observers.push(this.item); }
    observe() {}
    disconnect() { this.item.connected = false; }
  });
  resize = () => observers.filter(item => item.connected).forEach(item => item.callback());
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientTop", "get").mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const stream = this.closest<HTMLElement>(".message-stream");
    const offsets: Record<string, number> = { first: 100, user: 600, commentary: 650, last: 700 };
    const position = this.classList.contains("message-stream") ? 0
      : this.classList.contains("chat-scroll-spacer") ? 800 + shift - (stream?.scrollTop ?? 0)
      : (offsets[this.dataset.messageId ?? this.dataset.chatReplyId ?? ""] ?? 900) + shift - (stream?.scrollTop ?? 0);
    return { top: position + 40, bottom: position + 140, height: 100, left: 0, right: 500, width: 500, x: 0, y: position + 40, toJSON() {} };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens at the beginning of the last rendered reply immediately and provides space for short replies", async () => {
  await render({ hidden: true });
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 688, behavior: "instant" });
  expect(host.querySelector<HTMLElement>(".chat-scroll-spacer")!.style.minHeight).toBe("488px");
});
it("does not issue another scroll for unchanged metadata or unchanged geometry", async () => {
  await render(); await render(); await act(async () => resize());
  expect(scroll).toHaveBeenCalledTimes(1);
});
it("opens at the introductory agent text instead of the final summary of a development turn", async () => {
  await render({ commentary: true });
  expect(scroll).toHaveBeenLastCalledWith({ top: 638, behavior: "instant" });
});
it("retargets delayed commentary that arrives before the already displayed summary", async () => {
  await render(); await render({ commentary: true });
  expect(scroll).toHaveBeenLastCalledWith({ top: 638, behavior: "instant" });
});
it("preserves the reply start when delayed activity or images change layout", async () => {
  await render(); shift = 180; await act(async () => resize());
  expect(scroll).toHaveBeenLastCalledWith({ top: 868, behavior: "instant" });
});
it("releases the opening anchor as soon as the user scrolls", async () => {
  await render();
  await act(async () => host.firstElementChild!.dispatchEvent(new WheelEvent("wheel", { bubbles: true })));
  shift = 180; await act(async () => resize()); await render();
  expect(scroll).toHaveBeenCalledTimes(1);
});
it("cleans up old observers and positions the next conversation independently", async () => {
  await render(); const old = observers[0]!;
  await render({ request: null });
  expect(old.connected).toBe(false);
  shift = 100; await render({ request: "b:2" });
  expect(scroll).toHaveBeenLastCalledWith({ top: 788, behavior: "instant" });
  expect(observers.filter(item => item.connected)).toHaveLength(1);
});
it("stops holding history when a new reply is being streamed", async () => {
  await render(); await render({ sending: true });
  shift = 180; await act(async () => resize());
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLElement>(".chat-scroll-spacer")!.style.minHeight).toBe("");
});
it("uses the last visible assistant when a trailing user message has no answer yet", async () => {
  await render({ onlyUser: true });
  expect(scroll).toHaveBeenLastCalledWith({ top: 88, behavior: "instant" });
});
