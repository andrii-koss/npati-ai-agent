// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatResearchProgress } from "./use-chat-research-progress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());

function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result = {} as { current: T };
  const Probe = () => { result.current = hook(); return null; };
  act(() => { createRoot(document.createElement("div")).render(createElement(Probe)); });
  return { result };
}

describe("chat progress pacing", () => {
  it("does not pace the answer's own generation events", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const { result } = renderHook(() => useChatResearchProgress({ current: flush }));
    act(() => { result.current.enqueueProgress({ type: "final_generation_started", timestamp: "t" } as never); });
    act(() => { vi.advanceTimersByTime(0); });
    act(() => { result.current.enqueueProgress({ type: "final_generation_completed", timestamp: "t" } as never); });
    act(() => { vi.advanceTimersByTime(10); });
    expect(result.current.visibleProgressCount).toBe(2);
    expect(flush).toHaveBeenCalled();
  });

  it("still paces real research steps so they can be read", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatResearchProgress({ current: vi.fn() }));
    act(() => { result.current.enqueueProgress({ type: "search_started", query: "q", timestamp: "t" } as never); });
    act(() => { vi.advanceTimersByTime(0); });
    act(() => { result.current.enqueueProgress({ type: "research_completed", timestamp: "t" } as never); });
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.visibleProgressCount).toBe(1);
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current.visibleProgressCount).toBe(2);
  });
});
