import type { DevelopmentProcess } from "@npati/shared";
import { getStoredAuthToken } from "./AuthContext";
/** Stream notifications use server projections; GET remains the recovery source. */
export async function watchDevelopmentTrace(signal: AbortSignal, onChange: (processes?: DevelopmentProcess[]) => void, conversationId?: string, projectId?: string) {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      const token = getStoredAuthToken();
      // A chat watches only its own and running processes; a project link (no conversation filter) sees all.
      const url = "/api/chat/development/processes/stream" + (conversationId !== undefined ? "?conversationId=" + encodeURIComponent(conversationId) : projectId ? "?projectId=" + encodeURIComponent(projectId) : "");
      const response = await fetch(url, { signal, headers: token ? { authorization: "Bearer " + token } : {} });
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
            if (frame.split("\n").includes("event: change")) { delay = 1000;
              let processes: DevelopmentProcess[] | undefined;
              try {
                const data = JSON.parse(frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n"));
                if (Array.isArray(data.processes) && data.processes.every((p: Record<string,unknown>)=>p && ["id","companyId","parentConversationId","name","framework","createdAt","updatedAt"].every(key=>typeof p[key]==="string") && typeof p.hidden==="boolean" && ["idle","queued","preparing","running","stopping","completed","failed","cancelled","interrupted","awaiting_approval"].includes(String(p.status)))) processes=data.processes;
              } catch { /* Older/malformed hints recover through the existing GET. */ }
              onChange(processes); }
          }
          // A real file diff can span many network chunks. The old 64 KB limit
          // disconnected before the frame completed and froze the last visible step.
          if (buffer.length > 8 * 1024 * 1024) throw new Error("Invalid trace frame");
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
