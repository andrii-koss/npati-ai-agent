import { getStoredAuthToken } from "./AuthContext";
/** Stream notifications use server projections; GET remains the recovery source. */
export async function watchDevelopmentTrace(signal: AbortSignal, onChange: () => void) {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      const token = getStoredAuthToken();
      const response = await fetch("/api/chat/development/processes/stream", { signal, headers: token ? { authorization: "Bearer " + token } : {} });
      if (response.status === 401 || response.status === 403) return;
      if (!response.ok || !response.body) throw new Error("Trace stream unavailable");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (frame.split("\n").includes("event: change")) { delay = 1000; onChange(); }
          }
          if (buffer.length > 64_000) throw new Error("Invalid trace frame");
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { if (signal.aborted) return; }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delay); signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    delay = Math.min(delay * 2, 10_000);
  }
}
