import { monitorEventLoopDelay } from "node:perf_hooks";

/** Logs when the API's single thread was blocked long enough to delay tools and requests. */
export function watchEventLoop(thresholdMs = 500, everyMs = 10_000): void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  setInterval(() => {
    const maxMs = Math.round(delay.max / 1e6);
    if (maxMs >= thresholdMs) console.warn(`[event-loop] blocked max=${maxMs}ms p99=${Math.round(delay.percentile(99) / 1e6)}ms`);
    delay.reset();
  }, everyMs).unref();
}
