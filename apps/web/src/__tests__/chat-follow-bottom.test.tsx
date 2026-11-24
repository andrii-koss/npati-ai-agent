// @vitest-environment jsdom
import React, { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useChatFollowBottom } from "../use-chat-follow-bottom";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

/** A chat area whose scroll position the test sets: 1000px of content in a 200px window. */
function setup() {
  const follow = { current: true };
  let api: ReturnType<typeof useChatFollowBottom> | undefined;
  let element: HTMLDivElement | null = null;
  function Chat() {
    const stream = useRef<HTMLDivElement | null>(null);
    api = useChatFollowBottom(stream, follow, false);
    return <div ref={node => { stream.current = node; element = node; }} />;
  }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<Chat />));
  const at = (scrollTop: number) => {
    Object.defineProperty(element!, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(element!, "clientHeight", { configurable: true, value: 200 });
    element!.scrollTop = scrollTop;
    api!.updateFollow(element!);
  };
  return { follow, at, api: () => api! };
}

it("keeps following when the chat scrolls itself, stops on the user's scroll up and resumes at the bottom", () => {
  const { follow, at, api } = setup();
  at(500); // the chat's own smooth scroll, still on its way down while content grows
  expect(follow.current).toBe(true);
  api().noteUserInput({ type: "wheel", deltaY: -40 });
  expect(follow.current).toBe(false);
  at(700); // a small scroll up stays where the user left it
  expect(follow.current).toBe(false);
  api().noteUserInput({ type: "wheel", deltaY: 40 });
  at(800);
  expect(follow.current).toBe(true);
});

it("stops following when the user drags the scrollbar up", () => {
  const { follow, at, api } = setup();
  api().noteUserInput({ type: "pointerdown" });
  at(300);
  expect(follow.current).toBe(false);
});
