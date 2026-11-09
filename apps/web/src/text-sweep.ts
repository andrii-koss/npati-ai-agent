const FRAME_MS = 125;
const SWEEP_MS = 1200;

/** Background position of the sweep at a moment in time: right to left, repeating. */
export function sweepPosition(now: number): string {
  return `${(100 - 240 * ((now % SWEEP_MS) / SWEEP_MS)).toFixed(1)}% 0`;
}

/**
 * Moves the red sweep on active step text. Without a GPU every drawn frame costs CPU that a running build needs: a CSS
 * animation took 7-8% of a core even with steps(), this timer takes 3%, because the page is idle between its ticks.
 */
export function startTextSweep(): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.setInterval(() => {
    if (document.hidden) return;
    const position = sweepPosition(Date.now());
    document.querySelectorAll<HTMLElement>(".research-active-text:not(.generation-status-text)").forEach(element => {
      element.style.backgroundPosition = position;
    });
  }, FRAME_MS);
}
