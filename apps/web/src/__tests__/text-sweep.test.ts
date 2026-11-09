// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTextSweep, sweepPosition } from "../text-sweep";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const motion = (reduce: boolean) => vi.stubGlobal("matchMedia", (() => ({ matches: reduce })) as unknown as typeof window.matchMedia);

describe("step text sweep", () => {
  it("runs right to left and repeats", () => {
    expect(sweepPosition(0)).toBe("100.0% 0");
    expect(sweepPosition(600)).toBe("-20.0% 0");
    expect(sweepPosition(1200)).toBe("100.0% 0");
  });

  it("moves active text only, at 8 updates a second", () => {
    vi.useFakeTimers(); motion(false);
    document.body.innerHTML = '<span id="a" class="research-active-text"></span><span id="b"></span>';
    startTextSweep();
    const active = document.getElementById("a")!;
    const set = vi.spyOn(active.style, "backgroundPosition", "set");
    vi.advanceTimersByTime(1000);
    expect(set).toHaveBeenCalledTimes(8);
    expect(document.getElementById("b")!.style.backgroundPosition).toBe("");
  });

  it("does not run for a visitor who asked for reduced motion", () => {
    vi.useFakeTimers(); motion(true);
    const interval = vi.spyOn(window, "setInterval");
    startTextSweep();
    expect(interval).not.toHaveBeenCalled();
  });
});
