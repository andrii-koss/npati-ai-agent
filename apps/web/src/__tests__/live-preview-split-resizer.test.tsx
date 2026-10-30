// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  LivePreviewSplitResizer,
  SPLIT_STORAGE_KEY,
  DEFAULT_CHAT_RATIO,
  MIN_CHAT_RATIO,
  MAX_CHAT_RATIO,
} from "../LivePreviewSplitResizer";

let root: ReturnType<typeof createRoot> | undefined;

describe("LivePreviewSplitResizer", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    document.documentElement.style.removeProperty("--chat-split-ratio");
    document.documentElement.style.removeProperty("--preview-split-ratio");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    host?.remove();
    document.body.classList.remove("is-resizing");
  });

  it("renders with default ratio of 40% and sets CSS variables", async () => {
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]');
    expect(resizer).not.toBeNull();
    expect(resizer?.getAttribute("aria-valuenow")).toBe("40");
    expect(resizer?.getAttribute("aria-valuemin")).toBe("25");
    expect(resizer?.getAttribute("aria-valuemax")).toBe("75");
    expect(document.documentElement.style.getPropertyValue("--chat-split-ratio")).toBe("40%");
    expect(document.documentElement.style.getPropertyValue("--preview-split-ratio")).toBe("60%");
  });

  it("restores valid ratio from localStorage", async () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, "52");
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]');
    expect(resizer?.getAttribute("aria-valuenow")).toBe("52");
    expect(document.documentElement.style.getPropertyValue("--chat-split-ratio")).toBe("52%");
    expect(document.documentElement.style.getPropertyValue("--preview-split-ratio")).toBe("48%");
  });

  it("ignores out-of-bounds localStorage values and uses default", async () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, "95");
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]');
    expect(resizer?.getAttribute("aria-valuenow")).toBe("40");
  });

  it("resets to 40/60 on double click", async () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, "55");
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]') as HTMLDivElement;
    expect(resizer.getAttribute("aria-valuenow")).toBe("55");

    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("40");
    expect(localStorage.getItem(SPLIT_STORAGE_KEY)).toBe("40");
    expect(document.documentElement.style.getPropertyValue("--chat-split-ratio")).toBe("40%");
  });

  it("supports keyboard navigation (ArrowLeft, ArrowRight, Home)", async () => {
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]') as HTMLDivElement;

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("39");

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("44");

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("40");
  });

  it("clamps ratio to minimum 25% with keyboard", async () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, "26");
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]') as HTMLDivElement;

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("25");

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("25");
  });

  it("clamps ratio to maximum 75% with keyboard", async () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, "74");
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]') as HTMLDivElement;

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("75");

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("75");
  });

  it("handles mouse dragging and document classes", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1000 });
    await act(async () => {
      root?.render(<LivePreviewSplitResizer />);
    });
    const resizer = host.querySelector('[data-testid="live-preview-split-resizer"]') as HTMLDivElement;

    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 400, bubbles: true }));
    });
    expect(document.body.classList.contains("is-resizing")).toBe(true);

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("50");

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(document.body.classList.contains("is-resizing")).toBe(false);
    expect(localStorage.getItem(SPLIT_STORAGE_KEY)).toBe("50");
  });
});
