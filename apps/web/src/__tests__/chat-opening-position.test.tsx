// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatOpeningPosition } from "../use-chat-opening-position";
let host: HTMLDivElement, root: Root;
let cancel: () => void;
let height = 1800;
let observers: { connected: boolean; callback: () => void }[];
const resize = () => observers.filter(item => item.connected).forEach(item => item.callback());
const scroll = vi.fn(function(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; });
function Chat({ request = "a:1", sending = false, card = false }: { request?: string | null; sending?: boolean; card?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  cancel = useChatOpeningPosition(ref, request, sending);
  return <div ref={ref} className="message-stream" onWheel={() => cancel()}>
    <article className="user" data-message-id="user">Create a website</article>
    <article className="assistant" data-chat-reply-id="intro">I will create a website</article>
    <article className="assistant" data-message-id="last">Completed</article>
    {card && <article className="assistant">HTML/CSS · Website · Live Preview · Running · Open · Усього 0:19</article>}
    <div className="chat-scroll-spacer" />
  </div>;
}
const render = (props: Parameters<typeof Chat>[0] = {}) => act(async () => root.render(<Chat {...props} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  height = 1800; observers = []; scroll.mockClear();
  vi.stubGlobal("ResizeObserver", class {
    item: { connected: boolean; callback: () => void };
    constructor(callback: () => void) { this.item = { connected: true, callback }; observers.push(this.item); }
    observe() {}
    disconnect() { this.item.connected = false; }
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("opens immediately at the bottom, including the last project card and total time", async () => {
  await render({ card: true });
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1200, behavior: "instant" });
  expect(host.querySelector<HTMLElement>(".chat-scroll-spacer")!.style.minHeight).toBe("");
});
it("does not scroll again for unchanged metadata or unchanged geometry", async () => {
  await render(); await render(); await act(async () => resize());
  expect(scroll).toHaveBeenCalledTimes(1);
});
it("includes a project card that arrives after the saved reply", async () => {
  await render(); height += 400; await render({ card: true });
  expect(scroll).toHaveBeenLastCalledWith({ top: 1600, behavior: "instant" });
});
it("stays at the bottom when delayed images or layout changes increase the stream height", async () => {
  await render(); height += 180; await act(async () => resize());
  expect(scroll).toHaveBeenLastCalledWith({ top: 1380, behavior: "instant" });
});
it("releases automatic positioning as soon as the user scrolls", async () => {
  await render();
  await act(async () => host.firstElementChild!.dispatchEvent(new WheelEvent("wheel", { bubbles: true })));
  height += 180; await act(async () => resize()); await render();
  expect(scroll).toHaveBeenCalledTimes(1);
});
it("cleans up old observers and independently positions each next conversation", async () => {
  await render(); const old = observers[0]!;
  await render({ request: null }); expect(old.connected).toBe(false);
  height = 2800; await render({ request: "b:2" });
  expect(scroll).toHaveBeenLastCalledWith({ top: 2200, behavior: "instant" });
  expect(observers.filter(item => item.connected)).toHaveLength(1);
  await render({ request: "c:3" });
  expect(host.firstElementChild!.scrollTop).toBe(2200);
});
it("leaves follow-up streaming to the existing live-scroll controller", async () => {
  await render(); await render({ sending: true });
  height += 180; await act(async () => resize());
  expect(scroll).toHaveBeenCalledTimes(1);
});
it("does not add blank space or scroll beyond a short conversation", async () => {
  height = 300; await render({ card: true });
  expect(scroll).not.toHaveBeenCalled();
  expect(host.firstElementChild!.scrollTop).toBe(0);
  expect(host.querySelector<HTMLElement>(".chat-scroll-spacer")!.style.minHeight).toBe("");
});
