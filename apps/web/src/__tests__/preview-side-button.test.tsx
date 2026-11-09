// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewSideButton, readPreviewSide } from "../PreviewSideButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; localStorage.clear(); document.body.innerHTML = ""; });

describe("panel side button", () => {
  it("swaps sides, turns the arrow and remembers the choice", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<PreviewSideButton isUk={false} />));
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Move to the left");
    await act(async () => button.click());
    expect(document.documentElement.dataset.previewSide).toBe("left");
    expect(readPreviewSide()).toBe("left");
    expect(button.getAttribute("aria-label")).toBe("Move to the right");
    expect(button.classList.contains("points-right")).toBe(true);
    await act(async () => button.click());
    expect(document.documentElement.dataset.previewSide).toBe("right");
    expect(readPreviewSide()).toBe("right");
  });
});
