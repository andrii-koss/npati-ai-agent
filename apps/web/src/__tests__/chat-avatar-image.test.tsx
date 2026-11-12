// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatAvatarImage } from "../ChatAvatarImage";
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (url: string | null = "/avatar.png") => act(async () => root.render(<ChatAvatarImage url={url} initials="AB" />));
it("keeps a neutral surface while the avatar loads and decodes", async () => {
  await render(); const image = host.querySelector("img")!;
  let finish!: () => void;
  Object.defineProperty(image, "decode", { value: () => new Promise<void>(resolve => { finish = resolve; }) });
  expect(host.querySelector("[data-avatar-state]")?.getAttribute("data-avatar-state")).toBe("loading");
  expect(host.textContent).not.toContain("AB");
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(image.style.opacity).toBe("0");
  await act(async () => finish());
  expect(image.style.opacity).toBe("1");
  await render(); expect(host.querySelector("img")).toBe(image); expect(image.style.opacity).toBe("1");
});
it("ignores an old decode result when the avatar changes", async () => {
  await render(); const image = host.querySelector("img")!;
  let finish!: () => void;
  Object.defineProperty(image, "decode", { value: () => new Promise<void>(resolve => { finish = resolve; }) });
  await act(async () => image.dispatchEvent(new Event("load")));
  await render("/new-avatar.png"); await act(async () => finish());
  expect(image.style.opacity).toBe("0");
  expect(host.querySelector("[data-avatar-state]")?.getAttribute("data-avatar-state")).toBe("loading");
});
it("uses initials when the avatar is absent or fails to load", async () => {
  await render(); await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.textContent).toBe("AB"); expect(host.querySelector("img")).toBeNull();
  await render(null); expect(host.textContent).toBe("AB");
});
